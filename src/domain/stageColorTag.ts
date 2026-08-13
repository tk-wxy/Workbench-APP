import type { StageItem } from "../types";

export const STAGE_COLOR_TAGS = ["red", "yellow", "blue"] as const;

export type StageColorTag = (typeof STAGE_COLOR_TAGS)[number];

export function isStageColorTag(value: unknown): value is StageColorTag {
  return typeof value === "string" && (STAGE_COLOR_TAGS as readonly string[]).includes(value);
}

// pinned 是旧版单项保留开关。新颜色标记只表达用户分类，不再携带保留语义；
// 载入与落盘都经此函数，避免旧字段继续形成看不见的行为。
export function normalizeStageItemAppearance(item: StageItem): StageItem {
  const legacy = item as StageItem & { pinned?: unknown; colorTag?: unknown };
  const { pinned: _legacyPinned, colorTag, ...rest } = legacy;
  return isStageColorTag(colorTag) ? { ...rest, colorTag } : rest;
}

export function setStageItemsColorTag(
  items: readonly StageItem[],
  ids: readonly number[],
  colorTag: StageColorTag | null,
): StageItem[] {
  const targetIds = new Set(ids);
  return items.map(item => {
    if (!targetIds.has(item.id)) return item;
    if (colorTag) return item.colorTag === colorTag ? item : { ...item, colorTag };
    if (!item.colorTag) return item;
    const { colorTag: _removed, ...rest } = item;
    return rest;
  });
}
