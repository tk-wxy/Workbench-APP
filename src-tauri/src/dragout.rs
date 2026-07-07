//! 中转区拖出（drag-out）：用户在中转条目上按下并拖动超阈值后，overlay 隐藏，
//! 系统 OLE `DoDragDrop` 接管鼠标，用户拖到目标应用松手完成传递。
//!
//! 线程模型（铁律，不可绕过）：`DoDragDrop` 是阻塞调用、且要求调用线程已 `OleInitialize`（STA）。
//! 故全程跑在独立 `std::thread::spawn` detached 线程内：
//!   OleInitialize(STA) → 构建 IDataObject → 直接 hide overlay（Rust 侧 + 同步 `hotkey-hide`）→
//!   sleep 80ms 等合成器刷新+底层窗口成为 drop 目标 → DoDragDrop 阻塞 →
//!   按 effect emit `drag-out-done` → 延迟删临时文件 → OleUninitialize。
//! **绝不**在 `#[tauri::command]`（Tokio async 线程）内直接调 DoDragDrop。
//! DoDragDrop 阻塞在本线程，不影响热键键态轮询线程（独立线程）。
//!
//! 与 `dragdrop.rs`（拖入）正交：拖入是 setup 时一次性注册的 IDropTarget（接收侧）；
//! 拖出是按需 spawn 的 source 侧（IDataObject + IDropSource）。两者互不共享状态。

use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, Result, HRESULT};
use windows::Win32::Foundation::{BOOL, E_NOTIMPL, HGLOBAL, S_OK};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, DATADIR_GET,
    DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;

// ── 剪贴板格式编号（cfFormat 为 u16）──
const CF_UNICODETEXT: u16 = 13;
const CF_DIB: u16 = 8;
const CF_HDROP: u16 = 15;
const GMEM_MOVEABLE: u32 = 2;

// ── DoDragDrop / IDropSource 协议返回码（手定义、避开 import 路径在不同 windows 版本的差异）──
const DRAGDROP_S_DROP: HRESULT = HRESULT(0x0004_0100u32 as i32);
const DRAGDROP_S_CANCEL: HRESULT = HRESULT(0x0004_0101u32 as i32);
const DRAGDROP_S_USEDEFAULTCURSORS: HRESULT = HRESULT(0x0004_0102u32 as i32);
// QueryGetData/GetData 未命中返回码
const DV_E_FORMATETC: HRESULT = HRESULT(0x8004_0064u32 as i32);
const DV_E_TYMED: HRESULT = HRESULT(0x8004_0069u32 as i32);
// 鼠标左键位（grfKeyState）
const MK_LBUTTON: u32 = 0x0001;
// 临时 PNG 删除前的宽限（给目标 app 拷贝文件留时间，不阻塞 DoDragDrop 返回）
const TEMP_CLEANUP_DELAY_SECS: u64 = 5;
// DoDragDrop 在主线程**建立鼠标 capture 之后**再隐藏 overlay。绝不在 DoDragDrop 之前隐藏：
// 隐藏会释放鼠标 capture → DoDragDrop 起手 SetCapture 失败 → 拖拽根本不启动（续71 首版踩坑）。
const HIDE_AFTER_START_MS: u64 = 60;
const SW_HIDE: i32 = 0;
// "保持界面"模式：拖动中轮询热键键态的间隔（用户按热键→手动隐藏 overlay 去外部应用）。
// 与 lib.rs 的 HOTKEY_POLL_MS 同量级；那个是私有 const，此处独立取值、互不依赖。
const DRAG_HOTKEY_POLL_MS: u64 = 20;

// 拖出后是否自动关闭窗口（设置面板可切换，默认 true = 现状行为）。
// 关闭时：无论 move/copy/cancel，DoDragDrop 返回后都重新显示 overlay（复刻呼出三约束），
// 供"只是调整位置"的误触发场景使用；此时不再执行 activate_drop_target 前台交还（反正马上被抢回）。
static DRAGOUT_AUTO_CLOSE: AtomicBool = AtomicBool::new(true);

