import type { Pasteable } from "../types";

export type StageComparableItem = Pick<
  Pasteable,
  "type" | "content" | "contentFile" | "items" | "orig_path"
>;

function normalizeWindowsPath(path: string) {
  return path.trim().replace(/\//g, "\\").toLowerCase();
}

function canonicalFilePaths(item: StageComparableItem) {
  return (item.items ?? [])
    .map(file => normalizeWindowsPath(file.path))
    .filter(Boolean)
    .sort();
}

/**
 * Compares complete Stage items, never an individual file contained by them.
 * A one-file item therefore identifies that file, while a multi-file item only
 * matches another item containing the same complete path multiset.
 *
 * Stage currently allows duplicates, so this remains an exported domain policy
 * for callers that may need equality without coupling it to insertion.
 */
export function areStageItemsEquivalent(left: StageComparableItem, right: StageComparableItem) {
  if (left.type !== right.type) return false;
  if (left.type === "file") {
    const leftPaths = canonicalFilePaths(left);
    const rightPaths = canonicalFilePaths(right);
    return leftPaths.length > 0
      && leftPaths.length === rightPaths.length
      && leftPaths.every((path, index) => path === rightPaths[index]);
  }
  if (left.type === "text") return (left.content ?? "") === (right.content ?? "");

  if (left.contentFile && right.contentFile) {
    return normalizeWindowsPath(left.contentFile) === normalizeWindowsPath(right.contentFile);
  }
  if (left.orig_path && right.orig_path) {
    return normalizeWindowsPath(left.orig_path) === normalizeWindowsPath(right.orig_path);
  }
  return !!left.content && !!right.content && left.content === right.content;
}
