import type { EnhResult } from "../types";

// Rendering keys, preview cache keys and async response guards must share one identity rule.
export const enhancedResultKey = (result: EnhResult) =>
  result.kind === "app" ? `app:${result.app.path}`
  : result.kind === "stage" ? `stage:${result.item.id}`
  : result.kind === "clip" ? `clip:${result.item.time}`
  : `fs:${result.path}`;

export const enhancedResultPath = (result: EnhResult) =>
  result.kind === "app" ? result.app.path
  : result.kind === "fs" ? result.path
  : (result.item.items?.[0]?.path ?? "");
