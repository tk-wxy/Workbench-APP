import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-stage-interaction-"));
try {
  const output = path.join(temp, "domain.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/stageInteraction.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const domain = await import(pathToFileURL(output));
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.deepEqual(domain.resolveCardDragIntent({ multiselect: false, selectedIds: new Set(), itemId: 1, origin: { x: 3, y: 50 }, itemRect: rect }), { lasso: true, threshold: 6 });
  assert.deepEqual(domain.resolveCardDragIntent({ multiselect: true, selectedIds: new Set([1]), itemId: 1, origin: { x: 50, y: 50 }, itemRect: rect }), { lasso: false, threshold: 12 });
  assert.equal(domain.hasReachedStageThreshold({ x: 0, y: 0 }, { x: 12, y: 0 }, 12), true);
  assert.deepEqual(domain.resolveStageDragRoute({ itemId: 1, selectedIds: new Set([1]), missingIds: new Set(), autoClose: false, searchActive: false }), { kind: "reorder", ids: [1] });
  assert.equal(domain.resolveStageDragRoute({ itemId: 1, selectedIds: new Set([1]), missingIds: new Set(), autoClose: true, searchActive: false }).kind, "native");
  assert.equal(domain.resolveStageDragRoute({ itemId: 1, selectedIds: new Set([1, 2]), missingIds: new Set(), autoClose: false, searchActive: false }).kind, "native");
  assert.equal(domain.resolveStageDragRoute({ itemId: 1, selectedIds: new Set([1]), missingIds: new Set([1]), autoClose: false, searchActive: false }).kind, "cancel");
  assert.deepEqual([...domain.selectLassoIds({ x: 0, y: 0 }, { x: 20, y: 20 }, [{ id: 1, left: 10, top: 10, right: 30, bottom: 30 }, { id: 2, left: 40, top: 40, right: 50, bottom: 50 }])], [1]);
  assert.equal(domain.resolveStageRelease({ mode: "reorder", overLauncher: true, itemType: "image" }), "drop-launcher");
  assert.equal(domain.resolveStageRelease({ mode: "reorder", overLauncher: true, itemType: "text" }), "reject-launcher");
  assert.equal(domain.resolveStageRelease({ mode: "reorder", overLauncher: false, itemType: "file", hasFilePath: true }), "commit-reorder");
  console.log("舞台交互状态机 —— 意图、路由、框选与松手\n  ✓ 边缘/多选意图保持\n  ✓ 自动关闭/多选/失效路由保持\n  ✓ 框选相交与启动台落点保持\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

