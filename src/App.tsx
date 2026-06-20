import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./App.css";

// ── 类型 ──
interface AppInfo { name: string; path: string; icon: string | null; }
interface AppUsage { count: number; last_used: number; } // last_used = Unix 秒
interface FileEntry { path: string; name: string; isDir: boolean; size: number; ext: string; }
interface FileItem { path: string; name: string; ext: string; isImage: boolean; }
interface ClipItem { type: "text" | "image" | "file"; content?: string; time: number; items?: FileItem[]; count?: number; }

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

// 设置条目（左侧导航）；随后续开发逐步扩展，每项独立成区
const SETTINGS_TABS = [
  { id: "general",   icon: "⚙",  label: "常规" },
  { id: "clipboard", icon: "📋", label: "剪贴板" },
  { id: "hotkeys",   icon: "⌨",  label: "快捷键" },
  { id: "about",     icon: "ℹ",  label: "关于" },
] as const;
type SettingsTab = typeof SETTINGS_TABS[number]["id"];

// 应用启动「放大暂留」动画（Mac 启动台式）：点击后图标放大淡出、覆盖层淡出露桌面，暗示刚启动了什么。
// 时长可调；放大幅度在 CSS @keyframes launch-pop 里（克制档 scale 1.4）。
const LAUNCH_ANIM_MS = 200;
// 顶层克隆浮层的数据：图标 + 点击瞬间的屏幕坐标（getBoundingClientRect）。
// 用克隆而非就地 transform——避开 .app-grid/.app-panel/.main-area 的 overflow 裁剪。
interface LaunchAnim { icon: string | null; name: string; rect: { top: number; left: number; width: number; height: number }; }

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const [time, setTime] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
  const [store, setStore] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  const [clipboard, setClipboard] = useState<ClipItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [theme, setTheme] = useState<"dark"|"light"|"system">("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [copiedTime, setCopiedTime] = useState<number|null>(null); // 最近"只复制"的项 time，用于按钮 ✓ 反馈
  const [launchAnim, setLaunchAnim] = useState<LaunchAnim|null>(null); // 启动放大暂留动画的克隆数据，null=无动画
  const [dismissing, setDismissing] = useState(false); // 覆盖层「快速淡出露桌面」——启动应用与剪贴板粘贴共用同一套消失观感
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const launchingRef = useRef(false); // 防连点/重复触发（setState 异步，用 ref 即时锁）

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
  useEffect(() => { (async()=>{ try { const {load}=await import("@tauri-apps/plugin-store"); const s=await load("workbench-data.json",{autoSave:true,defaults:{}}); setStore(s); const raw=await s.get<Record<string,number|AppUsage>>("app-frequency")??{}; const nowS=Math.floor(Date.now()/1000); const usage:Record<string,AppUsage>={}; for(const[k,v]of Object.entries(raw)){ usage[k]= typeof v==="number" ? {count:v,last_used:nowS} : v; } setAppUsage(usage); const savedTheme=await s.get<string>("theme"); if(savedTheme==="dark"||savedTheme==="light"||savedTheme==="system") setTheme(savedTheme); const fps=await s.get<string[]>("file-list")??[]; if(fps.length){ const {invoke}=await import("@tauri-apps/api/core"); const infos:FileEntry[]=[]; for(const fp of fps.slice(0,10)){ try { infos.push(await invoke<FileEntry>("get_file_info",{path:fp})); } catch{} } setFiles(infos); } } catch{} })(); }, []);

  const saveFiles = useCallback(async (list:FileEntry[]) => { setFiles(list); if(store){ await store.set("file-list",list.map(f=>f.path)); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const cur=appUsage[p]; const u={...appUsage,[p]:{count:(cur?.count??0)+1,last_used:Math.floor(Date.now()/1000)}}; setAppUsage(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appUsage,store]);

  // ── 核心：事件监听（只注册一次，依赖[]）。可见性唯一真相在 Rust，前端只同步 ──
  useEffect(() => {
    let cleanup: (() => void)[] = [];
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un1 = await listen("hotkey-show", () => { setVisible(true); setDismissing(false); }); // 重开取消可能在播的淡出
        const un2 = await listen("hotkey-hide", () => { setVisible(false); setLaunchAnim(null); setDismissing(false); launchingRef.current = false; }); // 复位启动/粘贴/关闭动画
        const unDismiss = await listen("hotkey-dismiss", () => setDismissing(true)); // 短按 toggle 关闭：Rust 触发覆盖层淡出，200ms 后由 Rust hide
        const un3 = await listen("clipboard-update", (event: any) => {
          const item: ClipItem = { type: event.payload.type as "text"|"image"|"file", content: event.payload.content, time: event.payload.time, items: event.payload.items, count: event.payload.count };
          setClipboard(prev => {
            const filtered = prev.filter(x => {
              if (item.type === "file" && x.type === "file") return x.items?.[0]?.path !== item.items?.[0]?.path;
              if (item.type !== "file" && x.type !== "file") return x.content !== item.content;
              return true; // 不同类型保留
            });
            return [item, ...filtered].slice(0, 20);
          });
        });
        cleanup = [un1, un2, un3, unDismiss];
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
        const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number}[]>("get_clipboard_history");
        if (history.length) {
          setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count })));
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
  const handleDrop = useCallback(async (e:React.DragEvent) => { e.preventDefault(); setDragOver(false); const items=Array.from(e.dataTransfer.files??[]); if(!items.length) return; const {invoke}=await import("@tauri-apps/api/core"); const nf=[...files]; for(const item of items){ const fp=(item as any).path??item.name; if(nf.length>=10) break; if(nf.some(f=>f.path===fp)) continue; try { nf.push(await invoke<FileEntry>("get_file_info",{path:fp})); } catch{} } await saveFiles(nf.slice(0,10)); }, [files,saveFiles]);
  const removeFile = useCallback(async (i:number) => { await saveFiles(files.filter((_,j)=>j!==i)); }, [files,saveFiles]);
  const openFile = useCallback((f:FileEntry) => {
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:f.path})).catch(()=>{});
  }, []);
  const deleteClipItem = useCallback(async (time:number) => {
    setClipboard(prev => prev.filter(c => c.time !== time));
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("delete_clipboard_item",{time}); } catch{}
  }, []);
  const changeTheme = useCallback(async (t:"dark"|"light"|"system") => {
    setTheme(t);
    if(store){ await store.set("theme",t); await store.save(); }
  }, [store]);
  const clearClipboard = useCallback(async () => {
    setClipboard([]);
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("clear_clipboard_history"); } catch{}
  }, []);
  const copyAndPaste = useCallback((item:ClipItem) => {
    if (launchingRef.current) return; // 与启动共用锁：动画进行中忽略
    // 实际粘贴：hide+交还焦点+Ctrl+V 全在 Rust 命令内（流程不变），此处仅负责调用
    const doPaste = async () => {
      const {invoke}=await import("@tauri-apps/api/core");
      if (item.type === "text") { try { await invoke("paste_clipboard",{text:item.content}); } catch{ await hideWorkbench(); } }
      else if (item.type === "file" && item.items) { try { await invoke("set_clipboard_files",{paths:item.items.map(f=>f.path)}); } catch{ await hideWorkbench(); } }
      else { try { await invoke("set_clipboard_image",{base64:item.content}); } catch{ await hideWorkbench(); } }
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
      const {invoke}=await import("@tauri-apps/api/core");
      if (item.type === "text") await invoke("copy_text_to_clipboard",{text:item.content});
      else if (item.type === "file" && item.items) await invoke("copy_files_to_clipboard",{paths:item.items.map(f=>f.path)});
      else await invoke("copy_image_to_clipboard",{base64:item.content});
      setCopiedTime(item.time);
      setTimeout(()=>setCopiedTime(t=>t===item.time?null:t), 1000); // 1s 后还原 ✓（仅当未被更新的复制覆盖）
    } catch {}
  }, []);
  const openShortcut = useCallback((target:string) => {
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("launch_app",{path:target})).catch(()=>{});
  }, []);
  const fi = (ext:string)=>({pdf:"📄",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",ppt:"📽️",pptx:"📽️",jpg:"🖼️",png:"🖼️",gif:"🖼️",mp4:"🎬",mp3:"🎵",zip:"📦",rar:"📦",exe:"⚙️",txt:"📃"}[ext.toLowerCase()]??"📎");

  // ── 键盘 ──
  const GRID_COLS = 6;
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){e.preventDefault();if(settingsOpen){setSettingsOpen(false);return;}setVisible(false);hideWorkbench();return;}
      if(settingsOpen)return; // 设置打开时屏蔽应用导航/启动按键
      if(e.key==="ArrowLeft"){e.preventDefault();setSelectedIdx(i=>Math.max(i-1,0));}
      if(e.key==="ArrowRight"){e.preventDefault();setSelectedIdx(i=>Math.min(i+1,filteredApps.length-1));}
      if(e.key==="ArrowUp"){e.preventDefault();setSelectedIdx(i=>Math.max(i-GRID_COLS,0));}
      if(e.key==="ArrowDown"){e.preventDefault();setSelectedIdx(i=>Math.min(i+GRID_COLS,filteredApps.length-1));}
      if(e.key==="Tab"){e.preventDefault();const n=filteredApps.length;if(n)setSelectedIdx(i=>e.shiftKey?(i-1+n)%n:(i+1)%n);} // Tab 下一个 / Shift+Tab 上一个（循环）
      if(e.key==="Enter"&&filteredApps.length){e.preventDefault();const a=filteredApps[selectedIdx]??filteredApps[0];if(a)launchApp(a.app, document.querySelector<HTMLElement>(".app-tile.selected .app-tile-icon"));}
    };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  }, [visible, filteredApps, selectedIdx, launchApp, settingsOpen]);

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}`}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
        <div className="top-center">
          <div className="global-search">
            <svg className="search-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input ref={searchRef} className="search-field" placeholder="搜索应用、文件..." value={search} onChange={e=>{setSearch(e.target.value);setSelectedIdx(0);}} spellCheck={false} />
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
          <div className="section-label">文件中转区</div>
          <div className={`drop-area${dragOver?" drag-active":""}`} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop}>
            {files.length? files.map((f,i)=>(
              <div key={f.path} className="file-row" onClick={()=>openFile(f)} onContextMenu={e=>{e.preventDefault();removeFile(i);}}>
                <span className="file-emoji">{f.isDir?"📁":fi(f.ext)}</span>
                <span className="file-title">{f.name}</span>
                <span className="file-meta-sm">{f.isDir?"":f.ext.toUpperCase()}{!f.isDir&&` · ${fmtSize(f.size)}`}</span>
                <button className="rm-btn" onClick={e=>{e.stopPropagation();removeFile(i);}}>×</button>
              </div>
            )): <p className="empty-hint">拖入文件或文件夹</p>}
          </div>
          <div className="section-label" style={{marginTop:16}}>快捷入口</div>
          <div className="shortcut-row">
            {[{l:"此电脑",e:"🖥️",a:"explorer.exe"},{l:"下载",e:"⬇️",a:"explorer.exe"},{l:"文档",e:"📂",a:"explorer.exe"},{l:"桌面",e:"🖼️",a:"explorer.exe"},{l:"控制面板",e:"⚙️",a:"control"},{l:"任务管理器",e:"📊",a:"taskmgr"},{l:"终端",e:"⬛",a:"wt"},{l:"计算器",e:"🔢",a:"calc"}].map(s=>(
              <button key={s.l} className="shortcut-chip" onClick={()=>openShortcut(s.a)}><span>{s.e}</span><span>{s.l}</span></button>
            ))}
          </div>
        </section>
        <section className="clip-panel">
          <div className="section-label">剪贴板历史</div>
          <div className="clip-list">
            {clipboard.length? clipboard.map((c,i)=>(
              <div key={i} className="clip-block" onClick={()=>copyAndPaste(c)} title={c.type==="text"?"单击左键粘贴":c.type==="file"?"单击左键粘贴文件":"单击左键复制"}>
                <div className="clip-actions">
                  <button className={`clip-copy-btn${copiedTime===c.time?" copied":""}`} onClick={e=>{e.stopPropagation();copyToClipboard(c);}} title={copiedTime===c.time?"已复制":"复制到剪贴板"}>
                    {copiedTime===c.time
                      ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                  </button>
                  <button className="clip-del-btn" onClick={e=>{e.stopPropagation();deleteClipItem(c.time);}} title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
                </div>
                {c.type==="image"? <img className="clip-image" src={c.content} alt=""/>
                : c.type==="file"? <div className="file-clip-preview">
                    <span className="file-clip-icon">{c.items?.[0]?.isImage?"🖼️":"📁"}</span>
                    <span className="file-clip-info">{c.count===1? c.items?.[0]?.name : `${c.count}个文件`}</span>
                  </div>
                : <span className="clip-preview">{c.content?.slice(0,100)}{(c.content?.length??0)>100?"…":""}</span>}
                <span className="clip-time">{c.type==="image"?"📷 ":c.type==="file"?"📎 ":""}{ago(c.time)}</span>
              </div>
            )): <p className="empty-hint">显示时自动读取</p>}
          </div>
        </section>
      </main>
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
                </>)}
                {settingsTab==="clipboard" && (<>
                  <div className="settings-panel-title">剪贴板</div>
                  <div className="settings-row">
                    <span className="settings-row-label">剪贴板历史<span className="settings-row-sub">{clipboard.length} 条</span></span>
                    <button className="settings-action" onClick={clearClipboard} disabled={!clipboard.length}>清空</button>
                  </div>
                  <p className="settings-hint">复制的文本、图片、文件会自动记录，最多保留 20 条。</p>
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
   </>
  );
}
