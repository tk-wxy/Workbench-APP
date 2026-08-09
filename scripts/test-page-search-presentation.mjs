import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "page-search-presentation-"));
const outfile = join(dir, "bundle.mjs");
await build({ entryPoints: ["src/domain/pageSearchPresentation.ts"], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
const { MAX_PAGE_SEARCH_RANGES, matchPageSearch, buildSearchExcerpt } = await import(pathToFileURL(outfile).href);

let failed = 0;
const check = (name, condition) => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++; console.error(`  ✗ ${name}`);
};
const json = value => JSON.stringify(value);

console.log("\n页面搜索展示 —— 匹配区间");
check("完整短语高亮全部重复位置", json(matchPageSearch("报告", "报告草稿和报告终稿", []).ranges) === json([[0, 1], [5, 6]]));
check("多词查询逐词补充高亮", json(matchPageSearch("alpha budget", "alpha bravo budget", []).ranges) === json([[0, 4], [12, 17]]));
check("模糊命中保留原始子序列区间", json(matchPageSearch("abc", "aXbYc", []).ranges) === json([[0, 0], [2, 2], [4, 4]]));
check("类型词命中保留条目但不伪造正文高亮", (() => { const result = matchPageSearch("文本", "普通正文", ["文本", "txt"]); return result.matches && result.ranges.length === 0; })());
const repeatedMatch = matchPageSearch("a", "ax".repeat(25_000), []);
check("高频字面命中在收集阶段受固定上限约束", repeatedMatch.ranges.length <= MAX_PAGE_SEARCH_RANGES);
const lateMatch = matchPageSearch("needle", `${"x".repeat(1_000_000)}needle`, []);
check("超长文本末尾命中仍可定位", lateMatch.matches && lateMatch.ranges[0][0] === 1_000_000);

console.log("\n页面搜索展示 —— 长文本摘要");
const text = "这是一段开头内容，之后有很多不相关的说明文字，报销审批正在处理中，后面还有更多解释与附注，预算确认后再提交。";
const excerpt = buildSearchExcerpt(text, [[23, 24], [48, 49]], { prefixLength: 10, contextLength: 6, maxLength: 60, maxWindows: 3 });
check("保留正文开头", excerpt.text.startsWith("这是一段开头内容"));
check("包含两个命中窗口", excerpt.text.includes("报销审批") && excerpt.text.includes("预算确认"));
check("摘要区间回映射正确", excerpt.ranges.every(([start, end]) => excerpt.text.slice(start, end + 1).length > 0));
check("长文本以省略号连接窗口", excerpt.text.includes("…"));
const emojiExcerpt = buildSearchExcerpt("开头🙂中间关键词结尾", [[6, 8]], { prefixLength: 3, contextLength: 2, maxLength: 20, maxWindows: 1 });
check("emoji 边界不被截断", !emojiExcerpt.text.includes("\uD83D") || emojiExcerpt.text.includes("🙂"));
const repeatedExcerpt = buildSearchExcerpt("a".repeat(50_000), [[0, 49_999]], { prefixLength: 20, contextLength: 16, maxLength: 96, maxWindows: 3 });
check("连续超长命中仍严格遵守摘要预算", repeatedExcerpt.text.length <= 96);
check("连续超长命中的可见部分仍被高亮", repeatedExcerpt.ranges.length === 1 && repeatedExcerpt.ranges[0][0] === 0 && repeatedExcerpt.ranges[0][1] < 96);
const plainExcerpt = buildSearchExcerpt("🙂".repeat(100), [], { prefixLength: 20, contextLength: 16, maxLength: 42, maxWindows: 1 });
check("无正文命中时摘要也严格守预算且不截断 emoji", plainExcerpt.text.length <= 42 && !plainExcerpt.text.endsWith("\uD83D"));

rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 处失败\n`); process.exit(1); }
console.log("\n全部通过\n");
