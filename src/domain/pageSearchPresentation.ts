import { fuzzyScore } from "../lib/fuzzy";

export type TextRange = [number, number];

export interface PageSearchMatch {
  matches: boolean;
  ranges: TextRange[];
}

export interface SearchExcerpt {
  text: string;
  ranges: TextRange[];
}

export interface SearchExcerptOptions {
  prefixLength: number;
  contextLength: number;
  maxLength: number;
  maxWindows: number;
}

/** UI 只消费有限命中窗口；不得让全文重复次数决定保留的区间数量。 */
export const MAX_PAGE_SEARCH_RANGES = 12;

export const CLIPBOARD_SEARCH_EXCERPT: SearchExcerptOptions = {
  prefixLength: 20,
  contextLength: 16,
  maxLength: 96,
  maxWindows: 3,
};

export const STAGE_LIST_SEARCH_EXCERPT: SearchExcerptOptions = {
  prefixLength: 20,
  contextLength: 22,
  maxLength: 140,
  maxWindows: 3,
};

export const STAGE_GRID_SEARCH_EXCERPT: SearchExcerptOptions = {
  prefixLength: 0,
  contextLength: 12,
  maxLength: 42,
  maxWindows: 1,
};

function normalizeRanges(ranges: readonly TextRange[], length: number): TextRange[] {
  const sorted = ranges
    .slice(0, MAX_PAGE_SEARCH_RANGES)
    .map(([start, end]) => [Math.max(0, start), Math.min(length - 1, end)] as TextRange)
    .filter(([start, end]) => start <= end)
    .sort(([aStart, aEnd], [bStart, bEnd]) => aStart - bStart || aEnd - bEnd);
  const merged: TextRange[] = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function literalRanges(query: string, target: string, limit = MAX_PAGE_SEARCH_RANGES): TextRange[] {
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  if (!needle) return [];
  const ranges: TextRange[] = [];
  let from = 0;
  while (from < haystack.length && ranges.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    ranges.push([index, index + needle.length - 1]);
    from = index + needle.length;
  }
  return ranges;
}

/**
 * 页面搜索的筛选仍沿用现有 fuzzyScore + 类型词契约；本函数只额外产出可展示的命中区间。
 * 多词查询仅用于补充展示上的逐词高亮，不改变召回语义或排序。
 */
export function matchPageSearch(query: string, text: string, keywords: readonly string[]): PageSearchMatch {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { matches: true, ranges: [] };

  const fuzzy = fuzzyScore(normalizedQuery, text);
  if (fuzzy.score === 0) {
    return { matches: keywords.some(keyword => keyword.toLowerCase().includes(normalizedQuery.toLowerCase())), ranges: [] };
  }

  const fullPhrase = literalRanges(normalizedQuery, text);
  if (fullPhrase.length) return { matches: true, ranges: normalizeRanges(fullPhrase, text.length) };

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (terms.length > 1) {
    const representativeRanges: TextRange[] = [];
    let everyTermMatched = true;
    for (const term of terms) {
      const [firstRange] = literalRanges(term, text, 1);
      if (!firstRange) {
        everyTermMatched = false;
        break;
      }
      if (representativeRanges.length < MAX_PAGE_SEARCH_RANGES) representativeRanges.push(firstRange);
    }
    if (everyTermMatched) {
      return { matches: true, ranges: normalizeRanges(representativeRanges, text.length) };
    }
  }

  return { matches: true, ranges: normalizeRanges(fuzzy.ranges, text.length) };
}

function safeStart(text: string, index: number): number {
  if (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])) return index - 1;
  return index;
}

function safeEnd(text: string, index: number): number {
  if (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])) return index + 1;
  return index;
}

function makeWindows(text: string, ranges: readonly TextRange[], prefixLength: number, contextLength: number, maxWindows: number): [number, number][] {
  const windows: [number, number][] = [];
  if (prefixLength > 0) windows.push([0, safeEnd(text, Math.min(text.length, prefixLength))]);
  for (const [start, end] of ranges.slice(0, maxWindows)) {
    windows.push([
      safeStart(text, Math.max(0, start - contextLength)),
      safeEnd(text, Math.min(text.length, end + 1 + contextLength)),
    ]);
  }
  windows.sort(([a], [b]) => a - b);
  const merged: [number, number][] = [];
  for (const [start, end] of windows) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function renderedLength(windows: readonly [number, number][]): number {
  return windows.reduce((length, [start, end], index) => length + end - start + (index ? 1 : 0), 0);
}

/** Build a bounded beginning + hit-window excerpt while preserving original UTF-16 highlight coordinates. */
export function buildSearchExcerpt(text: string, sourceRanges: readonly TextRange[], options: SearchExcerptOptions): SearchExcerpt {
  if (!text) return { text: "", ranges: [] };
  const maxLength = Math.max(0, Math.floor(options.maxLength));
  if (maxLength === 0) return { text: "", ranges: [] };
  const prefixLength = Math.min(maxLength, Math.max(0, Math.floor(options.prefixLength)));
  const maxWindows = Math.min(MAX_PAGE_SEARCH_RANGES, Math.max(0, Math.floor(options.maxWindows)));
  const ranges = normalizeRanges(sourceRanges, text.length);
  if (!ranges.length) {
    if (text.length <= maxLength) return { text, ranges: [] };
    const end = safeStart(text, maxLength - 1);
    return { text: `${text.slice(0, end)}…`, ranges: [] };
  }

  // A single merged hit can span the whole source (for example 50k repeated chars).
  // Crop it before building windows so even intermediate strings stay bounded.
  const maxVisibleHitLength = Math.max(1, maxLength - 1);
  const visibleRanges = ranges.map(([start, end]) => [
    start,
    safeEnd(text, Math.min(end + 1, start + maxVisibleHitLength)) - 1,
  ] as TextRange);

  let contextLength = Math.min(maxLength, Math.max(0, Math.floor(options.contextLength)));
  let windows = makeWindows(text, visibleRanges, prefixLength, contextLength, maxWindows);
  while (contextLength > 0 && renderedLength(windows) > maxLength) {
    contextLength -= 1;
    windows = makeWindows(text, visibleRanges, prefixLength, contextLength, maxWindows);
  }

  let excerpt = "";
  const excerptRanges: TextRange[] = [];
  let previousEnd = 0;
  for (const [start, end] of windows) {
    if (start > previousEnd) excerpt += "…";
    const outputStart = excerpt.length;
    excerpt += text.slice(start, end);
    for (const [hitStart, hitEnd] of visibleRanges) {
      const visibleStart = Math.max(start, hitStart);
      const visibleEnd = Math.min(end - 1, hitEnd);
      if (visibleStart <= visibleEnd) excerptRanges.push([
        outputStart + visibleStart - start,
        outputStart + visibleEnd - start,
      ]);
    }
    previousEnd = end;
  }
  if (previousEnd < text.length) excerpt += "…";
  const normalizedExcerptRanges = normalizeRanges(excerptRanges, excerpt.length);
  if (excerpt.length <= maxLength) return { text: excerpt, ranges: normalizedExcerptRanges };

  const end = safeStart(excerpt, maxLength - 1);
  return {
    text: `${excerpt.slice(0, end)}…`,
    ranges: normalizeRanges(
      normalizedExcerptRanges.map(([start, rangeEnd]) => [start, Math.min(rangeEnd, end - 1)] as TextRange),
      end,
    ),
  };
}
