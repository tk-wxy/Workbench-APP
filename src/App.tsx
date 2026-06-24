import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./App.css";

// ── 类型 ──
interface AppInfo { name: string; path: string; icon: string | null; }
interface AppUsage { count: number; last_used: number; } // last_used = Unix 秒
interface FileEntry { path: string; name: string; isDir: boolean; size: number; ext: string; }
interface FileItem { path: string; name: string; ext: string; isImage: boolean; }
interface ClipItem { type: "text" | "image" | "file"; content?: string; time: number; items?: FileItem[]; count?: number; orig_path?: string; }
// 文件中转条目：与 ClipItem 同构（type/content/items/count）以复用现成粘贴/复制链路；
// 额外带 id（稳定 key + 去重）和 file 显示辅助字段（name/ext/isDir/size，可选）。
interface StageItem { id: number; type: "text" | "image" | "file"; content?: string; items?: FileItem[]; count?: number; name?: string; ext?: string; isDir?: boolean; size?: number; }
// copyAndPaste/复制 只读这几个字段，ClipItem 与 StageItem 都满足 → 两个面板共用同一套出口
type Pasteable = { type: "text" | "image" | "file"; content?: string; items?: FileItem[]; orig_path?: string; };
const STAGE_MAX = 20; // 中转区上限
const DRAG_THRESHOLD_PX = 8; // 剪贴板卡片按下后移动超过此距离才激活拖拽，防误触（短按仍走 onClick 粘贴）

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
  return { id: stageId(), type: "file", items: [{ path: f.path, name: f.name, ext: f.ext, isImage }], count: 1, name: f.name, ext: f.ext, isDir: f.isDir, size: f.size };
}
function clipToStage(c: ClipItem): StageItem {
  return { id: stageId(), type: c.type, content: c.content, items: c.items, count: c.count, name: c.items?.[0]?.name };
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

function getFileIcon(item: ClipItem): string {
  const items = item.items ?? [];
  if (items.length > 1) return "📦";
  const first = items[0];
  if (!first) return "📎";
  const ext = (first.ext || first.path.split(".").pop() || "").toLowerCase();
  if (["png","jpg","jpeg","gif","webp","bmp","svg","ico"].includes(ext) || first.isImage) return "🖼️";
  if (["mp4","mkv","avi","mov","wmv"].includes(ext)) return "🎬";
  if (["mp3","wav","flac","ogg","aac","m4a"].includes(ext)) return "🎵";
  if (["zip","rar","7z","tar","gz","bz2","xz"].includes(ext)) return "🗜️";
  if (ext === "pdf") return "📄";
  if (["doc","docx","odt"].includes(ext)) return "📝";
  if (["xls","xlsx","csv"].includes(ext)) return "📊";
  if (["ppt","pptx"].includes(ext)) return "📊";
  if (["js","ts","jsx","tsx","py","rs","go","cpp","c","h","java","cs","html","css","json","yaml","yml","xml","toml"].includes(ext)) return "💻";
  if (["exe","msi","bat","cmd","ps1","sh"].includes(ext)) return "⚙️";
  if (["txt","md","log","ini","cfg","conf"].includes(ext)) return "📃";
  return "📎";
}

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
  | { kind: "stage"; item: StageItem; name: string; ranges: [number, number][] };

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const [time, setTime] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stage, setStage] = useState<StageItem[]>([]); // 文件中转区：混合条目（文件/文本/图片）
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
  const [store, setStore] = useState<any>(null);
  const [clipboard, setClipboard] = useState<ClipItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [theme, setTheme] = useState<"dark"|"light"|"system">("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [copiedTime, setCopiedTime] = useState<number|null>(null); // 最近"只复制"的剪贴板项 time，用于按钮 ✓ 反馈
  const [copiedStageId, setCopiedStageId] = useState<number|null>(null); // 中转条目"复制到剪贴板"的 ✓ 反馈
  const [imgCacheCleared, setImgCacheCleared] = useState(false); // 设置面板「清空缓存」✓ 反馈
  const [launchAnim, setLaunchAnim] = useState<LaunchAnim|null>(null); // 启动放大暂留动画的克隆数据，null=无动画
  const [dismissing, setDismissing] = useState(false); // 覆盖层「快速淡出露桌面」——启动应用与剪贴板粘贴共用同一套消失观感
  const [clipCacheMax, setClipCacheMax] = useState(20); // 剪贴板历史保存条数（与 Rust CLIP_CACHE_MAX_RUNTIME 同步）
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null); // 自定义右键菜单
  const [autostartEnabled, setAutostartEnabled] = useState(false); // 开机自启
  const ctxMenuRef = useRef<CtxMenu>(null); // Esc 处理用（闭包快照避免加入 keydown deps）
  const clipCacheMaxRef = useRef(20); clipCacheMaxRef.current = clipCacheMax; // 供 clipboard-update 闭包读最新值
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const launchingRef = useRef(false); // 防连点/重复触发（setState 异步，用 ref 即时锁）
  const stageRef = useRef<StageItem[]>(stage); stageRef.current = stage; // 给 []-注册的 files-dropped 监听取最新 stage（避开闭包过期）
  const storeRef = useRef<any>(null); storeRef.current = store;
  const [stageSel, setStageSel] = useState<Set<number>>(new Set<number>()); // 中转区多选（选中的 StageItem.id）
  const [stageMultiselect, setStageMultiselect] = useState(false); // 多选模式开关（显式进入，非按住修饰键）
  const [batchCopied, setBatchCopied] = useState(false); // 批量复制 ✓ 反馈
  const stageSelRef = useRef<Set<number>>(new Set<number>()); stageSelRef.current = stageSel; // 供 Esc keydown 闭包读最新（仿 ctxMenuRef 模式）
  const stageMultiselectRef = useRef(false); stageMultiselectRef.current = stageMultiselect; // 同上
  const stageAnchorRef = useRef<number|null>(null); // shift 区间选择锚点 index
  // 剪贴板卡片长按拖拽到中转区（纯前端，Pointer Events，移动超阈值才激活）
  const [dragState, setDragState] = useState<{ item: ClipItem; originX: number; originY: number; currentX: number; currentY: number; active: boolean } | null>(null);
  const dragStateRef = useRef(dragState); // 供 pointermove/up 闭包读最新值（setState 异步）
  useEffect(() => { dragStateRef.current = dragState; }, [dragState]);
  const dropAreaRef = useRef<HTMLDivElement | null>(null); // 中转区 .drop-area，命中检测用
  const suppressClickRef = useRef(false); // 激活拖拽后抑制随之而来的 onClick（防拖拽落点误触发粘贴）
  // 增强搜索（Ctrl+K 独立全屏视图层；同一 overlay 内的视图层，不开新窗、不碰 show/hide/焦点/粘贴高危区）
  const [enhOpen, setEnhOpen] = useState(false);
  const [enhQuery, setEnhQuery] = useState("");
  const [enhSelIdx, setEnhSelIdx] = useState(0);
  const enhInputRef = useRef<HTMLInputElement>(null);
  const enhOpenRef = useRef(false); enhOpenRef.current = enhOpen; // 供 Esc keydown 闭包读最新

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
  useEffect(() => { (async()=>{ try { const {load}=await import("@tauri-apps/plugin-store"); const s=await load("workbench-data.json",{autoSave:true,defaults:{}}); setStore(s); const raw=await s.get<Record<string,number|AppUsage>>("app-frequency")??{}; const nowS=Math.floor(Date.now()/1000); const usage:Record<string,AppUsage>={}; for(const[k,v]of Object.entries(raw)){ usage[k]= typeof v==="number" ? {count:v,last_used:nowS} : v; } setAppUsage(usage); const savedTheme=await s.get<string>("theme"); if(savedTheme==="dark"||savedTheme==="light"||savedTheme==="system") setTheme(savedTheme); const savedMax=await s.get<number>("clip-cache-max"); if(typeof savedMax==="number"&&savedMax>=10&&savedMax<=100){ setClipCacheMax(savedMax); clipCacheMaxRef.current=savedMax; try{const{invoke}=await import("@tauri-apps/api/core");await invoke("set_clip_cache_max",{n:savedMax});}catch{} } const savedStage=await s.get<StageItem[]>("stage-items"); if(savedStage&&savedStage.length){ setStage(savedStage.slice(0,STAGE_MAX)); } else { const fps=await s.get<string[]>("file-list")??[]; if(fps.length){ const {invoke}=await import("@tauri-apps/api/core"); const items:StageItem[]=[]; for(const fp of fps.slice(0,STAGE_MAX)){ try { items.push(fileEntryToStage(await invoke<FileEntry>("get_file_info",{path:fp}))); } catch{} } setStage(items); } } } catch{} })(); }, []);

  // ── 开机自启：启动时读取当前状态 ──
  useEffect(() => { (async()=>{ try { const {invoke}=await import("@tauri-apps/api/core"); const enabled=await invoke<boolean>("plugin:autostart|is_enabled"); setAutostartEnabled(enabled); } catch{} })(); }, []);

  const saveStage = useCallback(async (list:StageItem[]) => { setStage(list); if(store){ await store.set("stage-items",list); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const cur=appUsage[p]; const u={...appUsage,[p]:{count:(cur?.count??0)+1,last_used:Math.floor(Date.now()/1000)}}; setAppUsage(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appUsage,store]);

  // ── 核心：事件监听（只注册一次，依赖[]）。可见性唯一真相在 Rust，前端只同步 ──
  useEffect(() => {
    let cleanup: (() => void)[] = [];
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un1 = await listen("hotkey-show", () => setVisible(true));
        const un2 = await listen("hotkey-hide", () => { setVisible(false); setLaunchAnim(null); setDismissing(false); launchingRef.current = false; setStageSel(new Set<number>()); setStageMultiselect(false); stageAnchorRef.current = null; setEnhOpen(false); setEnhQuery(""); setEnhSelIdx(0); }); // 复位
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
        // 原生拖入：Rust IDropTarget 收到外部文件 → emit 真实路径 → 转 file 型 StageItem 入中转（复用续26 去重/置顶/持久化）
        const un4 = await listen("files-dropped", async (event: any) => {
          const paths: string[] = event.payload || [];
          if (!paths.length) return;
          const { invoke } = await import("@tauri-apps/api/core");
          const built: StageItem[] = [];
          for (const p of paths) { try { built.push(fileEntryToStage(await invoke<FileEntry>("get_file_info", { path: p }))); } catch {} }
          if (!built.length) return;
          let next = [...stageRef.current];
          for (const it of built) {
            if (next.length >= STAGE_MAX) break;
            if (next.some(s => s.type === "file" && s.items?.[0]?.path === it.items?.[0]?.path)) continue; // 同路径去重
            next.push(it);
          }
          next = next.slice(0, STAGE_MAX);
          setStage(next);
          if (storeRef.current) { try { await storeRef.current.set("stage-items", next); await storeRef.current.save(); } catch {} }
          // Step 3：拖入后回焦点，让 Esc 可用（overlay 已显示+深色渲染，无白闪风险）
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setFocus(); } catch {}
        });
        cleanup = [un1, un2, un3, un4];
      } catch (e) { console.error("listen error:", e); }
    })();
    return () => { cleanup.forEach(fn => fn()); };
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
    // 加载应用（首次加载后缓存，不再重复扫描）
    if (!loadedRef.current) {
      loadedRef.current = true;
      (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const list = await invoke<AppInfo[]>("scan_start_menu");
          // 不在此处定死顺序：排序交给 sortedApps（响应 appUsage 变化，刚用过的 app 下次浮上来）
          setApps(list);
        } catch {}
      })();
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

  // ── 增强搜索结果（应用 + 中转区 file 条目；空查询=常用应用兜底，可直接 Enter）──
  const enhResults = useMemo<EnhResult[]>(() => {
    const q = enhQuery.trim();
    const nowS = Math.floor(Date.now() / 1000);
    if (!q) return sortedApps.slice(0, 30).map(app => ({ kind: "app" as const, app, ranges: [] as [number, number][] }));
    const appHits = apps.map(app => { const r = fuzzyScore(q, app.name); return { kind: "app" as const, app, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    const stageHits = stage.filter(s => s.type === "file").map(s => { const nm = s.name || s.items?.[0]?.name || "文件"; const r = fuzzyScore(q, nm); return { kind: "stage" as const, item: s, name: nm, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    return [...appHits, ...stageHits]
      .sort((a, b) => b.score - a.score || (a.kind === "app" && b.kind === "app" ? usageScore(appUsage[b.app.path], nowS) - usageScore(appUsage[a.app.path], nowS) : 0))
      .slice(0, 50)
      .map(({ score, ...rest }) => rest as EnhResult);
  }, [enhQuery, apps, stage, sortedApps, appUsage]);

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
    else { hideWorkbench(); import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_file", { path: r.item.items![0].path })).catch(() => {}); }
  }, [launchApp]);
  // 注：原生拖入（drag-in）已废弃——全屏 transparent+alwaysOnTop+focus:false 覆盖层收不到任何 OLE 拖放事件（阶段2 实测：零事件+红色禁止），且全屏会盖住拖拽源。改走剪贴板 📌 钉入。详见 DECISIONS §14。
  const removeStage = useCallback((id:number) => { saveStage(stage.filter(s=>s.id!==id)); }, [stage,saveStage]);
  // 剪贴板项「钉到中转」：同类型同内容已在则不重复；新项置顶
  const addToStage = useCallback((c:ClipItem) => {
    const exists = stage.some(s => s.type===c.type && (c.type==="file" ? s.items?.[0]?.path===c.items?.[0]?.path : s.content===c.content));
    if (exists) return;
    saveStage([clipToStage(c), ...stage].slice(0,STAGE_MAX));
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
  const clearClipboard = useCallback(async () => {
    setClipboard([]);
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("clear_clipboard_history"); } catch{}
  }, []);
  const clearStage = useCallback(async () => { await saveStage([]); }, [saveStage]);
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

  const fi = (ext:string)=>({pdf:"📄",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",ppt:"📽️",pptx:"📽️",jpg:"🖼️",png:"🖼️",gif:"🖼️",mp4:"🎬",mp3:"🎵",zip:"📦",rar:"📦",exe:"⚙️",txt:"📃"}[ext.toLowerCase()]??"📎");

  // ── 键盘 ──
  const GRID_COLS = 6;
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){e.preventDefault();if(ctxMenuRef.current){setCtxMenu(null);return;}if(enhOpenRef.current){setEnhOpen(false);setEnhQuery("");searchRef.current?.focus();return;}if(stageSelRef.current.size||stageMultiselectRef.current){setStageSel(new Set<number>());setStageMultiselect(false);stageAnchorRef.current=null;return;}if(settingsOpen){setSettingsOpen(false);return;}setVisible(false);hideWorkbench();return;}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();if(enhOpen){setEnhOpen(false);setEnhQuery("");searchRef.current?.focus();}else{setEnhQuery("");setEnhSelIdx(0);setEnhOpen(true);setTimeout(()=>enhInputRef.current?.focus(),0);}return;}
      if(settingsOpen)return; // 设置打开时屏蔽应用导航/启动按键
      if(enhOpen){ // 增强搜索接管导航，屏蔽下面 launcher 键（字母键不拦截，正常输入到 enhInput）
        if(e.key==="ArrowDown"){e.preventDefault();setEnhSelIdx(i=>Math.min(i+1,enhResults.length-1));}
        else if(e.key==="ArrowUp"){e.preventDefault();setEnhSelIdx(i=>Math.max(i-1,0));}
        else if(e.key==="Enter"){e.preventDefault();const r=enhResults[enhSelIdx]??enhResults[0];if(r)activateEnh(r, document.querySelector<HTMLElement>(".enh-result.selected .enh-result-icon"));}
        return;
      }
      if(e.key==="ArrowLeft"){e.preventDefault();setSelectedIdx(i=>Math.max(i-1,0));}
      if(e.key==="ArrowRight"){e.preventDefault();setSelectedIdx(i=>Math.min(i+1,filteredApps.length-1));}
      if(e.key==="ArrowUp"){e.preventDefault();setSelectedIdx(i=>Math.max(i-GRID_COLS,0));}
      if(e.key==="ArrowDown"){e.preventDefault();setSelectedIdx(i=>Math.min(i+GRID_COLS,filteredApps.length-1));}
      if(e.key==="Tab"){e.preventDefault();const n=filteredApps.length;if(n)setSelectedIdx(i=>e.shiftKey?(i-1+n)%n:(i+1)%n);} // Tab 下一个 / Shift+Tab 上一个（循环）
      if(e.key==="Enter"&&filteredApps.length){e.preventDefault();const a=filteredApps[selectedIdx]??filteredApps[0];if(a)launchApp(a.app, document.querySelector<HTMLElement>(".app-tile.selected .app-tile-icon"));}
    };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  }, [visible, filteredApps, selectedIdx, launchApp, settingsOpen, enhOpen, enhResults, enhSelIdx, activateEnh]);

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}`} onContextMenu={e=>e.preventDefault()}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
        <div className="top-center">
          <div className="global-search">
            <svg className="search-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input ref={searchRef} className="search-field" placeholder="搜索应用、中转、剪贴板…" value={search} onChange={e=>{setSearch(e.target.value);setSelectedIdx(0);}} spellCheck={false} />
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
          <div className="section-label">应用启动器</div>
          <div className="app-grid">
            {filteredApps.map(({app,ranges},i)=>(
              <div key={app.path} className={`app-tile${i===selectedIdx?" selected":""}`} onClick={e=>launchApp(app, e.currentTarget.querySelector<HTMLElement>(".app-tile-icon"))} onMouseEnter={()=>setSelectedIdx(i)} title="单击打开">
                <div className="app-tile-icon">{app.icon?<img src={app.icon} alt=""/>:<span>{app.name[0]}</span>}</div>
                <span className="app-tile-label"><HighlightText text={app.name} ranges={ranges} /></span>
              </div>
            ))}
            {!filteredApps.length && <p className="empty-hint" style={{gridColumn:"1/-1"}}>{apps.length?"无匹配":"扫描中..."}</p>}
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
          <div className="drop-area" ref={dropAreaRef}>
            {filteredStage.length? <div className="stage-list">{filteredStage.map((s,idx)=>{
              const label = s.type==="text" ? (s.content?.slice(0,60)||"文本") : s.type==="image" ? "图片" : (s.count!==1? `${s.count} 个文件` : (s.name||s.items?.[0]?.name||"文件"));
              return (
              <div key={s.id} className={`stage-item${stageSel.has(s.id)?" selected":""}`} onClick={e=>handleStageClick(e,s,idx)} onContextMenu={e=>openStageCtxMenu(e,s)} title={stageMultiselect?"单击选中 / 取消":(s.type==="file"?"单击取走（写回剪贴板并粘贴）":"单击取走（粘贴到上个窗口）")}>
                {s.type==="image"
                  ? <img className="stage-thumb" src={s.content} alt=""/>
                  : <span className="stage-emoji">{s.type==="text"?"📝":(s.items?.[0]?.isImage?"🖼️":(s.isDir?"📁":fi(s.ext??s.items?.[0]?.ext??"")))}</span>}
                <span className="stage-title">{label}</span>
                {s.type==="file"&&s.count===1&&s.size?<span className="stage-meta">{fmtSize(s.size)}</span>:null}
                <div className="stage-actions">
                  <button className={`clip-copy-btn${copiedStageId===s.id?" copied":""}`} onClick={e=>{e.stopPropagation();copyStageToClipboard(s);}} title={copiedStageId===s.id?"已复制":"复制到剪贴板"}>
                    {copiedStageId===s.id
                      ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                  </button>
                  {s.type==="file"&&<button className="stage-open-btn" onClick={e=>{e.stopPropagation();openStageFile(s);}} title="打开"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>}
                  <button className="clip-del-btn" onClick={e=>{e.stopPropagation();removeStage(s.id);}} title="移除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
                </div>
              </div>);
            })}</div>: <p className="empty-hint">{search.trim()?"无匹配":"拖入文件 / 文件夹，或在剪贴板卡片点 📌 钉入"}</p>}
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
      <div className={`enh-layer${enhOpen?" enh-open":""}`}>
        <div className="enh-search-box">
          <svg className="search-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input ref={enhInputRef} className="enh-search-input" placeholder="搜索应用、中转文件…"
            value={enhQuery} onChange={e=>{setEnhQuery(e.target.value);setEnhSelIdx(0);}} spellCheck={false}/>
          <span className="enh-hint"><kbd>Esc</kbd> 返回</span>
        </div>
        <div className="enh-results">
          {enhResults.length ? enhResults.map((r,i)=>{
            const key = r.kind==="app" ? "app:"+r.app.path : "stage:"+r.item.id;
            const icon = r.kind==="app" ? (r.app.icon? <img src={r.app.icon} alt=""/> : <span>{r.app.name[0]}</span>)
                                        : <span>{fi(r.item.ext??r.item.items?.[0]?.ext??"")}</span>;
            const label = r.kind==="app" ? r.app.name : r.name;
            return (
              <div key={key} className={`enh-result${i===enhSelIdx?" selected":""}`}
                onMouseEnter={()=>setEnhSelIdx(i)}
                onClick={e=>activateEnh(r, e.currentTarget.querySelector<HTMLElement>(".enh-result-icon"))}>
                <div className="enh-result-icon">{icon}</div>
                <span className="enh-result-label"><HighlightText text={label} ranges={r.ranges}/></span>
                <span className="enh-result-badge">{r.kind==="app"?"应用":"中转"}</span>
              </div>
            );
          }) : <p className="empty-hint">{enhQuery.trim()?"无匹配":"输入以搜索"}</p>}
        </div>
      </div>
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
                {settingsTab==="hotkeys" && (<>
                  <div className="settings-panel-title">快捷键</div>
                  <div className="settings-row"><span className="settings-row-label">呼出 / 隐藏</span><kbd>Ctrl+Space</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">关闭面板</span><kbd>Esc</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">应用导航</span><kbd>↑↓</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">启动选中应用</span><kbd>Enter</kbd></div>
                  <p className="settings-hint">当前快捷键暂不可自定义，后续版本开放配置。</p>
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
        <div className="bot-center"><kbd>Ctrl+Space</kbd> 切换 · <kbd>Esc</kbd> 关闭 · <kbd>↑↓</kbd> 导航 · <kbd>Enter</kbd> 启动</div>
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