// 一次拖出的生命周期内为 true（do_drag_on_main 起手置位、收尾清位）。热键 monitor（lib.rs）据此
// 在拖动期间**不活性化**自己的 show/hide toggle——否则"保持界面"模式下用户拖动中按热键去外部时，
// monitor 会误把这次按键当普通 toggle 处理、并发操作窗口可见性，导致隐藏后松手落地时白闪。
// 窗口可见性在拖动期间由 dragout 独占（自动隐藏 / 自轮询手动隐藏），monitor 只管拖动之外的 show/hide。
static DRAG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 是否正处于一次拖出的生命周期内（供 lib.rs 热键 monitor 判定是否让路）。
pub fn drag_in_progress() -> bool {
    DRAG_IN_PROGRESS.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_dragout_auto_close() -> bool {
    DRAGOUT_AUTO_CLOSE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_dragout_auto_close(enabled: bool) {
    DRAGOUT_AUTO_CLOSE.store(enabled, Ordering::Relaxed);
}

// ── 裸 extern：HGLOBAL 内存分配（与 clipboard.rs 同 idiom，避开版本签名猜测）──
#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(uFlags: u32, dwBytes: usize) -> isize;
    fn GlobalLock(hMem: isize) -> *mut u8;
    fn GlobalUnlock(hMem: isize) -> i32;
    fn GetCurrentThreadId() -> u32;
}

// SW_HIDE 跨线程隐藏 overlay：DoDragDrop 阻塞在主线程的模态消息循环、会泵此消息。
#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hwnd: isize, n_cmd_show: i32) -> i32;
    // 续82：读前台 class 确认交还 + AttachThreadInput 绕过前台锁（windows crate 该符号需未启用 feature，裸声明）。
    fn GetForegroundWindow() -> isize;
    fn GetClassNameW(hwnd: isize, lp: *mut u16, n: i32) -> i32;
    fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
}

/// 读前台窗口 class（续82：activate 后确认焦点确实落到落点窗口）。
fn foreground_class() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return "NULL".into();
        }
        let mut cls = [0u16; 128];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
        String::from_utf16_lossy(&cls[..n.max(0) as usize])
    }
}

/// 拖出**成功投放后**把前台焦点交还给「落点窗口」（续82 修复，根因见 DECISIONS §18）。
/// 根因：conhost/cmd/终端收到 drop 不自我激活，而我们隐藏 overlay 后仍持前台 → 目标 2-3s
/// 拿不到焦点、看着像卡死，须手动点一下才活。记事本/Word 等自我激活目标：本调用是无害重申。
/// **仅在 hr==DRAGDROP_S_DROP 时**由调用方门控（Esc 取消/无投放不进来，不误改前台）。
/// 落点 = 光标释放处顶层窗口（overlay 早已 SW_HIDE，WindowFromPoint 不命中自己；仍加本窗口守卫）。
/// 先裸 SetForegroundWindow（复用 clipboard.rs 同款 idiom）；被前台锁挡住则 AttachThreadInput
/// 临时挂输入队列强制转移、随即解挂（GUI 实测 cmd/Windows Terminal 走②路，attached+ok2 均 true）。
fn activate_drop_target(self_hwnd: isize) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetWindowThreadProcessId, SetForegroundWindow, WindowFromPoint,
        GA_ROOT,
    };
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return;
        }
        let under = WindowFromPoint(pt);
        if under.0.is_null() {
            return;
        }
        let top = GetAncestor(under, GA_ROOT);
        let top = if top.0.is_null() { under } else { top };
        let top_h = top.0 as isize;
        if top_h == self_hwnd {
            return;
        }
        // ① 裸调：本进程仍持前台许可即成（自我激活目标走这条）。
        let _ = SetForegroundWindow(top);
        if GetForegroundWindow() != top_h {
            // ② 被前台锁挡住（隐藏后仍持前台 → cmd/终端 2-3s 拿不到焦点像卡死）：
            //    AttachThreadInput 把本线程输入队列临时挂到目标线程绕过锁，强制转移后立即解挂。
            let target_tid = GetWindowThreadProcessId(top, None);
            let our_tid = GetCurrentThreadId();
            let attached = target_tid != 0
                && target_tid != our_tid
                && AttachThreadInput(our_tid, target_tid, 1) != 0;
            let _ = SetForegroundWindow(top);
            if attached {
                AttachThreadInput(our_tid, target_tid, 0);
            }
        }
        println!("[dragout] 前台交还落点 → {}", foreground_class());
    }
}

/// 把字节拷进一块 GMEM_MOVEABLE HGLOBAL，返回原始句柄。
/// 注意：这是 OLE `GetData` 的出参，所有权交给调用方（OLE 用完会 `ReleaseStgMedium` 释放），
/// 故本对象**不**持有/释放这些 HGLOBAL（只持有源字节 `Vec<u8>`，每次 GetData 现 alloc 一份）。
fn alloc_hglobal(bytes: &[u8]) -> Option<isize> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
        if h == 0 {
            return None;
        }
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        GlobalUnlock(h);
        Some(h)
    }
}

