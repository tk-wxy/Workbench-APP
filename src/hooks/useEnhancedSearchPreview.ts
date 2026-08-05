import { useEffect, useMemo, useRef, useState } from "react";
import type { EnhancedSearchPreview } from "../components/EnhancedSearchLayer";
import { enhancedResultKey, enhancedResultPath } from "../domain/enhancedSearch";
import type { makeT } from "../i18n";
import {
  IMG_EXTS,
  ago,
  agoSec,
  catToGroup,
  dirOf,
  fileCategory,
  fmtDateTime,
  fmtSize,
  type FileCat,
  type FileGlyphArgs,
} from "../lib/format";
import { searchPreviewApi } from "../platform/searchPreviewApi";
import type { EnhResult, FileEntry } from "../types";

type TFn = ReturnType<typeof makeT>;
type PreviewMeta = { info: FileEntry | null; icon: string | null; thumb: string | null };

// Uncached preview requests are delayed so held arrow navigation does not issue IPC for every crossed row.
const PREVIEW_DEBOUNCE_MS = 130;
// 60 preview entries are about 2.6 MB at the measured large-icon mean; both maps use LRU eviction.
const PREVIEW_CACHE_MAX = 60;
const LARGE_ICON_CACHE_MAX = 100;

async function preloadImage(source: string | null): Promise<void> {
  if (!source) return;
  try {
    const image = new Image();
    image.src = source;
    if (image.decode) await image.decode();
  } catch {
    // Pre-decoding only smooths replacement; browser rendering remains the fallback.
  }
}

export interface EnhancedSearchPreviewOptions {
  open: boolean;
  results: EnhResult[];
  selectedIndex: number;
  stageThumbnails: Record<string, string>;
  clipboardThumbnails: Record<number, string>;
  t: TFn;
}

