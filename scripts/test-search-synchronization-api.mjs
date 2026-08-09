import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = await mkdtemp(join(tmpdir(), "workbench-search-sync-api-"));
const outfile = join(dir, "bundle.mjs");
await build({ entryPoints: [join(process.cwd(), "src/platform/searchSynchronizationApi.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error", external: ["@tauri-apps/api/core"] });
const { createSearchSynchronizationApi } = await import(`file:///${outfile.replaceAll("\\", "/")}`);
const calls = [];
const api = createSearchSynchronizationApi(async (command, args) => { calls.push({ command, args }); return command === "get_index_status" ? { ready: true, count: 1, everythingAvailable: true } : command === "set_search_items" ? 8 : [[]]; });
await api.derivePinyin(["微信"]);
await api.setItems(7, []);
await api.getStatus();
const expected = ["to_pinyin_batch", "set_search_items", "get_index_status"];
if (JSON.stringify(calls.map(call => call.command)) !== JSON.stringify(expected)) process.exit(1);
if (calls[0].args.names[0] !== "微信" || calls[1].args.revision !== 7) process.exit(1);
console.log("\n搜索同步平台边界 —— 拼音、投影、状态命令\n  ✓ 三类命令与参数契约保持\n全部通过\n");
