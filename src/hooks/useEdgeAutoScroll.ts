import { useCallback, useEffect, useMemo, useRef } from "react";
import { resolveDragAutoScrollVelocity } from "../domain/dragAutoScroll";
import type { RectBounds } from "../domain/stageInteraction";

type AutoScrollRequest = {
  container: HTMLElement;
  bounds: RectBounds;
  pointerY: number;
  onScroll: (delta: number) => void;
};

export function useEdgeAutoScroll() {
  const requestRef = useRef<AutoScrollRequest | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    requestRef.current = null;
    lastFrameTimeRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const update = useCallback((request: AutoScrollRequest) => {
    requestRef.current = request;
    if (resolveDragAutoScrollVelocity(request.pointerY, request.bounds) === 0 || frameRef.current !== null) return;
    const tick = (timestamp: number) => {
      frameRef.current = null;
      const current = requestRef.current;
      if (!current) return;
      const velocity = resolveDragAutoScrollVelocity(current.pointerY, current.bounds);
      if (velocity === 0) {
        lastFrameTimeRef.current = null;
        return;
      }
      const previousTime = lastFrameTimeRef.current ?? timestamp - 16;
      lastFrameTimeRef.current = timestamp;
      const elapsedSeconds = Math.min(32, Math.max(1, timestamp - previousTime)) / 1000;
      const before = current.container.scrollTop;
      current.container.scrollTop = before + velocity * elapsedSeconds;
      const delta = current.container.scrollTop - before;
      if (delta === 0) {
        lastFrameTimeRef.current = null;
        return;
      }
      current.onScroll(delta);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => stop, [stop]);
  return useMemo(() => ({ update, stop }), [stop, update]);
}
