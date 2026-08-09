// 热键 token 工具（录制 + 应用内快捷键匹配 + 展示共用）。纯函数、无副作用，从 App.tsx 抽出。
// ⚠️ 主键集合 HOTKEY_MAIN_TOKENS 与解析规则 parseComboStr **必须与 Rust 侧 key_token / parse_combo
// 逐条对齐**——两边是同一套热键契约的手工副本，漂移即「设了热键却不生效」且不自明。
// `scripts/test-hotkey.mjs` 会解析 Rust 源码与本文件做自动对账，改任一侧务必让该测试仍绿。

// Rust key_token 接受的 54 个主键：a-z / 0-9 / f1-f12 / space,tab,up,down,left,right。
export const HOTKEY_MAIN_TOKENS = new Set<string>([
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  "space", "tab", "up", "down", "left", "right",
]);

// 浏览器 KeyboardEvent.code → token（KeyA→a / Digit1→1 / F12→f12 / Space→space / Arrow*→方向）
export const tokenFromCode = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (code === "Space") return "space";
  if (code === "Tab") return "tab";
  if (code === "ArrowUp") return "up";
  if (code === "ArrowDown") return "down";
  if (code === "ArrowLeft") return "left";
  if (code === "ArrowRight") return "right";
  return null;
};

// 解析 combo 串 → {ctrl,shift,alt,main} 或 null（非法）。规则同 Rust parse_combo：禁 Win + 裸 Alt+Space/Alt+F4/Alt+Tab，恰 1 主键。
export const parseComboStr = (combo: string): { ctrl: boolean; shift: boolean; alt: boolean; main: string } | null => {
  const toks = combo.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
  if (toks.some(t => ["win", "super", "meta", "windows"].includes(t))) return null;
  const ctrl = toks.some(t => t === "ctrl" || t === "control");
  const shift = toks.includes("shift");
  const alt = toks.some(t => t === "alt" || t === "option");
  const mains = toks.filter(t => !["ctrl", "control", "shift", "alt", "option"].includes(t));
  if (mains.length !== 1 || !HOTKEY_MAIN_TOKENS.has(mains[0])) return null;
  if (alt && !ctrl && !shift && (mains[0] === "space" || mains[0] === "f4" || mains[0] === "tab")) return null; // OS 占用（系统菜单/关窗/窗口切换）
  return { ctrl, shift, alt, main: mains[0] };
};

// keydown 事件是否精确匹配 combo（修饰键全等 + 主键一致；Win 键按下则不匹配）
export const matchComboEvent = (e: KeyboardEvent, combo: string): boolean => {
  const p = parseComboStr(combo);
  if (!p) return false;
  if (e.ctrlKey !== p.ctrl || e.shiftKey !== p.shift || e.altKey !== p.alt || e.metaKey) return false;
  return tokenFromCode(e.code) === p.main;
};

// combo 串 → 展示文案（ctrl→Ctrl / 方向→箭头）
export const comboLabel = (combo: string): string =>
  combo.split("+").map(t => t === "ctrl" ? "Ctrl" : t === "shift" ? "Shift" : t === "alt" ? "Alt" : t === "space" ? "Space" : t === "tab" ? "Tab" : t === "up" ? "↑" : t === "down" ? "↓" : t === "left" ? "←" : t === "right" ? "→" : t.toUpperCase()).join("+");
