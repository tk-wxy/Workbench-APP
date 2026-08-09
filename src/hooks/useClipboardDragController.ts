import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pointInRect, shouldActivateClipboardDrag } from "../domain/clipboardDrag";
import { clipboardDragApi } from "../platform/clipboardDragApi";
import type { ClipItem } from "../types";

type DragState = {
  item: ClipItem;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
  dropRect: DOMRect | null;
};

type ClipboardDragControllerOptions = {
  dropAreaRef: RefObject<HTMLDivElement | null>;
  dragOutSourceRef: { current: "stage" | "clip" };
  droppedOnSelfRef: { current: boolean };
  addToStage: (item: ClipItem) => void;
};

export function useClipboardDragController({
  dropAreaRef,
  dragOutSourceRef,
  droppedOnSelfRef,
  addToStage,
}: ClipboardDragControllerOptions) {
  const [dragItem, setDragItem] = useState<ClipItem | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);

  const setNativeActive = useCallback((active: boolean) => {
    clipboardDragApi.setActive(active);
  }, []);

  const endDrag = useCallback((clearNativeFlag = true) => {
    if (dragStateRef.current?.active) suppressClickRef.current = true;
    dragStateRef.current = null;
    document.getElementById("overlay")?.classList.remove("dragging");
    dropAreaRef.current?.closest(".center-panel")?.classList.remove("drag-over");
    setDragItem(null);
    if (clearNativeFlag) setNativeActive(false);
  }, [dropAreaRef, setNativeActive]);

  const pointerDown = useCallback((event: ReactPointerEvent, item: ClipItem) => {
    if (event.button !== 0 || (event.target as Element).closest(".clip-actions")) return;
    suppressClickRef.current = false;
    dragStateRef.current = {
      item,
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      dropRect: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const pointerMove = useCallback((event: ReactPointerEvent) => {
    const state = dragStateRef.current;
    if (!state) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.active) {
      if (!shouldActivateClipboardDrag(
        { x: state.originX, y: state.originY },
        { x: event.clientX, y: event.clientY },
      )) return;
      state.active = true;
      state.dropRect = (dropAreaRef.current?.closest(".center-panel") as HTMLElement | null)?.getBoundingClientRect() ?? null;
      document.getElementById("overlay")?.classList.add("dragging");
      setDragItem(state.item);
      setNativeActive(true);
      return;
    }
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate3d(${event.clientX + 12}px,${event.clientY + 12}px,0)`;
    }
    dropAreaRef.current?.closest(".center-panel")?.classList.toggle(
      "drag-over",
      pointInRect({ x: event.clientX, y: event.clientY }, state.dropRect),
    );
  }, [dropAreaRef, setNativeActive]);

  const pointerUp = useCallback((event: ReactPointerEvent) => {
    const state = dragStateRef.current;
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch {}
    const shouldDrop = !!state?.active
      && pointInRect({ x: event.clientX, y: event.clientY }, state.dropRect);
    const item = state?.item;
    endDrag();
    if (shouldDrop && item) addToStage(item);
  }, [addToStage, endDrag]);

  const pointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  const beginNativeDragOut = useCallback((item: ClipItem) => {
    dragOutSourceRef.current = "clip";
    droppedOnSelfRef.current = false;
    // This dispatch must remain synchronous with endDrag(false): no await is allowed here.
    clipboardDragApi.start({
      type: item.type,
      content: item.content ?? null,
      items: item.items?.map(file => file.path) ?? null,
      orig_path: item.orig_path ?? null,
      time: item.time,
    });
    endDrag(false);
  }, [dragOutSourceRef, droppedOnSelfRef, endDrag]);

  return {
    dragItem,
    dragStateRef,
    ghostRef,
    suppressClickRef,
    setNativeActive,
    endDrag,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    beginNativeDragOut,
  };
}