// ── 前端 emit("drag-out-begin", {...}) 的负载 ──
#[derive(serde::Deserialize)]
pub struct DragOutItem {
    pub r#type: String,             // "file" | "text" | "image"
    pub content: Option<String>,    // 文本内容 或 base64（image）
    pub items: Option<Vec<String>>, // file 条目的路径列表
    pub orig_path: Option<String>,  // image 原图路径（可选，存在则优先用、避免降分辨率）
}

// ── IDataObject：按需返回三种格式的 HGLOBAL ──────────────────────
#[implement(IDataObject)]
struct DragOutDataObject {
    formats: Vec<(u16, Vec<u8>)>, // cfFormat → 源字节（GetData 时现 alloc HGLOBAL）
}

impl IDataObject_Impl for DragOutDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> Result<STGMEDIUM> {
        let fmt = unsafe { &*pformatetcin };
        if fmt.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
            return Err(DV_E_TYMED.into());
        }
        for (cf, bytes) in &self.formats {
            if *cf == fmt.cfFormat {
                let h = alloc_hglobal(bytes).ok_or_else(|| windows::core::Error::from(E_NOTIMPL))?;
                return Ok(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 {
                        hGlobal: HGLOBAL(h as *mut core::ffi::c_void),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                });
            }
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _fmt: *const FORMATETC, _medium: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let fmt = unsafe { &*pformatetc };
        if fmt.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
            return DV_E_TYMED;
        }
        for (cf, _) in &self.formats {
            if *cf == fmt.cfFormat {
                return S_OK;
            }
        }
        DV_E_FORMATETC
    }

    fn GetCanonicalFormatEtc(&self, _fin: *const FORMATETC, fout: *mut FORMATETC) -> HRESULT {
        // 无设备相关格式：清零出参的 ptd 并报 E_NOTIMPL(调用方据此自行规范化)
        unsafe {
            if !fout.is_null() {
                (*fout).ptd = std::ptr::null_mut();
            }
        }
        E_NOTIMPL
    }

    fn SetData(&self, _fmt: *const FORMATETC, _medium: *const STGMEDIUM, _release: BOOL) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> Result<IEnumFORMATETC> {
        // Explorer 依赖此方法枚举可用格式。仅支持 GET 方向，用系统标准枚举器（免手写 IEnumFORMATETC）。
        if dwdirection == DATADIR_GET.0 as u32 {
            let fmts: Vec<FORMATETC> = self
                .formats
                .iter()
                .map(|(cf, _)| FORMATETC {
                    cfFormat: *cf,
                    ptd: std::ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                })
                .collect();
            unsafe { SHCreateStdEnumFmtEtc(&fmts) }
        } else {
            Err(E_NOTIMPL.into())
        }
    }

    fn DAdvise(&self, _fmt: *const FORMATETC, _advf: u32, _sink: Option<&IAdviseSink>) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _connection: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

// ── IDropSource：按左键/Esc 状态决定继续/完成/取消 ──────────────
#[implement(IDropSource)]
struct DragOutDropSource;

impl IDropSource_Impl for DragOutDropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        // 左键已松开 → 完成投放
        if grfkeystate.0 & MK_LBUTTON == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS // 用系统默认拖拽光标
    }
}

