export interface PointerPosition {
  x: number;
  y: number;
}

export const INITIAL_POINTER_POSITION: PointerPosition = { x: -1, y: -1 };

// Browser mouseenter events caused by list scrolling reuse the stationary pointer coordinates.
export function pointerPositionChanged(previous: PointerPosition, current: PointerPosition): boolean {
  return previous.x !== current.x || previous.y !== current.y;
}
