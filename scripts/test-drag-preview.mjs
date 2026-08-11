import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-drag-preview-"));
try {
  const output = path.join(temp, "domain.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/dragPreview.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const domain = await import(pathToFileURL(output));
  const t = (value, vars) => vars ? value.replace("{n}", String(vars.n)) : value;

  assert.equal(domain.buildNativeDragLabel({ type: "text", content: "  first\n  second  " }, t), "first second");
  assert.equal(domain.buildNativeDragLabel({ type: "image", orig_path: "C:\\shots\\screen.png" }, t), "screen.png");
  assert.equal(domain.buildNativeDragLabel({ type: "file", count: 3, items: [{ name: "first.txt" }] }, t), "3 个文件");
  const longLabel = domain.buildNativeDragLabel({ type: "text", content: "图".repeat(80) }, t);
  assert.equal(Array.from(longLabel).length, 13);
  assert.ok(longLabel.endsWith("…"));
  assert.equal(domain.formatNativeDragPreviewLabel("report-final.txt", 3), "report-final.txt  ×3");
  assert.equal(domain.buildNativeDragMeta({ type: "file", ext: "pdf" }, t), ".pdf");
  assert.equal(domain.buildNativeDragMeta({ type: "file", isDir: true }, t), "文件夹");
  assert.equal(domain.buildNativeDragMeta({ type: "image" }, t), "图片");
  assert.deepEqual(domain.nativeDragPreviewHotspot(), { x: 12, y: 12 });
  const firstSession = domain.nextNativeDragSessionId(100);
  const secondSession = domain.nextNativeDragSessionId(100);
  assert.ok(secondSession > firstSession);
  assert.equal(domain.shouldFinishNativeDragHandoff(secondSession, firstSession), false);
  assert.equal(domain.shouldFinishNativeDragHandoff(secondSession, secondSession), true);
  assert.equal(domain.shouldFinishNativeDragHandoff(secondSession), true);
  assert.equal(domain.shouldFinishNativeDragHandoff(null, secondSession), false);

  console.log("拖出悬浮样式 —— 中转卡片标签与交接代际\n  ✓ 文件/文本/图片使用同一卡片标签模型\n  ✓ 旧轮 ready 不会结束新轮 handoff\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
