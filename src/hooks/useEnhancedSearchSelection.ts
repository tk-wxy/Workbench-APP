import { useCallback, useEffect, useRef, useState, type MouseEvent, type MouseEventHandler } from "react";
import { INITIAL_POINTER_POSITION, pointerPositionChanged } from "../domain/searchSelection";
import type { EnhResult } from "../types";

const HOVER_DWELL_MS = 70;

export function useEnhancedSearchSelection(open: boolean, results: EnhResult[]) {
  // Keyboard activation and hover preview intentionally share one cursor; Enter must always target the visible selection.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pointerPositionRef = useRef(INITIAL_POINTER_POSITION);
  const hoverTimerRef = useRef<number | null>(null);

  const cancelPendingHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const selectByKeyboard = useCallback((next: number | ((index: number) => number)) => {
    // A pending hover must not overwrite a keyboard action when its dwell timer lands.
    cancelPendingHover();
    setSelectedIndex(next);
  }, [cancelPendingHover]);

  const onRowEnter = useCallback((index: number, event: MouseEvent) => {
    const current = { x: event.clientX, y: event.clientY };
    if (!pointerPositionChanged(pointerPositionRef.current, current)) return;
    cancelPendingHover();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setSelectedIndex(index);
    }, HOVER_DWELL_MS);
  }, [cancelPendingHover]);

  const trackPointer = useCallback<MouseEventHandler<HTMLDivElement>>(event => {
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  useEffect(() => {
    if (!open) cancelPendingHover();
  }, [open, cancelPendingHover]);

  // A timer armed for an old row index cannot be allowed to land after the result set changes.
  useEffect(() => cancelPendingHover, [results, cancelPendingHover]);

  return {
    selectedIndex,
    setSelectedIndex,
    selectByKeyboard,
    onRowEnter,
    cancelPendingHover,
    trackPointer,
  };
}
