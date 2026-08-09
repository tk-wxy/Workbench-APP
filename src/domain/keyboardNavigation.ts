export function resolveSectionNavigation(
  key: "ArrowDown" | "ArrowUp",
  sectionStarts: readonly number[],
  selectedIndex: number,
) {
  if (key === "ArrowDown") return sectionStarts.find(start => start > selectedIndex) ?? null;
  const currentStart = [...sectionStarts].reverse().find(start => start <= selectedIndex) ?? 0;
  if (selectedIndex > currentStart) return currentStart;
  return [...sectionStarts].reverse().find(start => start < currentStart) ?? null;
}

export type LauncherNavigation =
  | { kind: "none" }
  | { kind: "select"; index: number }
  | { kind: "focus-search" }
  | { kind: "activate"; index: number };

export function resolveLauncherNavigation(
  key: string,
  selectedIndex: number,
  itemCount: number,
  columns: number,
): LauncherNavigation {
  if (!itemCount) return { kind: "none" };
  if (selectedIndex < 0) {
    return key === "ArrowDown" ? { kind: "select", index: 0 } : { kind: "none" };
  }
  if (key === "ArrowRight") return { kind: "select", index: Math.min(selectedIndex + 1, itemCount - 1) };
  if (key === "ArrowLeft") return selectedIndex === 0
    ? { kind: "focus-search" }
    : { kind: "select", index: Math.max(selectedIndex - 1, 0) };
  if (key === "ArrowDown") return { kind: "select", index: Math.min(selectedIndex + columns, itemCount - 1) };
  if (key === "ArrowUp") return selectedIndex < columns
    ? { kind: "focus-search" }
    : { kind: "select", index: Math.max(selectedIndex - columns, 0) };
  if (key === "Enter") return { kind: "activate", index: selectedIndex };
  return { kind: "none" };
}

