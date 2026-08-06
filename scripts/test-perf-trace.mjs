// perfTrace contract tests: gate off = no-op, gate on = ring buffer + once-per-mark + percentiles.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "perf-trace-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/perfTrace.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/core"],
  outfile,
  logLevel: "error",
});

const { createPerfTracer, summarizeSamples } = await import(pathToFileURL(outfile).href);

let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
  if (!cond) failures++;
};

console.log("\nperfTrace 测量桩 —— 门控 / 环形缓冲 / 单记号单次 / 分位数");

// 1) 关闭时全部 no-op：不产生样本、不调用 report
{
  let reported = 0;
  const tracer = createPerfTracer({ on: false, now: () => 0, heapBytes: () => 1024, report: () => reported++ });
  tracer.mark("input");
  tracer.since("input", "input→paint");
  tracer.record("row-build", 5);
  tracer.heap("open");
  tracer.time("model-build", () => 42);
  check("关闭门控下 dump 为空且不上报", tracer.dump().length === 0 && reported === 0);
  tracer.setOn(true); // release 无 devtools：perf_env_on 经此方法翻开前端门控
  tracer.record("row-build", 7);
  check("setOn(true) 后恢复记录", tracer.dump().length === 1);
}

// 2) 开启时 time/record/since 入环，dump 触发一次 report
{
  let t = 0;
  const lines = [];
  const tracer = createPerfTracer({ on: true, now: () => t, heapBytes: () => 64 * 1024 * 1024, report: l => lines.push(...l) });
  tracer.mark("input");
  t = 12.5;
  check("since 返回经过毫秒", tracer.since("input", "input→echo") === 12.5);
  t = 30;
  tracer.since("input", "input→paint");
  check("同一 mark 实例同 tag 只记一次", tracer.since("input", "input→echo") === null);
  tracer.time("model-build", () => { t += 4; });
  tracer.heap("open");
  const out = tracer.dump();
  check("dump 汇总覆盖四个 tag", out.length === 4 && lines.length === 4);
  check("heap 以 MB 记录", out.some(l => l.startsWith("heap:open n=1 p50=64.0")));
  check("汇总含 p50/p95/max", out.every(l => /n=\d+ p50=[\d.]+ p95=[\d.]+ max=[\d.]+/.test(l)));
}

// 3) 环形缓冲容量：超出后丢最老
{
  const tracer = createPerfTracer({ on: true, now: () => 1, heapBytes: () => null, report: () => {}, capacity: 3 });
  for (let i = 0; i < 5; i++) tracer.record("rows", i);
  const out = tracer.dump();
  check("容量 3 时只留最新 3 条", out.length === 1 && out[0].startsWith("rows n=3 p50=3.0"));
}

// 4) summarizeSamples 纯函数：分位数与分组
{
  const lines = summarizeSamples([
    { tag: "a", ms: 10 }, { tag: "a", ms: 20 }, { tag: "a", ms: 30 }, { tag: "b", ms: 1 },
  ]);
  check("分位数正确且按 tag 分组",
    lines.includes("a n=3 p50=20.0 p95=30.0 max=30.0") && lines.includes("b n=1 p50=1.0 p95=1.0 max=1.0"));
  check("空样本返回空汇总", summarizeSamples([]).length === 0);
}

rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
