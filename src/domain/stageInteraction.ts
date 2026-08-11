export const LASSO_THRESHOLD_PX = 6;
export const STAGE_DRAG_THRESHOLD_PX = 12;
export const STAGE_MOAT_PX = 6;

export type StageInteractionMode = "idle" | "reorder" | "native" | "lasso";
export type StageInteractionState = {
  pressing: boolean;
  itemId: number | null;
  origin: { x: number; y: number };
  draggedIds: number[];
  mode: StageInteractionMode;
};

export type RectBounds = { left: number; top: number; right: number; bottom: number };
export type LassoRect = RectBounds & { id: number };
export type StageInsertAnchor = { beforeId: number } | { afterId: number } | { at: "start" };
export type StageInsertMarker = { left: number; top: number; width: number; height: number; orientation: "vertical" | "horizontal" };

export function clampPointToRect(point: { x: number; y: number }, rect: RectBounds) {
  return {
    x: Math.min(rect.right, Math.max(rect.left, point.x)),
    y: Math.min(rect.bottom, Math.max(rect.top, point.y)),
  };
}

export function resolveStageInsertSlot(
  point: { x: number; y: number },
  rects: readonly LassoRect[],
  layout: "list" | "grid",
) {
  if (layout === "list") {
    const index = rects.findIndex(rect => point.y < (rect.top + rect.bottom) / 2);
    return index < 0 ? rects.length : index;
  }
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (point.y < rect.top || (point.y <= rect.bottom && point.x < (rect.left + rect.right) / 2)) return index;
  }
  return rects.length;
}

export function stageInsertAnchorForSlot(slot: number, rects: readonly LassoRect[]): StageInsertAnchor {
  if (!rects.length) return { at: "start" };
  const index = Math.max(0, Math.min(slot, rects.length));
  return index < rects.length ? { beforeId: rects[index].id } : { afterId: rects[rects.length - 1].id };
}

export function stageInsertMarkerForSlot(
  slot: number,
  rects: readonly LassoRect[],
  layout: "list" | "grid",
): StageInsertMarker | null {
  if (!rects.length) return null;
  const index = Math.max(0, Math.min(slot, rects.length));
  if (layout === "list") {
    const current = rects[index];
    const previous = rects[index - 1];
    const reference = current ?? previous;
    if (!reference) return null;
    const y = current && previous ? (previous.bottom + current.top) / 2 : current ? current.top : previous.bottom;
    return { left: reference.left + 10, top: y - 7, width: Math.max(18, reference.right - reference.left - 20), height: 14, orientation: "horizontal" };
  }
  const current = rects[index];
  const previous = rects[index - 1];
  const reference = current ?? previous;
  if (!reference) return null;
  const sameRow = !!current && !!previous && Math.abs(current.top - previous.top) < Math.max(current.bottom - current.top, previous.bottom - previous.top) / 2;
  const x = current ? (sameRow ? (previous!.right + current.left) / 2 : current.left - 3) : previous!.right + 3;
  const y = reference.top + (reference.bottom - reference.top) / 2;
  return { left: x - 7, top: y - 16, width: 14, height: 32, orientation: "vertical" };
}

export function insertStageItemsAtAnchor<T extends { id: number }>(
  current: readonly T[],
  items: readonly T[],
  anchor: StageInsertAnchor = { at: "start" },
  maxItems = Number.POSITIVE_INFINITY,
) {
  const inserted = items.slice(0, Math.max(0, maxItems));
  if (!inserted.length) return [...current].slice(0, Math.max(0, maxItems));
  const next = [...current];
  let index = 0;
  if ("beforeId" in anchor) {
    const found = next.findIndex(candidate => candidate.id === anchor.beforeId);
    index = found < 0 ? 0 : found;
  } else if ("afterId" in anchor) {
    const found = next.findIndex(candidate => candidate.id === anchor.afterId);
    index = found < 0 ? next.length : found + 1;
  }
  next.splice(index, 0, ...inserted);
  const insertedIds = new Set(inserted.map(item => item.id));
  while (next.length > maxItems) {
    let removable = -1;
    for (let candidateIndex = next.length - 1; candidateIndex >= 0; candidateIndex--) {
      if (!insertedIds.has(next[candidateIndex].id)) {
        removable = candidateIndex;
        break;
      }
    }
    if (removable < 0) break;
    next.splice(removable, 1);
  }
  return next;
}

