// Enhanced search selection intent tests. Stationary-pointer mouseenter must not override keyboard navigation.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "search-selection-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/searchSelection.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { INITIAL_POINTER_POSITION, pointerPositionChanged } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition) => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}`);
};

console.log("\n增强搜索选择意图 —— 静止鼠标与真实移动");
check("首次真实坐标可进入 hover 驻留", pointerPositionChanged(INITIAL_POINTER_POSITION, { x: 40, y: 80 }));
check("滚动造成的同坐标 mouseenter 被拒绝", !pointerPositionChanged({ x: 40, y: 80 }, { x: 40, y: 80 }));
check("横向或纵向真实移动均被接受", pointerPositionChanged({ x: 40, y: 80 }, { x: 41, y: 80 }) && pointerPositionChanged({ x: 40, y: 80 }, { x: 40, y: 81 }));

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