// ── 数据构建 ────────────────────────────────────────────────
/// 按条目集合构建格式表 + 收集本次新建的临时文件（image 落地 PNG，DoDragDrop 后清理）。
/// 规则：
/// - file/image 统一汇入一份 CF_HDROP（image 落地真 PNG；多条目合并一份）；
/// - 仅当唯一条目且为 image 时，额外暴露 CF_DIB（供 Paint 等真位图目标）；
/// - 无任何文件格式（纯单条 text）时暴露 CF_UNICODETEXT。
///
/// 不删 orig_path 原图（`clip_images/` 持久缓存），只删本函数新建的 temp。
fn build_formats(items: &[DragOutItem]) -> (Vec<(u16, Vec<u8>)>, Vec<PathBuf>) {
    let mut file_paths: Vec<String> = Vec::new();
    let mut temp_files: Vec<PathBuf> = Vec::new();
    let mut text_payload: Option<String> = None;

    for it in items {
        match it.r#type.as_str() {
            "file" => {
                if let Some(paths) = &it.items {
                    file_paths.extend(paths.iter().cloned());
                }
            }
            "image" => {
                if let Some(p) = image_to_file(it, &mut temp_files) {
                    file_paths.push(p);
                }
            }
            "text" => text_payload = it.content.clone(),
            _ => {}
        }
    }

    let mut formats: Vec<(u16, Vec<u8>)> = Vec::new();
    if !file_paths.is_empty() {
        formats.push((CF_HDROP, build_dropfiles(&file_paths)));
    }
    // 单图条目额外暴露 CF_DIB（真位图目标用）
    if items.len() == 1 && items[0].r#type == "image" {
        if let Some(dib) = build_dib(&items[0]) {
            formats.push((CF_DIB, dib));
        }
    }
    // 无文件格式时才暴露纯文本（混合选区以文件为主，文本无法并入 CF_HDROP）
    if file_paths.is_empty() {
        if let Some(t) = text_payload {
            formats.push((CF_UNICODETEXT, utf16_bytes(&t)));
        }
    }

    (formats, temp_files)
}

/// image 条目 → 磁盘 PNG 路径：优先 orig_path（持久原图、不入 temp 列表），否则 base64 落临时文件。
fn image_to_file(it: &DragOutItem, temp_files: &mut Vec<PathBuf>) -> Option<String> {
    if let Some(op) = &it.orig_path {
        if std::path::Path::new(op).exists() {
            return Some(op.clone());
        }
    }
    let raw = strip_data_url(it.content.as_deref()?);
    let bytes = base64_decode(raw)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("workbench_dragout_{ts}.png"));
    std::fs::write(&path, &bytes).ok()?;
    temp_files.push(path.clone());
    Some(path.to_string_lossy().into_owned())
}

/// CF_DIB：base64 PNG → RGBA → BITMAPINFOHEADER(40, 32bpp, BI_RGB) + 自底向上 BGRA 像素。
fn build_dib(it: &DragOutItem) -> Option<Vec<u8>> {
    let bytes = base64_decode(strip_data_url(it.content.as_deref()?))?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let mut out = Vec::with_capacity(40 + (w * h * 4) as usize);
    // BITMAPINFOHEADER（小端）
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(w as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&(h as i32).to_le_bytes()); // biHeight (>0 → 自底向上)
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(w * h * 4).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    out.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    // 像素：自底向上逐行，每像素 BGRA
    for y in (0..h).rev() {
        for x in 0..w {
            let p = img.get_pixel(x, y).0; // [r, g, b, a]
            out.push(p[2]);
            out.push(p[1]);
            out.push(p[0]);
            out.push(p[3]);
        }
    }
    Some(out)
}

/// DROPFILES 头(fWide=1) + UTF-16 路径、双 \0 结尾（复刻 clipboard::write_cf_hdrop 的内存布局，
/// 但这里只构建 HGLOBAL 源字节、不写剪贴板）。
fn build_dropfiles(paths: &[String]) -> Vec<u8> {
    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(&20u32.to_ne_bytes()); // pFiles：路径数据偏移
    raw.extend_from_slice(&0u32.to_ne_bytes()); // pt.x
    raw.extend_from_slice(&0u32.to_ne_bytes()); // pt.y
    raw.extend_from_slice(&0u32.to_ne_bytes()); // fNC
    raw.extend_from_slice(&1u32.to_ne_bytes()); // fWide=1（必须：UTF-16 路径）
    for p in paths {
        for c in p.encode_utf16().chain(std::iter::once(0)) {
            raw.extend_from_slice(&c.to_ne_bytes());
        }
    }
    raw.push(0);
    raw.push(0); // 双 \0 结尾
    raw
}

/// CF_UNICODETEXT：UTF-16 + 结尾 \0。
fn utf16_bytes(s: &str) -> Vec<u8> {
    let mut raw = Vec::with_capacity((s.len() + 1) * 2);
    for c in s.encode_utf16().chain(std::iter::once(0)) {
        raw.extend_from_slice(&c.to_ne_bytes());
    }
    raw
}

/// 去掉 data URL 前缀（`data:image/png;base64,` → 裸 base64），非 data URL 原样返回。
fn strip_data_url(s: &str) -> &str {
    if let Some(i) = s.find(',') {
        if s[..i].contains("base64") {
            return &s[i + 1..];
        }
    }
    s
}

