import { useCallback, useRef, useState } from "react";
import type { makeT } from "../i18n";
import {
  buildLauncherLayoutExport,
  createLauncherId,
  LAUNCHER_MAX,
  previewLauncherImport,
} from "../domain/launcherLayout";
import { launcherActionsApi } from "../platform/launcherActionsApi";
import type { AppInfo, LauncherImportPreview, LauncherItem } from "../types";

export type AddResult = "added" | "duplicate" | "full";

type FileSearchItem = {
  path: string;
  name: string;
  ext?: string;
  isDir: boolean;
  icon?: string | null;
};

type LauncherActionsOptions = {
  launcher: LauncherItem[];
  saveLauncher: (items: LauncherItem[]) => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  notifyAddResult: (result: AddResult, target: "launcher" | "stage", name: string) => void;
  showToast: (message: string) => void;
  t: ReturnType<typeof makeT>;
};

export function useLauncherActions({
  launcher,
  saveLauncher,
  setSettingsOpen,
  notifyAddResult,
  showToast,
  t,
}: LauncherActionsOptions) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerOpenRef = useRef(false);
  pickerOpenRef.current = pickerOpen;
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const [launcherPicking, setLauncherPicking] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const managerOpenRef = useRef(false);
  managerOpenRef.current = managerOpen;
  const [managerSelected, setManagerSelected] = useState<Set<number>>(new Set());
  const [importPreview, setImportPreview] = useState<LauncherImportPreview | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);

  const addApp = useCallback((app: AppInfo): AddResult => {
    if (launcher.some(item => item.kind === "app" && item.path === app.path)) return "duplicate";
    if (launcher.length >= LAUNCHER_MAX) return "full";
    void saveLauncher([...launcher, {
      id: createLauncherId(),
      kind: "app",
      name: app.name,
      icon: app.icon,
      path: app.path,
    }]);
    return "added";
  }, [launcher, saveLauncher]);

  const addFileSystemItem = useCallback(async (item: FileSearchItem): Promise<AddResult> => {
    if (launcher.some(existing => existing.path === item.path)) return "duplicate";
    if (launcher.length >= LAUNCHER_MAX) return "full";
    let icon = item.icon ?? null;
    if (!icon) {
      try { icon = (await launcherActionsApi.getFileInfo(item.path)).icon ?? null; } catch {}
    }
    await saveLauncher([...launcher, {
      id: createLauncherId(),
      kind: item.isDir ? "folder" : "file",
      name: item.name,
      icon,
      path: item.path,
      ext: item.ext,
    }]);
    return "added";
  }, [launcher, saveLauncher]);

  const pickPath = useCallback(async (kind: "file" | "folder") => {
    if (launcherPicking) return;
    setLauncherPicking(true);
    try {
      const path = kind === "folder"
        ? await launcherActionsApi.pickFolder()
        : await launcherActionsApi.pickFile();
      if (!path) return;
      const info = await launcherActionsApi.getFileInfo(path);
      notifyAddResult(await addFileSystemItem({
        path,
        name: info.name,
        ext: info.ext,
        isDir: info.isDir,
        icon: info.icon ?? null,
      }), "launcher", info.name);
    } catch (error) {
      console.error("[pick_launcher_path]", error);
      showToast(t("添加失败"));
    } finally {
      setLauncherPicking(false);
    }
  }, [launcherPicking, addFileSystemItem, notifyAddResult, showToast, t]);

  const openManager = useCallback(() => {
    setManagerSelected(new Set());
    setImportPreview(null);
    setSettingsOpen(false);
    setManagerOpen(true);
  }, [setSettingsOpen]);

  const closeManager = useCallback(() => {
    setManagerOpen(false);
    setImportPreview(null);
  }, []);

  const openPicker = useCallback(() => {
    setPickerQuery("");
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerQuery("");
  }, []);

  const toggleManagerItem = useCallback((id: number) => {
    setManagerSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleManagerAll = useCallback(() => {
    setManagerSelected(previous => previous.size === launcher.length
      ? new Set()
      : new Set(launcher.map(item => item.id)));
  }, [launcher]);

  const deleteManagerSelection = useCallback(async () => {
    if (!managerSelected.size) return;
    await saveLauncher(launcher.filter(item => !managerSelected.has(item.id)));
    setManagerSelected(new Set());
  }, [launcher, managerSelected, saveLauncher]);

  const exportLayout = useCallback(async () => {
    if (!launcher.length || layoutBusy) return;
    setLayoutBusy(true);
    try {
      const dir = await launcherActionsApi.pickFolder();
      if (!dir) return;
      const content = JSON.stringify(buildLauncherLayoutExport(launcher), null, 2);
      const path = await launcherActionsApi.writeLayoutExport(dir, content);
      showToast(t("已导出到：{path}", { path }));
    } catch {
      showToast(t("导出失败"));
    } finally {
      setLayoutBusy(false);
    }
  }, [launcher, layoutBusy, showToast, t]);

  const chooseLayoutImport = useCallback(async () => {
    if (layoutBusy) return;
    setLayoutBusy(true);
    try {
      const path = await launcherActionsApi.pickFile();
      if (!path) return;
      setImportPreview(previewLauncherImport(await launcherActionsApi.readLayoutImport(path), launcher));
    } catch (error) {
      showToast(t(error instanceof Error ? error.message : "导入失败"));
    } finally {
      setLayoutBusy(false);
    }
  }, [launcher, layoutBusy, showToast, t]);

  const confirmLayoutImport = useCallback(async () => {
    if (!importPreview?.items.length) return;
    await saveLauncher([...launcher, ...importPreview.items]);
    setManagerSelected(new Set());
    setImportPreview(null);
    showToast(t("已导入 {n} 项", { n: importPreview.items.length }));
  }, [launcher, importPreview, saveLauncher, showToast, t]);

  const removeItem = useCallback((id: number) => {
    void saveLauncher(launcher.filter(item => item.id !== id));
  }, [launcher, saveLauncher]);

  const clearImportPreview = useCallback(() => setImportPreview(null), []);

  return {
    pickerOpen,
    pickerQuery,
    setPickerQuery,
    pickerOpenRef,
    pickerInputRef,
    launcherPicking,
    managerOpen,
    managerOpenRef,
    managerSelected,
    importPreview,
    layoutBusy,
    addApp,
    addFileSystemItem,
    pickPath,
    openManager,
    closeManager,
    openPicker,
    closePicker,
    toggleManagerItem,
    toggleManagerAll,
    deleteManagerSelection,
    exportLayout,
    chooseLayoutImport,
    confirmLayoutImport,
    removeItem,
    clearImportPreview,
  };
}

