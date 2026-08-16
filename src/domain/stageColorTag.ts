import type { StageItem } from "../types";

export const STAGE_COLOR_TAGS = ["red", "yellow", "blue", "green", "purple"] as const;

export type StageColorTag = (typeof STAGE_COLOR_TAGS)[number];

export function isStageColorTag(value: unknown): value is StageColorTag {
  return typeof value === "string" && (STAGE_COLOR_TAGS as readonly string[]).includes(value);
}

// 颜色、单项保留与“新增后尚未使用”是三个独立维度；落盘时只保留合法颜色、
// pinned=true 与 unused=true，避免未知值或冗余 false 污染 store。
export function normalizeStageItemAppearance(item: StageItem): StageItem {
  const raw = item as StageItem & { pinned?: unknown; colorTag?: unknown; unused?: unknown };
  const { pinned, colorTag, unused, ...rest } = raw;
  const normalized = isStageColorTag(colorTag) ? { ...rest, colorTag } : rest;
  const withPin = pinned === true ? { ...normalized, pinned: true } : normalized;
  return unused === true ? { ...withPin, unused: true } : withPin;
}

export function filterStageItemsByColor(
  items: readonly StageItem[],
  colorTag: StageColorTag | null,
): StageItem[] {
  return colorTag ? items.filter(item => item.colorTag === colorTag) : [...items];
}

export function markStageItemsUsed(
  items: readonly StageItem[],
  ids: readonly number[],
): StageItem[] {
  const targetIds = new Set(ids);
  return items.map(item => {
    if (!targetIds.has(item.id) || item.unused !== true) return item;
    const { unused: _removed, ...rest } = item;
    return rest;
  });
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

export function resolveStageColorClick(
  selected: StageColorTag | null,
  mixed: boolean,
  clicked: StageColorTag,
): StageColorTag | null {
  return !mixed && selected === clicked ? null : clicked;
}

export function shouldRetainStageItem(item: Pick<StageItem, "pinned">, persistAll: boolean): boolean {
  return persistAll || item.pinned === true;
}