export function insertStageItemAtAnchor<T extends { id: number }>(
  current: readonly T[],
  item: T,
  anchor: StageInsertAnchor = { at: "start" },
  maxItems = Number.POSITIVE_INFINITY,
) {
  return insertStageItemsAtAnchor(current, [item], anchor, maxItems);
}

export function createIdleStageInteraction(): StageInteractionState {
  return { pressing: false, itemId: null, origin: { x: 0, y: 0 }, draggedIds: [], mode: "idle" };
}

export function beginStageInteraction(itemId: number, origin: { x: number; y: number }): StageInteractionState {
  return { pressing: true, itemId, origin, draggedIds: [], mode: "idle" };
}

export function finishStageInteraction(state: StageInteractionState): StageInteractionState {
  return { ...state, pressing: false, mode: "idle" };
}

// 终止事件可能因 releasePointerCapture → lostpointercapture 同步重入。
// 先把共享 ref 置为 idle，再让调用方执行提交/取消；重入者因此只能拿到 idle 快照，
// 不会与第一个终止路径重复清理同一轮拖动。
export function claimStageInteractionCompletion(ref: { current: StageInteractionState }): StageInteractionState {
  const interaction = ref.current;
  ref.current = finishStageInteraction(interaction);
  return interaction;
}

export function resolveCardDragIntent(input: {
  multiselect: boolean;
  selectedIds: ReadonlySet<number>;
  itemId: number;
  origin: { x: number; y: number };
  itemRect: RectBounds;
}) {
  const lasso = input.multiselect
    ? !input.selectedIds.has(input.itemId)
    : input.origin.x - input.itemRect.left < STAGE_MOAT_PX
      || input.itemRect.right - input.origin.x < STAGE_MOAT_PX
      || input.origin.y - input.itemRect.top < STAGE_MOAT_PX
      || input.itemRect.bottom - input.origin.y < STAGE_MOAT_PX;
  return { lasso, threshold: lasso ? LASSO_THRESHOLD_PX : STAGE_DRAG_THRESHOLD_PX };
}

export function hasReachedStageThreshold(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  threshold: number,
) {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= threshold;
}

export function resolveStageDragRoute(input: {
  itemId: number;
  selectedIds: ReadonlySet<number>;
  missingIds: ReadonlySet<number>;
  autoClose: boolean;
  searchActive: boolean;
}): { kind: "cancel" | "native" | "reorder"; ids: number[] } {
  const candidates = input.selectedIds.size > 0 && input.selectedIds.has(input.itemId)
    ? Array.from(input.selectedIds)
    : [input.itemId];
  const ids = candidates.filter(id => !input.missingIds.has(id));
  if (!ids.length) return { kind: "cancel", ids };
  if (input.autoClose || ids.length > 1 || input.searchActive || ids[0] !== input.itemId) {
    return { kind: "native", ids };
  }
  return { kind: "reorder", ids };
}

export function selectLassoIds(origin: { x: number; y: number }, current: { x: number; y: number }, rects: readonly LassoRect[]) {
  const left = Math.min(origin.x, current.x);
  const right = Math.max(origin.x, current.x);
  const top = Math.min(origin.y, current.y);
  const bottom = Math.max(origin.y, current.y);
  return new Set(rects
    .filter(rect => rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top)
    .map(rect => rect.id));
}

export function sameIdSet(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  return left.size === right.size && [...right].every(id => left.has(id));
}

export function resolveStageRelease(input: {
  mode: StageInteractionMode;
  overLauncher: boolean;
  itemType?: "text" | "image" | "file";
  hasFilePath?: boolean;
}) {
  if (input.mode === "lasso") return "finish-lasso" as const;
  if (input.mode !== "reorder") return "none" as const;
  if (!input.overLauncher) return "commit-reorder" as const;
  if (input.itemType === "image" || (input.itemType === "file" && input.hasFilePath)) return "drop-launcher" as const;
  return "reject-launcher" as const;
}
