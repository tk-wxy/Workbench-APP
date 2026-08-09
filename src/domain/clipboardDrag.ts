export const CLIPBOARD_DRAG_THRESHOLD_PX = 8;

export type Point = { x: number; y: number };
export type RectBounds = { left: number; top: number; right: number; bottom: number };

export function shouldActivateClipboardDrag(origin: Point, current: Point, threshold = CLIPBOARD_DRAG_THRESHOLD_PX) {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= threshold;
}

export function pointInRect(point: Point, rect: RectBounds | null | undefined) {
  return !!rect
    && point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

export type WorkbenchFileDropZone = "stage" | "launcher" | null;

export function resolveWorkbenchFileDropZone(
  point: Point,
  stageRect: RectBounds | null | undefined,
  launcherRect: RectBounds | null | undefined,
): WorkbenchFileDropZone {
  if (pointInRect(point, launcherRect)) return "launcher";
  if (pointInRect(point, stageRect)) return "stage";
  return null;
}
