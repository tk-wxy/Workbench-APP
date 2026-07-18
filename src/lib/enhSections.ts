// 増強検索 Tier2（ファイル結果）のグルーピング（続114b）。純関数・React 非依存 —— App.tsx から
// 切り出した理由は二つ：① ここが分段ロジックで唯一「壊れ方が自明でない」部分（runt 併合 + 名次順）、
// ② 純関数なら GUI なしで実際に走らせて検証できる（合成入力で GUI を駆動しない鉄則の下では貴重）。
import { fileGroup, type FileGroup } from "./format";

export type FileLike = { path: string; ext: string; isDir: boolean };

/**
 * ファイル結果を大分類ごとのセクションへ畳む。
 *
 * 不変条件（テストで固定済み・崩すと Enter が壊れる）：
 * - **順序は入力の名次で決まる**。`files` は Rust 側が既にスコア順に並べたもので、下標＝名次。
 *   セクション順＝「そのセクション内の最小名次」。よって最良マッチを含むセクションが常に先頭 →
 *   派生する平坦配列の [0] は分段前と一致し、Enter の挙動が変わらない。
 * - `minSection` 未満のグループは "other"（保底バケツ）へ併合する。併合後も名次順を保つ。
 *   "other" 自身はこの閾値の対象外。
 * - 入出力で要素の増減なし（取りこぼし・重複なし）。
 *
 * ⚠ Map の挿入順に依存してはいけない：併合で "other" を後から set すると末尾に付くため、
 *   最良マッチが "other" にあると順序が狂う。必ず名次で明示ソートすること。
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

  // 閾値未満のグループを "other" へ回収
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
