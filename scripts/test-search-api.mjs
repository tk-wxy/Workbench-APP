// Enhanced search platform contract tests. Keep command names, parameters and responses visible without Tauri.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "search-api-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/platform/searchApi.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/core"],
  outfile,
  logLevel: "error",
});

const { createSearchApi } = await import(pathToFileURL(outfile).href);
const calls = [];
const api = createSearchApi(async (command, args) => {
  calls.push([command, args]);
  return { results: [], icons: {} };
});

await api.searchEverything("report", 500);
await api.searchBuiltin("docs", 150);

let failed = 0;
const check = (name, condition) => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}`);
};

console.log("\n增强搜索平台边界 —— 双引擎命令映射");
check("Everything 使用 search_files", calls[0][0] === "search_files");
check("内置引擎使用 search_builtin_all", calls[1][0] === "search_builtin_all");
check("查询与上限字段保持 Rust 契约", calls[0][1].query === "report" && calls[0][1].limit === 500 && calls[1][1].query === "docs" && calls[1][1].limit === 150);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
