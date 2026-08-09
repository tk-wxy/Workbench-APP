import type { AppUsage } from "../types";

// Frequency first, tempered by recency. After 30 days without use, weight halves.
const APP_USAGE_HALFLIFE_SECONDS = 30 * 24 * 3600;

export function appUsageScore(usage: AppUsage | undefined, nowSeconds: number): number {
  if (!usage || usage.count <= 0) return 0;
  return usage.count * Math.pow(0.5, (nowSeconds - usage.last_used) / APP_USAGE_HALFLIFE_SECONDS);
}
