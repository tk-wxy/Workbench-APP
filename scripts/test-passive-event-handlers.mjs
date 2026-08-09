// Passive event controller tests. Bundle the real modules so clipboard normalization, event
// decisions, and the native command mapping stay aligned with App.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "passive-events-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/shell/passiveEventHandlers.ts", "src/platform/clipboardApi.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  splitting: true,
  external: ["@tauri-apps/api/core"],
  outdir: dir,
  entryNames: "[name]",
  logLevel: "error",
});

const handlersModule = await import(pathToFileURL(join(dir, "passiveEventHandlers.js")).href);
const apiModule = await import(pathToFileURL(join(dir, "clipboardApi.js")).href);
const { createPassiveEventHandlers, normalizeClipboardHistory } = handlersModule;
const { createClipboardApi } = apiModule;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

console.log("\n被动后台同步 —— 剪贴板、索引与应用事件");

const rawHistory = [{
  type: "image",
  content: undefined,
  time: 7,
  orig_path: "C:/clip.png",
  orig_degraded: false,
  unexpected: "drop-me",
}];
const normalized = normalizeClipboardHistory(rawHistory);
check("历史规范化保留轻量字段", normalized[0].time === 7 && normalized[0].orig_path === "C:/clip.png");
check("历史规范化不透传未知字段", !("unexpected" in normalized[0]));
check("历史规范化返回新条目引用", normalized[0] !== rawHistory[0]);

let clipboard = [{ type: "image", time: 7, orig_degraded: false }, { type: "text", time: 8, content: "x" }];
let indexReady = null;
let apps = [{ name: "existing", path: "existing", icon: null }];
let toastCount = 0;
const controller = createPassiveEventHandlers({
  loadClipboardHistory: async () => rawHistory,
  replaceClipboard: history => { clipboard = history; },
  updateClipboard: update => { clipboard = update(clipboard); },
  setIndexReady: ready => { indexReady = ready; },
  setApps: next => { apps = next; },
  notifyOriginalFallback: () => { toastCount++; },
});

await controller.onClipboardUpdate();
check("clipboard-update 回拉权威历史", clipboard.length === 1 && clipboard[0].time === 7);
controller.onFileIndexReady(0);
check("零条索引保持未就绪", indexReady === false);
controller.onFileIndexReady(12);
check("正条数索引标记就绪", indexReady === true);
controller.onAppsReady([]);
check("空 apps-ready 不覆盖已有列表", apps[0].name === "existing");
controller.onAppsReady([{ name: "new", path: "new", icon: null }]);
check("非空 apps-ready 替换应用列表", apps.length === 1 && apps[0].name === "new");
controller.onClipboardOriginalDegraded({ time: 7, reason: "consume-fallback", visible: true });
check("原图降级只标记命中卡片", clipboard[0].orig_degraded === true);
check("可见消费降级触发一次提示", toastCount === 1);
controller.onClipboardOriginalDegraded({ time: 7, reason: "consume-fallback", visible: false });
check("隐藏态消费降级不提示", toastCount === 1);

const calls = [];
const clipboardNative = createClipboardApi(async (command, args) => {
  calls.push([command, args]);
  return rawHistory;
});
check("剪贴板 API 原样返回权威历史", (await clipboardNative.getHistory())[0].time === 7);
check("剪贴板 API 映射正确命令", calls.length === 1 && calls[0][0] === "get_clipboard_history");

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
