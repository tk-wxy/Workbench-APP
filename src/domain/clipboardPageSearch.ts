import { typeKeywords } from "../lib/fuzzy";
import type { ClipItem } from "../types";
import { matchesClipboardCategory, type ClipboardCategory } from "./clipboardCategory";
import { matchPageSearch, type TextRange } from "./pageSearchPresentation";

export interface ClipboardPageSearchProjection {
  items: ClipItem[];
  highlights: Map<number, TextRange[]>;
}

/**
 * 分类与页面搜索在同一遍历中取交集：先用廉价类型判定排除条目，再只为候选生成搜索高亮。
 * 默认“全部 + 空查询”原样返回输入数组，避免空闲状态额外分配。
 */
export function buildClipboardPageSearch(
  clipboard: ClipItem[],
  query: string,
  category: ClipboardCategory,
): ClipboardPageSearchProjection {
  const normalizedQuery = query.trim();
  if (!normalizedQuery && category === "all") return { items: clipboard, highlights: new Map() };

  const items: ClipItem[] = [];
  const highlights = new Map<number, TextRange[]>();
  for (const item of clipboard) {
    if (!matchesClipboardCategory(item, category)) continue;
    if (!normalizedQuery) {
      items.push(item);
      continue;
    }
    const name = item.type === "text" ? (item.content || "") : item.type === "image" ? "图片" : (item.items?.[0]?.name || "文件");
    const match = matchPageSearch(
      normalizedQuery,
      name,
      typeKeywords({ type: item.type, ext: item.items?.[0]?.ext, isImage: item.items?.[0]?.isImage }),
    );
    if (!match.matches) continue;
    items.push(item);
    highlights.set(item.time, match.ranges);
  }
  return { items, highlights };
}
