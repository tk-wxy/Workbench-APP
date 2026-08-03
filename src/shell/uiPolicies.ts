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
  if (snapshot.enhancedSearchOpen) return "enhanced-search";
  if (snapshot.stageRecoveryOpen) return "stage-recovery";
  if (snapshot.launcherManagerOpen) return "launcher-manager";
  if (snapshot.appPickerOpen) return "app-picker";
  if (snapshot.stageSelectionActive) return "stage-selection";
  if (snapshot.launcherSelectionActive) return "launcher-selection";
  if (snapshot.settingsOpen) return "settings";
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
