// Native event lifecycle contract tests. Bundle the real TypeScript module so StrictMode
// cleanup and per-event error isolation cannot regress during later App decomposition.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "native-events-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/platform/nativeEvents.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/event"],
  outfile,
  logLevel: "error",
});

const { subscribeNativeEvents } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

console.log("\n原生事件作用域 —— 注册、异常隔离与 StrictMode 清理");

{
  const registered = [];
  const unlistened = [];
  const reports = [];
  const scope = subscribeNativeEvents(async register => {
    await register("first", () => {});
    await register("broken", () => {});
    await register("last", () => {});
  }, {
    loadListen: async () => async name => {
      if (name === "broken") throw new Error("registration failed");
      registered.push(name);
      return () => unlistened.push(name);
    },
    reportError: (message, error) => reports.push([message, error]),
  });
  await scope.ready;
  check("单个注册失败不阻断后续事件", registered.join(",") === "first,last", `实际: ${registered}`);
  check("注册错误带事件名归属", reports.some(([message]) => message.includes("注册 broken 失败")));
  scope.dispose();
  check("已成功监听全部进入清理表", unlistened.join(",") === "first,last", `实际: ${unlistened}`);
}

{
  let releaseFirst;
  let markFirstRequested;
  const firstRequested = new Promise(resolve => { markFirstRequested = resolve; });
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  const unlistened = [];
  const scope = subscribeNativeEvents(async register => {
    await register("slow-first", () => {});
    await register("second", () => {});
  }, {
    loadListen: async () => async name => {
      if (name === "slow-first") {
        markFirstRequested();
        await firstReleased;
      }
      return () => unlistened.push(name);
    },
  });
  await firstRequested;
  scope.dispose();
  releaseFirst();
  await scope.ready;
  check(
    "cleanup 先于异步注册完成时，迟到监听立即自卸",
    unlistened.join(",") === "slow-first,second",
    `实际: ${unlistened}`,
  );
}

{
  const handlers = new Map();
  const reports = [];
  const scope = subscribeNativeEvents(async register => {
    await register("sync-handler", () => { throw new Error("sync"); });
    await register("async-handler", async () => { throw new Error("async"); });
  }, {
    loadListen: async () => async (name, handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    reportError: (message, error) => reports.push([message, error]),
  });
  await scope.ready;
  handlers.get("sync-handler")({ payload: null });
  handlers.get("async-handler")({ payload: null });
  await Promise.resolve();
  await Promise.resolve();
  check("同步 handler 异常在事件名边界收口", reports.some(([message]) => message.includes("处理 sync-handler 失败")));
  check("异步 handler rejection 在事件名边界收口", reports.some(([message]) => message.includes("处理 async-handler 失败")));
  scope.dispose();
}

{
  const reports = [];
  const scope = subscribeNativeEvents(() => {}, {
    loadListen: async () => { throw new Error("module unavailable"); },
    reportError: (message, error) => reports.push([message, error]),
  });
  await scope.ready;
  check("事件 API 加载失败只在加载边界报告", reports.length === 1 && reports[0][0].includes("加载 Tauri 事件 API 失败"));
  scope.dispose();
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
