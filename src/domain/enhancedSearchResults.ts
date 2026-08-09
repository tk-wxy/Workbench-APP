import { appUsageScore } from "./appUsage";
import { groupFiles, groupRanked } from "../lib/enhSections";
import { fileGroup, type FileGroup } from "../lib/format";
import { typeKeywords } from "../lib/fuzzy";
import { matchName, type PinyinTable } from "../lib/pinyin";
import type {
  AppInfo,
  AppUsage,
  BuiltinSearchHit,
  ClipItem,
  EnhResult,
  StageItem,
} from "../types";

export type SearchTranslate = (key: string, vars?: Record<string, string | number>) => string;

export interface EnhancedFileSearchResult {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  iconKey: string;
  icon?: string | null;
}

export interface EnhancedSearchSection {
  key: string;
  label: string;
  items: EnhResult[];
}

export interface EnhancedSearchResultModel {
  sections: EnhancedSearchSection[];
  results: EnhResult[];
  sectionStarts: number[];
  headingByIndex: Map<number, string>;
}

export interface BuildEnhancedSearchResultModelOptions {
  engine: "builtin" | "everything";
  query: string;
  apps: AppInfo[];
  sortedApps: AppInfo[];
  stage: StageItem[];
  clipboard: ClipItem[];
  appUsage: Record<string, AppUsage>;
  pinyin: PinyinTable;
  builtinHits: BuiltinSearchHit[];
  fileResults: EnhancedFileSearchResult[];
  nowSeconds: number;
  everythingFileLimit: number;
  minFileSection: number;
  t: SearchTranslate;
}

export const enhancedStageName = (item: StageItem, t: SearchTranslate) =>
  item.name || item.items?.[0]?.name || t("文件");

export const enhancedClipboardName = (item: ClipItem, t: SearchTranslate) =>
  item.type === "text" ? (item.content || "").trim().slice(0, 80)
  : item.type === "image" ? t("图片")
  : (item.count !== 1 ? t("{n} 个文件", { n: item.count ?? 0 }) : (item.items?.[0]?.name || t("文件")));

function buildLegacyTier1(input: BuildEnhancedSearchResultModelOptions): EnhResult[] {
  const query = input.query.trim();
  if (!query) {
    return input.sortedApps.slice(0, 30).map(app => ({
      kind: "app",
      app,
      ranges: [],
    }));
  }

  const appHits = input.apps
    .map(app => {
      const match = matchName(query, app.name, input.pinyin);
      return { kind: "app" as const, app, score: match.score, ranges: match.ranges };
    })
    .filter(result => result.score > 0);
  const stageHits = input.stage
    .filter(item => item.type === "file")
    .map(item => {
      const name = enhancedStageName(item, input.t);
      const match = matchName(query, name, input.pinyin);
      return { kind: "stage" as const, item, name, score: match.score, ranges: match.ranges };
    })
    .filter(result => result.score > 0);

  const loweredQuery = query.toLowerCase();
  const clipHits = input.clipboard
    .map(item => {
      const name = enhancedClipboardName(item, input.t);
      const match = matchName(query, name, input.pinyin);
      const typeMatch = match.score === 0 && typeKeywords({
        type: item.type,
        ext: item.items?.[0]?.ext,
        isImage: item.items?.[0]?.isImage,
      }).some(keyword => keyword.toLowerCase().includes(loweredQuery));
      return {
        kind: "clip" as const,
        item,
        name,
        score: typeMatch ? 5 : match.score,
        ranges: typeMatch ? [] : match.ranges,
      };
    })
    .filter(result => result.score > 0);

  return [...appHits, ...stageHits, ...clipHits]
    .sort((a, b) => b.score - a.score || (
      a.kind === "app" && b.kind === "app"
        ? appUsageScore(input.appUsage[b.app.path], input.nowSeconds)
          - appUsageScore(input.appUsage[a.app.path], input.nowSeconds)
        : 0
    ))
    .slice(0, 10)
    .map(({ score: _score, ...result }) => result as EnhResult);
}

