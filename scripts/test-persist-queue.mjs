// 共享持久化队列回归测试：用 Vite 已依赖的 esbuild 打包真实 TS 源码后在 Node 执行。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "persist-queue-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/persistQueue.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});
const { LatestWriteQueue } = await import(pathToFileURL(outfile).href);

let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`);
};

console.log("\nLatestWriteQueue —— 串行 + 分域 latest-wins");

const queue = new LatestWriteQueue();
const order = [];
let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });

const stage1 = queue.enqueue("stage", async isLatest => {
  order.push("stage1:start");
  await firstGate;
  order.push(isLatest() ? "stage1:write" : "stage1:skip");
});
// stage1 已开始并停在 await；同域新版本应立即让它的水位失效。
await Promise.resolve();
const stage2 = queue.enqueue("stage", async isLatest => {
  order.push(isLatest() ? "stage2:write" : "stage2:skip");
});
// 不同域共享串行队列，但 launcher 的 revision 不应让 stage2 失效。
const launcher1 = queue.enqueue("launcher", async isLatest => {
  order.push(isLatest() ? "launcher1:write" : "launcher1:skip");
});
releaseFirst();
await Promise.all([stage1, stage2, launcher1]);

check("旧 stage 在 await 后识别为过期", order.includes("stage1:skip"));
check("最新 stage 正常执行", order.includes("stage2:write"));
check("launcher 与 stage 分域判定", order.includes("launcher1:write"));
check(
  "共享资源严格按入队顺序串行",
  JSON.stringify(order) === JSON.stringify(["stage1:start", "stage1:skip", "stage2:write", "launcher1:write"]),
  `实际顺序: ${JSON.stringify(order)}`,
);

// 失败任务不能毒死队尾。
await queue.enqueue("stage", async () => { throw new Error("expected"); }).catch(() => {});
let recovered = false;
await queue.enqueue("stage", async () => { recovered = true; });
check("单次失败后后续任务仍可执行", recovered);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
