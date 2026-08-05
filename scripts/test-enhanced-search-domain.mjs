// Enhanced search result identity tests. Rendering, preview caches and async guards share these keys.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "enhanced-search-domain-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/enhancedSearch.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { enhancedResultKey, enhancedResultPath } = await import(pathToFileURL(outfile).href);
const cases = [
  [{ kind: "app", app: { path: "C:/tool.exe" } }, "app:C:/tool.exe", "C:/tool.exe"],
  [{ kind: "stage", item: { id: 7, items: [{ path: "D:/stage.txt" }] } }, "stage:7", "D:/stage.txt"],
  [{ kind: "clip", item: { time: 9, items: [{ path: "E:/clip.txt" }] } }, "clip:9", "E:/clip.txt"],
  [{ kind: "clip", item: { time: 10 } }, "clip:10", ""],
  [{ kind: "fs", path: "F:/result.pdf" }, "fs:F:/result.pdf", "F:/result.pdf"],
];

let failed = 0;
console.log("\n增强搜索领域 —— 结果身份与真实路径");
for (const [result, expectedKey, expectedPath] of cases) {
  const passed = enhancedResultKey(result) === expectedKey && enhancedResultPath(result) === expectedPath;
  if (passed) console.log(`  ✓ ${expectedKey}`);
  else { failed++; console.error(`  ✗ ${expectedKey}`); }
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
