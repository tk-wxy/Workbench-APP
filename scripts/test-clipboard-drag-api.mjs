import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-clip-drag-api-"));

try {
  const output = path.join(temp, "clipboardDragApi.mjs");
  await build({ entryPoints: [path.join(root, "src/platform/clipboardDragApi.ts")], outfile: output, bundle: true, platform: "node", format: "esm", external: ["@tauri-apps/api/core"] });
  const { createClipboardDragApi } = await import(pathToFileURL(output));
  const calls = [];
  const api = createClipboardDragApi((command, args) => calls.push({ command, args }));
  const item = {
    type: "image", content: null, items: null, orig_path: "x.png", time: 42,
    drag_preview: "data:image/png;base64,thumb",
    drag_label: "x.png", drag_meta: "图片", drag_preview_kind: "cover",
    drag_hotspot_x: 18, drag_hotspot_y: 21, drag_theme: "dark", drag_dpr: 2, drag_session_id: 1001,
  };
  api.setActive(true);
  api.start(item);
  assert.deepEqual(calls, [
    { command: "set_clip_drag_active", args: { active: true } },
    { command: "start_drag_out", args: { items: [item], forceHide: true } },
  ]);
  console.log("剪贴板拖拽平台边界 —— 原生交接命令\n  ✓ 激活标志与同步拖出参数保持\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