export function useEnhancedSearchPreview({
  open,
  results,
  selectedIndex,
  stageThumbnails,
  clipboardThumbnails,
  t,
}: EnhancedSearchPreviewOptions): EnhancedSearchPreview | null {
  const [previewMeta, setPreviewMeta] = useState<(PreviewMeta & { key: string }) | null>(null);
  const previewCacheRef = useRef(new Map<string, PreviewMeta>());
  const previewKeyRef = useRef("");
  // Rust owns icon identity: directories share one key, ordinary files share by extension, exe/lnk by path.
  const largeIconRef = useRef(new Map<string, string | null>());

  useEffect(() => {
    if (!open) {
      setPreviewMeta(null);
      // These maps hold the largest decoded images in this flow. Closing search must return them to baseline.
      previewCacheRef.current.clear();
      largeIconRef.current.clear();
      return;
    }

    const result = results[selectedIndex] ?? results[0];
    const key = result ? enhancedResultKey(result) : "";
    const path = result ? enhancedResultPath(result) : "";
    previewKeyRef.current = key;
    if (!result || !path) { setPreviewMeta(null); return; }

    const hit = previewCacheRef.current.get(key);
    if (hit) {
      // LRU mutation stays in the effect; render-time cache reads below remain pure.
      previewCacheRef.current.delete(key);
      previewCacheRef.current.set(key, hit);
      setPreviewMeta({ key, ...hit });
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const isImage = IMG_EXTS.includes((path.split(".").pop() ?? "").toLowerCase());
        const iconKey = result.kind === "fs" ? (result.iconKey ?? "") : "";
        const sharedIcon = iconKey ? largeIconRef.current.get(iconKey) : undefined;
        const [info, icon, thumbnail] = await Promise.all([
          searchPreviewApi.getFileInfo(path).catch(() => null),
          sharedIcon !== undefined
            ? Promise.resolve(sharedIcon)
            : searchPreviewApi.getLargeIcon(path).catch(() => null),
          isImage ? searchPreviewApi.getThumbnail(path).catch(() => null) : Promise.resolve(null),
        ]);

        if (iconKey && sharedIcon === undefined) {
          largeIconRef.current.set(iconKey, icon ?? null);
          while (largeIconRef.current.size > LARGE_ICON_CACHE_MAX) {
            const oldest = largeIconRef.current.keys().next().value;
            if (oldest === undefined) break;
            largeIconRef.current.delete(oldest);
          }
        }

        const entry: PreviewMeta = { info, icon: icon ?? null, thumb: thumbnail ?? null };
        previewCacheRef.current.set(key, entry);
        while (previewCacheRef.current.size > PREVIEW_CACHE_MAX) {
          const oldest = previewCacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          previewCacheRef.current.delete(oldest);
        }

        await Promise.all([preloadImage(entry.icon), preloadImage(entry.thumb)]);
        if (previewKeyRef.current === key) setPreviewMeta({ key, ...entry });
      } catch {
        // Partial preview failure must not affect search results or activation.
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, selectedIndex, results]);

  return useMemo<EnhancedSearchPreview | null>(() => {
    const result = results[selectedIndex] ?? results[0];
    if (!result) return null;
    const key = enhancedResultKey(result);
    // Cache hits must be available in the selection-change render, before the effect can mirror them to state.
    const meta = previewMeta?.key === key ? previewMeta : (previewCacheRef.current.get(key) ?? null);
    const info = meta?.info ?? null;
    const rows: EnhancedSearchPreview["rows"] = [];
    const stats: EnhancedSearchPreview["stats"] = [];
    let location: string | null = null;

    const pushRow = (label: string, value?: string | null, rtl?: boolean, title?: string) => {
      if (value) rows.push({ label, value, rtl, title });
    };
    const shortcutTargetRow = (path: string) => {
      if (!path.toLowerCase().endsWith(".lnk")) return;
      rows.push({
        label: t("目标"),
        value: !meta ? "…" : (info?.target || "—"),
        rtl: true,
        pending: !meta,
        title: info?.target || undefined,
      });
    };
    const addFileFacts = (path: string, isDir?: boolean, extHint?: string) => {
      location = dirOf(path);
      // Slot count depends only on synchronous item shape, preventing metadata arrival from changing geometry.
      const pending = !meta;
      const extension = (extHint || "").toLowerCase().replace(/^\./, "");
      const isImage = !isDir && IMG_EXTS.includes(extension);
      const modified = {
        label: t("修改"),
        value: pending ? "…" : (info?.modified ? agoSec(info.modified, t) : "—"),
        title: info?.modified ? fmtDateTime(info.modified) : undefined,
        pending,
      };
      const size = { label: t("大小"), value: pending ? "…" : (info ? fmtSize(info.size) : "—"), pending };

      if (isDir) {
        stats.push({
          label: t("项目数"),
          value: pending ? "…" : (info?.entries != null ? `${info.entries}${info.entriesCapped ? "+" : ""}` : "—"),
          pending,
        });
        stats.push(modified);
      } else if (isImage) {
        stats.push({
          label: t("尺寸"),
          value: pending ? "…" : (info?.width && info?.height ? `${info.width} × ${info.height}` : "—"),
          pending,
        });
        stats.push(size);
        rows.push(modified);
      } else {
        stats.push(size);
        stats.push(modified);
      }
      shortcutTargetRow(path);
    };

    const isPhoto = (extension?: string | null, isDir?: boolean) =>
      !isDir && IMG_EXTS.includes((extension ?? "").toLowerCase());

    let title = "";
    let badge = "";
    let big: string | null = null;
    let low: string | null = null;
    let glyph: FileGlyphArgs | null = null;
    let text: string | null = null;
    let photo = false;
    let category: FileCat = "generic";

    if (result.kind === "app") {
      title = result.app.name;
      badge = t("应用程序");
      glyph = { cat: "exe" };
      category = "exe";
      big = meta?.icon ?? result.app.icon ?? null;
      low = result.app.icon ?? null;
      location = dirOf(result.app.path);
      shortcutTargetRow(result.app.path);
    } else if (result.kind === "fs") {
      title = result.name;
      badge = result.isDir ? t("文件夹") : t("文件");
      category = result.isDir ? "folder" : fileCategory(result.ext ?? "");
      glyph = result.isDir ? { isDir: true } : { ext: result.ext };
      const sharedIcon = result.iconKey ? (largeIconRef.current.get(result.iconKey) ?? null) : null;
      big = meta?.thumb ?? meta?.icon ?? sharedIcon ?? result.icon ?? null;
      low = result.icon ?? null;
      photo = isPhoto(result.ext, result.isDir);
      addFileFacts(result.path, result.isDir, result.ext);
    } else if (result.kind === "stage") {
      const item = result.item;
      const path = item.items?.[0]?.path;
      if (item.type === "text") {
        title = (item.content || "").trim().slice(0, 60) || t("文本");
        badge = `${t("中转站")} · ${t("文本")}`;
        category = "text";
        glyph = { cat: "doc" };
        text = item.content ?? null;
        stats.push({ label: t("字数"), value: String((item.content || "").length) });
      } else if (item.type === "image") {
        title = t("图片");
        badge = `${t("中转站")} · ${t("图片")}`;
        category = "image";
        glyph = { isImage: true };
        big = (path && stageThumbnails[path]) || meta?.thumb || item.content || null;
        low = (path && stageThumbnails[path]) || item.content || null;
        photo = true;
      } else {
        title = result.name;
        badge = t("中转站");
        category = item.isDir ? "folder" : fileCategory(item.ext ?? "");
        glyph = item.isDir ? { isDir: true } : { ext: item.ext ?? "" };
        big = (path && stageThumbnails[path]) || meta?.thumb || meta?.icon || null;
        low = (path && stageThumbnails[path]) || null;
        photo = isPhoto(item.ext, item.isDir);
        if (path) addFileFacts(path, item.isDir, item.ext);
      }
      if (item.pinned) pushRow(t("状态"), t("已固定"));
    } else {
      const item = result.item;
      const path = item.items?.[0]?.path;
      if (item.type === "text") {
        title = (item.content || "").trim().slice(0, 60) || t("文本");
        badge = `${t("剪贴板")} · ${t("文本")}`;
        category = "text";
        glyph = { cat: "doc" };
        text = item.content ?? null;
        stats.push({ label: t("字数"), value: String((item.content || "").length) });
      } else if (item.type === "image") {
        title = t("图片");
        badge = `${t("剪贴板")} · ${t("图片")}`;
        category = "image";
        glyph = { isImage: true };
        big = clipboardThumbnails[item.time] ?? null;
        photo = true;
      } else {
        title = result.name;
        badge = t("剪贴板");
        category = fileCategory(item.items?.[0]?.ext ?? "");
        glyph = { ext: item.items?.[0]?.ext ?? "" };
        big = meta?.thumb ?? meta?.icon ?? null;
        photo = isPhoto(item.items?.[0]?.ext);
        if (path) addFileFacts(path, false, item.items?.[0]?.ext);
        if ((item.count ?? 1) > 1) pushRow(t("数量"), t("{n} 个文件", { n: item.count ?? 0 }));
      }
      pushRow(t("复制时间"), ago(item.time, t), false, fmtDateTime(Math.floor(item.time / 1000)));
    }

    const high = big && big !== low ? big : null;
    const locationText = location ?? (result.kind === "clip" ? t("剪贴板历史") : result.kind === "stage" ? t("中转站") : badge);
    return {
      r: result,
      title,
      badge,
      group: catToGroup(category),
      low,
      hi: high,
      photo,
      glyph,
      text,
      loc: location,
      locText: locationText,
      stats,
      rows,
      path: enhancedResultPath(result),
    };
  }, [results, selectedIndex, previewMeta, stageThumbnails, clipboardThumbnails, t]);
}
