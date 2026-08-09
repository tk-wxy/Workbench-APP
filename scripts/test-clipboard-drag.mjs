import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-clip-drag-"));

try {
  const output = path.join(temp, "clipboardDrag.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/clipboardDrag.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const { CLIPBOARD_DRAG_THRESHOLD_PX, pointInRect, resolveWorkbenchFileDropZone, shouldActivateClipboardDrag } = await import(pathToFileURL(output));

  assert.equal(shouldActivateClipboardDrag({ x: 0, y: 0 }, { x: 7, y: 0 }), false);
  assert.equal(shouldActivateClipboardDrag({ x: 0, y: 0 }, { x: CLIPBOARD_DRAG_THRESHOLD_PX, y: 0 }), true);
  assert.equal(pointInRect({ x: 10, y: 20 }, { left: 10, top: 20, right: 30, bottom: 40 }), true);
  assert.equal(pointInRect({ x: 31, y: 20 }, { left: 10, top: 20, right: 30, bottom: 40 }), false);
  assert.equal(pointInRect({ x: 0, y: 0 }, null), false);
  const stage = { left: 100, top: 0, right: 200, bottom: 100 };
  const launcher = { left: 0, top: 0, right: 90, bottom: 100 };
  assert.equal(resolveWorkbenchFileDropZone({ x: 150, y: 50 }, stage, launcher), "stage");
  assert.equal(resolveWorkbenchFileDropZone({ x: 50, y: 50 }, stage, launcher), "launcher");
  assert.equal(resolveWorkbenchFileDropZone({ x: 250, y: 50 }, stage, launcher), null);
  console.log("剪贴板拖拽领域 —— 阈值与落点命中\n  ✓ 阈值边界保持\n  ✓ 矩形边界包含\n  ✓ 空矩形不命中\n  ✓ 原生回落只接受中转站或启动台明确区域\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
