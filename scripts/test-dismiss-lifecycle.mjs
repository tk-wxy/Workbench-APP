import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "dismiss-lifecycle-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/dismissLifecycle.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { createDismissLifecycle } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  const cancelled = new Set();
  return {
    timers: {
      setTimeout(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
      clearTimeout(id) { cancelled.add(id); },
    },
    callback(id) { return callbacks.get(id); },
    latestId() { return nextId; },
    run(id) { if (!cancelled.has(id)) callbacks.get(id)?.(); },
  };
}

console.log("\n关闭淡出生命周期 —— transitionend 与 watchdog");

{
  const clock = fakeTimers();
  const lifecycle = createDismissLifecycle(clock.timers, 1000);
  let calls = 0;
  lifecycle.begin(() => { calls++; });
  const watchdogId = clock.latestId();
  check("transitionend 可正常完成", lifecycle.complete() && calls === 1);
  clock.run(watchdogId);
  check("正常完成会取消 watchdog，回调不重复", calls === 1);
}

{
  const clock = fakeTimers();
  const lifecycle = createDismissLifecycle(clock.timers, 1000);
  let calls = 0;
  lifecycle.begin(() => { calls++; });
  clock.run(clock.latestId());
  check("transitionend 缺失时 watchdog 完成关闭", calls === 1);
  // 同一轮竞争：watchdog 先完成，之后才送达的 transitionend 必须是无害 no-op。
  check("watchdog 先完成后，迟到 transitionend 不会二次收尾", lifecycle.complete() === false && calls === 1);
}

{
  const clock = fakeTimers();
  const lifecycle = createDismissLifecycle(clock.timers, 1000);
  let calls = 0;
  lifecycle.begin(() => { calls++; });
  const staleWatchdog = clock.callback(clock.latestId());
  lifecycle.begin(() => { calls += 10; });
  staleWatchdog?.();
  check("旧 watchdog 不得穿透新一轮关闭", calls === 0);
  clock.run(clock.latestId());
  check("当前轮 watchdog 仍可正确完成", calls === 10);
}

{
  const clock = fakeTimers();
  const lifecycle = createDismissLifecycle(clock.timers, 1000);
  let calls = 0;
  lifecycle.begin(() => { calls++; });
  const watchdogId = clock.latestId();
  lifecycle.cancel();
  clock.run(watchdogId);
  check("原生提前隐藏或卸载取消后不再执行续体", calls === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
