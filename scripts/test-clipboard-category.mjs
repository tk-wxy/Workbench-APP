// 剪贴板分类是纯视图过滤：必须按现有 ClipItem.type 精确分流，不能改变历史内容或在其他类中误匹配。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "clipboard-category-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/clipboardPageSearch.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { buildClipboardPageSearch } = await import(pathToFileURL(outfile).href);
const items = [
  { type: "text", time: 1, content: "文本目标" },
  { type: "image", time: 2 },
  { type: "file", time: 3, items: [{ name: "目标.pdf", ext: "pdf", isImage: false }] },
];
let failed = 0;
const check = (name, condition) => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}`);
};

console.log("\n剪贴板分类 —— 类型精确过滤");
check("全部保留所有类型", buildClipboardPageSearch(items, "", "all").items.length === items.length);
for (const category of ["text", "image", "file"]) {
  const visible = buildClipboardPageSearch(items, "", category).items;
  check(`${category} 只保留对应类型`, visible.length === 1 && visible[0].type === category);
}
const unfiltered = buildClipboardPageSearch(items, "", "all");
check("默认全部与空查询复用原数组", unfiltered.items === items && unfiltered.highlights.size === 0);
const textMatches = buildClipboardPageSearch(items, "目标", "text");
check("文本分类搜索只显示命中文本", textMatches.items.length === 1 && textMatches.items[0].time === 1 && textMatches.highlights.has(1));
const fileMatches = buildClipboardPageSearch(items, "目标", "file");
check("文件分类搜索只显示命中文件", fileMatches.items.length === 1 && fileMatches.items[0].time === 3 && fileMatches.highlights.has(3));
const imageMiss = buildClipboardPageSearch(items, "目标", "image");
check("分类先于搜索，其他分类不泄漏结果", imageMiss.items.length === 0 && imageMiss.highlights.size === 0);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