/// 标准 base64 解码（与 clipboard.rs 同实现；那份为模块私有、无法跨模块复用，故此处自带一份）。
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(s.len() * 3 / 4);
    let mut a = 0u32;
    let mut b = 0u32;
    for c in s.chars() {
        let v = match c {
            'A'..='Z' => c as u32 - 65,
            'a'..='z' => c as u32 - 71,
            '0'..='9' => c as u32 + 4,
            '+' => 62,
            '/' => 63,
            '=' => break,
            _ => continue,
        };
        a = (a << 6) | v;
        b += 6;
        if b >= 8 {
            b -= 8;
            buf.push((a >> b) as u8);
        }
    }
    Some(buf)
}

// ── 入口：前端命令调用 ────────────────────────────────────────
/// 启动一次拖出。命令本体只做轻活、立即返回；构建 + 调度全在 worker 线程。
///
/// 关键：`DoDragDrop` **必须在主线程**跑——主线程已 `OleInitialize`（STA，dragdrop setup 时）、
/// 拥有前台窗口、且 mousedown 起手已持有鼠标 capture。放在 worker 线程（无窗口/无 capture）会让
/// DoDragDrop 起手 SetCapture 失败、拖拽不启动（续71 首版症状：界面消失但什么都没投放）。
#[tauri::command]
pub fn start_drag_out(app: AppHandle, items: Vec<DragOutItem>) {
    std::thread::spawn(move || run_drag_out(app, items));
}

fn run_drag_out(app: AppHandle, items: Vec<DragOutItem>) {
    let (formats, temp_files) = build_formats(&items);
    println!("[dragout] start: {} item(s) → {} format(s)", items.len(), formats.len());
    if formats.is_empty() {
        eprintln!("[dragout] 无可拖出格式，放弃");
        return;
    }
    let hwnd = match app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
        Some(h) => h.0 as isize,
        None => {
            eprintln!("[dragout] 取主窗口 HWND 失败");
            return;
        }
    };
    let app_main = app.clone();
    // 切到主线程跑 DoDragDrop（阻塞其模态循环，期间 tao 窗口仍收消息——同文件对话框 idiom）
    if let Err(e) = app.run_on_main_thread(move || do_drag_on_main(app_main, formats, temp_files, hwnd)) {
        eprintln!("[dragout] run_on_main_thread 调度失败: {e}");
    }
}

