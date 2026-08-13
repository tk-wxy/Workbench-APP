import { appUsageScore } from "./appUsage";
import { enhancedClipboardName, enhancedStageName, type SearchTranslate } from "./enhancedSearchResults";
import { typeKeywords } from "../lib/fuzzy";
import type { PinyinTable, PinyinVariant } from "../lib/pinyin";
import type { AppInfo, AppUsage, ClipItem, StageItem } from "../types";

const HAS_CJK = /[一-鿿]/;

export type SearchProjectionItem = {
  kind: "app" | "stage" | "clip";
  key: string;
  name: string;
  path: string;
  ext: string;
  isDir: boolean;
  boost: number;
  keywords: string[];
};

export function searchUsageBoost(usage: AppUsage | undefined, nowSeconds: number): number {
  const score = appUsageScore(usage, nowSeconds);
  return score < 0.25 ? 0 : score < 1 ? 100 : score < 2 ? 200 : score < 4 ? 300 : 400;
}

export function collectPinyinNames(
  apps: readonly AppInfo[],
  stage: readonly StageItem[],
  clipboard: readonly ClipItem[],
  t: SearchTranslate,
): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => { if (name && HAS_CJK.test(name)) names.add(name); };
  for (const app of apps) add(app.name);
  for (const item of stage) if (item.type === "file") add(enhancedStageName(item, t));
  for (const item of clipboard) add(enhancedClipboardName(item, t));
  return names;
}

export function prunePinyinTable(table: PinyinTable, keep: ReadonlySet<string>): PinyinTable {
  const keys = Object.keys(table);
  if (keys.length === keep.size && keys.every(key => keep.has(key))) return table;
  const next: PinyinTable = {};
  for (const key of keys) if (keep.has(key)) next[key] = table[key];
  return next;
}

export function mergePinyinBatch(
  table: PinyinTable,
  names: readonly string[],
  variants: readonly PinyinVariant[][],
): PinyinTable {
  const next = { ...table };
  names.forEach((name, index) => { next[name] = variants[index] ?? []; });
  return next;
}

export function buildSearchProjection(input: {
  apps: readonly AppInfo[];
  stage: readonly StageItem[];
  clipboard: readonly ClipItem[];
  appUsage: Readonly<Record<string, AppUsage>>;
  nowSeconds: number;
  t: SearchTranslate;
}): SearchProjectionItem[] {
  return [
    ...input.apps.map(app => ({
      kind: "app" as const,
      key: app.path,
      name: app.name,
      path: app.path,
      ext: "",
      isDir: false,
      boost: searchUsageBoost(input.appUsage[app.path], input.nowSeconds),
      keywords: ["应用", "app", "application"],
    })),
    ...input.stage.filter(item => item.type === "file").map(item => ({
      kind: "stage" as const,
      key: String(item.id),
      name: enhancedStageName(item, input.t),
      path: item.items?.[0]?.path ?? "",
      ext: item.ext ?? item.items?.[0]?.ext ?? "",
      isDir: !!item.isDir,
      boost: item.pinned ? 100 : 0,
      keywords: item.isDir
        ? ["文件夹", "folder", "dir"]
        : typeKeywords({ type: "file", ext: item.ext ?? item.items?.[0]?.ext, isImage: item.items?.[0]?.isImage }),
    })),
    ...input.clipboard.map(item => ({
      kind: "clip" as const,
      key: String(item.time),
      name: enhancedClipboardName(item, input.t),
      path: item.items?.[0]?.path ?? "",
      ext: item.items?.[0]?.ext ?? "",
      isDir: false,
      boost: 0,
      keywords: typeKeywords({ type: item.type, ext: item.items?.[0]?.ext, isImage: item.items?.[0]?.isImage }),
    })),
  ];
}
