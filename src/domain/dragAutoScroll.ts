import type { RectBounds } from "./stageInteraction";

export const DRAG_AUTOSCROLL_EDGE_PX = 48;
export const DRAG_AUTOSCROLL_MAX_PX_PER_SECOND = 900;

export function resolveDragAutoScrollVelocity(pointerY: number, bounds: RectBounds): number {
  if (pointerY < bounds.top + DRAG_AUTOSCROLL_EDGE_PX) {
    const ratio = Math.min(1, Math.max(0, (bounds.top + DRAG_AUTOSCROLL_EDGE_PX - pointerY) / DRAG_AUTOSCROLL_EDGE_PX));
    return -DRAG_AUTOSCROLL_MAX_PX_PER_SECOND * ratio;
  }
  if (pointerY > bounds.bottom - DRAG_AUTOSCROLL_EDGE_PX) {
    const ratio = Math.min(1, Math.max(0, (pointerY - (bounds.bottom - DRAG_AUTOSCROLL_EDGE_PX)) / DRAG_AUTOSCROLL_EDGE_PX));
    return DRAG_AUTOSCROLL_MAX_PX_PER_SECOND * ratio;
  }
  return 0;
}
