// 热键映射前后端对账。手法同其他 test-*.mjs：esbuild 打真源码 + 解析 Rust 源码，两侧比对。
//
//   node scripts/test-hotkey.mjs
//
// 为什么必须自动对账：前端 src/lib/hotkey.ts 的主键集合与解析规则是 Rust lib.rs 的 key_token /
// parse_combo 的**手工副本**。任一侧改了另一侧忘改 → 用户「设的热键不生效」，且没有任何报错、
// 界面上也看不出来（尤其新增一个主键 token、或改动 blocklist 时）。这里钉死两侧一致。
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 前端：打包 lib/hotkey.ts ──
const dir = mkdtempSync(join(tmpdir(), "hk-"));
const outfile = join(dir, "bundle.mjs");
await build({ entryPoints: [join(root, "src/lib/hotkey.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
const { HOTKEY_MAIN_TOKENS, tokenFromCode, parseComboStr } = await import(`file://${outfile.replace(/\\/g, "/")}`);
const feTokens = new Set(HOTKEY_MAIN_TOKENS);

// ── Rust：解析 lib.rs 的 key_token / parse_combo ──
const rs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
const sliceFn = (name) => {
  const i = rs.indexOf(`fn ${name}(`);
  if (i < 0) throw new Error(`找不到 Rust fn ${name}`);
  const j = rs.indexOf("\nfn ", i + 1);
  return rs.slice(i, j < 0 ? undefined : j);
};
const keyTokenBody = sliceFn("key_token");
const parseComboBody = sliceFn("parse_combo");
// key_token 里所有 "xxx" => 即接受的主键（VK 常量不带引号，不会误入）
const rustTokens = new Set([...keyTokenBody.matchAll(/"([a-z0-9]+)"\s*=>/g)].map(m => m[1]));

let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  console.error(`  ✗ ${name}${extra ? "\n      " + extra : ""}`); failed++;
};

console.log(`\n主键 token 集对账（Rust key_token ${rustTokens.size} 个 / 前端 HOTKEY_MAIN_TOKENS ${feTokens.size} 个）`);
const onlyRust = [...rustTokens].filter(t => !feTokens.has(t)).sort();
const onlyFe = [...feTokens].filter(t => !rustTokens.has(t)).sort();
check("Rust 有、前端缺的 token = 空", onlyRust.length === 0, `Rust 独有: ${onlyRust.join(", ")}`);
check("前端有、Rust 缺的 token = 空", onlyFe.length === 0, `前端独有: ${onlyFe.join(", ")}`);
check("两侧数量一致（应为 54）", rustTokens.size === feTokens.size && rustTokens.size === 54, `Rust=${rustTokens.size} FE=${feTokens.size}`);

console.log("\n录制可达性：每个主键 token 都能由某个 KeyboardEvent.code 反解出来（否则录不进去）");
const codeFor = (tk) => {
  if (/^[a-z]$/.test(tk)) return "Key" + tk.toUpperCase();
  if (/^[0-9]$/.test(tk)) return "Digit" + tk;
  if (/^f([1-9]|1[0-2])$/.test(tk)) return "F" + tk.slice(1);
  return { space: "Space", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[tk];
};
const unreachable = [...feTokens].filter(tk => tokenFromCode(codeFor(tk)) !== tk).sort();
check("全部 token 可由 code 反解", unreachable.length === 0, `不可达: ${unreachable.join(", ")}`);

console.log("\n解析规则对账（parseComboStr 行为 + Rust parse_combo 源码含同款 blocklist）");
check("接受 ctrl+space", !!parseComboStr("ctrl+space"));
check("接受纯主键 f9", !!parseComboStr("f9"));
check("接受 alt+q（续46：Alt 组合可用）", !!parseComboStr("alt+q"));
check("接受 ctrl+shift+f", !!parseComboStr("ctrl+shift+f"));
check("拒绝 Win 组合", parseComboStr("win+space") === null);
check("拒绝裸 alt+space（系统菜单）", parseComboStr("alt+space") === null);
check("拒绝裸 alt+f4（关窗）", parseComboStr("alt+f4") === null);
check("拒绝裸 alt+tab（窗口切换）", parseComboStr("alt+tab") === null);
check("拒绝零主键（纯修饰键）", parseComboStr("ctrl+shift") === null);
check("拒绝双主键", parseComboStr("ctrl+a+b") === null);
// Rust 侧 parse_combo 必须含同一套 blocklist —— 防止只改了前端
check("Rust parse_combo 含 win/super/meta blocklist", /"win"\s*\|\s*"super"\s*\|\s*"meta"/.test(parseComboBody) || /matches!\(\*t,\s*"win"/.test(parseComboBody));
check("Rust parse_combo 含裸 Alt 保留键 space|f4|tab", /"space"\s*\|\s*"f4"\s*\|\s*"tab"/.test(parseComboBody));

rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 处失败——前后端热键映射已漂移，请同步 src/lib/hotkey.ts 与 src-tauri/src/lib.rs\n`); process.exit(1); }
console.log("\n全部通过\n");
