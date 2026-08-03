// Cross-feature UI policy tests. Bundle the real TypeScript module and exercise the exact
// priority/reset rules used by App instead of maintaining a test-only copy.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ui-policies-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/shell/uiPolicies.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { resolveEscapeTarget, resolveHideResetPlan } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

console.log("\n跨领域 UI 策略 —— Esc 优先级与隐藏复位");

const base = {
  clipDragActive: false,
  lassoActive: false,
  contextMenuOpen: false,
  enhancedSearchOpen: false,
  stageRecoveryOpen: false,
  launcherManagerOpen: false,
  appPickerOpen: false,
  stageSelectionActive: false,
  launcherSelectionActive: false,
  settingsOpen: false,
};
const priority = [
  ["clipDragActive", "clip-drag"],
  ["lassoActive", "lasso"],
  ["contextMenuOpen", "context-menu"],
  ["enhancedSearchOpen", "enhanced-search"],
  ["stageRecoveryOpen", "stage-recovery"],
  ["launcherManagerOpen", "launcher-manager"],
  ["appPickerOpen", "app-picker"],
  ["stageSelectionActive", "stage-selection"],
  ["launcherSelectionActive", "launcher-selection"],
  ["settingsOpen", "settings"],
];
for (let index = 0; index < priority.length; index++) {
  const snapshot = { ...base };
  for (const [field] of priority.slice(index)) snapshot[field] = true;
  const expected = priority[index][1];
  const actual = resolveEscapeTarget(snapshot);
  check(`${expected} 优先于其后所有层`, actual === expected, `实际: ${actual}`);
}
check("无浮层时 Esc 关闭工作台", resolveEscapeTarget(base) === "workbench");

check(
  "无搜索现场时立即复位搜索",
  resolveHideResetPlan({ pageSearchActive: false, enhancedSearchOpen: false }).search === "immediate",
);
check(
  "页面搜索现场延迟复位",
  resolveHideResetPlan({ pageSearchActive: true, enhancedSearchOpen: false }).search === "delayed",
);
check(
  "增强搜索现场延迟复位",
  resolveHideResetPlan({ pageSearchActive: false, enhancedSearchOpen: true }).search === "delayed",
);
check(
  "可恢复 UI 统一延迟复位",
  resolveHideResetPlan({ pageSearchActive: false, enhancedSearchOpen: false }).retainedUi === "delayed",
);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
