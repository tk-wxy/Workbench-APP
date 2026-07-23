// i18n 覆盖校验：扫真源码，与 i18n.ts 的 EN_DICT 对账，抓两类静默漂移。
//
//   node scripts/check-i18n.mjs
//
//   ① 缺 key：TS 里 t("某中文") 但 EN_DICT 没有 → EN 模式静默回退中文（fallback 设计，零报错）。
//   ② 死 key：EN_DICT 有、但该字符串**没有作为完整引号字面量**出现在任何 TS/Rust 源码里 → 白维护。
//
// 为什么「死 key」判据是「完整引号字面量」而非「t() 首参」：本项目相当一部分 key 是**动态**取用的——
//   · 热键错误：Rust 侧 `Err("不支持 Win 键")` 返回后，前端 t(errString) 动态查表；
//   · 快捷入口/主题/语言：`{ l: "下载" }` / `["dark","深色"]` 数组里存 key，再 t(item) 取；
// 这些 key 静态扫 t() 首参根本抓不到，会被误判成死 key。改判据为「该字符串是否作为某处的完整
// 字符串字面量存在」即可精准区分：动态 key 一定以 "下载"/"深色"/Err("…") 形式存在；真死 key
// （只在注释里出现、或仅作为长串子串）没有独立字面量。CJK 字符串几乎不可能巧合撞用，故可靠。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. 从 i18n.ts 取 EN_DICT 的全部 key ──
const i18nSrc = readFileSync(join(root, "src/i18n.ts"), "utf8");
const dictBody = i18nSrc.slice(i18nSrc.indexOf("EN_DICT"));
const dictKeys = new Set();
for (const m of dictBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) dictKeys.add(JSON.parse(`"${m[1]}"`));

// ── 2. 收集源码 ──
const tsFiles = [
  "src/App.tsx", "src/icons.tsx", "src/main.tsx",
  "src/lib/format.ts", "src/lib/fuzzy.ts", "src/lib/enhSections.ts", "src/lib/pinyin.ts",
].map(r => join(root, r));
const rustDir = join(root, "src-tauri/src");
const rustFiles = readdirSync(rustDir).filter(f => f.endsWith(".rs")).map(f => join(rustDir, f));
const readSafe = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const tsCode = tsFiles.map(readSafe).join("\n");
const allCode = tsCode + "\n" + rustFiles.map(readSafe).join("\n"); // TS + Rust，供死 key 判据

// ── 3. 缺 key：TS 里 t(...) 的静态首参（含 CJK）不在字典 ──
const usedInT = new Set();
const dynamic = [];
const callRe = /\bt\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
for (const m of tsCode.matchAll(callRe)) {
  const lit = m[1];
  if (lit[0] === "`" && lit.includes("${")) { dynamic.push(lit); continue; }
  let key;
  try { key = lit[0] === "`" ? lit.slice(1, -1) : JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/"/g, '\\"')}"` : lit); }
  catch { key = lit.slice(1, -1); }
  usedInT.add(key);
}
const hasCJK = (s) => /[一-鿿]/.test(s);
const missing = [...usedInT].filter(k => hasCJK(k) && !dictKeys.has(k)).sort();

// ── 4. 死 key：字典 key 未作为完整引号字面量出现在 TS/Rust ──
// 收集全部完整字符串字面量（三种引号）。
const literals = new Set();
for (const re of [/"((?:[^"\\]|\\.)*)"/g, /'((?:[^'\\]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g]) {
  for (const m of allCode.matchAll(re)) literals.add(m[1]);
}
const dead = [...dictKeys].filter(k => !literals.has(k)).sort();

// ── 5. 汇报 ──
let failed = 0;
console.log(`\ni18n 覆盖校验：EN_DICT ${dictKeys.size} key`);
if (missing.length) {
  failed++;
  console.error(`\n✗ 缺 key ×${missing.length}（EN 模式会静默回退中文，请在 EN_DICT 补译）：`);
  for (const k of missing) console.error(`    "${k}"`);
} else console.log("  ✓ 无缺 key（所有含中文的 t() 调用都有英译）");

if (dead.length) {
  failed++;
  console.error(`\n✗ 死 key ×${dead.length}（EN_DICT 有、全仓无完整字面量引用，请删除或确认用途）：`);
  for (const k of dead) console.error(`    "${k}"`);
} else console.log("  ✓ 无死 key（EN_DICT 每条都有引用）");

if (dynamic.length) {
  failed++;
  console.error(`\n⚠ 动态模板 key ×${dynamic.length}（无法静态对账，建议改回静态字面量 + {占位符}）：`);
  for (const d of dynamic) console.error(`    ${d}`);
}

if (failed) { console.error(`\ni18n 校验未通过（上列需处理）\n`); process.exit(1); }
console.log("\n全部通过\n");
