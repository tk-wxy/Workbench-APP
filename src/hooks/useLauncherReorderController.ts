import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { reorderLauncherItemAtSlot } from "../domain/launcherLayout";
import type { RectBounds } from "../domain/stageInteraction";
import type { LauncherItem } from "../types";
import { useEdgeAutoScroll } from "./useEdgeAutoScroll";

const LAUNCHER_DRAG_THRESHOLD_PX = 8;

type LauncherSlotRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type LauncherReorderState = {
  pointerId: number;
  sourceId: number;
  originX: number;
  originY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  active: boolean;
  insertSlot: number;
  sourceElement: HTMLElement;
  tiles: HTMLElement[];
  rects: LauncherSlotRect[];
  ghostElement: HTMLElement | null;
  container: HTMLElement;
  containerBounds: RectBounds;
  lastScrollTop: number;
  lastClientX: number;
  lastClientY: number;
};

type LauncherReorderOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  dragLayerRef: RefObject<HTMLDivElement | null>;
  itemsRef: { current: LauncherItem[] };
  searchActive: boolean;
  suppressClickRef: { current: boolean };
  saveItems: (items: LauncherItem[]) => Promise<void>;
};

const resolveInsertSlot = (x: number, y: number, rects: readonly LauncherSlotRect[]) => {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (y < rect.top || (y <= rect.top + rect.height && x < rect.left + rect.width / 2)) return index;
  }
  return rects.length;
};

const emptyState = (): null => null;

