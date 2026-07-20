// lib/pinyin.ts 的回归测试（续131）。与 test-enh-sections.mjs 同一套路：
// esbuild 打成临时 ESM 再 node 跑，测的是 App.tsx 真正 import 的那个实现。
//
//   node scripts/test-pinyin.mjs
//
// 派生（汉字→拼音）在 Rust 侧有自己的单测；这里测的是**匹配与回映射**——
// 尤其是「高亮区间落在原名上」这条，坏了不会报错，只会静静地把高亮画歪。
import { build } from "esbuild";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "pinyin-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/pinyin.ts"],
  bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
});
const { pinyinScore, matchName, isPinyinQuery } = await import(pathToFileURL(outfile).href);

let failed = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${name}`); return; }
  failed++; console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`);
};
const ok = (name, cond) => eq(name, !!cond, true);

// Rust `derive("微信")` 的等价输出（含「信」的冷僻读音 shen 那一支）
const weixin = [
  { full: "weixin", initials: "wx", map: [0,0,0,1,1,1], imap: [0,1] },
  { full: "weishen", initials: "ws", map: [0,0,0,1,1,1,1], imap: [0,1] },
];
// derive("QQ音乐")：乐 = le / yue 两支
const qqMusic = [
  { full: "qqyinle",  initials: "qqyl", map: [0,1,2,2,2,3,3],     imap: [0,1,2,3] },
  { full: "qqyinyue", initials: "qqyy", map: [0,1,2,2,2,3,3,3],   imap: [0,1,2,3] },
];

console.log("isPinyinQuery：只有纯字母数字查询才走拼音");
ok("wx 是", isPinyinQuery("wx"));
ok("微信 不是", !isPinyinQuery("微信"));
ok("带空格 不是", !isPinyinQuery("wei xin"));
ok("空串 不是", !isPinyinQuery(""));

console.log("\n全拼 / 首字母都能命中");
ok("weixin 命中", pinyinScore("weixin", weixin).score > 0);
ok("wx 命中", pinyinScore("wx", weixin).score > 0);
ok("wexin 子序列命中", pinyinScore("wexin", weixin).score > 0);
ok("abc 不命中", pinyinScore("abc", weixin).score === 0);
ok("无派生结果不命中", pinyinScore("wx", []).score === 0);
ok("undefined 不炸", pinyinScore("wx", undefined).score === 0);

console.log("\n多音字：命中任一读音即可（首版就是栽在乐 le/yue 上）");
ok("qqyinyue 命中", pinyinScore("qqyinyue", qqMusic).score > 0);
ok("qqyinle 也命中", pinyinScore("qqyinle", qqMusic).score > 0);
ok("qqyy 命中", pinyinScore("qqyy", qqMusic).score > 0);

console.log("\n回映射：高亮区间必须落在原名上（长度以原名计，不是拼音串）");
// 「微信」查 wx → 两个字都该高亮 → [[0,1]]（相邻合并）
eq("wx → 整词高亮", pinyinScore("wx", weixin).ranges, [[0, 1]]);
// 查 wei → 只该高亮「微」
eq("wei → 只高亮首字", pinyinScore("wei", weixin).ranges, [[0, 0]]);
// 「QQ音乐」查 yue → 只该高亮「乐」（原名下标 3）
eq("yue → 只高亮「乐」", pinyinScore("yue", qqMusic).ranges, [[3, 3]]);
// 区间必须在原名长度内——画到名字外面去就是崩溃或空白高亮
const name = "QQ音乐";
ok("区间不越界", pinyinScore("qqyy", qqMusic).ranges.every(([s, e]) => s >= 0 && e < name.length));

console.log("\nmatchName：直接命中优先于拼音命中");
const table = { "微信": weixin, "QQ音乐": qqMusic };
// 名字里直接含 "wx" 的条目，得分要高于靠拼音凑出 wx 的「微信」
const directHit = matchName("wx", "wxWork", table).score;
const pyHit = matchName("wx", "微信", table).score;
ok("直接命中 > 拼音命中", directHit > pyHit);
ok("拼音命中仍 > 0", pyHit > 0);
// 查询含汉字时不走拼音（表里有也不用）
eq("中文查询走直接匹配", matchName("微", "微信", table).ranges, [[0, 0]]);
// 表里没有的名字 = 纯英文，行为与直接匹配完全一致
eq("无派生的名字不受影响", matchName("ch", "Chrome", table).ranges, [[0, 1]]);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 个断言失败` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
