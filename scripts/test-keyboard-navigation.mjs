import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-keyboard-navigation-"));
try {
  const output = path.join(temp, "domain.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/keyboardNavigation.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const { resolveLauncherNavigation, resolveSectionNavigation } = await import(pathToFileURL(output));
  assert.equal(resolveSectionNavigation("ArrowDown", [0, 4, 9], 2), 4);
  assert.equal(resolveSectionNavigation("ArrowUp", [0, 4, 9], 7), 4);
  assert.equal(resolveSectionNavigation("ArrowUp", [0, 4, 9], 4), 0);
  assert.equal(resolveSectionNavigation("ArrowUp", [0, 4, 9], 0), null);
  assert.deepEqual(resolveLauncherNavigation("ArrowDown", -1, 8, 3), { kind: "select", index: 0 });
  assert.deepEqual(resolveLauncherNavigation("ArrowUp", 2, 8, 3), { kind: "focus-search" });
  assert.deepEqual(resolveLauncherNavigation("ArrowDown", 6, 8, 3), { kind: "select", index: 7 });
  assert.deepEqual(resolveLauncherNavigation("Enter", 5, 8, 3), { kind: "activate", index: 5 });
  assert.deepEqual(resolveLauncherNavigation("ArrowLeft", 0, 8, 3), { kind: "focus-search" });
  console.log("全局键盘导航 —— 分段与启动器网格\n  ✓ Ctrl+方向键分段跳转保持\n  ✓ 网格边界、回搜索框与激活保持\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