/// 在主线程执行：构建 COM 对象 → 起手 DoDragDrop（持有 capture）→ 延迟隐藏 overlay → 阻塞至投放/取消。
/// 主线程已是 OLE STA（dragdrop setup 的 OleInitialize），**不再 init/uninit**（否则破坏拖入的 OLE 状态）。
fn do_drag_on_main(app: AppHandle, formats: Vec<(u16, Vec<u8>)>, temp_files: Vec<PathBuf>, hwnd: isize) {
    let data_obj: IDataObject = DragOutDataObject { formats }.into();
    let drop_src: IDropSource = DragOutDropSource.into();
    let auto_close = DRAGOUT_AUTO_CLOSE.load(Ordering::Relaxed);
    println!("[dragout] DoDragDrop begin (main thread) auto_close={auto_close}");
    DRAG_IN_PROGRESS.store(true, Ordering::Relaxed); // 拖动期间热键 monitor 让路（见 static 注释）

    // "保持界面"模式的拖动中手动隐藏协调：manually_hidden=用户按热键触发过 SW_HIDE（去外部应用）；
    // drag_done=DoDragDrop 已返回、通知自轮询线程退出。
    let manually_hidden = std::sync::Arc::new(AtomicBool::new(false));
    let drag_done = std::sync::Arc::new(AtomicBool::new(false));

    if auto_close {
        // "拖出即隐藏"模式（默认）：拖拽建立 capture 后 60ms 隐藏 overlay（DoDragDrop 模态循环泵该消息），
        //   让出底层窗口做 drop 目标。
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(HIDE_AFTER_START_MS));
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
            let _ = app2.emit("hotkey-hide", ());
        });
    } else {
        // "保持界面"模式：全程不自动隐藏。后台轮询当前热键键态——用户拖动中**按下热键** → 立即 SW_HIDE
        //   让出底层窗口做 drop 目标（拖到外部应用）；不按热键则窗口始终可见、区内落点交给自身 IDropTarget。
        // 只在上升沿触发一次即退出；DoDragDrop 返回后 drag_done 也会让它退出（未按热键的区内/取消场景）。
        let app2 = app.clone();
        let mh = manually_hidden.clone();
        let dd = drag_done.clone();
        std::thread::spawn(move || {
            use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
            let is_down = |vk: u16| -> bool { unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000u16) != 0 } };
            let mut prev = true; // 起手视作"已按下"：要求先看到松开再看上升沿，避免拖动起手残留键位误触发
            loop {
                if dd.load(Ordering::Relaxed) {
                    break;
                }
                let keys = crate::current_hotkey_vks();
                let combo = !keys.is_empty() && keys.iter().all(|vk| is_down(*vk));
                if combo && !prev {
                    unsafe {
                        ShowWindow(hwnd, SW_HIDE);
                    }
                    mh.store(true, Ordering::Relaxed);
                    let _ = app2.emit("hotkey-hide", ());
                    println!("[dragout] 保持界面模式：拖动中按热键 → 手动隐藏 overlay");
                    break;
                }
                prev = combo;
                std::thread::sleep(std::time::Duration::from_millis(DRAG_HOTKEY_POLL_MS));
            }
        });
    }

    let mut effect = DROPEFFECT(0);
    let hr = unsafe {
        DoDragDrop(
            &data_obj,
            &drop_src,
            DROPEFFECT_COPY | DROPEFFECT_MOVE,
            &mut effect,
        )
    };
    drag_done.store(true, Ordering::Relaxed); // 通知自轮询线程退出（若还在跑）

    // DROPEFFECT_MOVE → 前端从中转区移除；COPY/取消(Esc)/错误 → 保留
    let effect_str = if hr == DRAGDROP_S_DROP {
        if effect.0 & DROPEFFECT_MOVE.0 != 0 {
            "move"
        } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
            "copy"
        } else {
            "none"
        }
    } else {
        "none"
    };
    println!("[dragout] DoDragDrop end hr={hr:?} effect={} → {effect_str}", effect.0);

    let manually_hidden = manually_hidden.load(Ordering::Relaxed);
    if auto_close || manually_hidden {
        // 窗口应以隐藏收场（自动隐藏 / "保持界面"模式下用户拖动中手动隐藏去外部应用）：
        // 收尾隐藏 **必须走 Tauri window.hide()**（此刻 DoDragDrop 已返回、主线程空闲）。不能再用裸
        // ShowWindow(SW_HIDE)：裸 FFI 绕过 tao 的可见性状态缓存 → tao 仍以为窗口可见 → 下次热键
        // window.show() 被 tao diff 成 no-op → 窗口再也呼不出（“卡死、须重启”）。拖拽中那个裸 ShowWindow
        // 由这里的 Tauri hide() 把 tao 缓存兜回“隐藏”、与真实状态重新对齐。
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
        let _ = app.emit("hotkey-hide", ());
        let _ = app.emit("drag-out-done", effect_str);
        // 续82：真正投放成功时把前台交还给落点窗口（conhost/cmd 不自我激活 → 否则无焦点像卡死）。
        // 门控 hr==DRAGDROP_S_DROP：Esc 取消/无投放不动前台。
        if hr == DRAGDROP_S_DROP {
            activate_drop_target(hwnd);
        }
    } else {
        // "保持界面"模式且未手动隐藏（区内落点/取消）：窗口全程可见（tao 缓存与真实一致，无需 hide 同步），
        //   不发 hotkey-hide（前端保持 visible）。只发 drag-out-done 让前端按 effect 处理条目（copy/none
        //   保留、move 移除）；区内落点（启动台/重排）由窗口 IDropTarget 的 files-dropped 分支处理。
        // 轻量 set_focus 确保 OLE 拖拽结束后 Esc 仍可用（窗口本就可见、未隐藏，无白闪风险；仍延迟+守卫，
        //   复刻 show 路径 idiom）。
        let _ = app.emit("drag-out-done", effect_str);
        if let Some(win) = app.get_webview_window("main") {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if win.is_visible().unwrap_or(false) { let _ = win.set_focus(); }
            });
        }
    }

    DRAG_IN_PROGRESS.store(false, Ordering::Relaxed); // 拖动收尾，热键 monitor 恢复正常 show/hide

    // 临时文件延迟删除：DoDragDrop 已返回，但目标 app 可能仍在异步拷贝，宽限几秒再删（detached，不阻塞）
    if !temp_files.is_empty() {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(TEMP_CLEANUP_DELAY_SECS));
            for p in temp_files {
                let _ = std::fs::remove_file(p);
            }
        });
    }
}
