import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { makeT } from "../i18n";
import {
  LASSO_THRESHOLD_PX,
  beginStageInteraction,
  clampPointToRect,
  finishStageInteraction,
  hasReachedStageThreshold,
  resolveCardDragIntent,
  resolveStageDragRoute,
  resolveStageRelease,
  sameIdSet,
  selectLassoIds,
  type LassoRect,
  type StageInteractionState,
} from "../domain/stageInteraction";
import type { StageItem } from "../types";

export type StageLassoState = {
  active: boolean;
  origin: { x: number; y: number };
  current: { x: number; y: number };
};

type StageInteractionOptions = {
  interactionRef: { current: StageInteractionState };
  dropAreaRef: RefObject<HTMLDivElement | null>;
  launcherDropRef: RefObject<HTMLDivElement | null>;
  stageRef: { current: StageItem[] };
  selectedRef: { current: Set<number> };
  multiselectRef: { current: boolean };
  missingIdsRef: { current: Set<number> };
  anchorRef: { current: number | null };
  stageLayout: "list" | "grid";
  autoClose: boolean;
  searchActive: boolean;
  clipDragActive: () => boolean;
  setSelected: (update: Set<number> | ((previous: Set<number>) => Set<number>)) => void;
  setMultiselect: (active: boolean) => void;
  startReorder: (id: number, element: HTMLElement, x: number, y: number) => void;
  updateReorder: (x: number, y: number) => void;
  commitReorder: () => void;
  cancelReorder: () => void;
  reorderActive: () => boolean;
  setNativeReorderActive: (active: boolean) => void;
  beginNativeDragOut: (ids: number[], forceHide?: boolean, point?: { x: number; y: number }, sourceElement?: HTMLElement) => void;
  dropToLauncher: (item: StageItem) => Promise<void>;
  showToast: (message: string) => void;
  t: ReturnType<typeof makeT>;
};

const emptyLasso = (): StageLassoState => ({ active: false, origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } });

