// Cache maintenance platform contract tests. Verify the view-facing facade keeps Rust command names exact.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "cache-api-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/platform/cacheApi.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/core"],
  outfile,
  logLevel: "error",
});

const { createCacheApi } = await import(pathToFileURL(outfile).href);
const calls = [];
const api = createCacheApi(async command => { calls.push(command); });

await api.openStageThumbnailDirectory();
await api.clearStageThumbnailCache();
await api.openClipboardImageDirectory();
await api.clearClipboardImageCache();

const expected = [
  "open_stage_thumb_dir",
  "clear_stage_thumb_cache",
  "open_clip_image_dir",
  "clear_clip_image_cache",
];
const passed = calls.join(",") === expected.join(",");
console.log("\n缓存维护平台边界 —— 命令映射");
console.log(passed ? "  ✓ 四个缓存命令保持 Rust 注册名" : `  ✗ 命令顺序错误：${calls.join(",")}`);

rmSync(dir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
