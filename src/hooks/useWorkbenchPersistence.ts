import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { LatestWriteQueue } from "../lib/persistQueue";
import type { LauncherItem, StageItem } from "../types";

interface StoreWriter {
  set: (key: string, value: unknown) => Promise<void>;
  save: () => Promise<void>;
}

interface PersistenceOptions {
  storeRef: MutableRefObject<StoreWriter | null>;
  setStage: Dispatch<SetStateAction<StageItem[]>>;
}

export function useWorkbenchPersistence({ storeRef, setStage }: PersistenceOptions) {
  // stage and launcher share one plugin-store file, so both domains must use one serialized tail.
  const [writeQueue] = useState(() => new LatestWriteQueue<"stage" | "launcher">());
  const stageContentFilesRef = useRef<Map<number, string>>(new Map());
  const launcherIconFilesRef = useRef<Map<number, string>>(new Map());

  const rememberStageReferences = useCallback((items: StageItem[]) => {
    for (const item of items) if (item.contentFile) stageContentFilesRef.current.set(item.id, item.contentFile);
  }, []);
  const rememberLauncherReferences = useCallback((items: LauncherItem[]) => {
    for (const item of items) if (item.iconFile) launcherIconFilesRef.current.set(item.id, item.iconFile);
  }, []);
  const hasStageContentFile = useCallback((id: number) => stageContentFilesRef.current.has(id), []);
  const getStageContentFile = useCallback((id: number) => stageContentFilesRef.current.get(id), []);
  const rememberStageContentFile = useCallback((id: number, file: string) => {
    stageContentFilesRef.current.set(id, file);
  }, []);
  const hasLauncherIconFile = useCallback((id: number) => launcherIconFilesRef.current.has(id), []);

  const dehydrateStage = useCallback(async (list: StageItem[]): Promise<StageItem[]> => {
    const known = stageContentFilesRef.current;
    const pending = list.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "image" && item.content && !item.contentFile && !known.has(item.id));
    if (pending.length) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const files = await invoke<(string | null)[]>("save_stage_images", { images: pending.map(({ item }) => item.content!) });
        pending.forEach(({ item }, index) => { const file = files[index]; if (file) known.set(item.id, file); });
      } catch (error) {
        console.warn("[persist] 中转图片外置失败，回退为内嵌内容：", error);
      }
    }
    return list.map(item => {
      if (item.type !== "image") return item;
      const contentFile = item.contentFile ?? known.get(item.id);
      if (!contentFile) return item;
      const { content: _omit, ...rest } = item;
      return { ...rest, contentFile };
    });
  }, []);

  const persistStage = useCallback(async (list: StageItem[]) => {
    await writeQueue.enqueue("stage", async isLatest => {
      const store = storeRef.current;
      if (!store) return;
      try {
        const persisted = await dehydrateStage(list);
        if (!isLatest()) return;
        await store.set("stage-items", persisted);
        await store.save();
        if (!isLatest()) return;
        const liveIds = new Set(list.map(item => item.id));
        for (const id of stageContentFilesRef.current.keys()) if (!liveIds.has(id)) stageContentFilesRef.current.delete(id);
        const sourceContent = new Map(list.filter(item => item.type === "image" && item.content).map(item => [item.id, item.content]));
        const persistedFile = new Map(persisted.filter(item => item.type === "image" && item.contentFile).map(item => [item.id, item.contentFile!]));
        if (persistedFile.size) {
          setStage(current => {
            let changed = false;
            const next = current.map(item => {
              const file = persistedFile.get(item.id);
              if (!file || !item.content || item.content !== sourceContent.get(item.id)) return item;
              const { content: _omit, ...rest } = item;
              changed = true;
              return { ...rest, contentFile: file };
            });
            return changed ? next : current;
          });
        }
      } catch (error) {
        console.error("[persist] 中转站落盘失败：", error);
      }
    });
  }, [dehydrateStage, setStage, storeRef, writeQueue]);

  const dehydrateLauncher = useCallback(async (list: LauncherItem[]): Promise<LauncherItem[]> => {
    const known = launcherIconFilesRef.current;
    const pending = list.map((item, index) => ({ item, index })).filter(({ item }) => item.icon && !item.iconFile && !known.has(item.id));
    if (pending.length) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const files = await invoke<(string | null)[]>("save_launcher_icons", { icons: pending.map(({ item }) => item.icon!) });
        pending.forEach(({ item }, index) => { const file = files[index]; if (file) known.set(item.id, file); });
      } catch (error) {
        console.warn("[persist] 启动台图标外置失败，回退为内嵌图标：", error);
      }
    }
    return list.map(item => {
      const iconFile = item.iconFile ?? known.get(item.id);
      if (!iconFile) return item;
      const { icon: _omit, ...rest } = item;
      return { ...rest, iconFile };
    });
  }, []);

  const persistLauncher = useCallback(async (list: LauncherItem[]) => {
    await writeQueue.enqueue("launcher", async isLatest => {
      const store = storeRef.current;
      if (!store) return;
      try {
        const persisted = await dehydrateLauncher(list);
        if (!isLatest()) return;
        await store.set("launcher-items", persisted);
        await store.save();
        if (!isLatest()) return;
        const liveIds = new Set(list.map(item => item.id));
        for (const id of launcherIconFilesRef.current.keys()) if (!liveIds.has(id)) launcherIconFilesRef.current.delete(id);
      } catch (error) {
        console.error("[persist] 启动台落盘失败：", error);
      }
    });
  }, [dehydrateLauncher, storeRef, writeQueue]);

  return {
    persistStage,
    persistLauncher,
    rememberStageReferences,
    rememberLauncherReferences,
    hasStageContentFile,
    getStageContentFile,
    rememberStageContentFile,
    hasLauncherIconFile,
  };
}
