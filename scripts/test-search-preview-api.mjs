// Enhanced search preview platform contract tests. Preview requests are independent and may fail separately.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "search-preview-api-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/platform/searchPreviewApi.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/core"],
  outfile,
  logLevel: "error",
});

const { createSearchPreviewApi } = await import(pathToFileURL(outfile).href);
const calls = [];
const api = createSearchPreviewApi(async (command, args) => {
  calls.push([command, args]);
  return command === "get_file_info" ? { path: args.path } : null;
});

await api.getFileInfo("C:/report.txt");
await api.getLargeIcon("C:/report.txt");
await api.getThumbnail("C:/photo.png");

const expected = ["get_file_info", "get_large_icon", "get_stage_thumbnail"];
const passed = calls.map(([command]) => command).join(",") === expected.join(",")
  && calls[0][1].path === "C:/report.txt"
  && calls[2][1].path === "C:/photo.png";

console.log("\n增强搜索预览平台边界 —— 元数据、图标与缩略图命令");
console.log(passed ? "  ✓ 三类预览命令及 path 参数保持 Rust 契约" : `  ✗ 实际调用：${JSON.stringify(calls)}`);

rmSync(dir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
