export type EscapeTarget =
  | "clip-drag"
  | "lasso"
  | "context-menu"
  | "enhanced-search"
  | "stage-recovery"
  | "launcher-manager"
  | "app-picker"
  | "stage-selection"
  | "launcher-selection"
  | "settings"
  | "workbench";

export interface EscapeSnapshot {
  clipDragActive: boolean;
  lassoActive: boolean;
  contextMenuOpen: boolean;
  enhancedSearchOpen: boolean;
  stageRecoveryOpen: boolean;
  launcherManagerOpen: boolean;
  appPickerOpen: boolean;
  stageSelectionActive: boolean;
  launcherSelectionActive: boolean;
  settingsOpen: boolean;
}

/**
 * Esc is a cross-feature priority policy. Keeping the decision pure prevents a newly added
 * overlay from silently jumping ahead of an existing drag or selection cleanup.
 */
export function resolveEscapeTarget(snapshot: EscapeSnapshot): EscapeTarget {
  if (snapshot.clipDragActive) return "clip-drag";
  if (snapshot.lassoActive) return "lasso";
  if (snapshot.contextMenuOpen) return "context-menu";
  if (snapshot.settingsOpen) return "settings";
  if (snapshot.enhancedSearchOpen) return "enhanced-search";
  if (snapshot.stageRecoveryOpen) return "stage-recovery";
  if (snapshot.launcherManagerOpen) return "launcher-manager";
  if (snapshot.appPickerOpen) return "app-picker";
  if (snapshot.stageSelectionActive) return "stage-selection";
  if (snapshot.launcherSelectionActive) return "launcher-selection";
  return "workbench";
}

export type ResetTiming = "immediate" | "delayed";

export interface HideResetPlan {
  search: ResetTiming;
  retainedUi: ResetTiming;
}

/**
 * Dangerous transient UI is always cleared by the caller immediately. Search and recoverable
 * workspace state are the only domains with a retention policy.
 */
export function resolveHideResetPlan(input: {
  pageSearchActive: boolean;
  enhancedSearchOpen: boolean;
}): HideResetPlan {
  return {
    search: input.pageSearchActive || input.enhancedSearchOpen ? "delayed" : "immediate",
    retainedUi: "delayed",
  };
}

export type SearchMode = "page" | "enhanced";

/**
 * The header is shared by both search surfaces, but their queries are independent.
 * Default enhanced mode routes typing to enhanced search until the user explicitly
 * returns to page search; a pinned enhanced layer always owns the header.
 */
export function resolveHeaderSearchTarget(input: {
  defaultMode: SearchMode;
  pageSearchForced: boolean;
  enhancedPinned: boolean;
}): SearchMode {
  return (input.defaultMode === "enhanced" && !input.pageSearchForced) || input.enhancedPinned
    ? "enhanced"
    : "page";
}

export interface SearchModeTogglePlan {
  enhancedOpen: boolean;
  enhancedPinned: boolean;
  enhancedQuery: string;
  pageSearchForced: boolean;
}

/**
 * Entering enhanced search seeds it from the page query. Leaving discards edits made
 * only in enhanced search and never mutates the page query, so the main view restores
 * its exact pre-enhanced filter without an intermediate recompute.
 */
export function resolveSearchModeToggle(input: {
  enhancedOpen: boolean;
  pageQuery: string;
  defaultMode: SearchMode;
}): SearchModeTogglePlan {
  if (input.enhancedOpen) {
    return {
      enhancedOpen: false,
      enhancedPinned: false,
      enhancedQuery: "",
      pageSearchForced: input.defaultMode === "enhanced",
    };
  }
  return {
    enhancedOpen: true,
    enhancedPinned: true,
    enhancedQuery: input.pageQuery,
    pageSearchForced: false,
  };
}
