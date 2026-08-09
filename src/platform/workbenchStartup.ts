import type { FileEntry } from "../types";

export interface WorkbenchStore {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
}

export type StartupInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type StartupNative = ReturnType<typeof createStartupNative>;

export function createStartupNative(invoke: StartupInvoke) {
  return {
    setTrayLanguage: (lang: "zh" | "en") =>
      invoke<void>("set_tray_language", { lang }),
    setClipCacheMax: (n: number) =>
      invoke<void>("set_clip_cache_max", { n }),
    setSearchDirs: (dirs: string[]) =>
      invoke<void>("set_search_dirs", { dirs }),
    setSearchEngine: (engine: "builtin" | "everything") =>
      invoke<void>("set_search_engine", { engine }),
    existingStageImages: (files: string[]) =>
      invoke<string[]>("existing_stage_images", { files }),
    getFileInfo: (path: string) =>
      invoke<FileEntry>("get_file_info", { path }),
    loadLauncherIcons: (files: string[]) =>
      invoke<Record<string, string>>("load_launcher_icons", { files }),
    setDragoutAutoClose: (enabled: boolean) =>
      invoke<void>("set_dragout_auto_close", { enabled }),
    isAutostartEnabled: () =>
      invoke<boolean>("plugin:autostart|is_enabled"),
  };
}

const invokeStartup: StartupInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

export const startupNative = createStartupNative(invokeStartup);

export async function openWorkbenchStore(): Promise<WorkbenchStore> {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("workbench-data.json", { autoSave: true, defaults: {} });
}

export async function runStartupStep(
  label: string,
  task: () => Promise<void>,
  reportError: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    reportError(`[startup] ${label}失败：`, error);
    return false;
  }
}
