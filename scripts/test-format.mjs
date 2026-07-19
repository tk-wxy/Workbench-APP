// lib/format.ts 的回归测试（续116）。手法与 test-enh-sections.mjs 相同：
// 用 vite 自带的 esbuild 把 TS 打成临时 ESM 再交给 node 跑（不依赖测试框架）。
//
//   node scripts/test-format.mjs
//
// 两个测试对象都属于「坏了也不会立刻在界面上看出来」的那类逻辑：
//   ① ago() 的分档边界——续116 加了日/月/年。除数写错一个数量级，
//      也只是输出「1个月前」这种*看着挺合理*的值，肉眼根本发现不了。
//   ② catToGroup()——从 fileGroup() 抽出的映射本体（续116）。它是预览面板徽标色
//      与搜索结果分段**共享同一份映射**的关键。这里一偏，就会出现
//      「徽标颜色和该项所在段落对不上」这种很难查的 bug。
//      顺带从 fileGroup 一侧确认抽取是行为保持的。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "fmt-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/format.ts"],
  bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
});
const { ago, agoSec, catToGroup, fileGroup } = await import(pathToFileURL(outfile).href);

// 代替 makeT 的最小 t()：原样返回中文 key，只展开 {n}（词典不在本测试范围内）
const t = (zh, vars) => zh.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

let failed = 0;
const eq = (name, actual, expected) => {
  if (actual === expected) { console.log(`  ✓ ${name} → ${actual}`); return; }
  console.error(`  ✗ ${name}\n      actual  : ${actual}\n      expected: ${expected}`);
  failed++;
};

const now = Date.now(), S = 1000, D = 86400 * S;

console.log("\nago() —— 分档边界（续116 增加了日/月/年）");
eq("0 秒",              ago(now,            t), "刚刚");
eq("59 秒",             ago(now - 59 * S,   t), "刚刚");
eq("60 秒（换档）",      ago(now - 60 * S,   t), "1分钟前");
eq("3599 秒",           ago(now - 3599 * S, t), "59分钟前");
eq("3600 秒（换档）",    ago(now - 3600 * S, t), "1小时前");
eq("23h59m",            ago(now - 86399 * S, t), "23小时前");
eq("24h（新档，旧版会显示 24小时前）", ago(now - D,      t), "1天前");
eq("3 天（旧版会显示 72小时前）",   ago(now - 3 * D,  t), "3天前");
eq("29 天",             ago(now - 29 * D,  t), "29天前");
eq("30 天（换档）",      ago(now - 30 * D,  t), "1个月前");
// 月按 30 天、年按 365 天——直接相除的话 330 天以后会显示「12个月前」，
// 紧挨着「1年前」显得别扭。故把月档封顶在 11（见 format.ts 的注释）。
eq("330 天（封顶下沿）", ago(now - 330 * D, t), "11个月前");
eq("364 天（不得变成 12个月前）", ago(now - 364 * D, t), "11个月前");
eq("365 天（换档）",     ago(now - 365 * D, t), "1年前");
// 未来时间戳：时钟偏差或网络盘上真实会发生。要保证不会因负值显示成
// 「-3分钟前」（应落进 s<60 显示「刚刚」）。
eq("未来时间（时钟偏差）", ago(now + 9999 * S, t), "刚刚");

console.log("\nagoSec() —— 单位换算（文件时间是 Unix 秒，ClipItem.time 是毫秒）");
eq("秒版 3 天前", agoSec(Math.floor(now / 1000) - 3 * 86400, t), "3天前");
eq("秒版 1 年前", agoSec(Math.floor(now / 1000) - 365 * 86400, t), "1年前");

console.log("\ncatToGroup() —— 全部 17 种 FileCat 都落到合法的 FileGroup");
const ALL_CATS = ["image","video","audio","archive","pdf","doc","sheet","ppt",
                  "ebook","disk","font","code","exe","text","folder","generic","box"];
const VALID = ["folder","image","archive","doc","code","media","exe","other"];
const strays = ALL_CATS.filter(c => !VALID.includes(catToGroup(c)));
if (strays.length) { console.error(`  ✗ 落到了非法的组: ${strays.join(", ")}`); failed++; }
else console.log(`  ✓ 17 种全部合法（徽标色 CSS 必然存在 = 不会掉成无色）`);
// 抽取时新增的分支。经由 fileGroup 时 isDir 会先起作用，故需单独确认。
eq("folder（抽取时新增的分支）", catToGroup("folder"), "folder");
eq("generic → other",            catToGroup("generic"), "other");
eq("text → doc（文本条目的徽标色）", catToGroup("text"), "doc");

console.log("\nfileGroup() —— 抽取重构必须行为保持");
eq("isDir 优先",  fileGroup("txt", true),  "folder");
eq(".png",        fileGroup("png", false), "image");
eq(".zip",        fileGroup("zip", false), "archive");
eq(".pdf",        fileGroup("pdf", false), "doc");
// 续116：此前 video 列表里也有 "ts"，而 video 判定跑在前面，
// 导致 TypeScript 文件全落进「媒体」段。钉死防止回归。
eq(".ts → code（不是视频）", fileGroup("ts", false), "code");
eq(".tsx",        fileGroup("tsx", false), "code");
eq(".mp4",        fileGroup("mp4", false), "media");
eq(".exe",        fileGroup("exe", false), "exe");
eq(".ttf → other", fileGroup("ttf", false), "other");
eq("未知扩展名",   fileGroup("qqq", false), "other");

rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 处失败\n`); process.exit(1); }
console.log("\n全部通过\n");