function projectBuiltinResults(input: BuildEnhancedSearchResultModelOptions): EnhResult[] {
  const appByKey = new Map(input.apps.map(app => [app.path, app]));
  const stageByKey = new Map(input.stage.map(item => [String(item.id), item]));
  const clipByKey = new Map(input.clipboard.map(item => [String(item.time), item]));
  const results: EnhResult[] = [];

  for (const hit of input.builtinHits) {
    if (hit.kind === "fs") {
      results.push({
        kind: "fs",
        path: hit.path,
        name: hit.name,
        ext: hit.ext,
        isDir: hit.isDir,
        icon: hit.icon,
        iconKey: hit.iconKey,
      });
      continue;
    }
    if (hit.kind === "app") {
      const app = appByKey.get(hit.key);
      if (app) results.push({ kind: "app", app, ranges: matchName(input.query, app.name, input.pinyin).ranges });
      continue;
    }
    if (hit.kind === "stage") {
      const item = stageByKey.get(hit.key);
      if (!item) continue;
      const name = enhancedStageName(item, input.t);
      results.push({ kind: "stage", item, name, ranges: matchName(input.query, name, input.pinyin).ranges });
      continue;
    }
    const item = clipByKey.get(hit.key);
    if (!item) continue;
    const name = enhancedClipboardName(item, input.t);
    results.push({ kind: "clip", item, name, ranges: matchName(input.query, name, input.pinyin).ranges });
  }
  return results;
}

function builtinSections(input: BuildEnhancedSearchResultModelOptions): EnhancedSearchSection[] {
  const labels: Record<string, string> = {
    "t1-app": input.t("应用程序"),
    "t1-stage": input.t("中转站"),
    "t1-clip": input.t("剪贴板"),
    "fs-folder": input.t("文件夹"),
    "fs-image": input.t("图片"),
    "fs-archive": input.t("压缩包"),
    "fs-doc": input.t("文档"),
    "fs-code": input.t("代码"),
    "fs-media": input.t("媒体"),
    "fs-exe": input.t("可执行文件"),
    "fs-other": input.t("其他文件"),
  };
  return groupRanked(
    projectBuiltinResults(input),
    result => result.kind === "fs" ? `fs-${fileGroup(result.ext, result.isDir)}` : `t1-${result.kind}`,
  ).map(({ group, items }) => ({
    key: `builtin-${group}`,
    label: labels[group] ?? input.t("最佳匹配"),
    items,
  }));
}

function legacySections(input: BuildEnhancedSearchResultModelOptions): EnhancedSearchSection[] {
  const sections: EnhancedSearchSection[] = [];
  const tier1Labels: Record<string, string> = {
    app: input.t("应用程序"),
    stage: input.t("中转站"),
    clip: input.t("剪贴板"),
  };
  const tier1Groups = new Map<string, EnhResult[]>();
  for (const result of buildLegacyTier1(input)) {
    if (!tier1Groups.has(result.kind)) tier1Groups.set(result.kind, []);
    tier1Groups.get(result.kind)!.push(result);
  }
  for (const [group, items] of tier1Groups) {
    sections.push({ key: `t1-${group}`, label: tier1Labels[group] ?? group, items });
  }

  const fileLabels: Record<FileGroup, string> = {
    folder: input.t("文件夹"),
    image: input.t("图片"),
    archive: input.t("压缩包"),
    doc: input.t("文档"),
    code: input.t("代码"),
    media: input.t("媒体"),
    exe: input.t("可执行文件"),
    other: input.t("其他文件"),
  };
  const files = input.fileResults.slice(0, input.everythingFileLimit);
  for (const { group, items } of groupFiles(files, input.minFileSection)) {
    sections.push({
      key: `fs-${group}`,
      label: fileLabels[group],
      items: items.map(file => ({
        kind: "fs",
        path: file.path,
        name: file.name,
        ext: file.ext,
        isDir: file.isDir,
        icon: file.icon,
        iconKey: file.iconKey,
      })),
    });
  }
  return sections;
}

function deriveLayout(sections: EnhancedSearchSection[]): EnhancedSearchResultModel {
  const results: EnhResult[] = [];
  const sectionStarts: number[] = [];
  const headingByIndex = new Map<number, string>();
  for (const section of sections) {
    const start = results.length;
    sectionStarts.push(start);
    headingByIndex.set(start, `${section.label} (${section.items.length})`);
    results.push(...section.items);
  }
  return { sections, results, sectionStarts, headingByIndex };
}

/**
 * Builds the one authoritative result model consumed by rendering, preview, Enter and
 * Ctrl+Arrow navigation. Built-in non-empty queries preserve Rust's cross-source ranking;
 * Everything keeps the legacy local Tier1 plus externally ranked file sections.
 */
export function buildEnhancedSearchResultModel(
  input: BuildEnhancedSearchResultModelOptions,
): EnhancedSearchResultModel {
  const useBuiltinRanking = input.engine === "builtin" && !!input.query.trim();
  return deriveLayout(useBuiltinRanking ? builtinSections(input) : legacySections(input));
}
