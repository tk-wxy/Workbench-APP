// lib/fuzzy.ts 的回归测试。手法与 test-format.mjs / test-enh-sections.mjs 相同：
// 用 esbuild 把真源码打成临时 ESM 再交给 node 跑（不引入测试框架，测的就是产品代码本体）。
//
//   node scripts/test-fuzzy.mjs
//
// 为什么值得测：fuzzyScore/typeKeywords/matchItem 是**所有搜索路径共用的打分器**
// （顶栏应用过滤 / 增强搜索 Tier1 / picker），它一偏，三处搜索一起坏，且「搜得出但排序不对」
// 这种劣化在界面上根本看不出来。这里钉的是**契约级行为 + 相对性质**，不钉具体魔数分值——
// 后者会在正常调优时误报。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "fuzzy-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/fuzzy.ts"],
  bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
});
const { fuzzyScore, typeKeywords, matchItem } = await import(pathToFileURL(outfile).href);

let failed = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  console.error(`  ✗ ${name}`); failed++;
};
const eqJson = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${name} → ${a}`); return; }
  console.error(`  ✗ ${name}\n      actual  : ${a}\n      expected: ${e}`); failed++;
};

console.log("\nfuzzyScore —— 边界契约");
eqJson("空 query 不打分", fuzzyScore("", "anything"), { score: 0, ranges: [] });
eqJson("完全不匹配 → 0 分", fuzzyScore("xyz", "abc"), { score: 0, ranges: [] });
check("子序列不成立（顺序反了）→ 0", fuzzyScore("cba", "abc").score === 0);

console.log("\nfuzzyScore —— 完全子串是最高档，前缀额外加分");
eqJson("前缀完全命中 = 120", fuzzyScore("app", "application"), { score: 120, ranges: [[0, 2]] });
eqJson("中段完全命中 = 100", fuzzyScore("cd", "abcdef"), { score: 100, ranges: [[2, 3]] });
check("前缀 > 中段（同 query）", fuzzyScore("app", "application").score > fuzzyScore("app", "my application").score);
check("完全子串 > 子序列缩写（同一 target）",
  fuzzyScore("code", "visual studio code").score > fuzzyScore("vsc", "visual studio code").score);

console.log("\nfuzzyScore —— 缩写/词首匹配（前端能做、正是 Rust gate A2 做不到的那类）");
check("vsc → visual studio code 命中", fuzzyScore("vsc", "visual studio code").score > 0);
check("app → advanced photo processor 命中", fuzzyScore("app", "advanced photo processor").score > 0);
check("词首缩写 > 同长度的散落中段匹配",
  fuzzyScore("vsc", "visual studio code").score > fuzzyScore("vsc", "vasculitis-scan").score - 1000); // 词首应有实打实加成

console.log("\nfuzzyScore —— ranges 供高亮，必须落在 target 原始下标且做连续压缩");
eqJson("散落子序列压成 3 段", fuzzyScore("ace", "abcde").ranges, [[0, 0], [2, 2], [4, 4]]);
eqJson("连续子序列压成 1 段", fuzzyScore("abc", "xabcy").ranges, [[1, 3]]);
check("range 上界不越 target 长度", (() => {
  const r = fuzzyScore("ef", "abcdef").ranges;
  return r.every(([s, e]) => s >= 0 && e < "abcdef".length && s <= e);
})());

console.log("\ntypeKeywords —— 类型词生成（让「图片/txt/pdf」等查询命中对应条目）");
check("text 条目含 文本/text/txt", (() => { const k = typeKeywords({ type: "text" }); return k.includes("文本") && k.includes("txt"); })());
check("image 条目含 图片/png", (() => { const k = typeKeywords({ type: "image" }); return k.includes("图片") && k.includes("png"); })());
check(".pdf → 含 pdf/文档", (() => { const k = typeKeywords({ type: "file", ext: "pdf" }); return k.includes("pdf") && k.includes("文档"); })());
check(".ts 归代码而非视频（format 侧同款回归点）", (() => { const k = typeKeywords({ type: "file", ext: "ts" }); return k.includes("代码") && !k.includes("视频"); })());
check(".mp4 → 视频", (() => typeKeywords({ type: "file", ext: "mp4" }).includes("视频"))());
check("isImage 覆盖未知扩展名也归图片", (() => typeKeywords({ type: "file", ext: "raw", isImage: true }).includes("图片"))());
check("未知扩展名至少带 文件/file", (() => { const k = typeKeywords({ type: "file", ext: "qqzz" }); return k.includes("文件") && k.includes("file"); })());

console.log("\nmatchItem —— 名称模糊 OR 类型词子串，任一命中即保留");
check("空 query 全保留", matchItem("", "whatever", []) === true);
check("名称模糊命中", matchItem("app", "application", []) === true);
check("类型词子串命中（名称对不上）", matchItem("图片", "DSC_0001", typeKeywords({ type: "image" })) === true);
check("都不命中 → false", matchItem("zzzz", "application", typeKeywords({ type: "text" })) === false);
check("query 前后空白被 trim", matchItem("  app  ", "application", []) === true);

rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 处失败\n`); process.exit(1); }
console.log("\n全部通过\n");
