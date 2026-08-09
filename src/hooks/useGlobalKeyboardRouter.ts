import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { matchComboEvent } from "../lib/hotkey";
import { perf } from "../lib/perfTrace";
import { resolveLauncherNavigation, resolveSectionNavigation } from "../domain/keyboardNavigation";
import { resolveEscapeTarget, resolveSearchModeToggle } from "../shell/uiPolicies";
import type { AppInfo, EnhResult, LauncherItem } from "../types";

type GlobalKeyboardRouterOptions = {
  visible: boolean;
  search: string;
  settingsOpen: boolean;
  pickerOpen: boolean;
  enhancedOpen: boolean;
  enhancedResults: EnhResult[];
  enhancedSectionStarts: number[];
  enhancedSelectedIndex: number;
  enhancedHotkey: string;
  launcherItems: LauncherItem[];
  launcherSelectedIndex: number;
  filteredApps: { app: AppInfo }[];
  searchRef: RefObject<HTMLInputElement | null>;
  launcherGridRef: RefObject<HTMLDivElement | null>;
  contextMenuRef: { current: unknown };
  clipDragActive: () => boolean;
  lassoActive: () => boolean;
  enhancedOpenRef: { current: boolean };
  stageRecoveryOpenRef: { current: boolean };
  launcherManagerOpenRef: { current: boolean };
  pickerOpenRef: { current: boolean };
  stageSelectedRef: { current: Set<number> };
  stageMultiselectRef: { current: boolean };
  searchDefaultModeRef: { current: "page" | "enhanced" };
  pageSearchForcedRef: { current: boolean };
  setContextMenu: (menu: null) => void;
  setEnhancedOpen: (open: boolean) => void;
  setEnhancedPinned: (pinned: boolean) => void;
  setEnhancedQuery: (query: string) => void;
  setEnhancedSelectedIndex: (index: number) => void;
  selectEnhancedByKeyboard: (next: number | ((index: number) => number)) => void;
  activateEnhanced: (result: EnhResult, iconElement?: HTMLElement | null) => void;
  setStageRecoveryOpen: (open: boolean) => void;
  closeLauncherManager: () => void;
  closePicker: () => void;
  setStageSelected: (selected: Set<number>) => void;
  setStageMultiselect: (active: boolean) => void;
  stageAnchorRef: { current: number | null };
  setLauncherSelectedIndex: Dispatch<SetStateAction<number>>;
  setSettingsOpen: (open: boolean) => void;
  setVisible: (visible: boolean) => void;
  endClipDrag: () => void;
  cancelLasso: () => void;
  hideWorkbench: () => void | Promise<void>;
  openLauncherItem: (item: LauncherItem, iconElement?: HTMLElement | null) => void;
  launchApp: (app: AppInfo, iconElement?: HTMLElement | null) => void;
};

function launcherColumnCount(grid: HTMLDivElement | null) {
  if (!grid) return 1;
  const tiles = grid.querySelectorAll<HTMLElement>(".app-tile");
  if (tiles.length < 2) return tiles.length || 1;
  const firstTop = tiles[0].offsetTop;
  let columns = 0;
  for (const tile of Array.from(tiles)) {
    if (tile.offsetTop !== firstTop) break;
    columns++;
  }
  return columns || 1;
}

