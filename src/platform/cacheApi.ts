export type CacheInvoke = <T>(command: string) => Promise<T>;

export function createCacheApi(invoke: CacheInvoke) {
  return {
    openStageThumbnailDirectory: () => invoke<void>("open_stage_thumb_dir"),
    clearStageThumbnailCache: () => invoke<void>("clear_stage_thumb_cache"),
    openClipboardImageDirectory: () => invoke<void>("open_clip_image_dir"),
    clearClipboardImageCache: () => invoke<void>("clear_clip_image_cache"),
  };
}

const invokeCache: CacheInvoke = async <T>(command: string) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command);
};

export const cacheApi = createCacheApi(invokeCache);
