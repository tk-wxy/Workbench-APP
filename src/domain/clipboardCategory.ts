import type { ClipItem } from "../types";

// `image` 是当前剪贴板协议中截图与其他图片的统一类型；分类只约束视图，不改变历史数据或 Rust IPC。
export type ClipboardCategory = "all" | ClipItem["type"];

export function matchesClipboardCategory(item: ClipItem, category: ClipboardCategory): boolean {
  return category === "all" || item.type === category;
}
