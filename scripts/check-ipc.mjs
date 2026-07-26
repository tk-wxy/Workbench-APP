// IPC 命令名前后端对账（续147，M3）：把「Rust 改/删命令名 → 前端 invoke 静默 reject（还常被
// catch{} 吞）」这条静默失效钉在测试期。手法同 test-hotkey.mjs 的前后端对账、check-i18n.mjs：
// 正则/扫描真源码，不跑运行时。
//
//   node scripts/check-ipc.mjs
//
//   FAIL（硬）：前端 invoke("x") 但 Rust generate_handler![] 没注册 x → 运行期必 reject。
//   WARN（软）：Rust 注册了但前端从不调 x → 死命令 / 或用了本脚本抓不到的动态名，人工确认。
//
// 提取为何要健壮（否则对账本身会漏判，反而给假安全）：
//   · 前端泛型可嵌套 `<>`：invoke<{ icons: Record<string,string> }>("search_files") —— 泛型里不含
//     `(`，故按「invoke 后可选 <…> 到 ( 为止」跳过泛型；
//   · 命令名可藏在三元里：invoke(kind==="folder"?"pick_folder":"pick_file") —— 首参非单一字面量，
//     故扫「首个实参子串」再从中取全部字符串字面量；
//   · 三元条件会掺非命令串（kind==="folder"）：真命令一律 snake_case 且**含下划线**，据此把
//     "folder"/"en"/"zh-CN" 这类噪声滤掉。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CMD_SHAPE = /^[a-z][a-z0-9_]*$/;

// ── 1. Rust 权威集：lib.rs 的 generate_handler![ … ] 内部，按 [] 配平截取 ──
const libSrc = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
const genAt = libSrc.indexOf("generate_handler!");
if (genAt < 0) { console.error("✗ 未找到 generate_handler!，对账无从做起"); process.exit(1); }
const open = libSrc.indexOf("[", genAt);
let depth = 0, close = -1;
for (let i = open; i < libSrc.length; i++) {
  if (libSrc[i] === "[") depth++;
  else if (libSrc[i] === "]" && --depth === 0) { close = i; break; }
}
const handlerBody = libSrc.slice(open + 1, close);
const rustCmds = new Set(
  handlerBody.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.includes("::") ? s.slice(s.lastIndexOf("::") + 2) : s)) // apps::launch_app → launch_app
    .filter(s => CMD_SHAPE.test(s))
);

// ── 2. 前端集：扫 invoke(…) 首参里的命令名字面量 ──
const tsFiles = ["src/App.tsx", "src/main.tsx"].map(r => join(root, r));
const tsCode = tsFiles.map(p => { try { return readFileSync(p, "utf8"); } catch { return ""; } }).join("\n");

const feCmds = new Set();
const N = tsCode.length;
const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
for (let i = 0; i < N; ) {
  const at = tsCode.indexOf("invoke", i);
  if (at < 0) break;
  i = at + 6;
  const prev = tsCode[at - 1];
  if (prev && /[A-Za-z0-9_$]/.test(prev)) continue; // 必须是独立标识符 invoke（防 xinvoke 之类）
  let j = at + 6;
  while (j < N && isWs(tsCode[j])) j++;
  // 可选泛型：按 <> 深度配平跳过——泛型内可含 ()[]{} 及嵌套 <>（如 <(string|null)[]> / <Record<..>>）
  if (tsCode[j] === "<") {
    for (let ad = 0; j < N; j++) {
      if (tsCode[j] === "<") ad++;
      else if (tsCode[j] === ">" && --ad === 0) { j++; break; }
    }
    while (j < N && isWs(tsCode[j])) j++;
  }
  if (tsCode[j] !== "(") { i = j; continue; } // 不是调用（如变量名恰含 invoke）
  // 扫首个实参：到 depth 0 的逗号或收尾 `)` 为止，字符串内的括号/逗号不计
  let firstArg = "", d = 0, str = null;
  for (j++; j < N; j++) {
    const ch = tsCode[j];
    if (str) {
      firstArg += ch;
      if (ch === "\\") { firstArg += tsCode[++j] ?? ""; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; firstArg += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { d++; firstArg += ch; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { if (d === 0) break; d--; firstArg += ch; continue; }
    if (ch === "," && d === 0) break;
    firstArg += ch;
  }
  for (const lm of firstArg.matchAll(/(['"`])([a-z][a-z0-9_]*)\1/g)) {
    if (lm[2].includes("_")) feCmds.add(lm[2]); // 命令名必含下划线；滤掉三元条件里的噪声串
  }
  i = j;
}

// ── 3. 对账 ──
const missing = [...feCmds].filter(c => !rustCmds.has(c)).sort(); // 前端调用、Rust 未注册 → 硬失败
const dead = [...rustCmds].filter(c => !feCmds.has(c)).sort();    // Rust 注册、前端未调 → 软告警

console.log(`\nIPC 命令名对账：Rust 注册 ${rustCmds.size} 个，前端 invoke ${feCmds.size} 个`);

if (missing.length) {
  console.error(`\n✗ 前端 invoke 了 Rust 未注册的命令 ×${missing.length}（运行期必 reject，多半被 catch{} 吞成静默失效）：`);
  for (const c of missing) console.error(`    "${c}"  ← 查 lib.rs generate_handler![] 是否漏注册或改了名`);
  console.error(`\nIPC 对账未通过\n`);
  process.exit(1);
}
console.log("  ✓ 前端每个 invoke 命令都在 Rust 注册表内");

if (dead.length) {
  console.warn(`\n⚠ Rust 注册但前端从不 invoke ×${dead.length}（死命令或动态调用，人工确认；不判失败）：`);
  for (const c of dead) console.warn(`    "${c}"`);
} else {
  console.log("  ✓ 无死命令（Rust 每个注册命令都有前端调用）");
}

console.log("\n全部通过\n");