export function useLauncherReorderController({
  containerRef,
  dragLayerRef,
  itemsRef,
  searchActive,
  suppressClickRef,
  saveItems,
}: LauncherReorderOptions) {
  const stateRef = useRef<LauncherReorderState | null>(emptyState());
  const autoScroll = useEdgeAutoScroll();

  const cleanupVisuals = useCallback((state: LauncherReorderState) => {
    state.tiles.forEach(tile => {
      tile.style.transform = "";
      tile.classList.remove("launcher-shift");
    });
    state.sourceElement.classList.remove("launcher-dragging-src");
    document.getElementById("overlay")?.classList.remove("launcher-reordering");
    state.ghostElement?.remove();
  }, []);

  const claim = useCallback(() => {
    const state = stateRef.current;
    stateRef.current = null;
    return state;
  }, []);

  const releaseCapture = useCallback((state: LauncherReorderState) => {
    try {
      if (state.sourceElement.hasPointerCapture(state.pointerId)) {
        state.sourceElement.releasePointerCapture(state.pointerId);
      }
    } catch {}
  }, []);

  const cancel = useCallback(() => {
    const state = claim();
    if (!state) return;
    autoScroll.stop();
    releaseCapture(state);
    cleanupVisuals(state);
  }, [autoScroll, claim, cleanupVisuals, releaseCapture]);

  const pointerDown = useCallback((event: ReactPointerEvent, sourceId: number) => {
    if (event.button !== 0 || searchActive || stateRef.current) return;
    const sourceIndex = itemsRef.current.findIndex(item => item.id === sourceId);
    if (sourceIndex < 0) return;
    event.preventDefault();
    const sourceElement = event.currentTarget as HTMLElement;
    const sourceRect = sourceElement.getBoundingClientRect();
    suppressClickRef.current = false;
    stateRef.current = {
      pointerId: event.pointerId,
      sourceId,
      originX: event.clientX,
      originY: event.clientY,
      grabOffsetX: event.clientX - sourceRect.left,
      grabOffsetY: event.clientY - sourceRect.top,
      active: false,
      insertSlot: sourceIndex,
      sourceElement,
      tiles: [],
      rects: [],
      ghostElement: null,
      container: containerRef.current ?? sourceElement,
      containerBounds: { left: 0, top: 0, right: 0, bottom: 0 },
      lastScrollTop: 0,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
    try { sourceElement.setPointerCapture(event.pointerId); } catch {}
  }, [itemsRef, searchActive, suppressClickRef]);

  const applyPosition = useCallback((state: LauncherReorderState, clientX: number, clientY: number) => {
    if (state.ghostElement) {
      state.ghostElement.style.transform = `translate3d(${clientX - state.grabOffsetX}px,${clientY - state.grabOffsetY}px,0) scale(1.05)`;
    }
    const insertSlot = resolveInsertSlot(clientX, clientY, state.rects);
    if (insertSlot === state.insertSlot) return true;
    state.insertSlot = insertSlot;
    const sourceIndex = itemsRef.current.findIndex(item => item.id === state.sourceId);
    if (sourceIndex < 0) return false;
    const target = insertSlot > sourceIndex ? insertSlot - 1 : insertSlot;
    for (let index = 0; index < state.tiles.length; index++) {
      if (index === sourceIndex) continue;
      const compactIndex = index < sourceIndex ? index : index - 1;
      const newSlot = compactIndex < target ? compactIndex : compactIndex + 1;
      const destination = state.rects[newSlot];
      const origin = state.rects[index];
      if (!destination || !origin) continue;
      const dx = destination.left - origin.left;
      const dy = destination.top - origin.top;
      state.tiles[index].style.transform = dx || dy ? `translate(${dx}px,${dy}px)` : "";
    }
    return true;
  }, [itemsRef]);

  const pointerMove = useCallback((event: ReactPointerEvent) => {
    const state = stateRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;
    if (!state.active) {
      if (Math.hypot(event.clientX - state.originX, event.clientY - state.originY) < LAUNCHER_DRAG_THRESHOLD_PX) return;
      const container = containerRef.current;
      if (!container) {
        cancel();
        return;
      }
      const tiles = Array.from(container.querySelectorAll<HTMLElement>(".app-tile"));
      const rects = tiles.map(tile => {
        const rect = tile.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      });
      const containerBounds = container.getBoundingClientRect();
      if (!tiles.length || rects.length !== itemsRef.current.length) {
        cancel();
        return;
      }
      tiles.forEach(tile => tile.classList.add("launcher-shift"));
      const ghostElement = state.sourceElement.cloneNode(true) as HTMLElement;
      ghostElement.classList.remove("selected", "launcher-dragging-src", "launcher-shift");
      ghostElement.classList.add("launcher-drag-ghost");
      ghostElement.querySelectorAll("img").forEach(image => { image.draggable = false; });
      const ghostHost = dragLayerRef.current ?? document.body;
      const inDragLayer = ghostHost === dragLayerRef.current;
      Object.assign(ghostElement.style, {
        position: inDragLayer ? "absolute" : "fixed",
        left: "0",
        top: "0",
        transition: "none",
        transform: `translate3d(${event.clientX - state.grabOffsetX}px,${event.clientY - state.grabOffsetY}px,0) scale(1.05)`,
        width: `${rects[state.insertSlot]?.width ?? state.sourceElement.offsetWidth}px`,
        height: `${rects[state.insertSlot]?.height ?? state.sourceElement.offsetHeight}px`,
        zIndex: inDragLayer ? "" : "100003",
        display: "flex",
        opacity: "0.72",
        visibility: "visible",
        pointerEvents: "none",
      });
      ghostHost.appendChild(ghostElement);
      state.sourceElement.classList.add("launcher-dragging-src");
      document.getElementById("overlay")?.classList.add("launcher-reordering");
      state.active = true;
      state.tiles = tiles;
      state.rects = rects;
      state.ghostElement = ghostElement;
      state.container = container;
      state.containerBounds = {
        left: containerBounds.left,
        top: containerBounds.top,
        right: containerBounds.right,
        bottom: containerBounds.bottom,
      };
      state.lastScrollTop = container.scrollTop;
      suppressClickRef.current = true;
    }

    const manualScrollDelta = state.container.scrollTop - state.lastScrollTop;
    if (manualScrollDelta !== 0) {
      state.rects.forEach(rect => { rect.top -= manualScrollDelta; });
      state.lastScrollTop = state.container.scrollTop;
    }

    if (!applyPosition(state, event.clientX, event.clientY)) {
      cancel();
      return;
    }
    autoScroll.update({
      container: state.container,
      bounds: state.containerBounds,
      pointerY: event.clientY,
      onScroll: () => {
        if (stateRef.current !== state) return;
        const scrollDelta = state.container.scrollTop - state.lastScrollTop;
        if (scrollDelta === 0) return;
        state.rects.forEach(rect => { rect.top -= scrollDelta; });
        state.lastScrollTop = state.container.scrollTop;
        if (!applyPosition(state, state.lastClientX, state.lastClientY)) cancel();
      },
    });
  }, [applyPosition, autoScroll, cancel, containerRef, dragLayerRef, itemsRef, suppressClickRef]);

  const pointerUp = useCallback((event: ReactPointerEvent) => {
    const current = stateRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    let finalInsertSlot = current.insertSlot;
    if (current.active) {
      const scrollDelta = current.container.scrollTop - current.lastScrollTop;
      if (scrollDelta !== 0) current.rects.forEach(rect => { rect.top -= scrollDelta; });
      finalInsertSlot = resolveInsertSlot(event.clientX, event.clientY, current.rects);
    }
    const state = claim();
    if (!state) return;
    autoScroll.stop();
    releaseCapture(state);
    cleanupVisuals(state);
    if (!state.active) return;
    const next = reorderLauncherItemAtSlot(itemsRef.current, state.sourceId, finalInsertSlot);
    const changed = next.some((item, index) => item.id !== itemsRef.current[index]?.id);
    if (changed) flushSync(() => { void saveItems(next); });
  }, [autoScroll, claim, cleanupVisuals, itemsRef, releaseCapture, saveItems]);

  const pointerCancel = useCallback((event: ReactPointerEvent) => {
    const current = stateRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    cancel();
  }, [cancel]);

  const lostPointerCapture = useCallback(() => {
    const state = claim();
    if (state) {
      autoScroll.stop();
      cleanupVisuals(state);
    }
  }, [autoScroll, claim, cleanupVisuals]);

  return { pointerDown, pointerMove, pointerUp, pointerCancel, lostPointerCapture, cancel };
}
