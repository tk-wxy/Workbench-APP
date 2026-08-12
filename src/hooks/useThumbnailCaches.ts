import { useEffect, useRef, useState } from "react";
import { isThumbnailImageFile } from "../lib/format";
import type { ClipItem, LauncherItem, StageItem } from "../types";

const STAGE_IMAGE_THUMB_PREFIX = "simg:";

export const stageImageThumbKey = (contentFile: string) => STAGE_IMAGE_THUMB_PREFIX + contentFile;

export function collectStageThumbnailKeys(stage: StageItem[], launcher: LauncherItem[]): string[] {
  const stagePaths = stage
    .filter(item => item.type === "file" && item.items?.[0]?.isImage && item.items?.[0]?.path)
    .map(item => item.items![0].path);
  const launcherPaths = launcher
    .filter(item => item.kind === "file" && isThumbnailImageFile(item.ext, item.path))
    .map(item => item.path);
  const stageImageKeys = stage
    .filter(item => item.type === "image" && item.contentFile)
    .map(item => stageImageThumbKey(item.contentFile!));
  return [...new Set([...stagePaths, ...launcherPaths, ...stageImageKeys])];
}

export function collectClipThumbnailTimes(clipboard: ClipItem[]): number[] {
  return [...new Set(clipboard.filter(item => item.type === "image").map(item => item.time))];
}

export function pruneStringThumbnailCache(
  cache: Record<string, string>,
  live: ReadonlySet<string>,
): Record<string, string> {
  const stale = Object.keys(cache).filter(key => !live.has(key));
  if (!stale.length) return cache;
  const next = { ...cache };
  for (const key of stale) delete next[key];
  return next;
}

export function pruneNumberThumbnailCache(
  cache: Record<number, string>,
  live: ReadonlySet<number>,
): Record<number, string> {
  const stale = Object.keys(cache).map(Number).filter(key => !live.has(key));
  if (!stale.length) return cache;
  const next = { ...cache };
  for (const key of stale) delete next[key];
  return next;
}

// The queue is intentionally module-scoped: stage and clipboard thumbnails must share one
// concurrency budget across effect reruns. Separate queues would double the cold-decode peak.
const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbQueue: Array<() => void> = [];

function runThumbTask(task: () => Promise<void>) {
  const run = () => {
    thumbActive++;
    task().finally(() => {
      thumbActive--;
      const next = thumbQueue.shift();
      if (next) next();
    });
  };
  if (thumbActive < THUMB_CONCURRENCY) run(); else thumbQueue.push(run);
}

interface UseThumbnailCachesOptions {
  stage: StageItem[];
  launcher: LauncherItem[];
  clipboard: ClipItem[];
}

export function useThumbnailCaches({ stage, launcher, clipboard }: UseThumbnailCachesOptions) {
  const [stageThumbs, setStageThumbs] = useState<Record<string, string>>({});
  const stagePendingRef = useRef<Set<string>>(new Set());
  const [clipThumbs, setClipThumbs] = useState<Record<number, string>>({});
  const clipPendingRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const keys = collectStageThumbnailKeys(stage, launcher);
    for (const key of keys) {
      if (stagePendingRef.current.has(key)) continue;
      stagePendingRef.current.add(key);
      runThumbTask(async () => {
        // The item may have been removed while this cold decode was waiting in the queue.
        if (!stagePendingRef.current.has(key)) return;
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const url = key.startsWith(STAGE_IMAGE_THUMB_PREFIX)
            ? await invoke<string>("get_stage_image_thumb", { file: key.slice(STAGE_IMAGE_THUMB_PREFIX.length) })
            : await invoke<string>("get_stage_thumbnail", { path: key });
          setStageThumbs(previous => ({ ...previous, [key]: url }));
        } catch {
          // Keep the pending marker so a failed image falls back without retrying every render.
        }
      });
    }

    const live = new Set(keys);
    for (const key of stagePendingRef.current) {
      if (!live.has(key)) stagePendingRef.current.delete(key);
    }
    setStageThumbs(previous => pruneStringThumbnailCache(previous, live));
  }, [stage, launcher]);

  useEffect(() => {
    const times = collectClipThumbnailTimes(clipboard);
    for (const time of times) {
      if (clipPendingRef.current.has(time)) continue;
      clipPendingRef.current.add(time);
      runThumbTask(async () => {
        // The item may have been evicted while this cold decode was waiting in the queue.
        if (!clipPendingRef.current.has(time)) return;
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const url = await invoke<string>("get_clip_thumbnail", { time });
          setClipThumbs(previous => ({ ...previous, [time]: url }));
        } catch {
          // Clipboard image content is not hydrated in the list, so the placeholder remains.
        }
      });
    }

    const live = new Set(times);
    for (const time of clipPendingRef.current) {
      if (!live.has(time)) clipPendingRef.current.delete(time);
    }
    setClipThumbs(previous => pruneNumberThumbnailCache(previous, live));
  }, [clipboard]);

  return { stageThumbs, clipThumbs };
}