export function useGlobalKeyboardRouter(options: GlobalKeyboardRouterOptions) {
  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;
  useEffect(() => {
    if (!options.visible) return;
    const onKey = (event: KeyboardEvent) => {
      const options = latestOptionsRef.current;
      if (options.contextMenuRef.current && event.key !== "Escape") options.setContextMenu(null);
      if (event.key === "Escape") {
        event.preventDefault();
        const target = resolveEscapeTarget({
          clipDragActive: options.clipDragActive(),
          lassoActive: options.lassoActive(),
          contextMenuOpen: !!options.contextMenuRef.current,
          enhancedSearchOpen: options.enhancedOpenRef.current,
          stageRecoveryOpen: options.stageRecoveryOpenRef.current,
          launcherManagerOpen: options.launcherManagerOpenRef.current,
          appPickerOpen: options.pickerOpenRef.current,
          stageSelectionActive: !!options.stageSelectedRef.current.size || options.stageMultiselectRef.current,
          launcherSelectionActive: options.launcherSelectedIndex >= 0,
          settingsOpen: options.settingsOpen,
        });
        if (target === "clip-drag") options.endClipDrag();
        else if (target === "lasso") options.cancelLasso();
        else if (target === "context-menu") options.setContextMenu(null);
        else if (target === "enhanced-search") {
          options.setEnhancedOpen(false);
          options.setEnhancedPinned(false);
          options.setEnhancedQuery("");
          if (options.searchDefaultModeRef.current === "enhanced") options.pageSearchForcedRef.current = true;
          options.searchRef.current?.focus();
        } else if (target === "stage-recovery") options.setStageRecoveryOpen(false);
        else if (target === "launcher-manager") options.closeLauncherManager();
        else if (target === "app-picker") options.closePicker();
        else if (target === "stage-selection") {
          options.setStageSelected(new Set());
          options.setStageMultiselect(false);
          options.stageAnchorRef.current = null;
        } else if (target === "launcher-selection") {
          options.setLauncherSelectedIndex(-1);
          options.searchRef.current?.focus();
        } else if (target === "settings") options.setSettingsOpen(false);
        else {
          options.setVisible(false);
          void options.hideWorkbench();
        }
        return;
      }

      if (options.enhancedOpen && event.ctrlKey && !event.shiftKey && !event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const next = resolveSectionNavigation(event.key, options.enhancedSectionStarts, options.enhancedSelectedIndex);
        if (next !== null) options.selectEnhancedByKeyboard(next);
        return;
      }
      if (matchComboEvent(event, options.enhancedHotkey)) {
        event.preventDefault();
        const plan = resolveSearchModeToggle({
          enhancedOpen: options.enhancedOpen,
          pageQuery: options.search,
          defaultMode: options.searchDefaultModeRef.current,
        });
        if (plan.enhancedOpen) perf.mark("open");
        options.setEnhancedOpen(plan.enhancedOpen);
        options.setEnhancedPinned(plan.enhancedPinned);
        options.setEnhancedQuery(plan.enhancedQuery);
        options.pageSearchForcedRef.current = plan.pageSearchForced;
        if (plan.enhancedOpen) options.setEnhancedSelectedIndex(0);
        options.searchRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        return;
      }
      if (options.settingsOpen || options.pickerOpen) return;
      if (options.enhancedOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          options.selectEnhancedByKeyboard(index => Math.min(index + 1, options.enhancedResults.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          options.selectEnhancedByKeyboard(index => Math.max(index - 1, 0));
        } else if (event.key === "Enter") {
          event.preventDefault();
          const result = options.enhancedResults[options.enhancedSelectedIndex] ?? options.enhancedResults[0];
          if (result) options.activateEnhanced(result, document.querySelector<HTMLElement>(".enh-result.selected .enh-result-icon"));
        }
        return;
      }

      const launcherNavigation = resolveLauncherNavigation(
        event.key,
        options.launcherSelectedIndex,
        options.launcherItems.length,
        launcherColumnCount(options.launcherGridRef.current),
      );
      if (launcherNavigation.kind !== "none") {
        event.preventDefault();
        if (launcherNavigation.kind === "select") options.setLauncherSelectedIndex(launcherNavigation.index);
        else if (launcherNavigation.kind === "focus-search") {
          options.setLauncherSelectedIndex(-1);
          options.searchRef.current?.focus();
        } else {
          const item = options.launcherItems[launcherNavigation.index];
          if (item) options.openLauncherItem(item, document.querySelector<HTMLElement>(".app-tile.selected .app-tile-icon"));
        }
        return;
      }

      if (event.key === "Enter" && options.search.trim() && options.filteredApps.length) {
        event.preventDefault();
        const app = options.filteredApps[0]?.app;
        if (app) options.launchApp(app, null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options.visible]);
}
