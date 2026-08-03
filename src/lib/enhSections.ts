// 增强搜索 Tier2（文件结果）的分组（续114b）。纯函数、不依赖 React —— 从 App.tsx 抽出的两个理由：
// ① 这里是分段逻辑里唯一「坏法不自明」的部分（runt 合并 + 名次序）；
// ② 纯函数才能脱离 GUI 真跑验证（在「不用合成输入驱动 GUI」的铁律下，这点很宝贵）。
import { fileGroup, type FileGroup } from "./format";

export type FileLike = { path: string; ext: string; isDir: boolean };

/**
 * 按来源/类别把一份已经排好名次的结果切成段。
 * 段序由该段第一次出现的名次决定，段内也保持原顺序；因此输入第 1 名
 * 永远仍是输出第 1 名，同时 Ctrl+↑↓ 能获得真实的多个段首。
 */
export function groupRanked<T, K extends string>(
  items: T[],
  groupOf: (item: T) => K,
): { group: K; items: T[] }[] {
  const groups = new Map<K, { rank: number; items: T[] }>();
  items.forEach((item, rank) => {
    const group = groupOf(item);
    const existing = groups.get(group);
    if (existing) existing.items.push(item);
    else groups.set(group, { rank, items: [item] });
  });
  return [...groups]
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([group, value]) => ({ group, items: value.items }));
}

/**
 * 把文件结果折叠成按大类划分的段落。
 *
 * 不变量（已被测试钉死，破坏它 Enter 就会坏）：
 * - **顺序由输入的名次决定**。`files` 是 Rust 侧已按分数排好的，下标即名次。
 *   段序 =「该段内的最小名次」。因此含最优匹配的段恒在最前 →
 *   派生出的扁平数组 [0] 与分段前一致，Enter 的行为不变。
 * - 数量不足 `minSection` 的组并入 "other"（兜底桶），并入后仍保持名次序。
 *   "other" 自身不受该阈值约束。
 * - 输入输出元素数量不变（不丢不重）。
 *
 * ⚠ 不得依赖 Map 的插入序：合并时后 set 的 "other" 会落到末尾，
 *   若最优匹配正好在 "other" 里，顺序就乱了。必须按名次显式排序。
 */
export function groupFiles<F extends FileLike>(
  files: F[],
  minSection: number,
): { group: FileGroup; items: F[] }[] {
  const rank = new Map<string, number>();
  const groups = new Map<FileGroup, F[]>();
  files.forEach((f, i) => {
    rank.set(f.path, i);
    const g = fileGroup(f.ext, f.isDir);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  });

  // 把数量不足阈值的组回收进 "other"
  const runt: F[] = [];
  for (const [g, items] of [...groups]) {
    if (g !== "other" && items.length < minSection) { runt.push(...items); groups.delete(g); }
  }
  if (runt.length) {
    const merged = [...(groups.get("other") ?? []), ...runt];
    merged.sort((a, b) => (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0));
    groups.set("other", merged);
  }

  return [...groups]
    .map(([group, items]) => ({
      group, items,
      rank: Math.min(...items.map(f => rank.get(f.path) ?? Number.MAX_SAFE_INTEGER)),
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ group, items }) => ({ group, items }));
}
