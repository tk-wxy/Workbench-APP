import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "search-focus-lifecycle-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/searchFocusLifecycle.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { startSearchFocusLifecycle } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition) => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}`);
};

console.log("\n搜索框聚焦生命周期 —— 首帧与原生激活");

let focuses = 0;
let frameCallback = () => {};
let focusListener = () => {};
let cancelledFrame = -1;
let removedListener = null;
const stop = startSearchFocusLifecycle({
  focusInput: () => focuses++,
  requestFrame: callback => { frameCallback = callback; return 7; },
  cancelFrame: frame => { cancelledFrame = frame; },
  addWindowFocusListener: listener => { focusListener = listener; },
  removeWindowFocusListener: listener => { removedListener = listener; },
});

frameCallback();
check("显示后首帧聚焦搜索框", focuses === 1);
focusListener();
check("原生窗口实际激活时再确认聚焦", focuses === 2);
stop();
check("收尾取消本轮帧并移除原监听器", cancelledFrame === 7 && removedListener === focusListener);
frameCallback();
focusListener();
check("上一轮迟到的帧或焦点事件不会穿透下一轮", focuses === 2);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