export function useStageInteractionController(options: StageInteractionOptions) {
  const {
    interactionRef, dropAreaRef, launcherDropRef, stageRef, selectedRef, multiselectRef, missingIdsRef,
    anchorRef, stageLayout, autoClose, searchActive, clipDragActive, setSelected, setMultiselect, startReorder,
    updateReorder, commitReorder, cancelReorder, reorderActive, setNativeReorderActive,
    beginNativeDragOut, dropToLauncher, showToast, t,
  } = options;
  const [lasso, setLasso] = useState<StageLassoState>(emptyLasso);
  const lassoRef = useRef(lasso);
  const lassoArmedRef = useRef(false);
  const lassoRectsRef = useRef<LassoRect[]>([]);
  const lassoVisualRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);

  const clampLassoPoint = useCallback((point: { x: number; y: number }) => {
    const rect = dropAreaRef.current?.getBoundingClientRect();
    return rect ? clampPointToRect(point, rect) : point;
  }, [dropAreaRef]);

  const paintLasso = useCallback((origin: { x: number; y: number }, current: { x: number; y: number }) => {
    const element = lassoVisualRef.current;
    if (!element) return;
    const start = clampLassoPoint(origin);
    const end = clampLassoPoint(current);
    Object.assign(element.style, {
      left: `${Math.min(start.x, end.x)}px`,
      top: `${Math.min(start.y, end.y)}px`,
      width: `${Math.abs(end.x - start.x)}px`,
      height: `${Math.abs(end.y - start.y)}px`,
    });
  }, [clampLassoPoint]);

  useLayoutEffect(() => {
    if (lasso.active) paintLasso(lasso.origin, lasso.current);
  }, [lasso.active, lasso.current, lasso.origin, paintLasso]);

  const snapshotLassoRects = useCallback(() => {
    const rects: LassoRect[] = [];
    dropAreaRef.current?.querySelectorAll<HTMLElement>(stageLayout === "grid" ? ".stage-card" : ".stage-item").forEach(element => {
      const id = Number(element.dataset.stageId);
      if (Number.isNaN(id)) return;
      const rect = element.getBoundingClientRect();
      rects.push({ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    });
    lassoRectsRef.current = rects;
  }, [dropAreaRef, stageLayout]);

  const computeLassoSelection = useCallback((origin: { x: number; y: number }, current: { x: number; y: number }) => {
    const selected = selectLassoIds(clampLassoPoint(origin), clampLassoPoint(current), lassoRectsRef.current);
    setSelected(previous => sameIdSet(previous, selected) ? previous : selected);
  }, [clampLassoPoint, setSelected]);

  const cancelLasso = useCallback(() => {
    lassoArmedRef.current = false;
    dropAreaRef.current?.classList.remove("lasso-active");
    lassoRef.current = { ...lassoRef.current, active: false };
    setLasso(state => state.active ? { ...state, active: false } : state);
  }, [dropAreaRef]);

  const resetForHide = useCallback(() => {
    if (reorderActive()) {
      cancelReorder();
      setNativeReorderActive(false);
    }
    interactionRef.current = finishStageInteraction(interactionRef.current);
    const next = emptyLasso();
    lassoRef.current = next;
    setLasso(next);
    lassoArmedRef.current = false;
    dropAreaRef.current?.classList.remove("lasso-active");
  }, [cancelReorder, dropAreaRef, interactionRef, reorderActive, setNativeReorderActive]);

  const upgradeReorderFromHotkey = useCallback(() => {
    const interaction = interactionRef.current;
    if (interaction.mode !== "reorder" || !reorderActive() || interaction.itemId === null) return;
    const itemId = interaction.itemId;
    cancelReorder();
    interaction.mode = "native";
    beginNativeDragOut([itemId], true);
  }, [beginNativeDragOut, cancelReorder, interactionRef, reorderActive]);

  const lassoPointerDown = useCallback((event: ReactPointerEvent) => {
    lassoArmedRef.current = false;
    if (event.button !== 0) return;
    if (clipDragActive()) return;
    if ((event.target as Element).closest(".stage-item,.stage-card,.stage-multi-toolbar,.stage-batch-bar,button")) return;
    lassoArmedRef.current = true;
    const next = { active: false, origin: { x: event.clientX, y: event.clientY }, current: { x: event.clientX, y: event.clientY } };
    lassoRef.current = next;
    setLasso(next);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, [clipDragActive]);

  const lassoPointerMove = useCallback((event: ReactPointerEvent) => {
    if (!lassoArmedRef.current || event.buttons === 0) return;
    const state = lassoRef.current;
    const current = { x: event.clientX, y: event.clientY };
    if (!state.active) {
      if (Math.hypot(current.x - state.origin.x, current.y - state.origin.y) <= LASSO_THRESHOLD_PX) return;
      dropAreaRef.current?.classList.add("lasso-active");
      const next = { ...state, active: true, current };
      lassoRef.current = next;
      setLasso(next);
      setMultiselect(true);
      snapshotLassoRects();
      computeLassoSelection(state.origin, current);
      return;
    }
    lassoRef.current = { ...state, current };
    paintLasso(state.origin, current);
    computeLassoSelection(state.origin, current);
  }, [computeLassoSelection, dropAreaRef, paintLasso, setMultiselect, snapshotLassoRects]);

  const lassoPointerUp = useCallback((event: ReactPointerEvent) => {
    if (!lassoArmedRef.current) return;
    lassoArmedRef.current = false;
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch {}
    if (!lassoRef.current.active) {
      if (selectedRef.current.size || multiselectRef.current) {
        setSelected(new Set());
        setMultiselect(false);
        anchorRef.current = null;
      }
      return;
    }
    dropAreaRef.current?.classList.remove("lasso-active");
    lassoRef.current = { ...lassoRef.current, active: false };
    setLasso(state => ({ ...state, active: false }));
    if (!selectedRef.current.size) setMultiselect(false);
  }, [anchorRef, dropAreaRef, multiselectRef, selectedRef, setMultiselect, setSelected]);

  const itemPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    suppressClickRef.current = false;
    const itemId = Number((event.currentTarget as HTMLElement).dataset.stageId);
    if (Number.isNaN(itemId)) return;
    interactionRef.current = beginStageInteraction(itemId, { x: event.clientX, y: event.clientY });
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch {}
  }, [interactionRef]);

  const itemPointerMove = useCallback((event: ReactPointerEvent) => {
    const interaction = interactionRef.current;
    const itemId = interaction.itemId;
    if (itemId === null || interaction.mode === "native") return;
    if (interaction.mode === "idle") {
      if (!interaction.pressing) return;
      const intent = resolveCardDragIntent({
        multiselect: multiselectRef.current,
        selectedIds: selectedRef.current,
        itemId,
        origin: interaction.origin,
        itemRect: (event.currentTarget as HTMLElement).getBoundingClientRect(),
      });
      const current = { x: event.clientX, y: event.clientY };
      if (!hasReachedStageThreshold(interaction.origin, current, intent.threshold)) return;
      interaction.pressing = false;
      suppressClickRef.current = true;
      if (intent.lasso) {
        interaction.mode = "lasso";
        const next = { active: true, origin: interaction.origin, current };
        lassoRef.current = next;
        setLasso(next);
        dropAreaRef.current?.classList.add("lasso-active");
        setMultiselect(true);
        snapshotLassoRects();
        computeLassoSelection(interaction.origin, current);
        return;
      }
      const route = resolveStageDragRoute({
        itemId,
        selectedIds: selectedRef.current,
        missingIds: missingIdsRef.current,
        autoClose,
        searchActive,
      });
      if (route.kind === "cancel") {
        interactionRef.current = finishStageInteraction(interaction);
        interactionRef.current.itemId = null;
      } else if (route.kind === "native") {
        interaction.mode = "native";
        beginNativeDragOut(route.ids, false, current, event.currentTarget as HTMLElement);
      } else {
        interaction.mode = "reorder";
        startReorder(itemId, event.currentTarget as HTMLElement, event.clientX, event.clientY);
      }
      return;
    }
    if (interaction.mode === "lasso") {
      const current = { x: event.clientX, y: event.clientY };
      lassoRef.current = { ...lassoRef.current, current };
      paintLasso(interaction.origin, current);
      computeLassoSelection(interaction.origin, current);
    } else if (interaction.mode === "reorder") {
      updateReorder(event.clientX, event.clientY);
    }
  }, [autoClose, beginNativeDragOut, computeLassoSelection, dropAreaRef, interactionRef, missingIdsRef, multiselectRef, paintLasso, searchActive, selectedRef, setMultiselect, snapshotLassoRects, startReorder, updateReorder]);

  const itemPointerUp = useCallback((event: ReactPointerEvent) => {
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch {}
    const interaction = interactionRef.current;
    let overLauncher = false;
    let item: StageItem | undefined;
    if (interaction.mode === "reorder") {
      const panel = (launcherDropRef.current?.closest(".app-panel") as HTMLElement | null) ?? launcherDropRef.current;
      const rect = panel?.getBoundingClientRect();
      overLauncher = !!rect
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      item = interaction.itemId === null ? undefined : stageRef.current.find(candidate => candidate.id === interaction.itemId);
    }
    const release = resolveStageRelease({
      mode: interaction.mode,
      overLauncher,
      itemType: item?.type,
      hasFilePath: !!item?.items?.[0]?.path,
    });
    if (release === "drop-launcher" && item) {
      cancelReorder();
      setNativeReorderActive(false);
      void dropToLauncher(item);
    } else if (release === "reject-launcher" && item) {
      cancelReorder();
      setNativeReorderActive(false);
      showToast(t("文本项无法加入启动台"));
    } else if (release === "commit-reorder") {
      commitReorder();
    } else if (release === "finish-lasso") {
      cancelLasso();
      if (!selectedRef.current.size) setMultiselect(false);
    }
    interactionRef.current = finishStageInteraction(interactionRef.current);
  }, [cancelLasso, cancelReorder, commitReorder, dropToLauncher, interactionRef, launcherDropRef, selectedRef, setMultiselect, setNativeReorderActive, showToast, stageRef, t]);

  const itemLostPointerCapture = useCallback(() => {
    if (reorderActive()) cancelReorder();
    if (interactionRef.current.mode === "lasso") cancelLasso();
    interactionRef.current = finishStageInteraction(interactionRef.current);
    setNativeReorderActive(false);
  }, [cancelLasso, cancelReorder, interactionRef, reorderActive, setNativeReorderActive]);

  return {
    lasso,
    lassoRef,
    lassoVisualRef,
    suppressClickRef,
    cancelLasso,
    resetForHide,
    upgradeReorderFromHotkey,
    lassoPointerDown,
    lassoPointerMove,
    lassoPointerUp,
    itemPointerDown,
    itemPointerMove,
    itemPointerUp,
    itemLostPointerCapture,
  };
}
