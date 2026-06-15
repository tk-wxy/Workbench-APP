import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./App.css";

// ── 类型 ──
interface AppInfo { name: string; path: string; icon: string | null; }
interface FileEntry { path: string; name: string; isDir: boolean; size: number; ext: string; }
interface ClipItem { type: "text" | "image"; content: string; time: number; }

function fmtSize(b: number) { if (!b) return "0 B"; const u = ["B","KB","MB","GB"]; const i = Math.min(Math.floor(Math.log(b)/Math.log(1024)), u.length-1); return `${(b/1024**i).toFixed(i?1:0)} ${u[i]}`; }
function ago(ms: number) { const s = Math.floor((Date.now()-ms)/1000); if (s<60) return "刚刚"; if (s<3600) return `${Math.floor(s/60)}分钟前`; return `${Math.floor(s/3600)}小时前`; }

async function hideWorkbench() { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("hide_window"); } catch{} }

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  // 诊断：监听 visible 变化
  useEffect(() => { console.log("[frontend] visible state changed to:", visible); }, [visible]);
  const [search, setSearch] = useState("");
  const [time, setTime] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [appFreq, setAppFreq] = useState<Record<string,number>>({});
  const [store, setStore] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  const [clipboard, setClipboard] = useState<ClipItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  // ── 时钟 ──
  useEffect(() => { const u=()=>setTime(new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})); u(); const t=setInterval(u,1000); return ()=>clearInterval(t); }, []);

  // ── Store ──
  useEffect(() => { (async()=>{ try { const {load}=await import("@tauri-apps/plugin-store"); const s=await load("workbench-data.json",{autoSave:true,defaults:{}}); setStore(s); const freq=await s.get<Record<string,number>>("app-frequency")??{}; setAppFreq(freq); const fps=await s.get<string[]>("file-list")??[]; if(fps.length){ const {invoke}=await import("@tauri-apps/api/core"); const infos:FileEntry[]=[]; for(const fp of fps.slice(0,10)){ try { infos.push(await invoke<FileEntry>("get_file_info",{path:fp})); } catch{} } setFiles(infos); } } catch{} })(); }, []);

  const saveFiles = useCallback(async (list:FileEntry[]) => { setFiles(list); if(store){ await store.set("file-list",list.map(f=>f.path)); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const u={...appFreq,[p]:(appFreq[p]??0)+1}; setAppFreq(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appFreq,store]);

  // ── 诊断 ref ──
  const visibleRef = useRef(false);

  // ── 核心：事件监听（只注册一次，依赖[]） ──
  useEffect(() => {
    let cleanup: (() => void)[] = [];
    console.log("[frontend] useEffect setup — registering listeners ONCE");
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un1 = await listen("hotkey-show", () => {
          console.log("[frontend] SHOW opacity→1 at", performance.now().toFixed(1), "ms");
          visibleRef.current = true;
          setVisible(true);
        });
        const un2 = await listen("hotkey-hide", () => {
          console.log("[frontend] ← hotkey-hide received, current visibleRef=", visibleRef.current);
          visibleRef.current = false;
          setVisible(false);
          // Rust 侧已直接 window.hide()，前端只需同步状态
        });
        cleanup = [un1, un2];
        console.log("[frontend] listeners registered OK");
      } catch (e) { console.error("[frontend] listen error:", e); }
    })();
    return () => {
      console.log("[frontend] useEffect cleanup — unlisten");
      cleanup.forEach(fn => fn());
    };
  }, []);

  // ── 窗口显示时加载数据 + 剪贴板轮询 ──
  useEffect(() => {
    if (!visible) return;
    // 首次立即读一次
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<{type:string;content:string}>("read_clipboard");
        if (r.type !== "empty" && r.content) {
          console.log("[frontend] INITIAL clipboard at", performance.now().toFixed(1), "ms, type=", r.type);
          const item: ClipItem = { type: r.type as "text"|"image", content: r.content, time: Date.now() };
          setClipboard(prev => { const filtered = prev.filter(x => x.content !== item.content); return [item, ...filtered].slice(0, 20); });
        }
      } catch {}
    })();
    // 轮询：每 500ms 检查剪贴板变化，visible=false 时 React 自动清理 interval
    let latest = "";
    const poll = setInterval(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<{type:string;content:string}>("read_clipboard");
        if (r.type !== "empty" && r.content && r.content !== latest) {
          console.log("[frontend] CLIPBOARD UPDATE at", performance.now().toFixed(1), "ms, type=", r.type, "len=", r.content.length);
          latest = r.content;
          const item: ClipItem = { type: r.type as "text"|"image", content: r.content, time: Date.now() };
          setClipboard(prev => { const filtered = prev.filter(x => x.content !== item.content); return [item, ...filtered].slice(0, 20); });
        }
      } catch {}
    }, 500);
    return () => clearInterval(poll);
    // 加载应用（首次加载后缓存，不再重复扫描）
    if (!loadedRef.current) {
      loadedRef.current = true;
      (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          let list = await invoke<AppInfo[]>("scan_start_menu");
          list.sort((a,b) => (appFreq[b.path]??0) - (appFreq[a.path]??0));
          setApps(list);
        } catch {}
      })();
    }
    setTimeout(() => searchRef.current?.focus(), 100);
  }, [visible]);

  // ── 搜索过滤 ──
  const q = search.toLowerCase().trim();
  const filteredApps = useMemo(() => q ? apps.filter(a=>a.name.toLowerCase().includes(q)||a.path.toLowerCase().includes(q)).slice(0,24) : apps.slice(0,24), [apps, q]);

  // ── 操作函数 ──
  const launchApp = useCallback(async (app:AppInfo) => { await recordUse(app.path); try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("launch_app",{path:app.path}); } catch{} await hideWorkbench(); }, [recordUse]);
  const handleDrop = useCallback(async (e:React.DragEvent) => { e.preventDefault(); setDragOver(false); const items=Array.from(e.dataTransfer.files??[]); if(!items.length) return; const {invoke}=await import("@tauri-apps/api/core"); const nf=[...files]; for(const item of items){ const fp=(item as any).path??item.name; if(nf.length>=10) break; if(nf.some(f=>f.path===fp)) continue; try { nf.push(await invoke<FileEntry>("get_file_info",{path:fp})); } catch{} } await saveFiles(nf.slice(0,10)); }, [files,saveFiles]);
  const removeFile = useCallback(async (i:number) => { await saveFiles(files.filter((_,j)=>j!==i)); }, [files,saveFiles]);
  const openFile = useCallback(async (f:FileEntry) => { try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("open_file",{path:f.path}); } catch{} await hideWorkbench(); }, []);
  const copyAndPaste = useCallback(async (item:ClipItem) => {
    console.log("[frontend] copyAndPaste called, type=", item.type);
    if (item.type === "text") { try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("paste_clipboard",{text:item.content}); } catch{ await hideWorkbench(); } }
    else { try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("set_clipboard_image",{base64:item.content}); } catch{} await hideWorkbench(); }
  }, []);
  const openShortcut = useCallback(async (target:string) => { try { const {invoke}=await import("@tauri-apps/api/core"); await invoke("launch_app",{path:target}); } catch{} await hideWorkbench(); }, []);
  const fi = (ext:string)=>({pdf:"📄",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",ppt:"📽️",pptx:"📽️",jpg:"🖼️",png:"🖼️",gif:"🖼️",mp4:"🎬",mp3:"🎵",zip:"📦",rar:"📦",exe:"⚙️",txt:"📃"}[ext.toLowerCase()]??"📎");

  // ── 键盘 ──
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){e.preventDefault();setVisible(false);return;}
      if(e.key==="ArrowDown"){e.preventDefault();setSelectedIdx(i=>Math.min(i+1,filteredApps.length-1));}
      if(e.key==="ArrowUp"){e.preventDefault();setSelectedIdx(i=>Math.max(i-1,0));}
      if(e.key==="Enter"&&filteredApps.length){e.preventDefault();const a=filteredApps[selectedIdx]??filteredApps[0];if(a)launchApp(a);}
    };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  }, [visible, filteredApps, selectedIdx, launchApp]);

  return (
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}`}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
        <div className="top-center">
          <div className="global-search">
            <svg className="search-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input ref={searchRef} className="search-field" placeholder="搜索应用、文件..." value={search} onChange={e=>{setSearch(e.target.value);setSelectedIdx(0);}} spellCheck={false} />
          </div>
        </div>
        <div className="top-right"><span className="clock">{time}</span></div>
      </header>
      <main className="main-area">
        <section className="app-panel">
          <div className="section-label">应用启动器</div>
          <div className="app-list">
            {filteredApps.map((a,i)=>(
              <div key={a.path} className={`app-row${i===selectedIdx?" selected":""}`} onClick={()=>launchApp(a)} onMouseEnter={()=>setSelectedIdx(i)}>
                <div className="app-icon-sm">{a.icon?<img src={a.icon} alt=""/>:<span>{a.name[0]}</span>}</div>
                <span className="app-name-text">{a.name}</span>
              </div>
            ))}
            {!filteredApps.length && <p className="empty-hint">{apps.length?"无匹配":"扫描中..."}</p>}
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
              <div key={i} className="clip-block" onClick={()=>copyAndPaste(c)} title={c.type==="text"?"点击粘贴":"点击复制"}>
                {c.type==="image"? <img className="clip-image" src={c.content} alt=""/> : <span className="clip-preview">{c.content.slice(0,100)}{c.content.length>100?"…":""}</span>}
                <span className="clip-time">{c.type==="image"?"📷 ":""}{ago(c.time)}</span>
              </div>
            )): <p className="empty-hint">显示时自动读取</p>}
          </div>
        </section>
      </main>
      <footer className="bottom-bar">
        <div className="bot-left"><span className="sys-dot"/><span>CPU {navigator.hardwareConcurrency??"?"} 核</span></div>
        <div className="bot-center"><kbd>Alt+F1</kbd> 切换 · <kbd>Esc</kbd> 关闭 · <kbd>↑↓</kbd> 导航 · <kbd>Enter</kbd> 启动</div>
        <div className="bot-right"><span>Workbench v0.1.0</span></div>
      </footer>
    </div>
  );
}
