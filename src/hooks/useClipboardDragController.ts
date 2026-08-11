import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pointInRect, shouldActivateClipboardDrag } from "../domain/clipboardDrag";
import {
  resolveStageInsertSlot,
  stageInsertAnchorForSlot,
  stageInsertMarkerForSlot,
  type LassoRect,
  type StageInsertAnchor,
} from "../domain/stageInteraction";
import { hideStageInsertMarker, showStageInsertMarker } from "../lib/stageInsertMarker";
import { clipboardDragApi } from "../platform/clipboardDragApi";
import { nextNativeDragSessionId, shouldFinishNativeDragHandoff } from "../domain/dragPreview";
import type { ClipItem } from "../types";

type DragState = {
  item: ClipItem;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
  dropRect: DOMRect | null;
  stageRects: LassoRect[];
  insertAnchor: StageInsertAnchor | null;
  hotspotX: number;
  hotspotY: number;
};

type ClipboardDragControllerOptions = {
  dropAreaRef: RefObject<HTMLDivElement | null>;
  insertMarkerRef: RefObject<HTMLDivElement | null>;
  stageLayout: "list" | "grid";
  dragOutSourceRef: { current: "stage" | "clip" };
  droppedOnSelfRef: { current: boolean };
  addToStage: (item: ClipItem, anchor?: StageInsertAnchor) => void;
  getDragLabel: (item: ClipItem) => string;
  getDragMeta: (item: ClipItem) => string;
  getDragPreview: (item: ClipItem) => string | null;
};

export function useClipboardDragController({
  dropAreaRef,
  insertMarkerRef,
  stageLayout,
  dragOutSourceRef,
  droppedOnSelfRef,
  addToStage,
  getDragLabel,
  getDragMeta,
  getDragPreview,
}: ClipboardDragControllerOptions) {
  const [dragItem, setDragItem] = useState<ClipItem | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const nativeHandoffSessionRef = useRef<number | null>(null);

  const setNativeActive = useCallback((active: boolean) => {
    clipboardDragApi.setActive(active);
  }, []);

  const endDrag = useCallback((clearNativeFlag = true, preserveGhost = false) => {
    if (dragStateRef.current?.active) suppressClickRef.current = true;
    dragStateRef.current = null;
    document.getElementById("overlay")?.classList.remove("dragging");
    dropAreaRef.current?.closest(".center-panel")?.classList.remove("drag-over");
    hideStageInsertMarker(insertMarkerRef.current);
    if (!preserveGhost) {
      nativeHandoffSessionRef.current = null;
      setDragItem(null);
    }
    if (clearNativeFlag) setNativeActive(false);
  }, [dropAreaRef, insertMarkerRef, setNativeActive]);

  const finishNativeHandoff = useCallback((sessionId?: number) => {
    if (!shouldFinishNativeDragHandoff(nativeHandoffSessionRef.current, sessionId)) return;
    nativeHandoffSessionRef.current = null;
    setDragItem(null);
  }, []);

  const pointerDown = useCallback((event: ReactPointerEvent, item: ClipItem) => {
    if (event.button !== 0 || (event.target as Element).closest(".clip-actions")) return;
    suppressClickRef.current = false;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dragStateRef.current = {
      item,
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      dropRect: null,
      stageRects: [],
      insertAnchor: null,
      hotspotX: Math.max(4, Math.min(68, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 72)),
      hotspotY: Math.max(4, Math.min(90, ((event.clientY - rect.top) / Math.max(1, rect.height)) * 94)),
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
      const selector = stageLayout === "grid" ? ".stage-card" : ".stage-item";
      state.stageRects = Array.from(dropAreaRef.current?.querySelectorAll<HTMLElement>(selector) ?? []).flatMap(element => {
        const id = Number(element.dataset.stageId);
        if (Number.isNaN(id)) return [];
        const rect = element.getBoundingClientRect();
        return [{ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
      });
      document.getElementById("overlay")?.classList.add("dragging");
      setDragItem(state.item);
      setNativeActive(true);
      return;
    }
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate3d(${event.clientX - state.hotspotX}px,${event.clientY - state.hotspotY}px,0) scale(1.04)`;
    }
    const point = { x: event.clientX, y: event.clientY };
    const overStage = pointInRect(point, state.dropRect);
    dropAreaRef.current?.closest(".center-panel")?.classList.toggle("drag-over", overStage);
    if (overStage) {
      const slot = resolveStageInsertSlot(point, state.stageRects, stageLayout);
      state.insertAnchor = stageInsertAnchorForSlot(slot, state.stageRects);
      showStageInsertMarker(insertMarkerRef.current, stageInsertMarkerForSlot(slot, state.stageRects, stageLayout));
    } else {
      state.insertAnchor = null;
      hideStageInsertMarker(insertMarkerRef.current);
    }
  }, [dropAreaRef, insertMarkerRef, setNativeActive, stageLayout]);

  const pointerUp = useCallback((event: ReactPointerEvent) => {
    const state = dragStateRef.current;
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch {}
    const shouldDrop = !!state?.active
      && pointInRect({ x: event.clientX, y: event.clientY }, state.dropRect);
    const item = state?.item;
    let anchor = state?.insertAnchor ?? undefined;
    if (state?.active && shouldDrop) {
      const point = { x: event.clientX, y: event.clientY };
      anchor = stageInsertAnchorForSlot(resolveStageInsertSlot(point, state.stageRects, stageLayout), state.stageRects);
    }
    endDrag();
    if (shouldDrop && item) addToStage(item, anchor);
  }, [addToStage, endDrag, stageLayout]);

  const pointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  const beginNativeDragOut = useCallback((item: ClipItem) => {
    dragOutSourceRef.current = "clip";
    droppedOnSelfRef.current = false;
    // This dispatch must remain synchronous with endDrag(false): no await is allowed here.
    const sessionId = nextNativeDragSessionId();
    nativeHandoffSessionRef.current = sessionId;
    const state = dragStateRef.current;
    const started = clipboardDragApi.start({
      type: item.type,
      content: item.content ?? null,
      items: item.items?.map(file => file.path) ?? null,
      orig_path: item.orig_path ?? null,
      time: item.time,
      drag_preview: getDragPreview(item),
      drag_label: getDragLabel(item),
      drag_meta: getDragMeta(item),
      drag_preview_kind: item.type === "image" || !!item.items?.[0]?.isImage ? "cover" : "icon",
      drag_hotspot_x: state?.hotspotX ?? 12,
      drag_hotspot_y: state?.hotspotY ?? 12,
      drag_theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      drag_dpr: window.devicePixelRatio,
      drag_session_id: sessionId,
    });
    // 原生 ready 事件到达前保留最后一帧页内 ghost；调用顺序仍完全同步，不在 DoDragDrop 起手前 await。
    endDrag(false, true);
    void started.catch(() => finishNativeHandoff(sessionId));
  }, [dragOutSourceRef, droppedOnSelfRef, endDrag, finishNativeHandoff, getDragLabel, getDragMeta, getDragPreview]);

  return {
    dragItem,
    dragStateRef,
    ghostRef,
    suppressClickRef,
    setNativeActive,
    endDrag,
    finishNativeHandoff,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    beginNativeDragOut,
  };
}
