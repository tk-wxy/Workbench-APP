import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import "./App.css";

// ── 类型 ──
interface AppInfo { name: string; path: string; icon: string | null; }
interface AppUsage { count: number; last_used: number; } // last_used = Unix 秒
interface FileEntry { path: string; name: string; isDir: boolean; size: number; ext: string; icon?: string | null; }
interface FileItem { path: string; name: string; ext: string; isImage: boolean; icon?: string | null; }
interface ClipItem { type: "text" | "image" | "file"; content?: string; time: number; items?: FileItem[]; count?: number; orig_path?: string; }
// 文件中转条目：与 ClipItem 同构（type/content/items/count）以复用现成粘贴/复制链路；
// 额外带 id（稳定 key + 去重）和 file 显示辅助字段（name/ext/isDir/size，可选）。
interface StageItem { id: number; type: "text" | "image" | "file"; content?: string; items?: FileItem[]; count?: number; name?: string; ext?: string; isDir?: boolean; size?: number; orig_path?: string; }
// copyAndPaste/复制 只读这几个字段，ClipItem 与 StageItem 都满足 → 两个面板共用同一套出口
type Pasteable = { type: "text" | "image" | "file"; content?: string; items?: FileItem[]; orig_path?: string; };
const STAGE_MAX = 20; // 中转区上限
// 增强搜索（Ctrl+K）文件结果上限：内置仅扫用户目录够用；Everything 覆盖全盘，给大得多的上限（列表可滚动）
const ENH_FILE_LIMIT_BUILTIN = 50;
const ENH_FILE_LIMIT_EVERYTHING = 200;
const DRAG_THRESHOLD_PX = 8; // 剪贴板卡片按下后移动超过此距离才激活拖拽，防误触（短按仍走 onClick 粘贴）
const LASSO_THRESHOLD_PX = 6; // 中转区框选：按下后移动超过此距离才激活框选，防误触（纯点击空白不进多选）
const DRAG_OUT_THRESHOLD_PX = 12; // 中转条目拖出：按下后移动超过此距离才触发 OLE DoDragDrop（高于框选/卡片拖拽阈值，防误触）


// 启动器收藏条目：手动策展的常用 app/file/folder「托盘」，独立于 StageItem（左键动作契约不同：启动器=打开/启动，中转=取走粘贴）。
// 持久化到 store key "launcher-items"，不参与自动扫描；扫描链(filteredApps)仅供搜索，不再全量平铺到此面板。
interface LauncherItem {
  id: number;
  kind: "app" | "file" | "folder";
  name: string;
  icon?: string | null;   // app 图标 base64（来自 AppInfo.icon）；file/folder 无，用 emoji
  path: string;           // app=launch_app 的 path；file/folder=open_file 的 path
  ext?: string;           // file 显示图标用
}
const LAUNCHER_MAX = 60;
const launcherId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

function fmtSize(b: number) { if (!b) return "0 B"; const u = ["B","KB","MB","GB"]; const i = Math.min(Math.floor(Math.log(b)/Math.log(1024)), u.length-1); return `${(b/1024**i).toFixed(i?1:0)} ${u[i]}`; }
function ago(ms: number) { const s = Math.floor((Date.now()-ms)/1000); if (s<60) return "刚刚"; if (s<3600) return `${Math.floor(s/60)}分钟前`; return `${Math.floor(s/3600)}小时前`; }

// ── 应用使用打分：频率为主 × 近期乘数（频率高且近期用过的排前）──
// score = count × 0.5^(距上次使用 / 半衰期)。30 天没用，权重掉一半。要调"近期"敏感度改这个常量。
const USAGE_HALFLIFE_S = 30 * 24 * 3600;
function usageScore(u: AppUsage | undefined, nowS: number): number {
  if (!u || u.count <= 0) return 0;
  return u.count * Math.pow(0.5, (nowS - u.last_used) / USAGE_HALFLIFE_S);
}

async function hideWorkbench() { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("hide_window"); } catch{} }

// ── 文件中转：转换 + 写剪贴板助手 ──
const IMG_EXTS = ["jpg","jpeg","png","gif","bmp","webp","svg","ico"];
const stageId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000); // 稳定唯一 id（key/去重）
function fileEntryToStage(f: FileEntry): StageItem {
  const isImage = IMG_EXTS.includes(f.ext.toLowerCase());
  return { id: stageId(), type: "file", items: [{ path: f.path, name: f.name, ext: f.ext, isImage, icon: f.icon }], count: 1, name: f.name, ext: f.ext, isDir: f.isDir, size: f.size };
}
function clipToStage(c: ClipItem): StageItem {
  return { id: stageId(), type: c.type, content: c.content, items: c.items, count: c.count, name: c.items?.[0]?.name, orig_path: c.orig_path };
}
// 只写当前系统剪贴板（不粘贴、不隐藏 overlay），复用现成 copy_* 命令；剪贴板卡片与中转条目共用
async function writeItemToClipboard(item: Pasteable) {
  const { invoke } = await import("@tauri-apps/api/core");
  if (item.type === "text") await invoke("copy_text_to_clipboard", { text: item.content });
  else if (item.type === "file" && item.items) await invoke("copy_files_to_clipboard", { paths: item.items.map(f => f.path) });
  else await invoke("copy_image_to_clipboard", { base64: item.content, origPath: item.orig_path ?? null });
}

// ── 模糊搜索：子序列打分器（统一解决模糊 + 缩写）──
interface MatchResult { score: number; ranges: [number, number][]; } // ranges 基于 target 原始字符串
function fuzzyScore(query: string, target: string): MatchResult {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 完全子串：最高分直接返回（前缀额外加分）
  const exactIdx = t.indexOf(q);
  if (exactIdx !== -1) return { score: 100 + (exactIdx === 0 ? 20 : 0), ranges: [[exactIdx, exactIdx + q.length - 1]] };

  // 子序列匹配：query 字符按序出现在 target（不要求连续）
  let qi = 0;
  const idxs: number[] = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { idxs.push(ti); qi++; }
  }
  if (qi < q.length) return { score: 0, ranges: [] }; // 子序列不成立

  // 打分：词首 / 连续 / 靠前 加分（缩写匹配靠词首加分自然涌现）
  let score = 10;
  let consecutive = 0;
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i];
    const prev = idx > 0 ? target[idx - 1] : null;
    const isWordStart = idx === 0 || prev === " " || prev === "_" || prev === "-"
      || (target[idx] === target[idx].toUpperCase() && prev !== null && prev === prev.toLowerCase() && prev !== " ");
    if (isWordStart) score += 8;
    if (i > 0 && idxs[i] === idxs[i - 1] + 1) { consecutive++; score += 3 + consecutive; } else { consecutive = 0; }
    score += Math.max(0, 5 - Math.floor(idx / 5));
  }

  // 压缩为连续区间，供高亮
  const ranges: [number, number][] = [];
  let start = idxs[0], end = idxs[0];
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] === end + 1) end = idxs[i];
    else { ranges.push([start, end]); start = end = idxs[i]; }
  }
  ranges.push([start, end]);
  return { score, ranges };
}

// 高亮命中字符（色用 --accent 兜底，贴合主题系统）
function HighlightText({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<span key={start} style={{ color: "var(--accent, #60a5fa)", fontWeight: 600 }}>{text.slice(start, end + 1)}</span>);
    cursor = end + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// 自定义右键菜单（浮层）
type CtxMenuItem = { label: string; action: () => void; disabled?: boolean };
type CtxMenu = { x: number; y: number; items: CtxMenuItem[] } | null;

// 设置条目（左侧导航）；随后续开发逐步扩展，每项独立成区
const SETTINGS_TABS = [
  { id: "general",   icon: "⚙",  label: "常规" },
  { id: "clipboard", icon: "📋", label: "剪贴板" },
  { id: "search",    icon: "🔍", label: "搜索" },
  { id: "hotkeys",   icon: "⌨",  label: "快捷键" },
  { id: "about",     icon: "ℹ",  label: "关于" },
] as const;
type SettingsTab = typeof SETTINGS_TABS[number]["id"];

const SHORTCUTS = [
  { l: "文件管理器", e: "🖥️", a: "explorer.exe"    },
  { l: "下载",       e: "⬇️", a: "shell:Downloads" },
  { l: "桌面",       e: "🖼️", a: "shell:Desktop"   },
  { l: "终端",       e: "⬛", a: "wt"              },
  { l: "计算器",     e: "🔢", a: "calc"            },
  { l: "设置",       e: "⚙️", a: "ms-settings:"   },
] as const;

// 应用启动「放大暂留」动画（Mac 启动台式）：点击后图标放大淡出、覆盖层淡出露桌面，暗示刚启动了什么。
// 时长可调；放大幅度在 CSS @keyframes launch-pop 里（克制档 scale 1.4）。
const LAUNCH_ANIM_MS = 200;
// 顶层克隆浮层的数据：图标 + 点击瞬间的屏幕坐标（getBoundingClientRect）。
// 用克隆而非就地 transform——避开 .app-grid/.app-panel/.main-area 的 overflow 裁剪。
interface LaunchAnim { icon: string | null; name: string; rect: { top: number; left: number; width: number; height: number }; }

// 按扩展名映射文件类型图标（搜索结果 + 剪贴板卡片共用，单一真相源）。
function extIcon(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png","jpg","jpeg","gif","webp","bmp","svg","ico","tif","tiff","heic","heif","avif","psd"].includes(e)) return "🖼️";
  if (["mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpeg","mpg","ts","3gp"].includes(e)) return "🎬";
  if (["mp3","wav","flac","ogg","aac","m4a","wma","opus","aiff","mid"].includes(e)) return "🎵";
  if (["zip","rar","7z","tar","gz","bz2","xz","zst","tgz"].includes(e)) return "🗜️";
  if (e === "pdf") return "📕";
  if (["doc","docx","odt","rtf","pages"].includes(e)) return "📝";
  if (["xls","xlsx","csv","ods","tsv"].includes(e)) return "📊";
  if (["ppt","pptx","odp","key"].includes(e)) return "📽️";
  if (["epub","mobi","azw","azw3","fb2"].includes(e)) return "📚";
  if (["iso","img","dmg","vhd","vhdx"].includes(e)) return "💿";
  if (["ttf","otf","woff","woff2","fon"].includes(e)) return "🔤";
  if (["js","mjs","cjs","ts","jsx","tsx","py","rs","go","cpp","cc","cxx","c","h","hpp","java","cs","php","rb","swift","kt","scala","html","htm","css","scss","sass","less","vue","json","yaml","yml","xml","toml","sql","lua","r","dart"].includes(e)) return "💻";
  if (["exe","msi","bat","cmd","ps1","sh","appx","apk","deb","rpm"].includes(e)) return "⚙️";
  if (["txt","md","markdown","log","ini","cfg","conf","env","properties"].includes(e)) return "📃";
  return "📎";
}

function getFileIcon(item: ClipItem): string {
  const items = item.items ?? [];
  if (items.length > 1) return "📦";
  const first = items[0];
  if (!first) return "📎";
  if (first.isImage) return "🖼️"; // 剪贴板图片（可能无扩展名）
  const ext = first.ext || first.path.split(".").pop() || "";
  return extIcon(ext);
}

// 从绝对路径提取父目录（用于搜索结果目录串展示）
const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : p; };

// 给条目算"类型词"，让"图片/文本/txt/pdf"等查询能命中对应类型条目（与名称/内容搜索并存）
function typeKeywords(opts: { type: "text" | "image" | "file"; ext?: string; isImage?: boolean }): string[] {
  const { type, ext, isImage } = opts;
  if (type === "text") return ["文本", "text", "txt"];
  if (type === "image") return ["图片", "image", "img", "png", "jpg"];
  // file：按扩展名归类
  const e = (ext || "").toLowerCase();
  const kw = ["文件", "file"];
  if (isImage || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(e)) kw.push("图片", "image", e);
  else if (["mp4", "mkv", "avi", "mov", "wmv"].includes(e)) kw.push("视频", "video", e);
  else if (["mp3", "wav", "flac", "ogg", "aac", "m4a"].includes(e)) kw.push("音频", "audio", e);
  else if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(e)) kw.push("压缩", "archive", e);
  else if (e === "pdf") kw.push("pdf", "文档");
  else if (["doc", "docx", "odt"].includes(e)) kw.push("文档", "word", e);
  else if (["xls", "xlsx", "csv"].includes(e)) kw.push("表格", "excel", e);
  else if (["ppt", "pptx"].includes(e)) kw.push("幻灯片", "ppt", e);
  else if (["js", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "c", "h", "java", "cs", "html", "css", "json", "yaml", "yml", "xml", "toml"].includes(e)) kw.push("代码", "code", e);
  else if (["exe", "msi", "bat", "cmd", "ps1", "sh"].includes(e)) kw.push("程序", "exe", e);
  else if (["txt", "md", "log", "ini", "cfg", "conf"].includes(e)) kw.push("文本", "txt", e);
  else if (e) kw.push(e);
  return kw;
}
// 通用命中判断：名称/内容优先（子序列模糊），叠加类型词（子串即可）。任一命中即保留。
function matchItem(query: string, name: string, keywords: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (fuzzyScore(q, name).score > 0) return true;        // 名称/内容（子序列模糊）
  return keywords.some(k => k.toLowerCase().includes(q)); // 类型词（子串即可，"图片""txt"好命中）
}

// ── 增强搜索结果（Ctrl+K 独立视图层；范围=应用 + 中转区 file 条目）──
type EnhResult =
  | { kind: "app";   app: AppInfo;  ranges: [number, number][] }
  | { kind: "stage"; item: StageItem; name: string; ranges: [number, number][] }
  | { kind: "fs";    path: string; name: string; ext: string; isDir: boolean; icon?: string | null }; // 文件系统结果（无 ranges，Rust 侧已打分排序）

