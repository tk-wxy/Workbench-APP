import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "hidden-reset-lifecycle-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/hiddenResetLifecycle.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { createHiddenResetLifecycle } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map();
  return {
    clock: {
      now: () => now,
      setTimeout: callback => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      clearTimeout: id => callbacks.delete(id),
    },
    advance: milliseconds => { now += milliseconds; },
    pending: () => [...callbacks.values()],
  };
}

console.log("\n隐藏复位生命周期 —— 截止时间与跨轮隔离");

{
  const fake = createFakeClock();
  let resets = 0;
  const lifecycle = createHiddenResetLifecycle(10_000, () => resets++, fake.clock);
  lifecycle.arm();
  fake.advance(9_999);
  lifecycle.resume();
  check("十秒内重开保留现场", resets === 0);
  check("重开后取消本轮计时器", fake.pending().length === 0);
}

{
  const fake = createFakeClock();
  let resets = 0;
  const lifecycle = createHiddenResetLifecycle(10_000, () => resets++, fake.clock);
  lifecycle.arm();
  fake.advance(10_001);
  lifecycle.resume();
  check("隐藏计时器未获调度时，超期重开仍同步复位", resets === 1);
}

{
  const fake = createFakeClock();
  let resets = 0;
  const lifecycle = createHiddenResetLifecycle(10_000, () => resets++, fake.clock);
  lifecycle.arm();
  const staleCallback = fake.pending()[0];
  fake.advance(1_000);
  lifecycle.resume();
  lifecycle.arm();
  staleCallback();
  check("上一轮迟到回调不会重置新一轮", resets === 0);
}

{
  const fake = createFakeClock();
  let resets = 0;
  const lifecycle = createHiddenResetLifecycle(10_000, () => resets++, fake.clock);
  lifecycle.arm();
  const callback = fake.pending()[0];
  callback();
  callback();
  check("同一轮回调重入时只复位一次", resets === 1);
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
