// 拼音匹配（增强搜索 Tier1，续131）。派生在 Rust（见 src-tauri/src/pinyin_util.rs），
// 这里只负责「拿派生好的 ASCII 串做匹配 + 把命中位置映射回原名」。
//
// 设计要点：
// ① **复用 fuzzyScore 打分，不另起一套尺子**。Tier1 是 `b.score - a.score` 混排，
//    拼音命中若用别的算式，分数与直接命中不可比，排序就没有意义了。
// ② 命中区间必须映射回**原名**的下标——高亮画在名字上，不是画在 `weixin` 上。
//    映射表由 Rust 一并给出（UTF-16 下标，与 JS 字符串下标一致）。
// ③ 只有含汉字的名字才有派生结果，纯英文名 variants 为空 → 直接短路。

import { fuzzyScore, type MatchResult } from "./fuzzy";

/** 与 Rust PinyinVariant 一一对应（serde camelCase） */
export interface PinyinVariant {
  full: string;      // 全拼，如 weixin
  initials: string;  // 首字母，如 wx
  map: number[];     // full[i] ← 原名的第 map[i] 个 UTF-16 单位
  imap: number[];    // initials[i] ← 原名的第 imap[i] 个 UTF-16 单位
}

/** 原名 → 其全部拼音变体。空数组 = 该名无汉字（已查过、确实没有），与"没查过"区分开 */
export type PinyinTable = Record<string, PinyinVariant[]>;

/// 拼音命中的折价系数。
/// 为什么要折价：同一个查询既直接命中名字、又拼音命中时，**直接命中才是用户更可能想要的**
/// （搜 "wps" 命中 WPS 本身，而不是某个拼音里凑出 w-p-s 的中文名）。
/// 取 0.9 而不是更低：拼音命中在中文环境里是正经命中，不该被压到聊胜于无——
/// 这与 App.tsx 里 path basename 用 0.6 重度降权是两种性质（那个是弱信号兜底）。
export const PINYIN_SCORE_FACTOR = 0.9;

/** 查询是否走拼音路径：只有纯 ASCII 字母数字查询才有意义（已含汉字时直接匹配就够了） */
export function isPinyinQuery(q: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(q);
}

/** 把派生串上的命中区间映射回原名的区间（合并相邻、去重） */
function remapRanges(ranges: [number, number][], map: number[]): [number, number][] {
  const hit = new Set<number>();
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) {
      const m = map[i];
      // 命中拼音里的**任何一个字母**，就整体高亮它所属的那个汉字——
      // 汉字没法只高亮半个，而"wei"命中就把「微」标出来正是用户期望的反馈。
      if (m !== undefined) hit.add(m);
    }
  }
  const sorted = [...hit].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

/**
 * 对一个名字做拼音匹配，返回**已折价**的分数与映射回原名的高亮区间。
 * 未命中（或该名无拼音派生）时 score 为 0，调用方按原有的 `score > 0` 过滤即可。
 *
 * 全拼与首字母都试、取分高者：用户可能打 "weixin" 也可能打 "wx"，
 * 两者在同一个变体里是两个独立的串，谁命中得更好用谁。
 */
export function pinyinScore(query: string, variants: PinyinVariant[] | undefined): MatchResult {
  if (!variants || variants.length === 0) return { score: 0, ranges: [] };
  let best: MatchResult = { score: 0, ranges: [] };
  for (const v of variants) {
    for (const [text, map] of [[v.full, v.map], [v.initials, v.imap]] as const) {
      if (!text) continue;
      const r = fuzzyScore(query, text);
      if (r.score > best.score) best = { score: r.score, ranges: remapRanges(r.ranges, map) };
    }
  }
  return { score: Math.round(best.score * PINYIN_SCORE_FACTOR), ranges: best.ranges };
}

/**
 * 名字匹配的统一入口：先直接匹配，未命中或分更低时再看拼音。
 * Tier1 的三类条目（应用/中转/剪贴板）都走它，保证三处口径一致。
 */
export function matchName(query: string, name: string, table: PinyinTable): MatchResult {
  const direct = fuzzyScore(query, name);
  if (!isPinyinQuery(query)) return direct;
  const py = pinyinScore(query, table[name]);
  return py.score > direct.score ? py : direct;
}
