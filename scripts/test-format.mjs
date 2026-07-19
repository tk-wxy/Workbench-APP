// lib/format.ts の回帰テスト（続116）。test-enh-sections.mjs と同じ手口：
// vite 同梱の esbuild で TS を一時 ESM に固めて node で走らせる（テストランナー無依存）。
//
//   node scripts/test-format.mjs
//
// 対象は 2 つとも「壊れても画面上すぐには気づかない」種類のロジック：
//   ① ago() の分档境界 —— 続116 で日/月/年を足した。除数を 1 桁間違えても
//      「1个月前」のように*もっともらしい*値が出るだけで、目視では発見できない。
//   ② catToGroup() —— fileGroup() から抽出した写像本体（続116）。プレビュー面板の徽標色と
//      検索結果のセクション分けが**同じ写像を共有する**ための要。ここがズレると
//      「徽標の色とその項目が入っているセクションが食い違う」という分かりにくいバグになる。
//      抽出が挙動保存であることも fileGroup 側から併せて確認する。
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

// makeT の代わりの最小 t()：中文キーをそのまま返し {n} だけ展開する（辞書は本テストの対象外）
const t = (zh, vars) => zh.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

let failed = 0;
const eq = (name, actual, expected) => {
  if (actual === expected) { console.log(`  ✓ ${name} → ${actual}`); return; }
  console.error(`  ✗ ${name}\n      actual  : ${actual}\n      expected: ${expected}`);
  failed++;
};

const now = Date.now(), S = 1000, D = 86400 * S;

console.log("\nago() —— 分档境界（続116 で日/月/年を追加）");
eq("0 秒",              ago(now,            t), "刚刚");
eq("59 秒",             ago(now - 59 * S,   t), "刚刚");
eq("60 秒（档切替）",    ago(now - 60 * S,   t), "1分钟前");
eq("3599 秒",           ago(now - 3599 * S, t), "59分钟前");
eq("3600 秒（档切替）",  ago(now - 3600 * S, t), "1小时前");
eq("23h59m",            ago(now - 86399 * S, t), "23小时前");
eq("24h（新档・旧版は 24小时前）", ago(now - D,      t), "1天前");
eq("3 日（旧版は 72小时前）",      ago(now - 3 * D,  t), "3天前");
eq("29 日",             ago(now - 29 * D,  t), "29天前");
eq("30 日（档切替）",    ago(now - 30 * D,  t), "1个月前");
// 月は 30 日固定・年は 365 日 —— 素直に割ると 330 日以降が「12个月前」になり「1年前」の直前で
// 妙な表示になる。11 で頭打ちにしてある（format.ts のコメント参照）。
eq("330 日（頭打ち下端）", ago(now - 330 * D, t), "11个月前");
eq("364 日（12个月前 にならないこと）", ago(now - 364 * D, t), "11个月前");
eq("365 日（档切替）",   ago(now - 365 * D, t), "1年前");
// 未来のタイムスタンプ：時計ずれやネットワークドライブで実際に起こる。負値で
// 「-3分钟前」のような表示にならないこと（s<60 に落ちて「刚刚」）を担保する。
eq("未来時刻（時計ずれ）", ago(now + 9999 * S, t), "刚刚");

console.log("\nagoSec() —— 単位換算（ファイル時刻は Unix 秒、ClipItem.time はミリ秒）");
eq("秒版 3 日前", agoSec(Math.floor(now / 1000) - 3 * 86400, t), "3天前");
eq("秒版 1 年前", agoSec(Math.floor(now / 1000) - 365 * 86400, t), "1年前");

console.log("\ncatToGroup() —— FileCat 全 17 種が合法な FileGroup に落ちる");
const ALL_CATS = ["image","video","audio","archive","pdf","doc","sheet","ppt",
                  "ebook","disk","font","code","exe","text","folder","generic","box"];
const VALID = ["folder","image","archive","doc","code","media","exe","other"];
const strays = ALL_CATS.filter(c => !VALID.includes(catToGroup(c)));
if (strays.length) { console.error(`  ✗ 不正な組へ落ちた: ${strays.join(", ")}`); failed++; }
else console.log(`  ✓ 17 種すべて合法（徽標色 CSS が必ず存在する = 無色落ちしない）`);
// 抽出時に新設した分岐。fileGroup 経由では isDir が先に効くので単体で確認する必要がある。
eq("folder（抽出時の新設分岐）", catToGroup("folder"), "folder");
eq("generic → other",            catToGroup("generic"), "other");
eq("text → doc（テキスト項目の徽標色）", catToGroup("text"), "doc");

console.log("\nfileGroup() —— 抽出リファクタが挙動保存であること");
eq("isDir 優先",  fileGroup("txt", true),  "folder");
eq(".png",        fileGroup("png", false), "image");
eq(".zip",        fileGroup("zip", false), "archive");
eq(".pdf",        fileGroup("pdf", false), "doc");
// 続116：以前は video リストにも "ts" があり、video 判定が先に走るせいで TypeScript ファイルが
// 全部「媒体」セクションへ落ちていた。回帰しないよう釘を打つ。
eq(".ts → code（動画ではない）", fileGroup("ts", false), "code");
eq(".tsx",        fileGroup("tsx", false), "code");
eq(".mp4",        fileGroup("mp4", false), "media");
eq(".exe",        fileGroup("exe", false), "exe");
eq(".ttf → other", fileGroup("ttf", false), "other");
eq("未知拡張子",   fileGroup("qqq", false), "other");

rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 件失敗\n`); process.exit(1); }
console.log("\n全部通过\n");
