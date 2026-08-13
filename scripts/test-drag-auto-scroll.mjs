import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-drag-auto-scroll-"));
try {
  const output = path.join(temp, "domain.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/dragAutoScroll.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const domain = await import(pathToFileURL(output));
  const bounds = { left: 0, top: 100, right: 800, bottom: 500 };
  assert.equal(domain.resolveDragAutoScrollVelocity(300, bounds), 0);
  assert.equal(domain.resolveDragAutoScrollVelocity(148, bounds), 0);
  assert.equal(domain.resolveDragAutoScrollVelocity(124, bounds), -450);
  assert.equal(domain.resolveDragAutoScrollVelocity(80, bounds), -900);
  assert.equal(domain.resolveDragAutoScrollVelocity(452, bounds), 0);
  assert.equal(domain.resolveDragAutoScrollVelocity(476, bounds), 450);
  assert.equal(domain.resolveDragAutoScrollVelocity(520, bounds), 900);
  console.log("拖动边缘滚动 —— 中区静止、边缘渐进与最大速度\n  ✓ 上下边缘速度对称且有界\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
