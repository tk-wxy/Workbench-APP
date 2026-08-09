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

export function createIdleStageInteraction(): StageInteractionState {
  return { pressing: false, itemId: null, origin: { x: 0, y: 0 }, draggedIds: [], mode: "idle" };
}

export function beginStageInteraction(itemId: number, origin: { x: number; y: number }): StageInteractionState {
  return { pressing: true, itemId, origin, draggedIds: [], mode: "idle" };
}

export function finishStageInteraction(state: StageInteractionState): StageInteractionState {
  return { ...state, pressing: false, mode: "idle" };
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