// ── 热键 token 工具（录制 + 应用内快捷键匹配 + 展示共用；映射对齐 Rust key_token 54 条）──
const HOTKEY_MAIN_TOKENS = new Set<string>([
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  ...Array.from({length:12},(_,i)=>`f${i+1}`),
  "space","tab","up","down","left","right",
]);
// 浏览器 KeyboardEvent.code → token（KeyA→a / Digit1→1 / F12→f12 / Space→space / Arrow*→方向）
const tokenFromCode = (code: string): string | null => {
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
// 解析 combo 串 → {ctrl,shift,alt,main} 或 null（非法）。规则同 Rust parse_combo：禁 Win + 裸 Alt+Space/Alt+F4，恰 1 主键。
const parseComboStr = (combo: string): {ctrl:boolean;shift:boolean;alt:boolean;main:string} | null => {
  const toks = combo.toLowerCase().split("+").map(s=>s.trim()).filter(Boolean);
  if (toks.some(t => ["win","super","meta","windows"].includes(t))) return null;
  const ctrl = toks.some(t => t==="ctrl"||t==="control");
  const shift = toks.includes("shift");
  const alt = toks.some(t => t==="alt"||t==="option");
  const mains = toks.filter(t => !["ctrl","control","shift","alt","option"].includes(t));
  if (mains.length !== 1 || !HOTKEY_MAIN_TOKENS.has(mains[0])) return null;
  if (alt && !ctrl && !shift && (mains[0]==="space"||mains[0]==="f4"||mains[0]==="tab")) return null; // OS 占用（系统菜单/关窗/窗口切换）
  return {ctrl,shift,alt,main:mains[0]};
};
// keydown 事件是否精确匹配 combo（修饰键全等 + 主键一致；Win 键按下则不匹配）
const matchComboEvent = (e: KeyboardEvent, combo: string): boolean => {
  const p = parseComboStr(combo);
  if (!p) return false;
  if (e.ctrlKey!==p.ctrl || e.shiftKey!==p.shift || e.altKey!==p.alt || e.metaKey) return false;
  return tokenFromCode(e.code) === p.main;
};
// combo 串 → 展示文案（ctrl→Ctrl / 方向→箭头）
const comboLabel = (combo: string): string =>
  combo.split("+").map(t=>t==="ctrl"?"Ctrl":t==="shift"?"Shift":t==="alt"?"Alt":t==="space"?"Space":t==="tab"?"Tab":t==="up"?"↑":t==="down"?"↓":t==="left"?"←":t==="right"?"→":t.toUpperCase()).join("+");

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const [time, setTime] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stage, setStage] = useState<StageItem[]>([]); // 文件中转区：混合条目（文件/文本/图片）
  const [launcher, setLauncher] = useState<LauncherItem[]>([]); // 启动器收藏托盘（手动策展，持久化）
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
  const [store, setStore] = useState<any>(null);
  const [clipboard, setClipboard] = useState<ClipItem[]>([]);
  const [theme, setTheme] = useState<"dark"|"light"|"system">("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [copiedTime, setCopiedTime] = useState<number|null>(null); // 最近"只复制"的剪贴板项 time，用于按钮 ✓ 反馈
  const [copiedStageId, setCopiedStageId] = useState<number|null>(null); // 中转条目"复制到剪贴板"的 ✓ 反馈
  const [imgCacheCleared, setImgCacheCleared] = useState(false); // 设置面板「清空缓存」✓ 反馈
  const [launchAnim, setLaunchAnim] = useState<LaunchAnim|null>(null); // 启动放大暂留动画的克隆数据，null=无动画
  const [dismissing, setDismissing] = useState(false); // 覆盖层「快速淡出露桌面」——启动应用与剪贴板粘贴共用同一套消失观感
  const [clipCacheMax, setClipCacheMax] = useState(20); // 剪贴板历史保存条数（与 Rust CLIP_CACHE_MAX_RUNTIME 同步）
  const [hotkeyCombo, setHotkeyCombo] = useState("ctrl+space"); // 呼出热键（与 Rust HOTKEY_VK_KEYS 同步）
  const [hotkeyInput, setHotkeyInput] = useState("ctrl+space"); // 设置面板输入框编辑态
  const [hotkeyError, setHotkeyError] = useState(""); // 切换失败提示（如被其他应用占用），3s 后自动清
  const [enhHotkey, setEnhHotkey] = useState("ctrl+k"); // 增强搜索呼出键（应用内快捷键，纯前端，不经 Rust）
  const [enhHotkeyInput, setEnhHotkeyInput] = useState("ctrl+k"); // 增强搜索键输入框编辑态
  const [enhHotkeyError, setEnhHotkeyError] = useState(""); // 增强搜索键校验提示，2.5s 自清
  const [recording, setRecording] = useState<null|"main"|"enh">(null); // 录制态：录哪个键（监听物理按键写回对应输入框，不自动应用）
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null); // 自定义右键菜单
  const [autostartEnabled, setAutostartEnabled] = useState(false); // 开机自启
  const ctxMenuRef = useRef<CtxMenu>(null); // Esc 处理用（闭包快照避免加入 keydown deps）
  const clipCacheMaxRef = useRef(20); clipCacheMaxRef.current = clipCacheMax; // 供 clipboard-update 闭包读最新值
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const appsRef = useRef<AppInfo[]>(apps); appsRef.current = apps; // 供 [visible] 兜底扫描闭包读最新 apps（apps-ready 是否已填充）
  const launchingRef = useRef(false); // 防连点/重复触发（setState 异步，用 ref 即时锁）
  const stageRef = useRef<StageItem[]>(stage); stageRef.current = stage; // 给 []-注册的 files-dropped 监听取最新 stage（避开闭包过期）
  const launcherRef = useRef<LauncherItem[]>(launcher); launcherRef.current = launcher; // 给 []-注册监听用（S3b 拖入落点会用到，先备好）
  const storeRef = useRef<any>(null); storeRef.current = store;
  const [stageSel, setStageSel] = useState<Set<number>>(new Set<number>()); // 中转区多选（选中的 StageItem.id）
  const [stageMultiselect, setStageMultiselect] = useState(false); // 多选模式开关（显式进入，非按住修饰键）
  const [stageLayout, setStageLayout] = useState<"list"|"grid">("list"); // 中转区布局：列表 / 方格
  const [batchCopied, setBatchCopied] = useState(false); // 批量复制 ✓ 反馈
  const stageSelRef = useRef<Set<number>>(new Set<number>()); stageSelRef.current = stageSel; // 供 Esc keydown 闭包读最新（仿 ctxMenuRef 模式）
  const stageMultiselectRef = useRef(false); stageMultiselectRef.current = stageMultiselect; // 同上
  const stageAnchorRef = useRef<number|null>(null); // shift 区间选择锚点 index
  // 剪贴板卡片长按拖拽到中转区（纯前端，Pointer Events，移动超阈值才激活）
  const [dragState, setDragState] = useState<{ item: ClipItem; originX: number; originY: number; currentX: number; currentY: number; active: boolean } | null>(null);
  const dragStateRef = useRef(dragState); // 供 pointermove/up 闭包读最新值（setState 异步）
  useEffect(() => { dragStateRef.current = dragState; }, [dragState]);
  const dropAreaRef = useRef<HTMLDivElement | null>(null); // 中转区 .drop-area，命中检测用
  const launcherDropRef = useRef<HTMLDivElement | null>(null); // 启动器 .app-grid，OLE 拖入落点判断用
  const suppressClickRef = useRef(false); // 激活拖拽后抑制随之而来的 onClick（防拖拽落点误触发粘贴）
  // 中转区鼠标框选多选（续70，纯前端）：在 .drop-area 空白处按下拖拽，扫过的条目实时选中
  type LassoState = { active: boolean; origin: { x: number; y: number }; current: { x: number; y: number } };
  const [lassoState, setLassoState] = useState<LassoState>({ active: false, origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } });
  const lassoStateRef = useRef(lassoState); lassoStateRef.current = lassoState; // 供 move/up 闭包读最新值（仿 stageSelRef 渲染时同步）
  const lassoArmedRef = useRef(false); // down 通过排除判定才布防；move/up 据此区分「框选拖拽」与「条目上拖拽」
  // 中转条目拖出（续71）：按下记录起点，move 超阈值 → emit drag-out-begin（Rust 接管 OLE DoDragDrop）
  const dragOutRef = useRef<{ pressing: boolean; itemId: number | null; origin: { x: number; y: number }; draggedIds: number[] }>({ pressing: false, itemId: null, origin: { x: 0, y: 0 }, draggedIds: [] });
  const suppressStageClickRef = useRef(false); // 拖出触发后抑制随之而来的 onClick（防误触取走粘贴）
  // 外部文件拖入窗口时的悬停高亮（HTML5 dragenter/dragleave，与 OLE IDropTarget 正交）
  const [fileDragOver, setFileDragOver] = useState(false);
  // 增强搜索（Ctrl+K 独立全屏视图层；同一 overlay 内的视图层，不开新窗、不碰 show/hide/焦点/粘贴高危区）
  const [enhOpen, setEnhOpen] = useState(false);
  const [enhPinned, setEnhPinned] = useState(false); // true=打字触发（顶栏为输入框，不覆盖顶栏）；false=Ctrl+K触发（全覆盖+独立搜索框）
  const [enhQuery, setEnhQuery] = useState("");
  const [enhSelIdx, setEnhSelIdx] = useState(0);
  const [enhAdded, setEnhAdded] = useState<{path:string;target:"stage"|"launcher"}|null>(null); // 操作按钮 ✓ 反馈
  const enhInputRef = useRef<HTMLInputElement>(null);
  const enhOpenRef = useRef(false); enhOpenRef.current = enhOpen; // 供 Esc keydown 闭包读最新
  const enhPinnedRef = useRef(false); enhPinnedRef.current = enhPinned; // 供 onChange 闭包读最新 pinned 状态
  const pageSearchForcedRef = useRef(false); // enhanced 模式下用户主动按 Ctrl+K 切到界面搜索，本次呼出有效
  // 文件系统搜索结果（S4b）：增强搜索 Tier 2，来自 Rust 后台索引 search_files；150ms 防抖查询；icon 随结果同步返回
  const [fsResults, setFsResults] = useState<{ path: string; name: string; ext: string; isDir: boolean; icon?: string | null }[]>([]);
  const [indexReady, setIndexReady] = useState(false); // 文件索引是否就绪（未就绪时显示「建立中…」，不阻塞 Tier 1）
  // 搜索引擎（续57）：内置自建索引 / 可选 Everything；持久化 store，运行时由 Rust set_search_engine 应用
  const [searchEngine, setSearchEngine] = useState<"builtin"|"everything">("builtin");
  const [searchDirs, setSearchDirs] = useState<string[]>([]); // 内置引擎额外扫描根目录（如 D:\）
  const [searchDirInput, setSearchDirInput] = useState(""); // 添加目录输入框
  const [everythingAvailable, setEverythingAvailable] = useState(false); // Everything 是否可用（DLL 加载且服务运行）
  const [evtRedetected, setEvtRedetected] = useState(false); // 「重新检测」✓ 反馈
  // 呼出默认搜索模式：page=顶栏界面搜索（默认），enhanced=直接进增强搜索层
  const [searchDefaultMode, setSearchDefaultMode] = useState<"page"|"enhanced">("page");
  const searchDefaultModeRef = useRef<"page"|"enhanced">("page");
  searchDefaultModeRef.current = searchDefaultMode;
  // 启动器「添加应用」picker 模态（复用 settings-modal 样式）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerOpenRef = useRef(false); pickerOpenRef.current = pickerOpen; // 供 Esc keydown 闭包读最新
  const pickerInputRef = useRef<HTMLInputElement>(null);

  // 同步 ctxMenu ref（供 keydown 闭包读取，无需加入 deps）
  useEffect(() => { ctxMenuRef.current = ctxMenu; }, [ctxMenu]);
  // 点外任意处关闭右键菜单（mousedown 先于 click，不影响 click 回调）
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  // ── 时钟 ──
  useEffect(() => { const u=()=>setTime(new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})); u(); const t=setInterval(u,1000); return ()=>clearInterval(t); }, []);

  // ── 主题：把 theme 解析为 data-theme（"system" 跟随 OS prefers-color-scheme 并实时响应切换）──
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { const resolved = theme==="system" ? (mq.matches?"dark":"light") : theme; document.documentElement.setAttribute("data-theme", resolved); };
    apply();
    if (theme==="system") { mq.addEventListener("change", apply); return ()=>mq.removeEventListener("change", apply); }
  }, [theme]);

  // ── Store ──
  useEffect(() => { (async()=>{ try { const {load}=await import("@tauri-apps/plugin-store"); const s=await load("workbench-data.json",{autoSave:true,defaults:{}}); setStore(s); const raw=await s.get<Record<string,number|AppUsage>>("app-frequency")??{}; const nowS=Math.floor(Date.now()/1000); const usage:Record<string,AppUsage>={}; for(const[k,v]of Object.entries(raw)){ usage[k]= typeof v==="number" ? {count:v,last_used:nowS} : v; } setAppUsage(usage); const savedTheme=await s.get<string>("theme"); if(savedTheme==="dark"||savedTheme==="light"||savedTheme==="system") setTheme(savedTheme); const savedMax=await s.get<number>("clip-cache-max"); if(typeof savedMax==="number"&&savedMax>=10&&savedMax<=100){ setClipCacheMax(savedMax); clipCacheMaxRef.current=savedMax; try{const{invoke}=await import("@tauri-apps/api/core");await invoke("set_clip_cache_max",{n:savedMax});}catch{} } const savedHotkey=await s.get<string>("hotkey-combo"); if(typeof savedHotkey==="string"&&savedHotkey.trim()){const hk=savedHotkey.trim();setHotkeyCombo(hk);setHotkeyInput(hk);} /* 不 invoke set_hotkey——Rust setup 已按 store 同步落地，避免重复注册 */ const savedEnh=await s.get<string>("enh-hotkey"); if(typeof savedEnh==="string"&&savedEnh.trim()&&parseComboStr(savedEnh.trim())){const eh=savedEnh.trim();setEnhHotkey(eh);setEnhHotkeyInput(eh);} /* 增强搜索键纯前端，无需 invoke */ const savedEngine=await s.get<string>("search-engine"); const savedDirs=await s.get<string[]>("search-dirs")??[]; const eng:("builtin"|"everything")=savedEngine==="everything"?"everything":"builtin"; setSearchEngine(eng); setSearchDirs(savedDirs); try{const{invoke}=await import("@tauri-apps/api/core"); if(savedDirs.length){await invoke("set_search_dirs",{dirs:savedDirs});} /* 空目录无需 invoke：默认已扫用户目录，避免启动期冗余重建 */ await invoke("set_search_engine",{engine:eng});}catch{} const savedStage=await s.get<StageItem[]>("stage-items"); if(savedStage&&savedStage.length){ setStage(savedStage.slice(0,STAGE_MAX)); } else { const fps=await s.get<string[]>("file-list")??[]; if(fps.length){ const {invoke}=await import("@tauri-apps/api/core"); const items:StageItem[]=[]; for(const fp of fps.slice(0,STAGE_MAX)){ try { items.push(fileEntryToStage(await invoke<FileEntry>("get_file_info",{path:fp}))); } catch{} } setStage(items); } } const savedLauncher=await s.get<LauncherItem[]>("launcher-items"); if(savedLauncher&&savedLauncher.length){ setLauncher(savedLauncher.slice(0,LAUNCHER_MAX)); } const savedStageLayout=await s.get<string>("stage-layout"); if(savedStageLayout==="list"||savedStageLayout==="grid")setStageLayout(savedStageLayout); const savedSearchMode=await s.get<string>("search-default-mode"); if(savedSearchMode==="enhanced"||savedSearchMode==="page")setSearchDefaultMode(savedSearchMode as "enhanced"|"page"); } catch{} })(); }, []);

  // ── 开机自启：启动时读取当前状态 ──
  useEffect(() => { (async()=>{ try { const {invoke}=await import("@tauri-apps/api/core"); const enabled=await invoke<boolean>("plugin:autostart|is_enabled"); setAutostartEnabled(enabled); } catch{} })(); }, []);

  const saveStage = useCallback(async (list:StageItem[]) => { setStage(list); if(store){ await store.set("stage-items",list); await store.save(); } }, [store]);
  const saveLauncher = useCallback(async (list:LauncherItem[]) => { setLauncher(list); if(store){ await store.set("launcher-items",list); await store.save(); } }, [store]);
  const changeStageLayout = useCallback(async (v:"list"|"grid") => { setStageLayout(v); if(store){ await store.set("stage-layout",v); await store.save(); } }, [store]);
  const changeSearchDefaultMode = useCallback(async (v:"page"|"enhanced") => { setSearchDefaultMode(v); if(store){ await store.set("search-default-mode",v); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const cur=appUsage[p]; const u={...appUsage,[p]:{count:(cur?.count??0)+1,last_used:Math.floor(Date.now()/1000)}}; setAppUsage(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appUsage,store]);

  // ── 核心：事件监听（只注册一次，依赖[]）。可见性唯一真相在 Rust，前端只同步 ──
  useEffect(() => {
    let cleanup: (() => void)[] = [];
    let fileDragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un1 = await listen("hotkey-show", () => setVisible(true));
        const un2 = await listen("hotkey-hide", () => { setVisible(false); setLaunchAnim(null); setDismissing(false); launchingRef.current = false; setStageSel(new Set<number>()); setStageMultiselect(false); stageAnchorRef.current = null; setLassoState({active:false,origin:{x:0,y:0},current:{x:0,y:0}}); lassoArmedRef.current=false; dropAreaRef.current?.classList.remove("lasso-active"); setEnhOpen(false); setEnhPinned(false); setEnhQuery(""); setEnhSelIdx(0); setFsResults([]); setPickerOpen(false); setPickerQuery(""); setSearch(""); pageSearchForcedRef.current=false; }); // 复位
        const un3 = await listen("clipboard-update", (event: any) => {
          const item: ClipItem = { type: event.payload.type as "text"|"image"|"file", content: event.payload.content, time: event.payload.time, items: event.payload.items, count: event.payload.count, orig_path: event.payload.orig_path };
          setClipboard(prev => {
            const filtered = prev.filter(x => {
              if (item.type === "file" && x.type === "file") return x.items?.[0]?.path !== item.items?.[0]?.path;
              if (item.type !== "file" && x.type !== "file") return x.content !== item.content;
              return true; // 不同类型保留
            });
            return [item, ...filtered].slice(0, clipCacheMaxRef.current);
          });
        });
        // 原生拖入（S3b）：落点在启动器区→入启动器，否则→入中转（兜底）；落地区域闪烁确认。
        // pt 是 Windows 屏幕物理像素，÷ devicePixelRatio 转 CSS px 后与 getBoundingClientRect 比对。
        const un4 = await listen("files-dropped", async (event: any) => {
          const payload = event.payload as { paths: string[]; x: number; y: number };
          const paths = payload.paths ?? [];
          if (!paths.length) return;
          const cssX = payload.x / window.devicePixelRatio;
          const cssY = payload.y / window.devicePixelRatio;
          const launcherRect = launcherDropRef.current?.getBoundingClientRect();
          const inLauncher = !!launcherRect && cssX >= launcherRect.left && cssX <= launcherRect.right && cssY >= launcherRect.top && cssY <= launcherRect.bottom;
          const { invoke } = await import("@tauri-apps/api/core");
          if (inLauncher) {
            // 落点在启动器：.lnk → resolve_lnk → kind:"app"；其余 → get_file_info → file/folder
            let next = [...launcherRef.current];
            for (const p of paths) {
              try {
                if (next.length >= LAUNCHER_MAX) break;
                if (next.some(x => x.path === p)) continue; // 原始路径去重
                let newItem: LauncherItem;
                if (p.toLowerCase().endsWith(".lnk")) {
                  const lnk = await invoke<{ name: string; path: string; icon: string | null }>("resolve_lnk", { path: p });
                  newItem = { id: launcherId(), kind: "app", name: lnk.name, icon: lnk.icon, path: lnk.path };
                } else {
                  const f = await invoke<FileEntry>("get_file_info", { path: p });
                  newItem = { id: launcherId(), kind: f.isDir ? "folder" : "file", name: f.name, path: f.path, ext: f.ext };
                }
                next = [...next, newItem];
              } catch {}
            }
            next = next.slice(0, LAUNCHER_MAX);
            setLauncher(next);
            if (storeRef.current) { try { await storeRef.current.set("launcher-items", next); await storeRef.current.save(); } catch {} }
            launcherDropRef.current?.classList.add("drop-flash");
            setTimeout(() => launcherDropRef.current?.classList.remove("drop-flash"), 200);
          } else {
            // 落点在中转区或区域外（兜底）：转 StageItem 入中转（原有行为）
            const built: StageItem[] = [];
            for (const p of paths) { try { built.push(fileEntryToStage(await invoke<FileEntry>("get_file_info", { path: p }))); } catch {} }
            if (!built.length) return;
            let next = [...stageRef.current];
            for (const it of built) {
              if (next.length >= STAGE_MAX) break;
              if (next.some(s => s.type === "file" && s.items?.[0]?.path === it.items?.[0]?.path)) continue;
              next.push(it);
            }
            next = next.slice(0, STAGE_MAX);
            setStage(next);
            if (storeRef.current) { try { await storeRef.current.set("stage-items", next); await storeRef.current.save(); } catch {} }
            dropAreaRef.current?.classList.add("drop-flash");
            setTimeout(() => dropAreaRef.current?.classList.remove("drop-flash"), 200);
          }
          setFileDragOver(false);
          // 拖入后回焦点，让 Esc 可用
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setFocus(); } catch {}
        });
        // 文件索引就绪（S4b）：后台线程每次建/重建完成 emit 条目数，>0 视为就绪
        const un5 = await listen("file-index-ready", (e: any) => setIndexReady((e.payload ?? 0) > 0));
        // 应用扫描就绪（S4c）：后台预扫线程扫完一次性推送 apps，呼出前填充、消除首次卡顿
        const un6 = await listen("apps-ready", (e: any) => { const list = (e.payload ?? []) as AppInfo[]; if (list.length) setApps(list); });
        // 外部文件拖入悬停高亮（S5a）：Rust DragEnter/DragLeave emit，前端 100ms 防抖过滤 HWND 间快速 leave-enter
        const un7 = await listen("file-drag-enter", () => {
          if (fileDragLeaveTimer) { clearTimeout(fileDragLeaveTimer); fileDragLeaveTimer = null; }
          setFileDragOver(true);
        });
        const un8 = await listen("file-drag-leave", () => {
          fileDragLeaveTimer = setTimeout(() => setFileDragOver(false), 100);
        });
        // 拖出完成（续71）：effect==="move" → 从中转区移除被拖出的条目（draggedIds 在拖出触发时已快照）；
        // copy/取消(Esc)/none → 保留。overlay 已被 Rust 隐藏，此处只改状态 + 落盘，用户重按热键再呼出。
        const un9 = await listen<string>("drag-out-done", async (event) => {
          const dr = dragOutRef.current;
          if (event.payload === "move" && dr.draggedIds.length) {
            const ids = new Set(dr.draggedIds);
            const next = stageRef.current.filter(s => !ids.has(s.id));
            setStage(next);
            setStageSel(new Set<number>());
            setStageMultiselect(false);
            if (storeRef.current) { try { await storeRef.current.set("stage-items", next); await storeRef.current.save(); } catch {} }
          }
          dr.draggedIds = [];
        });
        cleanup = [un1, un2, un3, un4, un5, un6, un7, un8, un9];
      } catch (e) { console.error("listen error:", e); }
    })();
    return () => { cleanup.forEach(fn => fn()); if (fileDragLeaveTimer) clearTimeout(fileDragLeaveTimer); };
  }, []);

  // ── 窗口显示时从后台缓存加载剪贴板历史（毫秒级）──
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
        if (history.length) {
          setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
        }
      } catch {}
    })();
    // 应用列表：现由后台预扫线程（start_apps_worker）提前填充并 emit("apps-ready")，呼出时通常已就绪。
    // 此处仅作兜底：首次 visible 时若 apps 仍空（apps-ready 还没到/被错过），才 invoke scan_start_menu
    // 兜底（命中 APP_CACHE、近乎瞬时）；否则跳过、不重复扫描。
    if (!loadedRef.current) {
      loadedRef.current = true;
      if (appsRef.current.length === 0) {
        (async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const list = await invoke<AppInfo[]>("scan_start_menu");
            // 不在此处定死顺序：排序交给 sortedApps（响应 appUsage 变化，刚用过的 app 下次浮上来）
            if (list.length) setApps(list);
          } catch {}
        })();
      }
    }
    setTimeout(() => searchRef.current?.focus(), 100);
  }, [visible]);

  // ── 按使用打分排序（频率为主×近期乘数：常用且近期用过的浮前；同分按名字兜底）──
  const sortedApps = useMemo(() => { const nowS=Math.floor(Date.now()/1000); return [...apps].sort((a,b) =>
    usageScore(appUsage[b.path],nowS) - usageScore(appUsage[a.path],nowS) || a.name.localeCompare(b.name)
  ); }, [apps, appUsage]);

  // ── 搜索过滤（模糊打分 + 相关度排序）。统一输出 {app, ranges}，空查询时 ranges 为空 ──
  const filteredApps = useMemo<{ app: AppInfo; ranges: [number, number][] }[]>(() => {
    const query = search.trim();
    if (!query) return sortedApps.slice(0, 200).map(app => ({ app, ranges: [] }));
    const nowS = Math.floor(Date.now()/1000);
    return sortedApps
      .map(app => {
        const nameR = fuzzyScore(query, app.name);
        const basename = app.path.split(/[\\/]/).pop() ?? "";
        const pathScore = fuzzyScore(query, basename).score * 0.6; // path basename 降权
        const useName = nameR.score >= pathScore;
        return { app, score: useName ? nameR.score : pathScore, ranges: useName ? nameR.ranges : [] };
      })
      .filter(it => it.score > 0) // 子序列不成立的淘汰
      .sort((a, b) =>
        b.score - a.score                                                              // 相关度降序
        || usageScore(appUsage[b.app.path],nowS) - usageScore(appUsage[a.app.path],nowS) // 同分按使用打分
        || a.app.name.localeCompare(b.app.name))                                       // 再按字母
      .slice(0, 200)
      .map(({ app, ranges }) => ({ app, ranges }));
  }, [search, sortedApps, appUsage]);

  // ── 增强搜索 Tier 1（应用 + 中转区 file 条目；空查询=常用应用兜底，可直接 Enter）──
  // 有查询时上限 10（D5）；空查询兜底仍给 30 常用应用（此时无文件结果，总数 ≤30 不超）。
  const enhTier1 = useMemo<EnhResult[]>(() => {
    const q = enhQuery.trim();
    const nowS = Math.floor(Date.now() / 1000);
    if (!q) return sortedApps.slice(0, 30).map(app => ({ kind: "app" as const, app, ranges: [] as [number, number][] }));
    const appHits = apps.map(app => { const r = fuzzyScore(q, app.name); return { kind: "app" as const, app, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    const stageHits = stage.filter(s => s.type === "file").map(s => { const nm = s.name || s.items?.[0]?.name || "文件"; const r = fuzzyScore(q, nm); return { kind: "stage" as const, item: s, name: nm, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    return [...appHits, ...stageHits]
      .sort((a, b) => b.score - a.score || (a.kind === "app" && b.kind === "app" ? usageScore(appUsage[b.app.path], nowS) - usageScore(appUsage[a.app.path], nowS) : 0))
      .slice(0, 10)
      .map(({ score, ...rest }) => rest as EnhResult);
  }, [enhQuery, apps, stage, sortedApps, appUsage]);

  // ── 文件查询：150ms 防抖（每次 search_files 是 Rust 命令往返，避免逐键 invoke）──
  useEffect(() => {
    if (!enhOpen) return;
    const q = enhQuery.trim();
    if (!q) { setFsResults([]); return; }
    // Everything 覆盖全盘、结果量大，给更高 limit；内置仅用户目录，50 足够
    const lim = searchEngine==="everything" ? ENH_FILE_LIMIT_EVERYTHING : ENH_FILE_LIMIT_BUILTIN;
    const t = setTimeout(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<{ path: string; name: string; ext: string; isDir: boolean }[]>("search_files", { query: q, limit: lim });
        setFsResults(r);
      } catch { setFsResults([]); }
    }, 150);
    return () => clearTimeout(t);
  }, [enhQuery, enhOpen, searchEngine]);

  // 增强搜索/设置打开或引擎切换时主动查一次状态（含 Everything 可用性；事件 file-index-ready 之外的兜底）
  useEffect(() => {
    if (!enhOpen && !settingsOpen) return;
    (async () => { try { const { invoke } = await import("@tauri-apps/api/core"); const s = await invoke<{ ready: boolean; count: number; everythingAvailable: boolean }>("get_index_status"); setIndexReady(s.ready); setEverythingAvailable(!!s.everythingAvailable); } catch {} })();
  }, [enhOpen, settingsOpen, searchEngine]);

  // 长结果列表下让键盘选中项滚入视野（否则 ↑↓ 导航会移出可视区）
  useEffect(() => {
    if (!enhOpen) return;
    document.querySelector(".enh-result.selected")?.scrollIntoView({ block: "nearest" });
  }, [enhSelIdx, enhOpen]);

  // ── 增强搜索合并结果：Tier 1（应用/中转）在前，Tier 2（文件，量由引擎决定）在后；索引连续供 ↑↓/Enter 跨组导航 ──
  const enhResults = useMemo<EnhResult[]>(() => {
    const tier2: EnhResult[] = fsResults.slice(0, ENH_FILE_LIMIT_EVERYTHING).map(f => ({ kind: "fs" as const, path: f.path, name: f.name, ext: f.ext, isDir: f.isDir, icon: f.icon }));
    return [...enhTier1, ...tier2];
  }, [enhTier1, fsResults]);

  // ── 启动器「添加应用」picker 结果：排除已加入的 app，空查询=常用前 50，有查询=fuzzyScore 排序 ──
  const pickerResults = useMemo<{ app: AppInfo; ranges: [number, number][] }[]>(() => {
    const q = pickerQuery.trim();
    const base = sortedApps.filter(a => !launcher.some(x => x.kind === "app" && x.path === a.path)); // 排除已加入
    if (!q) return base.slice(0, 50).map(app => ({ app, ranges: [] as [number, number][] }));
    return base.map(app => { const r = fuzzyScore(q, app.name); return { app, score: r.score, ranges: r.ranges }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 50).map(({ app, ranges }) => ({ app, ranges }));
  }, [pickerQuery, sortedApps, launcher]);

  // ── 顶栏普通搜索：三区联动过滤（与 Ctrl+K 增强搜索的 enhQuery 完全独立）──
  // 中转区：名称/内容优先 + 类型词叠加；空查询=全量
  const filteredStage = useMemo(() => {
    const q = search.trim();
    if (!q) return stage;
    return stage.filter(s => {
      const name = s.type === "text" ? (s.content || "") : s.type === "image" ? "图片" : (s.name || s.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: s.type, ext: s.ext ?? s.items?.[0]?.ext, isImage: s.items?.[0]?.isImage }));
    });
  }, [stage, search]);
  // 剪贴板历史：同上
  const filteredClip = useMemo(() => {
    const q = search.trim();
    if (!q) return clipboard;
    return clipboard.filter(c => {
      const name = c.type === "text" ? (c.content || "") : c.type === "image" ? "图片" : (c.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: c.type, ext: c.items?.[0]?.ext, isImage: c.items?.[0]?.isImage }));
    });
  }, [clipboard, search]);
  // 启动器过滤：有 search 时按名称模糊过滤，无 search 直接返回原列表（持久化/拖入/picker 行为不受影响）
  const filteredLauncher = useMemo(() => {
    const q = search.trim();
    if (!q) return launcher;
    return launcher.filter(it => matchItem(q, it.name, []));
  }, [launcher, search]);

  // ── 操作函数 ──
  const launchApp = useCallback((app:AppInfo, iconEl?:HTMLElement|null) => {
    if (launchingRef.current) return; // 防连点：动画进行中忽略后续触发
    recordUse(app.path);
    // 立即发起启动，不等动画——app 照常秒开，只把覆盖层的「消失」动画化
    import("@tauri-apps/api/core").then(({invoke})=>invoke("launch_app",{path:app.path})).catch(()=>{});
    // 无障碍 / 拿不到图标坐标：跳过动画，沿用即时隐藏（与改造前一致）
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !iconEl) { hideWorkbench(); return; }
    // 放大暂留：克隆图标到顶层浮层做 scale+淡出，覆盖层整体淡出露桌面，LAUNCH_ANIM_MS 后再 Rust hide
    launchingRef.current = true;
    const r = iconEl.getBoundingClientRect();
    setLaunchAnim({ icon: app.icon, name: app.name, rect: { top:r.top, left:r.left, width:r.width, height:r.height } });
    setDismissing(true); // 覆盖层淡出（与剪贴板粘贴共用）
    setTimeout(() => hideWorkbench(), LAUNCH_ANIM_MS);
  }, [recordUse]);
  // 增强搜索激活：app 复用 launchApp（含放大动画+淡出+hide，不在此 setEnhOpen，让整层随 overlay dismiss 一起淡出，hotkey-hide 复位）；
  // stage file 走 hide + open_file（fire-and-forget）。两条都不碰粘贴/焦点交还/CLIPBOARD_LOCK。
  const activateEnh = useCallback((r: EnhResult, iconEl?: HTMLElement | null) => {
    if (r.kind === "app") { launchApp(r.app, iconEl ?? null); }
    else if (r.kind === "fs") { hideWorkbench(); import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_file", { path: r.path })).catch(() => {}); }
    else { hideWorkbench(); import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_file", { path: r.item.items![0].path })).catch(() => {}); }
  }, [launchApp]);
  // 注：原生拖入（drag-in）已废弃——全屏 transparent+alwaysOnTop+focus:false 覆盖层收不到任何 OLE 拖放事件（阶段2 实测：零事件+红色禁止），且全屏会盖住拖拽源。改走剪贴板 📌 钉入。详见 DECISIONS §14。

  // ── 启动器（收藏托盘）操作 ──
  // 左键打开/启动条目：app→launchApp（含放大动画+hide）；file/folder→open_file。由区决定动作，不走粘贴/焦点交还/CLIPBOARD_LOCK。
  const openLauncherItem = useCallback((it:LauncherItem, iconEl?:HTMLElement|null) => {
    if (it.kind === "app") {
      launchApp({ name: it.name, path: it.path, icon: it.icon ?? null }, iconEl ?? null);
    } else {
      hideWorkbench();
      import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:it.path})).catch(()=>{});
    }
  }, [launchApp]);
  // 从 app picker 加入应用（按 path 去重）
  const addAppToLauncher = useCallback((app:AppInfo) => {
    if (launcher.some(x=>x.kind==="app" && x.path===app.path)) return;
    saveLauncher([...launcher, { id:launcherId(), kind:"app" as const, name:app.name, icon:app.icon, path:app.path }].slice(0,LAUNCHER_MAX));
  }, [launcher, saveLauncher]);
  // 增强搜索 fs 结果加入中转区（按 path 去重，置顶）
  const addFsToStage = useCallback(async (r:{path:string;name:string;ext:string;isDir:boolean}) => {
    if (stage.some(s => s.items?.[0]?.path === r.path)) return;
    const isImage = IMG_EXTS.includes((r.ext||"").toLowerCase());
    let icon: string | null = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<FileEntry>("get_file_info", { path: r.path });
      icon = info.icon ?? null;
    } catch {}
    const item: StageItem = { id:stageId(), type:"file", items:[{path:r.path,name:r.name,ext:r.ext,isImage,icon}], count:1, name:r.name, ext:r.ext, isDir:r.isDir };
    saveStage([item, ...stage].slice(0, STAGE_MAX));
  }, [stage, saveStage]);
  // 增强搜索 fs 结果加入启动台（按 path 去重）
  const addFsToLauncher = useCallback((r:{path:string;name:string;ext?:string;isDir:boolean}) => {
    if (launcher.some(x => x.path === r.path)) return;
    saveLauncher([...launcher, {id:launcherId(), kind:r.isDir?"folder" as const:"file" as const, name:r.name, icon:null, path:r.path, ext:r.ext}].slice(0,LAUNCHER_MAX));
  }, [launcher, saveLauncher]);
  // 从启动器移除（右键）
  const removeLauncherItem = useCallback((id:number) => { saveLauncher(launcher.filter(x=>x.id!==id)); }, [launcher, saveLauncher]);

  const removeStage = useCallback((id:number) => { saveStage(stage.filter(s=>s.id!==id)); }, [stage,saveStage]);
  // 剪贴板项「钉到中转」：同类型同内容已在则不重复；新项置顶；单文件异步补全 Windows 图标
  const addToStage = useCallback(async (c:ClipItem) => {
    const exists = stage.some(s => s.type===c.type && (c.type==="file" ? s.items?.[0]?.path===c.items?.[0]?.path : s.content===c.content));
    if (exists) return;
    let item = clipToStage(c);
    if (c.type==="file" && (c.count??0)<=1 && c.items?.[0]?.path && item.items?.[0]) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<FileEntry>("get_file_info", { path: c.items[0].path });
        if (info.icon) item = { ...item, items: [{ ...item.items![0], icon: info.icon }] };
      } catch {}
    }
    saveStage([item, ...stage].slice(0,STAGE_MAX));
  }, [stage,saveStage]);
  // 拖拽：按下记录起点（不立刻激活，等移动超阈值），但跳过 .clip-actions 内的按钮区，且仅左键
  const handleClipPointerDown = useCallback((e: React.PointerEvent, c: ClipItem) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".clip-actions")) return; // 复制/删除/📌 按钮区不参与拖拽
    suppressClickRef.current = false; // 每次新交互复位，避免上次拖拽残留误抑制本次点击
    setDragState({ item: c, originX: e.clientX, originY: e.clientY, currentX: e.clientX, currentY: e.clientY, active: false });
    e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针，移动出卡片也持续收到 move/up
  }, []);
  // 拖拽：移动超阈值激活；激活后跟手并按命中与否高亮中转区
  const handleClipPointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    if (!ds.active) {
      if (Math.hypot(e.clientX - ds.originX, e.clientY - ds.originY) < DRAG_THRESHOLD_PX) return;
      document.getElementById("overlay")?.classList.add("dragging"); // 防泛蓝 + grabbing 光标
      setDragState({ ...ds, active: true, currentX: e.clientX, currentY: e.clientY });
      return;
    }
    const rect = dropAreaRef.current?.getBoundingClientRect();
    const over = !!rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    dropAreaRef.current?.classList.toggle("drag-over", over);
    setDragState({ ...ds, currentX: e.clientX, currentY: e.clientY });
  }, []);
  // 拖拽结束：仅在激活且落点命中中转区时入中转（不粘贴）；未激活则放手让 onClick 正常粘贴
  const handleClipPointerUp = useCallback((e: React.PointerEvent) => {
    const ds = dragStateRef.current;
    document.getElementById("overlay")?.classList.remove("dragging");
    dropAreaRef.current?.classList.remove("drag-over");
    setDragState(null);
    if (!ds?.active) return; // 短按 / cancel：不拦截，交给原有 onClick 粘贴
    suppressClickRef.current = true; // 抑制紧随的 onClick（落点处可能触发粘贴）
    const rect = dropAreaRef.current?.getBoundingClientRect();
    if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) addToStage(ds.item);
  }, [addToStage]);
  // ── 中转区框选多选（续70）──
  // 实时计算选区矩形与各条目 DOM 的相交，命中者写入 stageSel；与显式多选共用同一套状态。
  const computeLassoSelection = useCallback((origin:{x:number;y:number}, current:{x:number;y:number}) => {
    const l = Math.min(origin.x, current.x), r = Math.max(origin.x, current.x);
    const t = Math.min(origin.y, current.y), b = Math.max(origin.y, current.y);
    const sel = new Set<number>();
    // 列表/方格两种布局分别查不同选择器（move 时按当前 stageLayout 决定）
    dropAreaRef.current?.querySelectorAll<HTMLElement>(stageLayout==="grid"?".stage-card":".stage-item").forEach(el => {
      const rc = el.getBoundingClientRect();
      if (rc.left <= r && rc.right >= l && rc.top <= b && rc.bottom >= t) { // 矩形相交
        const id = Number(el.dataset.stageId);
        if (!Number.isNaN(id)) sel.add(id);
      }
    });
    setStageSel(sel);
  }, [stageLayout]);
  const handleLassoPointerDown = useCallback((e: React.PointerEvent) => {
    lassoArmedRef.current = false;
    if (e.button !== 0) return; // 仅左键
    if (dragStateRef.current?.active) return; // 剪贴板卡片拖拽进行中不框选（复用现有 dragState 检查）
    // 命中条目 / 操作按钮 / 工具栏则交给原有点击逻辑，不框选
    if ((e.target as Element).closest(".stage-item,.stage-card,.stage-multi-toolbar,.stage-batch-bar,button")) return;
    lassoArmedRef.current = true;
    setLassoState({ active: false, origin: { x: e.clientX, y: e.clientY }, current: { x: e.clientX, y: e.clientY } });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // 不立即激活——等 move 超阈值
  }, []);
  const handleLassoPointerMove = useCallback((e: React.PointerEvent) => {
    if (!lassoArmedRef.current) return; // 未布防（如在条目上按下拖拽）
    if (e.buttons === 0) return; // 未按下
    const ls = lassoStateRef.current;
    const cur = { x: e.clientX, y: e.clientY };
    if (!ls.active) {
      if (Math.hypot(cur.x - ls.origin.x, cur.y - ls.origin.y) <= LASSO_THRESHOLD_PX) return; // 未超阈值不激活
      dropAreaRef.current?.classList.add("lasso-active"); // user-select:none + crosshair
      setLassoState({ ...ls, active: true, current: cur });
      setStageMultiselect(true);
      computeLassoSelection(ls.origin, cur);
      return;
    }
    setLassoState({ ...ls, current: cur }); // 触发重渲染刷新选区矩形
    computeLassoSelection(ls.origin, cur);
  }, [computeLassoSelection]);
  const handleLassoPointerUp = useCallback((e: React.PointerEvent) => {
    if (!lassoArmedRef.current) return;
    lassoArmedRef.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    const ls = lassoStateRef.current;
    if (!ls.active) {
      // 未激活=纯点击空白（未拖出框选）：若当前有选择则取消（点空白处取消选择）。
      // armed 已保证点的是空白区——条目/按钮在 down 阶段被排除、不会 armed，故不影响条目自身的 toggle/取走。
      if (stageSelRef.current.size || stageMultiselectRef.current) {
        setStageSel(new Set<number>());
        setStageMultiselect(false);
        stageAnchorRef.current = null;
      }
      return;
    }
    dropAreaRef.current?.classList.remove("lasso-active");
    setLassoState(s => ({ ...s, active: false }));
    // 框中条目 → 保持多选；框中空白（选区为空）→ 退出多选
    if (stageSelRef.current.size === 0) setStageMultiselect(false);
  }, []);
  // ── 中转条目拖出（续71）──
  // 条目上按下→拖动超阈值→emit drag-out-begin，Rust 侧 STA 线程跑 DoDragDrop（hide overlay 后接管鼠标）。
  // 与框选互斥：down 在条目上时 .drop-area 的 lasso 不布防（closest 排除）；与左键取走互斥：未超阈值=普通点击。
  const handleStagePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // 悬浮操作按钮区不触发拖出
    suppressStageClickRef.current = false; // 每次新交互复位
    const id = Number((e.currentTarget as HTMLElement).dataset.stageId);
    if (Number.isNaN(id)) return;
    // 多选状态下按下选中项 → 拖全部选中（ids 在 move 时按 stageSel 决定）；未超阈值松手仍走 onClick 点选
    dragOutRef.current = { pressing: true, itemId: id, origin: { x: e.clientX, y: e.clientY }, draggedIds: [] };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  }, []);
  const handleStagePointerMove = useCallback((e: React.PointerEvent) => {
    const dr = dragOutRef.current;
    if (!dr.pressing || dr.itemId === null) return;
    if (Math.hypot(e.clientX - dr.origin.x, e.clientY - dr.origin.y) < DRAG_OUT_THRESHOLD_PX) return;
    dr.pressing = false; // 一次性触发
    suppressStageClickRef.current = true; // 抑制紧随的 onClick 取走粘贴
    // 多选且按下项在选区内 → 拖全部选中项；否则 → 拖当前单项
    const sel = stageSelRef.current;
    const ids = (sel.size > 0 && sel.has(dr.itemId)) ? Array.from(sel) : [dr.itemId];
    dr.draggedIds = ids;
    const dragItems = stageRef.current.filter(s => ids.includes(s.id)).map(s => ({
      type: s.type,
      content: s.content ?? null,
      items: s.items?.map(f => f.path) ?? null,
      orig_path: s.orig_path ?? null,
    }));
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("start_drag_out", { items: dragItems })).catch(() => {});
  }, []);
  const handleStagePointerUp = useCallback((e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    dragOutRef.current.pressing = false; // 未超阈值=普通点击，交给 onClick（取走/选中）
  }, []);
  const openStageFile = useCallback((s:StageItem) => {
    if (s.type!=="file"||!s.items?.[0]) return;
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:s.items![0].path})).catch(()=>{});
  }, []);
  const deleteClipItem = useCallback(async (time:number) => {
    setClipboard(prev => prev.filter(c => c.time !== time));
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("delete_clipboard_item",{time}); } catch{}
  }, []);
  const changeTheme = useCallback(async (t:"dark"|"light"|"system") => {
    setTheme(t);
    if(store){ await store.set("theme",t); await store.save(); }
  }, [store]);
  const changeAutostart = useCallback(async (enable: boolean) => {
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke(enable?"plugin:autostart|enable":"plugin:autostart|disable"); setAutostartEnabled(enable); } catch{}
  }, []);
  // 切换呼出热键：先 invoke set_hotkey（Rust 原子注册新组合，失败 throw）成功后再更新 state + 持久化。
  // Rust 失败（如被占用）则保留旧组合工作，UI 红字提示 3s 后自清。
  const changeHotkey = useCallback(async (next: string) => {
    const normalized = next.trim().toLowerCase();
    if (normalized === hotkeyCombo) return;
    try {
      const {invoke}=await import("@tauri-apps/api/core");
      await invoke("set_hotkey", { combo: normalized });
      setHotkeyCombo(normalized);
      setHotkeyInput(normalized);
      setHotkeyError("");
      if (store) { await store.set("hotkey-combo", normalized); await store.save(); }
    } catch (e:any) {
      setHotkeyError(String(e));
      setTimeout(() => setHotkeyError(""), 3000);
    }
  }, [hotkeyCombo, store]);
  // 切换增强搜索键（纯前端，不经 Rust）：前端校验合法 + 不与呼出热键冲突 → 更新 state + 持久化。
  const changeEnhHotkey = useCallback(async (next: string) => {
    const normalized = next.trim().toLowerCase();
    if (normalized === enhHotkey) return;
    const fail = (msg:string)=>{ setEnhHotkeyError(msg); setTimeout(()=>setEnhHotkeyError(""), 2500); };
    if (!parseComboStr(normalized)) { fail("无效组合"); return; }
    if (normalized === hotkeyCombo) { fail("与呼出热键冲突"); return; }
    setEnhHotkey(normalized);
    setEnhHotkeyInput(normalized);
    setEnhHotkeyError("");
    if (store) { await store.set("enh-hotkey", normalized); await store.save(); }
  }, [enhHotkey, hotkeyCombo, store]);
  // 录制式快捷键：录制态下捕获阶段监听 keydown（抢在全局 onKey 冒泡 handler 之前），转成 token 串写回
  // 对应输入框（不自动应用，用户再点「应用」走 changeHotkey/changeEnhHotkey）。token 映射对齐 Rust key_token 54 条。
  useEffect(() => {
    if (!recording) return;
    const setInput = recording === "main" ? setHotkeyInput : setEnhHotkeyInput; // 写回哪个输入框
    const setErr = recording === "main" ? setHotkeyError : setEnhHotkeyError;
    const flash = (msg: string) => { setErr(msg); setTimeout(() => setErr(""), 2500); };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecording(null); return; } // Esc 取消录制（不关窗——已被 stopPropagation 拦下）
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.shiftKey) mods.push("shift");
      if (e.altKey) mods.push("alt"); // Alt 续46 spike 实测可用（RegisterHotKey 消费组合，不触发菜单栏）
      const isMod = /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code);
      if (isMod) { setInput(mods.length ? mods.join("+") + "+…" : "…"); return; } // 仅修饰键：实时预览等待主键
      if (e.metaKey) { flash("暂不支持 Win 组合"); return; } // 仅拒 Win（OS 吞键）；Alt+Space/Alt+F4 由校验兜底拒
      const main = tokenFromCode(e.code); // 修饰键可选（含纯主键）；Win 仍拒
      if (!main) { flash("不支持的键"); return; }
      setInput([...mods, main].join("+")); // 定型，写回文本框
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true); // capture 阶段：抢在全局 onKey（冒泡）之前
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  const clearClipboard = useCallback(async () => {
    setClipboard([]);
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("clear_clipboard_history"); } catch{}
  }, []);
  const clearStage = useCallback(async () => { await saveStage([]); }, [saveStage]);
  // ── 搜索引擎切换 + 额外目录配置（续57）：持久化 store + 运行时 invoke 应用 ──
  const changeSearchEngine = useCallback(async (eng: "builtin"|"everything") => {
    setSearchEngine(eng);
    if (store) { await store.set("search-engine", eng); await store.save(); }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_search_engine", { engine: eng });
      // 切到 Everything 顺带热检测一次（reload 丢弃旧句柄 → 重载 → 返回是否可用）
      if (eng === "everything") { const avail = await invoke<boolean>("reload_everything"); setEverythingAvailable(!!avail); }
    } catch {}
  }, [store]);
  // Everything 热更新：丢弃旧 DLL 句柄重载 + 重新检测（运行期换 DLL / 启动 Everything 后无需重启）
  const redetectEverything = useCallback(async () => {
    try { const { invoke } = await import("@tauri-apps/api/core"); const avail = await invoke<boolean>("reload_everything"); setEverythingAvailable(!!avail); setEvtRedetected(true); setTimeout(()=>setEvtRedetected(false), 1500); } catch {}
  }, []);
  const applySearchDirs = useCallback(async (dirs: string[]) => {
    setSearchDirs(dirs);
    if (store) { await store.set("search-dirs", dirs); await store.save(); }
    try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_search_dirs", { dirs }); } catch {}
  }, [store]);
  const addSearchDir = useCallback(async () => {
    const d = searchDirInput.trim();
    if (!d || searchDirs.includes(d)) { setSearchDirInput(""); return; }
    await applySearchDirs([...searchDirs, d]);
    setSearchDirInput("");
  }, [searchDirInput, searchDirs, applySearchDirs]);
  const removeSearchDir = useCallback(async (d: string) => {
    await applySearchDirs(searchDirs.filter(x => x !== d));
  }, [searchDirs, applySearchDirs]);
  const changeClipCacheMax = useCallback(async (n: number) => {
    setClipCacheMax(n);
    if (store) { await store.set("clip-cache-max", n); await store.save(); }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_clip_cache_max", { n });
      // Rust 已截断缓存，重新拉取最新历史同步前端 state
      const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
      setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
    } catch {}
  }, [store]);
  const copyAndPaste = useCallback((item:Pasteable) => { // 剪贴板历史 + 中转条目共用：取走（写回剪贴板+焦点交还+Ctrl+V）
    if (launchingRef.current) return; // 与启动共用锁：动画进行中忽略
    // 实际粘贴：hide+交还焦点+Ctrl+V 全在 Rust 命令内（流程不变），此处仅负责调用
    const doPaste = async () => {
      const {invoke}=await import("@tauri-apps/api/core");
      if (item.type === "text") { try { await invoke("paste_clipboard",{text:item.content}); } catch{ await hideWorkbench(); } }
      else if (item.type === "file" && item.items) { try { await invoke("set_clipboard_files",{paths:item.items.map(f=>f.path)}); } catch{ await hideWorkbench(); } }
      else { try { await invoke("set_clipboard_image",{base64:item.content,origPath:item.orig_path??null}); } catch{ await hideWorkbench(); } }
    };
    // 无障碍：跳过淡出，沿用即时粘贴
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { doPaste(); return; }
    // 与启动一致：先播 LAUNCH_ANIM_MS 覆盖层淡出露桌面，再调粘贴命令（命令自身会 hide+粘贴）
    launchingRef.current = true;
    setDismissing(true);
    setTimeout(async () => {
      if (!launchingRef.current) return; // 淡出期间被 Esc/热键复位（用户反悔）→ 放弃粘贴
      try { await doPaste(); }
      finally { setDismissing(false); launchingRef.current = false; } // 粘贴命令不发 hotkey-hide，手动复位（窗口此时已隐藏，复位不可见）
    }, LAUNCH_ANIM_MS);
  }, []);
  // 只复制到当前剪贴板（不粘贴、不隐藏 overlay）：内容进系统剪贴板供用户自行 Ctrl+V，且不回流历史面板
  const copyToClipboard = useCallback(async (item:ClipItem) => {
    try {
      await writeItemToClipboard(item);
      setCopiedTime(item.time);
      setTimeout(()=>setCopiedTime(t=>t===item.time?null:t), 1000); // 1s 后还原 ✓（仅当未被更新的复制覆盖）
    } catch {}
  }, []);
  // 中转条目「复制到剪贴板」：同上，独立 ✓ 反馈（按 id）
  const copyStageToClipboard = useCallback(async (s:StageItem) => {
    try {
      await writeItemToClipboard(s);
      setCopiedStageId(s.id);
      setTimeout(()=>setCopiedStageId(x=>x===s.id?null:x), 1000);
    } catch {}
  }, []);

  // 中转区单击 handler
  // Ctrl/Meta+click：隐式进入多选模式 + 切换单项
  // Shift+click：隐式进入多选模式；首次=设锚点（选这一项为起始）；再次=扩展区间到此
  // plain（多选模式）：切换单项 + 更新锚点
  // plain（非多选模式）：取走粘贴（原行为）
  const handleStageClick = useCallback((e: React.MouseEvent, s: StageItem, idx: number) => {
    if (suppressStageClickRef.current) { suppressStageClickRef.current = false; return; } // 拖出触发后抑制本次点击
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!stageMultiselect) setStageMultiselect(true);
      setStageSel(prev => { const next = new Set(prev); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; });
      stageAnchorRef.current = idx;
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      if (!stageMultiselect) setStageMultiselect(true);
      const a = stageAnchorRef.current;
      if (a == null) {
        stageAnchorRef.current = idx; // 首次：设此项为区间起始锚点
        setStageSel(new Set([s.id]));
      } else {
        const lo = Math.min(a, idx), hi = Math.max(a, idx);
        // idx/anchor 均为「当前显示列表」(filteredStage) 的索引，故区间切片也走 filteredStage——
        // 否则 search 过滤态下用全量 stage 索引切片会选错（遗漏锚点起始项）。无 search 时 filteredStage===stage，行为不变。
        setStageSel(new Set(filteredStage.slice(lo, hi + 1).map(x => x.id)));
      }
      return;
    }
    if (!stageMultiselect) { copyAndPaste(s); return; }
    setStageSel(prev => { const next = new Set(prev); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; });
    stageAnchorRef.current = idx;
  }, [stageMultiselect, filteredStage, copyAndPaste]);

  // 通用：在鼠标位置弹出自定义右键菜单（边界检测防出屏）
  const openCtxMenu = useCallback((e: React.MouseEvent, items: CtxMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 176, MENU_H = items.length * 36 + 8;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setCtxMenu({ x, y, items });
  }, []);

  // 中转区条目右键菜单：多选模式且有选中项→批量操作；否则→单项操作
  const openStageCtxMenu = useCallback((e: React.MouseEvent, s: StageItem) => {
    if (stageMultiselect && stageSel.size > 0) {
      const sel = stage.filter(x => stageSel.has(x.id));
      const allFiles = sel.length > 0 && sel.every(x => x.type === "file");
      const combined = (): Pasteable => ({ type: "file", items: sel.flatMap(x => x.items ?? []) });
      openCtxMenu(e, [
        { label: `取走全部（${sel.length} 项）`, disabled: !allFiles,
          action: () => { copyAndPaste(combined()); setStageSel(new Set()); setStageMultiselect(false); } },
        { label: `复制全部（${sel.length} 项）`, disabled: !allFiles,
          action: async () => { await writeItemToClipboard(combined()); setBatchCopied(true); setTimeout(() => setBatchCopied(false), 1000); } },
        { label: `删除全部（${sel.length} 项）`,
          action: () => { saveStage(stage.filter(x => !stageSel.has(x.id))); setStageSel(new Set()); } },
        { label: "取消选择", action: () => setStageSel(new Set()) },
      ]);
      return;
    }
    const items: CtxMenuItem[] = [];
    if (s.type === "file" && s.items?.[0]?.path) {
      items.push({
        label: "打开所在目录",
        action: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("reveal_in_explorer", { path: s.items![0].path });
        },
      });
    }
    items.push({ label: "复制到剪贴板", action: () => copyStageToClipboard(s) });
    items.push({ label: "删除该项目",   action: () => removeStage(s.id) });
    openCtxMenu(e, items);
  }, [stageMultiselect, stageSel, stage, openCtxMenu, copyAndPaste, saveStage, copyStageToClipboard, removeStage]);

  // 剪贴板历史卡片右键菜单（file 额外加「打开所在目录」；通用：复制/钉入中转/删除）
  const openClipCtxMenu = useCallback((e: React.MouseEvent, c: ClipItem) => {
    const items: CtxMenuItem[] = [];
    if (c.type === "file" && c.items?.[0]?.path) {
      items.push({
        label: "打开所在目录",
        action: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("reveal_in_explorer", { path: c.items![0].path });
        },
      });
    }
    items.push({ label: "复制到剪贴板", action: () => copyToClipboard(c) });
    items.push({ label: "📌 钉到中转区",  action: () => addToStage(c) });
    items.push({ label: "删除该条目",    action: () => deleteClipItem(c.time) });
    openCtxMenu(e, items);
  }, [openCtxMenu, copyToClipboard, addToStage, deleteClipItem]);

  // 启动器条目右键菜单（file/folder 额外加「打开所在目录」；通用：从启动器移除）
  const openLauncherCtxMenu = useCallback((e: React.MouseEvent, it: LauncherItem) => {
    const items: CtxMenuItem[] = [];
    if (it.kind !== "app") items.push({ label: "打开所在目录", action: async () => { const { invoke } = await import("@tauri-apps/api/core"); await invoke("reveal_in_explorer", { path: it.path }); } });
    items.push({ label: "从启动器移除", action: () => removeLauncherItem(it.id) });
    openCtxMenu(e, items);
  }, [openCtxMenu, removeLauncherItem]);

  // shell:/ms-settings:/wt 等系统路径走 cmd /c start，能找到 WindowsApps 里的 wt.exe
  const openShortcut = useCallback((target:string) => {
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:target})).catch(()=>{});
  }, []);

  // 截屏：Rust 侧负责 hide + emit + 150ms 等待 + Win+Shift+S，前端无需额外 hideWorkbench。
  const handleScreenshot = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trigger_screenshot");
    } catch {}
  }, []);

  const fi = extIcon; // 文件类型图标统一走模块级 extIcon（搜索结果 + 中转条目共用）

  // ── 键盘 ──
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){e.preventDefault();if(lassoStateRef.current.active){setLassoState(s=>({...s,active:false}));dropAreaRef.current?.classList.remove("lasso-active");lassoArmedRef.current=false;return;}if(ctxMenuRef.current){setCtxMenu(null);return;}if(enhOpenRef.current){setEnhOpen(false);setEnhPinned(false);setEnhQuery("");setSearch("");if(searchDefaultModeRef.current==="enhanced")pageSearchForcedRef.current=true;searchRef.current?.focus();return;}if(pickerOpenRef.current){setPickerOpen(false);setPickerQuery("");return;}if(stageSelRef.current.size||stageMultiselectRef.current){setStageSel(new Set<number>());setStageMultiselect(false);stageAnchorRef.current=null;return;}if(settingsOpen){setSettingsOpen(false);return;}setVisible(false);hideWorkbench();return;}
      if(matchComboEvent(e, enhHotkey)){e.preventDefault();if(enhOpen){setEnhOpen(false);setEnhPinned(false);setEnhQuery("");setSearch("");if(searchDefaultModeRef.current==="enhanced")pageSearchForcedRef.current=true;searchRef.current?.focus();}else{pageSearchForcedRef.current=false;setEnhQuery(search);setEnhSelIdx(0);setEnhOpen(true);setEnhPinned(true);searchRef.current?.focus();}return;}
      // 中和默认 Tab 焦点遍历（防焦点逃逸到模态背后的按钮 / 旧死 filteredApps 导航）。Tab 作为热键已被上面 matchComboEvent 先处理。
      if(e.key==="Tab"){e.preventDefault();return;}
      if(settingsOpen||pickerOpen)return; // 设置 / picker 打开时屏蔽应用导航/启动按键
      if(enhOpen){ // 增强搜索接管导航，屏蔽下面 launcher 键（字母键不拦截，正常输入到 enhInput）
        if(e.key==="ArrowDown"){e.preventDefault();setEnhSelIdx(i=>Math.min(i+1,enhResults.length-1));}
        else if(e.key==="ArrowUp"){e.preventDefault();setEnhSelIdx(i=>Math.max(i-1,0));}
        else if(e.key==="Enter"){e.preventDefault();const r=enhResults[enhSelIdx]??enhResults[0];if(r)activateEnh(r, document.querySelector<HTMLElement>(".enh-result.selected .enh-result-icon"));}
        return;
      }
      // Enter：顶栏搜索非空时启动排名第一的应用（launcher 键盘导航待后续实现）
      if(e.key==="Enter"&&search.trim()&&filteredApps.length){e.preventDefault();const a=filteredApps[0];if(a)launchApp(a.app, null);}
    };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  }, [visible, search, filteredApps, launchApp, settingsOpen, pickerOpen, enhOpen, enhResults, enhSelIdx, activateEnh, enhHotkey]);

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}${fileDragOver ? " file-drag-active" : ""}`} onContextMenu={e=>e.preventDefault()}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
        <div className="top-center">
          <div className="global-search">
            <svg className="search-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input ref={searchRef} className="search-field" placeholder="搜索应用、中转、剪贴板…" value={search}
              onChange={e=>{
                const v=e.target.value;
                if((searchDefaultModeRef.current==="enhanced"&&!pageSearchForcedRef.current)||enhPinnedRef.current){
                  // enhanced 模式自动打开 / 或 enh 已以 pinned 方式打开（page 模式手动呼出时）：顶栏输入同步到 enhQuery
                  setSearch(v);setEnhQuery(v);setEnhSelIdx(0);
                  if(v&&!enhOpenRef.current){setEnhOpen(true);setEnhPinned(true);}
                }else{setSearch(v);}
              }} spellCheck={false} />
          </div>
        </div>
        <div className="top-right">
          <span className="clock">{time}</span>
          <button className="settings-btn" onClick={()=>setSettingsOpen(true)} title="设置" aria-label="设置">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>
      <main className="main-area">
        <section className="app-panel">
          <div className="stage-section-header">
            <span className="section-label">启动器</span>
            <button className="stage-batch-btn" onClick={()=>{setPickerQuery("");setPickerOpen(true);}} title="添加应用">添加</button>
          </div>
          <div className="app-grid" ref={launcherDropRef}>
            {/* 启动器=手动策展的收藏托盘（非自动扫描全量）。条目左键打开/启动，右键移除。键盘导航待后续。 */}
            {filteredLauncher.map(it=>(
              <div key={it.id} className="app-tile" onClick={e=>openLauncherItem(it, e.currentTarget.querySelector<HTMLElement>(".app-tile-icon"))}
                   onContextMenu={e=>openLauncherCtxMenu(e,it)} title={it.kind==="app"?"单击启动":"单击打开"}>
                <div className="app-tile-icon">
                  {it.kind==="app" && it.icon ? <img src={it.icon} alt=""/>
                   : it.kind==="folder" ? <span>📁</span>
                   : it.kind==="file" ? <span>{fi(it.ext??"")}</span>
                   : <span>{it.name[0]}</span>}
                </div>
                <span className="app-tile-label">{it.name}</span>
              </div>
            ))}
            {!filteredLauncher.length && (
              <p className="empty-hint" style={{gridColumn:"1/-1"}}>
                {launcher.length ? "无匹配" : "拖入或点「添加」收藏应用"}
              </p>
            )}
          </div>
        </section>
        <section className="center-panel">
          <div className="stage-section-header">
            <span className="section-label">文件中转区</span>
            {stageMultiselect ? (
              <div className="stage-multi-toolbar">
                {stageSel.size > 0 && <span className="stage-sel-count">已选 {stageSel.size}</span>}
                <button className="stage-batch-btn" disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")?"取走并粘贴到上个窗口":"仅文件可批量取走"}
                  onClick={()=>{const sel=stage.filter(x=>stageSel.has(x.id));copyAndPaste({type:"file",items:sel.flatMap(x=>x.items??[])});setStageSel(new Set());setStageMultiselect(false);}}>取走</button>
                <button className={`stage-batch-btn${batchCopied?" copied":""}`} disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")?"复制到剪贴板":"仅文件可批量复制"}
                  onClick={async()=>{const sel=stage.filter(x=>stageSel.has(x.id));await writeItemToClipboard({type:"file",items:sel.flatMap(x=>x.items??[])});setBatchCopied(true);setTimeout(()=>setBatchCopied(false),1000);}}>复制</button>
                <button className="stage-batch-btn" disabled={stageSel.size===0}
                  onClick={()=>{saveStage(stage.filter(x=>!stageSel.has(x.id)));setStageSel(new Set());}}>删除</button>
                <button className="stage-batch-btn stage-batch-cancel"
                  onClick={()=>{setStageSel(new Set());setStageMultiselect(false);stageAnchorRef.current=null;}}>完成</button>
              </div>
            ) : (
              <button className="stage-batch-btn" disabled={!stage.length}
                onClick={()=>setStageMultiselect(true)} title="进入多选模式">多选</button>
            )}
          </div>
          <div className="drop-area" ref={dropAreaRef}
            onPointerDown={handleLassoPointerDown} onPointerMove={handleLassoPointerMove}
            onPointerUp={handleLassoPointerUp} onPointerCancel={handleLassoPointerUp}>
            {lassoState.active && (() => {
              const rect = dropAreaRef.current?.getBoundingClientRect();
              if (!rect) return null;
              return <div className="stage-lasso" style={{
                left:   Math.min(lassoState.origin.x, lassoState.current.x) - rect.left + dropAreaRef.current!.scrollLeft,
                top:    Math.min(lassoState.origin.y, lassoState.current.y) - rect.top + dropAreaRef.current!.scrollTop,
                width:  Math.abs(lassoState.current.x - lassoState.origin.x),
                height: Math.abs(lassoState.current.y - lassoState.origin.y),
              }}/>;
            })()}
            {filteredStage.length ? (stageLayout==="grid"
              ? <div className="stage-grid">{filteredStage.map((s,idx)=>{
                  const rawExt = (s.ext||s.items?.[0]?.ext||"").replace(/^\./,"");
                  const isAnyDir = !!s.isDir;
                  const cardName = s.type==="image" ? "图片"
                    : s.type==="text" ? (s.content?.slice(0,12)||"文本")
                    : (s.count!==1 ? `${s.count} 个文件` : (s.name||s.items?.[0]?.name||"文件"));
                  const cardMeta = s.type==="image" ? "图片"
                    : s.type==="text" ? "文本"
                    : (isAnyDir ? "文件夹" : (rawExt ? `.${rawExt}` : "文件"));
                  return (
                  <div key={s.id} data-stage-id={s.id} className={`stage-card${stageSel.has(s.id)?" selected":""}`} draggable={false} onDragStart={e=>e.preventDefault()} onClick={e=>handleStageClick(e,s,idx)} onContextMenu={e=>openStageCtxMenu(e,s)} onPointerDown={handleStagePointerDown} onPointerMove={handleStagePointerMove} onPointerUp={handleStagePointerUp} onPointerCancel={handleStagePointerUp} title={stageMultiselect?"单击选中 / 取消":(s.type==="file"?"单击取走（写回剪贴板并粘贴），拖出可拖到其他应用":"单击取走（粘贴到上个窗口），拖出可拖到其他应用")}>
                    {/* ── 缩略图区（thumb 固定 110×90，内容直接置于其中）── */}
                    {s.type==="image" && (
                      <div className="stage-card-thumb">
                        <div className="stage-card-dot type-image"/>
                        {s.content
                          ? <img className="cover" draggable={false} src={s.content.startsWith("data:")?s.content:`data:image/png;base64,${s.content}`} alt=""/>
                          : <span style={{fontSize:28}}>🖼️</span>}
                      </div>
                    )}
                    {s.type==="text" && (
                      <div className="stage-card-thumb">
                        <div className="stage-card-dot type-text"/>
                        <div className="stage-card-text-preview">{s.content||""}</div>
                      </div>
                    )}
                    {s.type==="file" && (
                      <div className="stage-card-thumb">
                        <div className="stage-card-dot type-file"/>
                        <div className="stage-card-icon-wrap">
                          {s.items?.[0]?.icon
                            ? <img src={s.items[0].icon} alt="" draggable={false} style={{width:28,height:28,objectFit:"contain"}}/>
                            : isAnyDir
                              ? <svg width="26" height="26" viewBox="0 0 24 24" fill="#EF9F27" xmlns="http://www.w3.org/2000/svg"><path d="M2 7.5C2 6.395 2.895 5.5 4 5.5h4.172l1.414 1.414.586.586H20c1.105 0 2 .895 2 2V17c0 1.105-.895 2-2 2H4c-1.105 0-2-.895-2-2V7.5z"/></svg>
                              : <span style={{fontSize:22}}>{s.items?.[0]?.isImage?"🖼️":fi(s.ext??s.items?.[0]?.ext??"")}</span>}
                        </div>
                      </div>
                    )}
                    {/* ── 标签区 ── */}
                    <div className="stage-card-label">
                      <span className="stage-card-name">{cardName}</span>
                      <span className="stage-card-meta">{cardMeta}</span>
                    </div>
                    {/* ── 悬浮操作栏：左键本体已=取走粘贴，故悬浮栏统一留「复制到剪贴板 + 删除」两键（所有类型一致）── */}
                    <div className="stage-card-actions">
                      <button className="stage-card-act-btn" onClick={e=>{e.stopPropagation();copyStageToClipboard(s);}} title={copiedStageId===s.id?"已复制":"复制到剪贴板"}>
                        {copiedStageId===s.id
                          ?<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          :<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                      </button>
                      <button className="stage-card-act-btn" onClick={e=>{e.stopPropagation();removeStage(s.id);}} title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
                    </div>
                  </div>
                );})}</div>
              : <div className="stage-list">{filteredStage.map((s,idx)=>{
                  const label = s.type==="text"?(s.content?.slice(0,60)||"文本"):s.type==="image"?"图片":(s.count!==1?`${s.count} 个文件`:(s.name||s.items?.[0]?.name||"文件"));
                  return (
                  <div key={s.id} data-stage-id={s.id} className={`stage-item${stageSel.has(s.id)?" selected":""}`} draggable={false} onDragStart={e=>e.preventDefault()} onClick={e=>handleStageClick(e,s,idx)} onContextMenu={e=>openStageCtxMenu(e,s)} onPointerDown={handleStagePointerDown} onPointerMove={handleStagePointerMove} onPointerUp={handleStagePointerUp} onPointerCancel={handleStagePointerUp} title={stageMultiselect?"单击选中 / 取消":(s.type==="file"?"单击取走（写回剪贴板并粘贴）":"单击取走（粘贴到上个窗口）")}>
                    {s.type==="image"
                      ?<img className="stage-thumb" draggable={false} src={s.content} alt=""/>
                      :s.type==="file" && s.items?.[0]?.icon
                        ?<img className="stage-thumb" draggable={false} src={s.items[0].icon} alt=""/>
                        :<span className="stage-emoji">{s.type==="text"?"📝":(s.items?.[0]?.isImage?"🖼️":(s.isDir?"📁":fi(s.ext??s.items?.[0]?.ext??"")))}</span>}
                    <span className="stage-title">{label}</span>
                    {s.type==="file"&&s.count===1&&s.size?<span className="stage-meta">{fmtSize(s.size)}</span>:null}
                    <div className="stage-actions">
                      <button className={`clip-copy-btn${copiedStageId===s.id?" copied":""}`} onClick={e=>{e.stopPropagation();copyStageToClipboard(s);}} title={copiedStageId===s.id?"已复制":"复制到剪贴板"}>
                        {copiedStageId===s.id
                          ?<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          :<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                      </button>
                      {s.type==="file"&&<button className="stage-open-btn" onClick={e=>{e.stopPropagation();openStageFile(s);}} title="打开"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>}
                      <button className="clip-del-btn" onClick={e=>{e.stopPropagation();removeStage(s.id);}} title="移除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
                    </div>
                  </div>);
                })}</div>
            ) : <p className="empty-hint">{search.trim()?"无匹配":"拖入文件 / 文件夹，或在剪贴板卡片点 📌 钉入"}</p>}
          </div>
          <div className="section-label" style={{marginTop:16}}>快捷入口</div>
          <div className="shortcut-row">
            <button className="shortcut-chip" onClick={handleScreenshot}><span>📸</span><span>截屏</span></button>
            {SHORTCUTS.map(s=>(
              <button key={s.l} className="shortcut-chip" onClick={()=>openShortcut(s.a)}><span>{s.e}</span><span>{s.l}</span></button>
            ))}
          </div>
        </section>
        <section className="clip-panel">
          <div className="section-label">剪贴板历史</div>
          <div className="clip-list">
            {filteredClip.length? filteredClip.map((c,i)=>(
              <div key={i} className="clip-block"
                onClick={()=>{ if(suppressClickRef.current){suppressClickRef.current=false;return;} copyAndPaste(c); }}
                onPointerDown={e=>handleClipPointerDown(e,c)} onPointerMove={handleClipPointerMove} onPointerUp={handleClipPointerUp} onPointerCancel={handleClipPointerUp}
                onContextMenu={e=>openClipCtxMenu(e,c)} title={c.type==="text"?"单击左键粘贴":c.type==="file"?"单击左键粘贴文件":"单击左键复制"}>
                <div className="clip-actions">
                  <button className="clip-pin-btn" onClick={e=>{e.stopPropagation();addToStage(c);}} title="钉到中转区"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-2-4V7a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v6z"/></svg></button>
                  <button className={`clip-copy-btn${copiedTime===c.time?" copied":""}`} onClick={e=>{e.stopPropagation();copyToClipboard(c);}} title={copiedTime===c.time?"已复制":"复制到剪贴板"}>
                    {copiedTime===c.time
                      ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                  </button>
                  <button className="clip-del-btn" onClick={e=>{e.stopPropagation();deleteClipItem(c.time);}} title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
                </div>
                {c.type==="image"? <img className="clip-image" src={c.content} alt=""/>
                : c.type==="file"? <div className="file-clip-preview">
                    <span className="clip-file-icon">{getFileIcon(c)}</span>
                    <span className="file-clip-info">{c.count===1? c.items?.[0]?.name : `${c.count}个文件`}</span>
                  </div>
                : <span className="clip-preview">{c.content?.slice(0,100)}{(c.content?.length??0)>100?"…":""}</span>}
                <span className="clip-time">{c.type==="image"?"📷 ":c.type==="file"?"📎 ":""}{ago(c.time)}</span>
              </div>
            )): <p className="empty-hint">{search.trim()?"无匹配":"显示时自动读取"}</p>}
          </div>
        </section>
      </main>
      {/* ── 增强搜索层（始终挂载，靠 class 切换显隐，沿用 overlay-visible/hidden 模式避免卸载闪烁）── */}
      <div className={`enh-layer${enhOpen?" enh-open":""}${enhPinned?" enh-pinned":""}`}>
        <div className="enh-search-box">
          <svg className="search-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input ref={enhInputRef} className="enh-search-input" placeholder="搜索应用、中转文件…"
            value={enhQuery} onChange={e=>{setEnhQuery(e.target.value);setEnhSelIdx(0);}} spellCheck={false}/>
          <span className="enh-hint">{searchDefaultMode==="enhanced"&&<><kbd>{comboLabel(enhHotkey)}</kbd> 界面搜索 · </>}<kbd>Esc</kbd> 关闭</span>
        </div>
        {/* 索引未就绪提示：不阻塞 Tier 1（应用/中转）结果显示 */}
        {enhQuery.trim() && searchEngine==="everything" && !everythingAvailable ? <div className="enh-index-hint">Everything 未运行，已回退内置搜索</div> : (!indexReady && enhQuery.trim() ? <div className="enh-index-hint">文件索引建立中…</div> : null)}
        <div className="enh-results">
          {enhResults.length ? enhResults.map((r,i)=>{
            const key = r.kind==="app" ? "app:"+r.app.path : r.kind==="stage" ? "stage:"+r.item.id : "fs:"+r.path;
            const icon = r.kind==="app" ? (r.app.icon? <img src={r.app.icon} alt=""/> : <span>{r.app.name[0]}</span>)
                       : r.kind==="stage" ? <span>{fi(r.item.ext??r.item.items?.[0]?.ext??"")}</span>
                       : r.kind==="fs" && r.icon ? <img src={r.icon} alt=""/>
                                                 : <span>{r.kind==="fs" && r.isDir?"📁":fi(r.kind==="fs"?r.ext:"")}</span>;
            const label = r.kind==="app" ? r.app.name : r.name;
            const ranges = r.kind==="fs" ? [] : r.ranges; // 文件结果无高亮区间（Rust 侧子串匹配，未回传位置）
            const badge = r.kind==="app" ? "应用" : r.kind==="stage" ? "中转" : (r.isDir?"文件夹":"文件");
            const rPath = r.kind==="app" ? r.app.path : r.kind==="fs" ? r.path : ""; // 操作按钮反馈用统一路径键
            // Tier1/Tier2 之间插分隔线（i 到达 enhTier1.length 且 Tier1 非空时，此项为首个文件结果）
            const divider = (i===enhTier1.length && enhTier1.length>0) ? <div key="enh-div" className="enh-divider">文件 / 文件夹</div> : null;
            return (
              <Fragment key={key}>
                {divider}
                <div className={`enh-result${i===enhSelIdx?" selected":""}`}
                  onMouseEnter={()=>setEnhSelIdx(i)}
                  onClick={e=>activateEnh(r, e.currentTarget.querySelector<HTMLElement>(".enh-result-icon"))}>
                  <div className="enh-result-icon">{icon}</div>
                  <div className="enh-result-meta">
                    <span className="enh-result-label"><HighlightText text={label} ranges={ranges}/></span>
                    {r.kind==="fs" && <span className="enh-result-dir">{dirOf(r.path)}</span>}
                  </div>
                  <span className="enh-result-badge">{badge}</span>
                  {(r.kind==="fs" || r.kind==="app") && (
                    <div className="enh-result-actions">
                      {r.kind==="fs" && <button className={`enh-action-btn${enhAdded?.path===rPath&&enhAdded?.target==="stage"?" enh-action-added":""}`} onClick={e=>{e.stopPropagation();addFsToStage(r);setEnhAdded({path:rPath,target:"stage"});setTimeout(()=>setEnhAdded(null),1000);}} title="加入中转区">{enhAdded?.path===rPath&&enhAdded?.target==="stage"?"✓":"中转"}</button>}
                      <button className={`enh-action-btn${enhAdded?.path===rPath&&enhAdded?.target==="launcher"?" enh-action-added":""}`} onClick={e=>{e.stopPropagation();r.kind==="app"?addAppToLauncher(r.app):addFsToLauncher(r);setEnhAdded({path:rPath,target:"launcher"});setTimeout(()=>setEnhAdded(null),1000);}} title="加入启动台">{enhAdded?.path===rPath&&enhAdded?.target==="launcher"?"✓":"启动台"}</button>
                    </div>
                  )}
                </div>
              </Fragment>
            );
          }) : <p className="empty-hint">{enhQuery.trim()?"无匹配":"输入以搜索"}</p>}
        </div>
      </div>
      {/* ── 启动器「添加应用」picker（复用 settings-modal 样式 + enh-result 列表项）── */}
      {pickerOpen && (
        <div className="settings-mask" onClick={()=>{setPickerOpen(false);setPickerQuery("");}}>
          <div className="settings-modal picker-modal" onClick={e=>e.stopPropagation()}>
            <div className="settings-head">
              <span className="settings-title">添加应用</span>
              <button className="settings-close" onClick={()=>{setPickerOpen(false);setPickerQuery("");}} title="关闭" aria-label="关闭">×</button>
            </div>
            <div className="picker-search">
              <svg className="search-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input ref={pickerInputRef} className="picker-search-input" autoFocus placeholder="搜索要添加的应用…" value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)} spellCheck={false}/>
            </div>
            <div className="picker-list">
              {pickerResults.length ? pickerResults.map(({app,ranges})=>(
                <div key={app.path} className="enh-result" onClick={()=>addAppToLauncher(app)} title="点击添加到启动器">
                  <div className="enh-result-icon">{app.icon? <img src={app.icon} alt=""/> : <span>{app.name[0]}</span>}</div>
                  <span className="enh-result-label"><HighlightText text={app.name} ranges={ranges}/></span>
                </div>
              )) : <p className="empty-hint">{pickerQuery.trim()?"无匹配应用":"暂无可添加应用"}</p>}
            </div>
            <div className="picker-foot">点击添加，可连续添加；<kbd>Esc</kbd> 关闭</div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="settings-mask" onClick={()=>setSettingsOpen(false)}>
          <div className="settings-modal" onClick={e=>e.stopPropagation()}>
            <div className="settings-head">
              <span className="settings-title">设置</span>
              <button className="settings-close" onClick={()=>setSettingsOpen(false)} title="关闭" aria-label="关闭">×</button>
            </div>
            <div className="settings-layout">
              <nav className="settings-nav">
                {SETTINGS_TABS.map(t=>(
                  <button key={t.id} className={`settings-nav-item${settingsTab===t.id?" settings-nav-active":""}`} onClick={()=>setSettingsTab(t.id)}>
                    <span className="settings-nav-icon">{t.icon}</span>{t.label}
                  </button>
                ))}
              </nav>
              <div className="settings-panel">
                {settingsTab==="general" && (<>
                  <div className="settings-panel-title">常规</div>
                  <div className="settings-row">
                    <span className="settings-row-label">背景主题</span>
                    <div className="seg">
                      {([["dark","深色"],["light","浅色"],["system","系统"]] as const).map(([v,l])=>(
                        <button key={v} className={`seg-btn${theme===v?" seg-active":""}`} onClick={()=>changeTheme(v)}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">开机自启</span>
                    <div className="seg">
                      <button className={`seg-btn${autostartEnabled?" seg-active":""}`} onClick={()=>changeAutostart(true)}>开启</button>
                      <button className={`seg-btn${!autostartEnabled?" seg-active":""}`} onClick={()=>changeAutostart(false)}>关闭</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">中转区布局</span>
                    <div className="seg">
                      <button className={`seg-btn${stageLayout==="list"?" seg-active":""}`} onClick={()=>changeStageLayout("list")}>列表</button>
                      <button className={`seg-btn${stageLayout==="grid"?" seg-active":""}`} onClick={()=>changeStageLayout("grid")}>方格</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">呼出默认搜索</span>
                    <div className="seg">
                      <button className={`seg-btn${searchDefaultMode==="page"?" seg-active":""}`} onClick={()=>changeSearchDefaultMode("page")}>界面搜索</button>
                      <button className={`seg-btn${searchDefaultMode==="enhanced"?" seg-active":""}`} onClick={()=>changeSearchDefaultMode("enhanced")}>增强搜索</button>
                    </div>
                  </div>
                  <p className="settings-hint">{searchDefaultMode==="enhanced"?"呼出后顶栏输入直接进入增强搜索；"+comboLabel(enhHotkey)+"切换为界面搜索。":"呼出后顶栏搜索过滤界面内容；"+comboLabel(enhHotkey)+"进入增强搜索（共用顶栏）。"}</p>
                </>)}
                {settingsTab==="clipboard" && (<>
                  <div className="settings-panel-title">剪贴板</div>
                  <div className="settings-row">
                    <span className="settings-row-label">历史保存条数</span>
                    <div className="seg">
                      {([10, 20, 50, 100] as const).map(n=>(
                        <button key={n} className={`seg-btn${clipCacheMax===n?" seg-active":""}`} onClick={()=>changeClipCacheMax(n)}>{n}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">剪贴板历史<span className="settings-row-sub">{clipboard.length} 条</span></span>
                    <button className="settings-action" onClick={clearClipboard} disabled={!clipboard.length}>清空</button>
                  </div>
                  <p className="settings-hint">复制的文本、图片、文件会自动记录，最多保留 {clipCacheMax} 条。</p>
                  <div className="settings-row">
                    <span className="settings-row-label">图片原图缓存</span>
                    <div style={{display:"flex",gap:4}}>
                      <button className="settings-action" onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("open_clip_image_dir");}catch{}}}>打开文件夹</button>
                      <button className={`settings-action${imgCacheCleared?" copied":""}`} onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("clear_clip_image_cache");setImgCacheCleared(true);setTimeout(()=>setImgCacheCleared(false),1500);}catch{}}}>{ imgCacheCleared?"✓ 已清空":"清空缓存"}</button>
                    </div>
                  </div>
                  <p className="settings-hint">历史图片原图存放于此，清空后历史图粘贴退回缩略图质量。</p>
                  <div className="settings-row">
                    <span className="settings-row-label">文件中转区<span className="settings-row-sub">{stage.length} 条</span></span>
                    <button className="settings-action" onClick={clearStage} disabled={!stage.length}>清空</button>
                  </div>
                  <p className="settings-hint">手动钉入或拖入的文件、文本、图片条目。</p>
                </>)}
                {settingsTab==="search" && (<>
                  <div className="settings-panel-title">搜索</div>
                  <div className="settings-row">
                    <span className="settings-row-label">搜索引擎</span>
                    <div className="seg">
                      <button className={`seg-btn${searchEngine==="builtin"?" seg-active":""}`} onClick={()=>changeSearchEngine("builtin")}>内置</button>
                      <button className={`seg-btn${searchEngine==="everything"?" seg-active":""}`} onClick={()=>changeSearchEngine("everything")}>Everything</button>
                    </div>
                  </div>
                  {searchEngine==="everything" && (
                    <div className="settings-row">
                      <span className="settings-row-label">连接状态<span className="settings-row-sub">{everythingAvailable?"已连接":"未连接"}</span></span>
                      <button className={`settings-action${evtRedetected?" copied":""}`} onClick={redetectEverything}>{evtRedetected?"✓ 已检测":"重新检测"}</button>
                    </div>
                  )}
                  {searchEngine==="everything" && !everythingAvailable && <p className="settings-hint settings-hint-error">未检测到 Everything（需安装 Everything 并保持其后台运行，DLL 已随应用内置）。查询将自动回退到内置引擎。换 DLL / 启动 Everything 后点「重新检测」即可热更新，无需重启。</p>}
                  {searchEngine==="everything" && everythingAvailable && <p className="settings-hint">已连接 Everything，查询覆盖全盘、即时。</p>}
                  <p className="settings-hint">内置引擎扫描整个用户目录（含下方额外目录），无需任何外部依赖；Everything 覆盖全盘但需另装。</p>
                  {searchEngine==="builtin" && (<>
                    <div className="settings-row">
                      <span className="settings-row-label">额外扫描目录</span>
                      <div style={{display:"flex",gap:6}}>
                        <input
                          className="hotkey-input"
                          value={searchDirInput}
                          onChange={e=>setSearchDirInput(e.target.value)}
                          onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addSearchDir();}}}
                          placeholder="如 D:\\Work"
                          spellCheck={false}
                        />
                        <button className="settings-action" onClick={addSearchDir}>添加</button>
                      </div>
                    </div>
                    {searchDirs.length>0 ? <div className="search-dir-list">{searchDirs.map(d=>(
                      <div key={d} className="search-dir-item"><span className="search-dir-path" title={d}>{d}</span><button className="search-dir-remove" onClick={()=>removeSearchDir(d)} title="移除">✕</button></div>
                    ))}</div> : <p className="settings-hint">默认仅扫描用户目录（桌面/下载/文档…）。如需搜其他盘符，在此添加根目录。</p>}
                    <p className="settings-hint">添加目录后约几秒完成后台重建即可搜到；node_modules / .git 等噪音目录自动跳过。</p>
                  </>)}
                </>)}
                {settingsTab==="hotkeys" && (<>
                  <div className="settings-panel-title">快捷键</div>
                  <div className="settings-row">
                    <span className="settings-row-label">呼出 / 隐藏</span>
                    <div style={{display:"flex",gap:6}}>
                      <input
                        className="hotkey-input"
                        value={hotkeyInput}
                        onChange={e=>setHotkeyInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();changeHotkey(hotkeyInput);}}}
                        placeholder="如 ctrl+shift+f"
                        spellCheck={false}
                        readOnly={recording==="main"}
                      />
                      <button className={"settings-action"+(recording==="main"?" recording":"")} onClick={()=>{setHotkeyError("");setRecording(r=>r==="main"?null:"main");}}>{recording==="main"?"按下快捷键…":"录制"}</button>
                      <button className="settings-action" onClick={()=>changeHotkey(hotkeyInput)}>应用</button>
                    </div>
                  </div>
                  {hotkeyError && <p className="settings-hint settings-hint-error">{hotkeyError}</p>}
                  {hotkeyCombo!=="ctrl+space" && <button className="settings-action" onClick={()=>changeHotkey("ctrl+space")}>恢复默认</button>}
                  <div className="settings-row">
                    <span className="settings-row-label">增强搜索</span>
                    <div style={{display:"flex",gap:6}}>
                      <input
                        className="hotkey-input"
                        value={enhHotkeyInput}
                        onChange={e=>setEnhHotkeyInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();changeEnhHotkey(enhHotkeyInput);}}}
                        placeholder="如 ctrl+k"
                        spellCheck={false}
                        readOnly={recording==="enh"}
                      />
                      <button className={"settings-action"+(recording==="enh"?" recording":"")} onClick={()=>{setEnhHotkeyError("");setRecording(r=>r==="enh"?null:"enh");}}>{recording==="enh"?"按下快捷键…":"录制"}</button>
                      <button className="settings-action" onClick={()=>changeEnhHotkey(enhHotkeyInput)}>应用</button>
                    </div>
                  </div>
                  {enhHotkeyError && <p className="settings-hint settings-hint-error">{enhHotkeyError}</p>}
                  {enhHotkey!=="ctrl+k" && <button className="settings-action" onClick={()=>changeEnhHotkey("ctrl+k")}>恢复默认</button>}
                  <p className="settings-hint">点「录制」后直接按下组合键自动填入；也可手动输入。</p>
                  <p className="settings-hint" style={{marginTop: '4px'}}>格式：ctrl+x · alt+q · ctrl+shift+x · f9</p>
                  <p className="settings-hint" style={{marginTop: '4px'}}>· 不支持 Win 键及 Alt+Space / Alt+F4（系统保留）<br/>· 修饰键 Ctrl / Shift / Alt 可选；纯主键会全局抢占该键，慎设<br/>· 中文输入法下录制前请先切换到英文输入法</p>
                  <div className="settings-row"><span className="settings-row-label">关闭面板</span><kbd>Esc</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">应用导航</span><kbd>↑↓</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">启动选中应用</span><kbd>Enter</kbd></div>
                  <p className="settings-hint">长按 = 按住显示松开关闭；短按 = 切换显隐。</p>
                </>)}
                {settingsTab==="about" && (<>
                  <div className="settings-panel-title">关于</div>
                  <div className="settings-about">
                    <div>Workbench <b>v0.1.0</b></div>
                    <div>Windows 全屏「第二桌面」工具</div>
                    <div>应用启动器 · 文件中转 · 剪贴板历史</div>
                  </div>
                </>)}
              </div>
            </div>
          </div>
        </div>
      )}
      <footer className="bottom-bar">
        <div className="bot-left"><span className="sys-dot"/><span>CPU {navigator.hardwareConcurrency??"?"} 核</span></div>
        <div className="bot-center"><kbd>{comboLabel(hotkeyCombo)}</kbd> 切换 · <kbd>{comboLabel(enhHotkey)}</kbd> {enhOpen?"界面搜索":"增强搜索"} · <kbd>Esc</kbd> 关闭 · <kbd>↑↓</kbd> 导航 · <kbd>Enter</kbd> 启动</div>
        <div className="bot-right"><span>Workbench v0.1.0</span></div>
      </footer>
    </div>
    {/* 启动放大暂留：顶层克隆，#overlay 的兄弟节点（避开 backdrop-filter 的定位上下文与宫格 overflow 裁剪），按点击瞬间坐标定位、自播 scale+淡出 */}
    {launchAnim && (
      <div className="launch-clone" style={{top:launchAnim.rect.top,left:launchAnim.rect.left,width:launchAnim.rect.width,height:launchAnim.rect.height}}>
        {launchAnim.icon ? <img src={launchAnim.icon} alt=""/> : <span>{launchAnim.name[0]}</span>}
      </div>
    )}
    {/* 自定义右键菜单浮层：fixed 定位，渲染在最顶层；mousedown stopPropagation 防被全局 close 监听立即关掉 */}
    {ctxMenu && (
      <div className="ctx-menu" style={{left:ctxMenu.x, top:ctxMenu.y}} onMouseDown={e=>e.stopPropagation()}>
        {ctxMenu.items.map((item,i)=>(
          <button key={i} className="ctx-menu-item" disabled={item.disabled}
            onClick={()=>{item.action();setCtxMenu(null);}}>
            {item.label}
          </button>
        ))}
      </div>
    )}
    {/* 拖拽跟手克隆：与 #overlay 同为兄弟节点（#overlay 的 backdrop-filter 会成为 fixed 的包含块，放里面定位会错），pointerEvents:none 不挡命中检测 */}
    {dragState?.active && (
      <div className="clip-drag-ghost" style={{position:"fixed",left:dragState.currentX+12,top:dragState.currentY+12,pointerEvents:"none",zIndex:100002}}>
        {dragState.item.type==="image"
          ? <img src={dragState.item.content} className="clip-ghost-img" alt=""/>
          : dragState.item.type==="file"
          ? <span>📄 {dragState.item.items?.[0]?.name ?? "文件"}</span>
          : <span>{String(dragState.item.content ?? "").slice(0,40)}</span>}
      </div>
    )}
   </>
  );
}
