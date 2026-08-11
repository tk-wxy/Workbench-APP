//! 中转区拖出（drag-out）：用户在中转条目上按下并拖动超阈值后，overlay 隐藏，
//! 系统 OLE `DoDragDrop` 接管鼠标，用户拖到目标应用松手完成传递。
//!
//! 线程模型（铁律，不可绕过）：`DoDragDrop` 是阻塞调用、且要求调用线程已 `OleInitialize`（STA）。
//! 命令线程只构建格式/预览，再通过 `run_on_main_thread` 进入已初始化 OLE 的 Tauri 主线程；
//! `DoDragDrop` 建立 capture 后，独立可见性 worker 才按设置隐藏 overlay；拖图由独立分层窗持有，
//! 不随 source HWND 隐藏时的系统 cursor 重置而消失。HCURSOR 仅是分层窗创建失败时的降级。
//! **绝不**在 `#[tauri::command]`（Tokio async 线程）内直接调 DoDragDrop，也绝不在起手前隐藏主 HWND。
//! OLE 终态先停止 worker，再同步 Tauri 可见性缓存、emit 结果并延迟清理临时文件。
//!
//! 与 `dragdrop.rs`（拖入）正交：拖入是 setup 时一次性注册的 IDropTarget（接收侧）；
//! 拖出是按需 spawn 的 source 侧（IDataObject + IDropSource）。两者互不共享状态。

use std::cell::Cell;
use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Mutex, OnceLock,
};
#[cfg(test)]
use std::sync::{
    atomic::{AtomicU32, AtomicUsize},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, w, Error, Result, HRESULT};
use windows::Win32::Foundation::{
    BOOL, COLORREF, E_NOTIMPL, FALSE, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, POINT,
    SIZE, S_OK, TRUE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject,
    SelectObject, SetBkMode, SetTextColor, TextOutW, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, FW_NORMAL, HBITMAP, HDC, HGDIOBJ,
    OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA,
    CLSCTX_INPROC_SERVER, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0,
    TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, ReleaseStgMedium, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_MOVE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{
    CLSID_DragDropHelper, IDragSourceHelper, SHCreateDataObject, SHCreateStdEnumFmtEtc,
    CFSTR_DROPDESCRIPTION, SHDRAGIMAGE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateIconIndirect, CreateWindowExW, DefWindowProcW, DestroyIcon,
    DestroyWindow, DispatchMessageW, GetCursor, GetCursorPos, GetMessageW, GetWindowLongPtrW,
    KillTimer, PostMessageW, PostQuitMessage, PostThreadMessageW, RegisterClassW, SetCursor,
    SetTimer, SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, UpdateLayeredWindow, GWLP_USERDATA, HCURSOR, HC_ACTION, HHOOK, HICON,
    HTTRANSPARENT, HWND_TOPMOST, ICONINFO, MSG, MSLLHOOKSTRUCT, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, ULW_ALPHA, WH_MOUSE_LL, WM_APP, WM_CLOSE, WM_DESTROY, WM_MOUSEMOVE, WM_NCHITTEST,
    WM_QUIT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT, WS_POPUP,
};

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
const SW_SHOWNOACTIVATE: i32 = 4;
// "保持界面"模式：拖动中轮询热键键态的间隔（用户按热键→手动隐藏 overlay 去外部应用）。
// 与 lib.rs 的 HOTKEY_POLL_MS 同量级；那个是私有 const，此处独立取值、互不依赖。
const DRAG_HOTKEY_POLL_MS: u64 = 20;
// 独立悬浮窗正常由本轮 WH_MOUSE_LL 的系统鼠标事件驱动；timer 只在 hook 异常失联时兜底，
// 不依赖 OLE 落点回调或窗口命中频率。
const DRAG_IMAGE_FRAME_MS: u32 = 16;
const DRAG_IMAGE_TIMER_ID: usize = 1;
const WM_DRAG_IMAGE_MOVE: u32 = WM_APP + 1;
#[cfg(test)]
const WM_DRAG_IMAGE_TEST_HOOK: u32 = WM_APP + 2;

// 拖出后是否自动关闭窗口（设置面板可切换，默认 true = 现状行为）。
// 关闭时：无论 move/copy/cancel，DoDragDrop 返回后都重新显示 overlay（复刻呼出三约束），
// 供"只是调整位置"的误触发场景使用；此时不再执行 activate_drop_target 前台交还（反正马上被抢回）。
static DRAGOUT_AUTO_CLOSE: AtomicBool = AtomicBool::new(true);

// 一次拖出的生命周期内为 true（do_drag_on_main 起手置位、收尾清位）。热键 monitor（lib.rs）据此
// 在拖动期间**不活性化**自己的 show/hide toggle——否则"保持界面"模式下用户拖动中按热键去外部时，
// monitor 会误把这次按键当普通 toggle 处理、并发操作窗口可见性，导致隐藏后松手落地时白闪。
// 窗口可见性在拖动期间由 dragout 独占（自动隐藏 / 自轮询手动隐藏），monitor 只管拖动之外的 show/hide。
static DRAG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn finish_hidden(auto_close: bool, overlay_hidden: bool, reshown_during_drag: bool) -> bool {
    overlay_hidden || (auto_close && !reshown_during_drag)
}

/// 是否正处于一次拖出的生命周期内（供 lib.rs 热键 monitor 判定是否让路）。
pub fn drag_in_progress() -> bool {
    DRAG_IN_PROGRESS.load(Ordering::Relaxed)
}

// 续88 区内重排：JS 侧纯前端 FLIP 重排阶段（尚未升级为原生 DoDragDrop 之前）——此时窗口仍完全可见，
// DRAG_IN_PROGRESS 尚未置位（只在 do_drag_on_main 真正起手时才置位）。这段时间窗口可见性同样必须由
// 拖动独占：若此时 light-dismiss（start_focus_watch，lib.rs）检测到前台瞬时切走就自行 hide()，会在
// 升级到原生拖出之前就打断整个手势——JS 侧从未收到「窗口已被别人关闭」的通知，ghost/让路 transform
// 永久卡死；且因为从未真正调用 start_drag_out，「拖到外部目标」这个操作本身也根本没发生。
// 前端进入/退出重排时调 set_stage_reorder_active 同步此标志，light-dismiss 与之一并检查后让路。
static STAGE_REORDER_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 是否正处于中转区区内重排阶段（供 lib.rs light-dismiss / 热键 monitor 判定是否让路）。
pub fn stage_reorder_active() -> bool {
    STAGE_REORDER_ACTIVE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_stage_reorder_active(active: bool) {
    STAGE_REORDER_ACTIVE.store(active, Ordering::Relaxed);
}

// 续110 剪贴板项拖出：与 STAGE_REORDER_ACTIVE 完全同构、独立隔离的标志。剪贴板卡片的纯 JS ghost 拖动
// 激活期间（尚未升级为原生 DoDragDrop）置真——同样让 light-dismiss 让路、让热键 monitor 改 emit
// "clip-drag-hotkey"（而非直接 hide / 单纯让路，理由见 STAGE_REORDER_ACTIVE 注释与 lib.rs monitor）。
// 升级为原生拖出时在 do_drag_on_main 与 DRAG_IN_PROGRESS 无缝交接（先置 DRAG_IN_PROGRESS 再清本标志）。
static CLIP_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 是否正处于剪贴板项纯 JS 拖动阶段（供 lib.rs light-dismiss / 热键 monitor 判定是否让路）。
pub fn clip_drag_active() -> bool {
    CLIP_DRAG_ACTIVE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_clip_drag_active(active: bool) {
    CLIP_DRAG_ACTIVE.store(active, Ordering::Relaxed);
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
    fn GlobalFree(hMem: isize) -> isize;
    fn GlobalSize(hMem: isize) -> usize;
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
    // 续110：模拟 Alt 键解 SetForegroundWindow 前台锁（Windows Terminal 即使 AttachThreadInput 仍被拒）。
    fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
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
            // ② 被前台锁挡住（隐藏后仍持前台 → cmd/终端拿不到焦点像卡死）：AttachThreadInput 把本线程输入
            //    队列临时挂到目标线程绕过锁。**续110 实测**：对 Windows Terminal(CASCADIA_HOSTING_WINDOW_CLASS)
            //    AttachThreadInput 挂上后 SetForegroundWindow 仍被前台锁拒（ok2=false）——须再模拟一次 Alt
            //    down+up「欺骗」系统认为用户正在交互、解除前台锁，SetForegroundWindow 才生效。经典绕过手法；
            //    Alt 成对快速、DoDragDrop 已结束，对终端无可见副作用。VK_MENU=0x12，KEYEVENTF_KEYUP=0x0002。
            //    传统 conhost(ConsoleWindowClass) 走 AttachThreadInput 即成（续82），Alt tap 对其是无害重申。
            let target_tid = GetWindowThreadProcessId(top, None);
            let our_tid = GetCurrentThreadId();
            let attached = target_tid != 0
                && target_tid != our_tid
                && AttachThreadInput(our_tid, target_tid, 1) != 0;
            keybd_event(0x12, 0, 0, 0);
            keybd_event(0x12, 0, 0x0002, 0);
            let _ = SetForegroundWindow(top);
            if attached {
                AttachThreadInput(our_tid, target_tid, 0);
            }
        }
        println!("[dragout] 前台交还落点 → [{}]", foreground_class());
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
            GlobalFree(h);
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
    pub r#type: String,          // "file" | "text" | "image"
    pub content: Option<String>, // 文本内容 或 base64（image）
    /// 中转 image 在 stage_images/ 下的文件名。与剪贴板 time 同理，让同步拖出路径由 Rust
    /// 自查内容，前端无需为拖出 await 大 base64。
    pub content_file: Option<String>,
    pub items: Option<Vec<String>>, // file 条目的路径列表
    pub orig_path: Option<String>,  // image 原图路径（可选，存在则优先用、避免降分辨率）
    /// 剪贴板 image 条目的 time（性能优化步骤2）。前端 image 条目已不常驻 content，
    /// 拖出路径又必须完全同步（不能 await 现取，否则卡死 R13 交接），故带 time 让 Rust 自查 CLIP_CACHE。
    /// 中转条目用 content_file，此项为 None。serde 对缺失的 Option 字段自动填 None。
    pub time: Option<i64>,
    /// 前端已缓存的小缩略图/文件图标；缺失时 Rust 画类型色占位。
    pub drag_preview: Option<String>,
    pub drag_label: Option<String>,
    pub drag_meta: Option<String>,
    pub drag_preview_kind: Option<String>,
    pub drag_hotspot_x: Option<f64>,
    pub drag_hotspot_y: Option<f64>,
    pub drag_theme: Option<String>,
    /// WebView CSS px → 屏幕物理像素比例；用于 200% DPI 下保持拖拽图像视觉尺寸。
    pub drag_dpr: Option<f64>,
    /// 前端单调递增的单次交接 id；ready 事件带回，防上一轮迟到事件清掉下一轮 ghost。
    pub drag_session_id: Option<u64>,
}

#[derive(Clone, serde::Serialize)]
struct DragPreviewReady {
    session_id: Option<u64>,
    mode: &'static str,
}

fn emit_drag_preview_ready(app: &AppHandle, session_id: Option<u64>, mode: &'static str) {
    let _ = app.emit("drag-preview-ready", DragPreviewReady { session_id, mode });
}

struct DragRunOptions {
    hwnd: isize,
    force_hide: bool,
    copy_only: bool,
    session_id: Option<u64>,
}

impl DragOutItem {
    /// image 原始 PNG 字节：内嵌兜底 / 剪贴板 time / 中转 content_file 三路统一。
    fn resolve_image_bytes(&self) -> Option<Vec<u8>> {
        if let Some(content) = self
            .content
            .clone()
            .or_else(|| self.time.and_then(crate::clipboard::clip_content_by_time))
        {
            return base64_decode(strip_data_url(&content));
        }
        self.content_file
            .as_deref()
            .and_then(crate::apps::read_stage_image_bytes)
    }
}

// ── IDataObject：按需返回三种格式的 HGLOBAL ──────────────────────
#[implement(IDataObject)]
struct DragOutDataObject {
    // Shell drag-image helper 会通过 SetData 写入若干私有 HGLOBAL 格式；与应用自身格式放同一表，
    // 才能在跨进程拖动期间由 helper 再 GetData 取回。Mutex 仅保护短 Vec 操作，不跨 COM 调用。
    formats: Mutex<Vec<(u16, Vec<u8>)>>, // cfFormat → 源字节（GetData 时现 alloc HGLOBAL）
}

impl IDataObject_Impl for DragOutDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> Result<STGMEDIUM> {
        let fmt = unsafe { &*pformatetcin };
        if fmt.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
            return Err(DV_E_TYMED.into());
        }
        let formats = self
            .formats
            .lock()
            .map_err(|_| windows::core::Error::from(E_NOTIMPL))?;
        for (cf, bytes) in formats.iter() {
            if *cf == fmt.cfFormat {
                let h =
                    alloc_hglobal(bytes).ok_or_else(|| windows::core::Error::from(E_NOTIMPL))?;
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
        let Ok(formats) = self.formats.lock() else {
            return DV_E_FORMATETC;
        };
        for (cf, _) in formats.iter() {
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

    fn SetData(
        &self,
        fmt: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> Result<()> {
        if fmt.is_null() || medium.is_null() {
            return Err(E_NOTIMPL.into());
        }
        let (cf, bytes) = unsafe {
            let fmt = &*fmt;
            let medium_ref = &*medium;
            if fmt.tymed & TYMED_HGLOBAL.0 as u32 == 0
                || medium_ref.tymed & TYMED_HGLOBAL.0 as u32 == 0
            {
                return Err(DV_E_TYMED.into());
            }
            let handle = medium_ref.u.hGlobal.0 as isize;
            if handle == 0 {
                return Err(E_NOTIMPL.into());
            }
            let size = GlobalSize(handle);
            if size == 0 {
                return Err(E_NOTIMPL.into());
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return Err(E_NOTIMPL.into());
            }
            let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
            GlobalUnlock(handle);
            (fmt.cfFormat, bytes)
        };
        {
            let mut formats = self
                .formats
                .lock()
                .map_err(|_| windows::core::Error::from(E_NOTIMPL))?;
            if let Some(existing) = formats.iter_mut().find(|(format, _)| *format == cf) {
                existing.1 = bytes;
            } else {
                formats.push((cf, bytes));
            }
        }
        // fRelease=true 表示 SetData 成功后所有权转给数据对象。我们已经复制成 Vec，立即按 COM 规则
        // 释放原 medium；失败路径在此之前返回，仍由调用方持有。
        if release.as_bool() {
            unsafe {
                ReleaseStgMedium(medium as *mut STGMEDIUM);
            }
        }
        Ok(())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> Result<IEnumFORMATETC> {
        // Explorer 依赖此方法枚举可用格式。仅支持 GET 方向，用系统标准枚举器（免手写 IEnumFORMATETC）。
        if dwdirection == DATADIR_GET.0 as u32 {
            let formats = self
                .formats
                .lock()
                .map_err(|_| windows::core::Error::from(E_NOTIMPL))?;
            let fmts: Vec<FORMATETC> = formats
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

    fn DAdvise(
        &self,
        _fmt: *const FORMATETC,
        _advf: u32,
        _sink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _connection: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

/// 用 Shell 自己的通用数据对象承载拖放格式。`IDragSourceHelper` 写入的私有格式并不保证是
/// HGLOBAL（当前 Windows 实际首先写入 TYMED_ISTREAM）；交给 SHCreateDataObject 保存完整
/// FORMATETC/STGMEDIUM 语义，避免自制对象把任意私有格式错误压扁成字节数组。
fn create_shell_drag_data_object(formats: &[(u16, Vec<u8>)]) -> Result<IDataObject> {
    let data_object: IDataObject = unsafe { SHCreateDataObject(None, None, None::<&IDataObject>)? };
    for (format_id, bytes) in formats {
        let handle = alloc_hglobal(bytes).ok_or_else(|| windows::core::Error::from(E_NOTIMPL))?;
        let format = FORMATETC {
            cfFormat: *format_id,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 {
                hGlobal: HGLOBAL(handle as *mut core::ffi::c_void),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        };
        if let Err(error) = unsafe { data_object.SetData(&format, &medium, TRUE) } {
            // SetData 失败时所有权仍属于调用方；成功时由 Shell 对象接管。
            unsafe {
                GlobalFree(handle);
            }
            return Err(error);
        }
    }
    Ok(data_object)
}

static DROP_DESCRIPTION_FORMAT: OnceLock<u16> = OnceLock::new();

fn drop_description_format() -> u16 {
    *DROP_DESCRIPTION_FORMAT
        .get_or_init(|| unsafe { RegisterClipboardFormatW(CFSTR_DROPDESCRIPTION) as u16 })
}

fn should_suppress_drop_description(format_id: u16, registered_id: u16) -> bool {
    registered_id != 0 && format_id == registered_id
}

/// Explorer 等落点会用 `CFSTR_DROPDESCRIPTION` 写入“复制/粘贴为 …”文字。Workbench 已自行绘制
/// 完整 card/text cursor，这段 target 文案会形成第二套字体。包装层只吞这一种显示格式；Shell helper
/// 的任意私有 TYMED 以及 PERFORMEDDROPEFFECT 等业务反馈仍原样委托给系统数据对象。
#[implement(IDataObject)]
struct DropDescriptionSuppressingDataObject {
    inner: IDataObject,
    drop_description_format: u16,
}

impl IDataObject_Impl for DropDescriptionSuppressingDataObject_Impl {
    fn GetData(&self, format: *const FORMATETC) -> Result<STGMEDIUM> {
        unsafe { self.inner.GetData(format) }
    }

    fn GetDataHere(&self, format: *const FORMATETC, medium: *mut STGMEDIUM) -> Result<()> {
        unsafe { self.inner.GetDataHere(format, medium) }
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        unsafe { self.inner.QueryGetData(format) }
    }

    fn GetCanonicalFormatEtc(&self, input: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        unsafe { self.inner.GetCanonicalFormatEtc(input, output) }
    }

    fn SetData(
        &self,
        format: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> Result<()> {
        let format_id = if format.is_null() {
            0
        } else {
            unsafe { (*format).cfFormat }
        };
        if should_suppress_drop_description(format_id, self.drop_description_format) {
            // 返回成功即表示接管 medium；fRelease=true 时必须照 COM 契约释放，不能因过滤显示文字而泄漏。
            if release.as_bool() && !medium.is_null() {
                unsafe {
                    ReleaseStgMedium(medium as *mut STGMEDIUM);
                }
            }
            return Ok(());
        }
        unsafe { self.inner.SetData(format, medium, release) }
    }

    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        unsafe { self.inner.EnumFormatEtc(direction) }
    }

    fn DAdvise(
        &self,
        format: *const FORMATETC,
        flags: u32,
        sink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        unsafe { self.inner.DAdvise(format, flags, sink) }
    }

    fn DUnadvise(&self, connection: u32) -> Result<()> {
        unsafe { self.inner.DUnadvise(connection) }
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        unsafe { self.inner.EnumDAdvise() }
    }
}

fn suppress_drop_description(inner: IDataObject) -> IDataObject {
    DropDescriptionSuppressingDataObject {
        inner,
        drop_description_format: drop_description_format(),
    }
    .into()
}

// ── 拖图悬浮窗：由 source 自己绘制，不依赖落点实现 IDropTargetHelper ──
const DRAG_IMAGE_WINDOW_CLASS: windows::core::PCWSTR = w!("WorkbenchDragImageWindow");
static DRAG_IMAGE_WINDOW_CLASS_READY: OnceLock<bool> = OnceLock::new();

thread_local! {
    // WH_MOUSE_LL 回调由系统投递回安装 hook 的线程，因此用 TLS 绑定本轮窗口状态，
    // 不需要进程级 HWND/指针，也不会让上一轮 hook 写进下一轮。
    static DRAG_IMAGE_HOOK_POSITION: Cell<*const DragImagePosition> = const { Cell::new(std::ptr::null()) };
}

unsafe extern "system" fn drag_image_mouse_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 && wparam.0 as u32 == WM_MOUSEMOVE && lparam.0 != 0 {
        let point = (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt;
        DRAG_IMAGE_HOOK_POSITION.with(|slot| {
            let position = slot.get();
            if !position.is_null() {
                let position = &*position;
                let callback_thread_id = GetCurrentThreadId();
                #[cfg(test)]
                if let Some(tracker) = &position.tracker {
                    tracker
                        .last_hook_thread_id
                        .store(callback_thread_id, Ordering::Relaxed);
                    if callback_thread_id != position.owner_thread_id {
                        tracker
                            .hook_thread_mismatches
                            .fetch_add(1, Ordering::Relaxed);
                    }
                }
                // 防御性守卫：文档保证 low-level hook 回调运行在安装线程；若未来接线破坏此前提，
                // 不允许异线程继续触碰本线程拥有的 HWND/状态。
                if callback_thread_id != position.owner_thread_id
                    || position.closing.load(Ordering::Acquire)
                {
                    return;
                }
                position.latest_x.store(point.x, Ordering::Relaxed);
                position.latest_y.store(point.y, Ordering::Relaxed);
                // 高频鼠标包只保留最新坐标；hook 回调绝不直接 SetWindowPos，避免阻塞系统输入链。
                if !position.move_pending.swap(true, Ordering::AcqRel)
                    && PostMessageW(
                        HWND(position.hwnd as *mut core::ffi::c_void),
                        WM_DRAG_IMAGE_MOVE,
                        WPARAM(0),
                        LPARAM(0),
                    )
                    .is_err()
                {
                    position.move_pending.store(false, Ordering::Release);
                }
            }
        });
    }
    CallNextHookEx(HHOOK(std::ptr::null_mut()), code, wparam, lparam)
}

unsafe extern "system" fn drag_image_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => {
            // 只负责穿透；OLE capture 下它并不保证随每个鼠标包到达，不能承担位置刷新。
            LRESULT(HTTRANSPARENT as isize)
        }
        WM_DRAG_IMAGE_MOVE => {
            let position = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const DragImagePosition;
            if !position.is_null() {
                let position = &*position;
                // 先允许下一批输入投递，再读取最新坐标；若此间来了新包，它会另投一条消息，
                // 当前帧即使已读到最新值，下一条也只是幂等重申而不会丢最终位置。
                position.move_pending.store(false, Ordering::Release);
                let point = POINT {
                    x: position.latest_x.load(Ordering::Acquire),
                    y: position.latest_y.load(Ordering::Acquire),
                };
                move_drag_image_to_point(hwnd, position, point);
            }
            LRESULT(0)
        }
        #[cfg(test)]
        WM_DRAG_IMAGE_TEST_HOOK => {
            // 在窗口属主线程模拟一次系统 hook 回调，覆盖 TLS→坐标合并→PostMessage 全链路。
            let event = MSLLHOOKSTRUCT {
                pt: POINT {
                    x: wparam.0 as i32,
                    y: lparam.0 as i32,
                },
                ..Default::default()
            };
            drag_image_mouse_hook_proc(
                HC_ACTION as i32,
                WPARAM(WM_MOUSEMOVE as usize),
                LPARAM((&event as *const MSLLHOOKSTRUCT) as isize),
            );
            LRESULT(0)
        }
        WM_TIMER if wparam.0 == DRAG_IMAGE_TIMER_ID => {
            let position = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const DragImagePosition;
            if !position.is_null() {
                move_drag_image_to_cursor(hwnd, &*position);
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // 第一个状态变更就是摘掉裸指针；SetWindowLongPtrW 的返回值保留旧指针供本处理栈标记。
            // 后续任何迟到消息再 GetWindowLongPtrW 都只能得到 null，不能碰到半释放状态。
            let position = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *const DragImagePosition;
            if !position.is_null() {
                (*position).closing.store(true, Ordering::Release);
                (*position).move_pending.store(false, Ordering::Release);
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn premultiply_bgra(mut pixels: Vec<u8>) -> Vec<u8> {
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        pixel[0] = ((u16::from(pixel[0]) * alpha + 127) / 255) as u8;
        pixel[1] = ((u16::from(pixel[1]) * alpha + 127) / 255) as u8;
        pixel[2] = ((u16::from(pixel[2]) * alpha + 127) / 255) as u8;
    }
    pixels
}

fn point_in_polygon(x: f32, y: f32, polygon: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let mut previous = polygon.len() - 1;
    for current in 0..polygon.len() {
        let (xi, yi) = polygon[current];
        let (xj, yj) = polygon[previous];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

/// 自定义 cursor 会取代普通箭头，因此把高对比指针直接合成进卡片，热点位于箭头尖端。
fn paint_cursor_pointer(preview: &DragPreview, pixels: &mut [u8]) {
    let scale = preview.pointer_scale.clamp(1.0, 4.0);
    let outline = [
        (0.0, 0.0),
        (0.0, 18.0),
        (4.5, 13.5),
        (8.5, 22.0),
        (12.5, 20.0),
        (8.5, 12.0),
        (15.0, 12.0),
    ];
    let fill = [
        (2.0, 3.0),
        (2.0, 13.2),
        (5.0, 10.2),
        (9.1, 18.5),
        (10.2, 17.9),
        (6.1, 9.8),
        (11.6, 9.8),
    ];
    let left = preview.offset_x.max(0) as usize;
    let top = preview.offset_y.max(0) as usize;
    let right = (preview.offset_x as f32 + 16.0 * scale).ceil().max(0.0) as usize;
    let bottom = (preview.offset_y as f32 + 23.0 * scale).ceil().max(0.0) as usize;
    for y in top..bottom.min(preview.height as usize) {
        for x in left..right.min(preview.width as usize) {
            let local_x = (x as f32 + 0.5 - preview.offset_x as f32) / scale;
            let local_y = (y as f32 + 0.5 - preview.offset_y as f32) / scale;
            let color = if point_in_polygon(local_x, local_y, &fill) {
                Some([255, 255, 255, 255])
            } else if point_in_polygon(local_x, local_y, &outline) {
                Some([0, 0, 0, 255])
            } else {
                None
            };
            if let Some(bgra) = color {
                let start = (y * preview.width as usize + x) * 4;
                pixels[start..start + 4].copy_from_slice(&bgra);
            }
        }
    }
}

/// 用系统 cursor 合成链承载拖图：图像位置由 Windows 与真实指针同步，不再由应用轮询坐标。
struct DragCursor {
    // Win32 USER handle 是进程级不透明值；跨线程 worker 仅传整数句柄，并在调用点还原具体类型。
    // 这与本文件 HWND worker 的既有纪律一致，避免给 windows-rs 原始指针包装强行 unsafe Send/Sync。
    icon: isize,
    previous: isize,
    applied: AtomicBool,
}

impl DragCursor {
    unsafe fn create(preview: &DragPreview) -> Result<Self> {
        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: preview.width,
                biHeight: -preview.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: preview.bgra.len() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let color = CreateDIBSection(
            HDC(std::ptr::null_mut()),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            HANDLE(std::ptr::null_mut()),
            0,
        )?;
        if bits.is_null() {
            let _ = DeleteObject(HGDIOBJ(color.0));
            return Err(Error::from_win32());
        }
        // 32-bit alpha cursor 与 UpdateLayeredWindow 一样消费预乘 BGRA；源预览仍保留直 alpha，
        // 供 IDragSourceHelper 的降级路径使用（该 API 明确要求非预乘）。
        let mut cursor_pixels = preview.bgra.clone();
        paint_cursor_pointer(preview, &mut cursor_pixels);
        let pixels = premultiply_bgra(cursor_pixels);
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());

        // 彩色 cursor 仍要求一张同尺寸单色 mask。alpha 通道决定实际透明度，空 mask 仅满足结构契约。
        let mask = CreateBitmap(preview.width, preview.height, 1, 1, None);
        if mask.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(color.0));
            return Err(Error::from_win32());
        }
        let info = ICONINFO {
            fIcon: FALSE,
            xHotspot: preview.offset_x.max(0) as u32,
            yHotspot: preview.offset_y.max(0) as u32,
            hbmMask: mask,
            hbmColor: color,
        };
        // CreateIconIndirect 会复制两张位图；成功与否都由本函数立即回收原始 GDI bitmap。
        let icon = CreateIconIndirect(&info);
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
        Ok(Self {
            icon: icon?.0 as isize,
            previous: GetCursor().0 as isize,
            applied: AtomicBool::new(false),
        })
    }

    fn apply(&self) {
        // 先记录“已接管”再 SetCursor，保证任何重入清理都知道需要恢复；SetCursor 本身不失败。
        self.applied.store(true, Ordering::Relaxed);
        unsafe {
            SetCursor(HCURSOR(self.icon as *mut core::ffi::c_void));
        }
    }
}

impl Drop for DragCursor {
    fn drop(&mut self) {
        unsafe {
            let cursor = HCURSOR(self.icon as *mut core::ffi::c_void);
            // 若 OLE/目标已换成更新的 cursor，不覆盖它；仍是本 cursor 才恢复起拖前形状。
            if self.applied.load(Ordering::Relaxed) && GetCursor() == cursor {
                SetCursor(HCURSOR(self.previous as *mut core::ffi::c_void));
            }
            let _ = DestroyIcon(HICON(self.icon as *mut core::ffi::c_void));
        }
    }
}

struct DragImagePosition {
    hwnd: isize,
    owner_thread_id: u32,
    offset_x: i32,
    offset_y: i32,
    latest_x: AtomicI32,
    latest_y: AtomicI32,
    last_applied_x: AtomicI32,
    last_applied_y: AtomicI32,
    move_pending: AtomicBool,
    closing: AtomicBool,
    #[cfg(test)]
    tracker: Option<Arc<DragImageResourceTracker>>,
}

unsafe fn move_drag_image_to_point(hwnd: HWND, position: &DragImagePosition, point: POINT) -> bool {
    if position.closing.load(Ordering::Acquire) {
        #[cfg(test)]
        if let Some(tracker) = &position.tracker {
            tracker.moves_after_close.fetch_add(1, Ordering::Relaxed);
        }
        return false;
    }
    if position.last_applied_x.load(Ordering::Relaxed) == point.x
        && position.last_applied_y.load(Ordering::Relaxed) == point.y
    {
        return false;
    }
    let moved = SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        point.x - position.offset_x,
        point.y - position.offset_y,
        0,
        0,
        SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
    )
    .is_ok();
    if moved {
        position.last_applied_x.store(point.x, Ordering::Relaxed);
        position.last_applied_y.store(point.y, Ordering::Relaxed);
        #[cfg(test)]
        if let Some(tracker) = &position.tracker {
            tracker.applied_moves.fetch_add(1, Ordering::Relaxed);
        }
    }
    moved
}

unsafe fn move_drag_image_to_cursor(hwnd: HWND, position: &DragImagePosition) {
    let mut cursor = POINT::default();
    if GetCursorPos(&mut cursor).is_ok() {
        move_drag_image_to_point(hwnd, position, cursor);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DragImageInitFailure {
    CreateWindow,
    CreateCompatibleDc,
    CreateDibSection,
    UpdateLayeredWindow,
    SetTimer,
    SetWindowsHook,
}

#[derive(Clone, Default)]
struct DragImageInitOptions {
    #[cfg(test)]
    fail_at: Option<DragImageInitFailure>,
    #[cfg(test)]
    tracker: Option<Arc<DragImageResourceTracker>>,
}

fn inject_drag_image_failure(
    options: &DragImageInitOptions,
    stage: DragImageInitFailure,
) -> Result<()> {
    #[cfg(test)]
    if options.fail_at == Some(stage) {
        return Err(Error::from(E_NOTIMPL));
    }
    let _ = (options, stage);
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
struct DragImageResourceTracker {
    hwnds: AtomicUsize,
    gdi_objects: AtomicUsize,
    hooks: AtomicUsize,
    timers: AtomicUsize,
    workers: AtomicUsize,
    applied_moves: AtomicUsize,
    moves_after_close: AtomicUsize,
    hook_thread_mismatches: AtomicUsize,
    last_hook_thread_id: AtomicU32,
}

struct DragImageWorkerGuard {
    #[cfg(test)]
    tracker: Option<Arc<DragImageResourceTracker>>,
}

impl DragImageWorkerGuard {
    fn new(options: &DragImageInitOptions) -> Self {
        #[cfg(test)]
        if let Some(tracker) = &options.tracker {
            tracker.workers.fetch_add(1, Ordering::Relaxed);
        }
        #[cfg(not(test))]
        let _ = options;
        Self {
            #[cfg(test)]
            tracker: options.tracker.clone(),
        }
    }
}

impl Drop for DragImageWorkerGuard {
    fn drop(&mut self) {
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.workers.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

struct DragImageResources {
    hwnd: HWND,
    memory_dc: HDC,
    bitmap: HBITMAP,
    previous_bitmap: HGDIOBJ,
    timer_started: bool,
    mouse_hook: Option<HHOOK>,
    position: Option<Box<DragImagePosition>>,
    #[cfg(test)]
    tracker: Option<Arc<DragImageResourceTracker>>,
}

impl DragImageResources {
    fn new(options: &DragImageInitOptions) -> Self {
        #[cfg(not(test))]
        let _ = options;
        Self {
            hwnd: HWND(std::ptr::null_mut()),
            memory_dc: HDC(std::ptr::null_mut()),
            bitmap: HBITMAP(std::ptr::null_mut()),
            previous_bitmap: HGDIOBJ(std::ptr::null_mut()),
            timer_started: false,
            mouse_hook: None,
            position: None,
            #[cfg(test)]
            tracker: options.tracker.clone(),
        }
    }

    fn set_hwnd(&mut self, hwnd: HWND) {
        self.hwnd = hwnd;
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.hwnds.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn set_memory_dc(&mut self, memory_dc: HDC) {
        self.memory_dc = memory_dc;
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.gdi_objects.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn set_bitmap(&mut self, bitmap: HBITMAP) {
        self.bitmap = bitmap;
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.gdi_objects.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn set_timer_started(&mut self) {
        self.timer_started = true;
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.timers.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn set_mouse_hook(&mut self, hook: HHOOK) {
        self.mouse_hook = Some(hook);
        #[cfg(test)]
        if let Some(tracker) = &self.tracker {
            tracker.hooks.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for DragImageResources {
    fn drop(&mut self) {
        unsafe {
            if let Some(hook) = self.mouse_hook.take() {
                let _ = UnhookWindowsHookEx(hook);
                #[cfg(test)]
                if let Some(tracker) = &self.tracker {
                    tracker.hooks.fetch_sub(1, Ordering::Relaxed);
                }
            }
            DRAG_IMAGE_HOOK_POSITION.with(|slot| slot.set(std::ptr::null()));
            if self.timer_started {
                let _ = KillTimer(self.hwnd, DRAG_IMAGE_TIMER_ID);
                self.timer_started = false;
                #[cfg(test)]
                if let Some(tracker) = &self.tracker {
                    tracker.timers.fetch_sub(1, Ordering::Relaxed);
                }
            }
            if !self.hwnd.0.is_null() {
                SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0);
                let _ = DestroyWindow(self.hwnd);
                self.hwnd = HWND(std::ptr::null_mut());
                #[cfg(test)]
                if let Some(tracker) = &self.tracker {
                    tracker.hwnds.fetch_sub(1, Ordering::Relaxed);
                }
            }
            if !self.memory_dc.0.is_null() && !self.previous_bitmap.0.is_null() {
                let _ = SelectObject(self.memory_dc, self.previous_bitmap);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
                self.bitmap = HBITMAP(std::ptr::null_mut());
                #[cfg(test)]
                if let Some(tracker) = &self.tracker {
                    tracker.gdi_objects.fetch_sub(1, Ordering::Relaxed);
                }
            }
            if !self.memory_dc.0.is_null() {
                let _ = DeleteDC(self.memory_dc);
                self.memory_dc = HDC(std::ptr::null_mut());
                #[cfg(test)]
                if let Some(tracker) = &self.tracker {
                    tracker.gdi_objects.fetch_sub(1, Ordering::Relaxed);
                }
            }
        }
        self.position.take();
    }
}

unsafe fn run_native_drag_image_window(
    preview: DragPreview,
    ready: std::sync::mpsc::SyncSender<std::result::Result<(isize, u32), String>>,
    options: DragImageInitOptions,
) {
    let _worker_guard = DragImageWorkerGuard::new(&options);
    let mut resources = DragImageResources::new(&options);
    let result = (|| -> Result<()> {
        let module = GetModuleHandleW(None)?;
        let instance = HINSTANCE(module.0);
        let class_ready = *DRAG_IMAGE_WINDOW_CLASS_READY.get_or_init(|| {
            let class = WNDCLASSW {
                lpfnWndProc: Some(drag_image_window_proc),
                hInstance: instance,
                lpszClassName: DRAG_IMAGE_WINDOW_CLASS,
                ..Default::default()
            };
            RegisterClassW(&class) != 0
        });
        if !class_ready {
            return Err(Error::from_win32());
        }

        inject_drag_image_failure(&options, DragImageInitFailure::CreateWindow)?;
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            DRAG_IMAGE_WINDOW_CLASS,
            w!(""),
            WS_POPUP,
            0,
            0,
            preview.width,
            preview.height,
            HWND(std::ptr::null_mut()),
            None,
            instance,
            None,
        )?;
        resources.set_hwnd(hwnd);

        inject_drag_image_failure(&options, DragImageInitFailure::CreateCompatibleDc)?;
        let memory_dc = CreateCompatibleDC(HDC(std::ptr::null_mut()));
        if memory_dc.0.is_null() {
            return Err(Error::from_win32());
        }
        resources.set_memory_dc(memory_dc);
        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: preview.width,
                biHeight: -preview.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: preview.bgra.len() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        inject_drag_image_failure(&options, DragImageInitFailure::CreateDibSection)?;
        let bitmap = CreateDIBSection(
            memory_dc,
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            HANDLE(std::ptr::null_mut()),
            0,
        )?;
        resources.set_bitmap(bitmap);
        if bits.is_null() {
            return Err(Error::from_win32());
        }

        // UpdateLayeredWindow 要求预乘 alpha；Shell helper 则要求直 alpha。两条路径不能共用像素语义。
        let pixels = premultiply_bgra(preview.bgra.clone());
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());
        let previous_bitmap = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        resources.previous_bitmap = previous_bitmap;
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor)?;
        let destination = POINT {
            x: cursor.x - preview.offset_x,
            y: cursor.y - preview.offset_y,
        };
        let source = POINT::default();
        let size = SIZE {
            cx: preview.width,
            cy: preview.height,
        };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        inject_drag_image_failure(&options, DragImageInitFailure::UpdateLayeredWindow)?;
        UpdateLayeredWindow(
            hwnd,
            HDC(std::ptr::null_mut()),
            Some(&destination),
            Some(&size),
            memory_dc,
            Some(&source),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )?;
        let owner_thread_id = GetCurrentThreadId();
        let position = Box::new(DragImagePosition {
            hwnd: hwnd.0 as isize,
            owner_thread_id,
            offset_x: preview.offset_x,
            offset_y: preview.offset_y,
            latest_x: AtomicI32::new(cursor.x),
            latest_y: AtomicI32::new(cursor.y),
            last_applied_x: AtomicI32::new(cursor.x),
            last_applied_y: AtomicI32::new(cursor.y),
            move_pending: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            #[cfg(test)]
            tracker: options.tracker.clone(),
        });
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            (&*position as *const DragImagePosition) as isize,
        );
        resources.position = Some(position);
        inject_drag_image_failure(&options, DragImageInitFailure::SetTimer)?;
        if SetTimer(hwnd, DRAG_IMAGE_TIMER_ID, DRAG_IMAGE_FRAME_MS, None) == 0 {
            return Err(Error::from_win32());
        }
        resources.set_timer_started();
        let position = resources
            .position
            .as_deref()
            .expect("position stored before hook");
        DRAG_IMAGE_HOOK_POSITION.with(|slot| slot.set(position));
        inject_drag_image_failure(&options, DragImageInitFailure::SetWindowsHook)?;
        // WH_MOUSE_LL 是 Win32 仅支持全局范围的 low-level hook，因此 dwThreadId 必须为 0；
        // 系统仍会把回调以消息形式送回安装 hook 的当前 worker 线程（由 owner_thread_id 守卫/测试验证）。
        let mouse_hook =
            SetWindowsHookExW(WH_MOUSE_LL, Some(drag_image_mouse_hook_proc), instance, 0)?;
        resources.set_mouse_hook(mouse_hook);
        ShowWindow(hwnd.0 as isize, SW_SHOWNOACTIVATE);
        Ok(())
    })();

    if let Err(error) = result {
        let _ = ready.send(Err(error.to_string()));
        return;
    }
    let thread_id = GetCurrentThreadId();
    if ready
        .send(Ok((resources.hwnd.0 as isize, thread_id)))
        .is_err()
    {
        return;
    }

    // 独立属主线程持续泵消息：WH_MOUSE_LL 由系统把每个鼠标移动投递回本线程，回调只合并
    // 最新坐标并 PostMessage；窗口消息再执行 SetWindowPos。OLE target/capture 与命中频率都不参与。
    let mut message = MSG::default();
    loop {
        let status = GetMessageW(&mut message, HWND(std::ptr::null_mut()), 0, 0).0;
        if status <= 0 {
            break;
        }
        let _ = TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

struct NativeDragImageWindow {
    hwnd: isize,
    thread_id: u32,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl NativeDragImageWindow {
    fn create(preview: &DragPreview) -> std::result::Result<Self, String> {
        Self::create_with_options(preview, DragImageInitOptions::default())
    }

    fn create_with_options(
        preview: &DragPreview,
        options: DragImageInitOptions,
    ) -> std::result::Result<Self, String> {
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let preview = preview.clone();
        let worker = std::thread::spawn(move || unsafe {
            run_native_drag_image_window(preview, ready_tx, options);
        });
        match ready_rx.recv() {
            Ok(Ok((hwnd, thread_id))) => Ok(Self {
                hwnd,
                thread_id,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(error) => {
                let _ = worker.join();
                Err(format!(
                    "drag-image worker ended before initialization: {error}"
                ))
            }
        }
    }
}

impl Drop for NativeDragImageWindow {
    fn drop(&mut self) {
        unsafe {
            let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
            if PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)).is_err() {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

// ── IDropSource：按左键/Esc 状态决定继续/完成/取消 ──────────────
#[implement(IDropSource)]
struct DragOutDropSource {
    drag_cursor: Option<std::sync::Arc<DragCursor>>,
    // 只用于把独立显示线程的所有权绑定到 OLE source 生命周期；位置更新由该线程自行驱动。
    _drag_image: Option<NativeDragImageWindow>,
}

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
        if let Some(cursor) = &self.drag_cursor {
            cursor.apply();
            S_OK
        } else {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
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
fn build_formats(app: &AppHandle, items: &[DragOutItem]) -> (Vec<(u16, Vec<u8>)>, Vec<PathBuf>) {
    let mut file_paths: Vec<String> = Vec::new();
    let mut temp_files: Vec<PathBuf> = Vec::new();
    let mut text_payload: Option<String> = None;

    for it in items {
        match it.r#type.as_str() {
            "file" => {
                if let Some(paths) = &it.items {
                    // 续100：过滤已不存在的路径。死路径进 CF_HDROP → 拖到 cmd 等目标时 OLE 崩溃、连带本进程闪退。
                    // 整条失踪由前端拦截不发；此处兜底两种情况：① batch 条目部分文件被删；② 前端漏拦的防御。
                    // 全部过滤空 → 上层 run_drag_out 的 `formats.is_empty()` 守卫会干净中止（并清 STAGE_REORDER_ACTIVE）。
                    file_paths.extend(
                        paths
                            .iter()
                            .filter(|p| std::path::Path::new(p).exists())
                            .cloned(),
                    );
                }
            }
            "image" => {
                if let Some(p) = image_to_file(app, it, &mut temp_files) {
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
fn image_to_file(
    app: &AppHandle,
    it: &DragOutItem,
    temp_files: &mut Vec<PathBuf>,
) -> Option<String> {
    if let Some(op) = &it.orig_path {
        if std::path::Path::new(op).exists() {
            return Some(op.clone());
        }
        // 剪贴板来源才有 time；中转 image 可沿用 fallback，但其状态由前端持久化域管理。
        if it.time.is_some() {
            crate::clipboard::mark_clip_original_degraded(
                app,
                it.time,
                Some(op),
                "consume-fallback",
            );
        }
    }
    // stage_images 是不可重建的持久资产，不能直接交给允许 MOVE 的 OLE（Explorer 会搬走源文件）。
    // 复制成临时 PNG 再交付：仍省掉 base64 IPC/解码，只多一次文件复制，且保持原有 temp 生命周期。
    if let Some(source) = it
        .content_file
        .as_deref()
        .and_then(crate::apps::stage_image_path)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("workbench_dragout_{ts}.png"));
        std::fs::copy(source, &path).ok()?;
        temp_files.push(path.clone());
        return Some(path.to_string_lossy().into_owned());
    }
    let bytes = it.resolve_image_bytes()?;
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
    let bytes = it.resolve_image_bytes()?;
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

#[derive(Clone)]
struct DragPreview {
    width: i32,
    height: i32,
    offset_x: i32,
    offset_y: i32,
    pointer_scale: f32,
    bgra: Vec<u8>,
}

fn point_in_rounded_rect(x: i32, y: i32, width: i32, height: i32, radius: i32) -> bool {
    let cx = if x < radius {
        radius
    } else if x >= width - radius {
        width - radius - 1
    } else {
        x
    };
    let cy = if y < radius {
        radius
    } else if y >= height - radius {
        height - radius - 1
    } else {
        y
    };
    let dx = x - cx;
    let dy = y - cy;
    dx * dx + dy * dy <= radius * radius
}

#[derive(Clone, Copy)]
struct PreviewTextSpec {
    x: i32,
    y: i32,
    font_px: i32,
    color: COLORREF,
}

unsafe fn draw_text_into_preview(
    bgra: &mut [u8],
    width: i32,
    height: i32,
    label: &str,
    spec: PreviewTextSpec,
) -> bool {
    let memory_dc = CreateCompatibleDC(HDC(std::ptr::null_mut()));
    if memory_dc.0.is_null() {
        return false;
    }
    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: bgra.len() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(
        memory_dc,
        &bitmap_info,
        DIB_RGB_COLORS,
        &mut bits,
        HANDLE(std::ptr::null_mut()),
        0,
    ) {
        Ok(bitmap) => bitmap,
        Err(_) => {
            let _ = DeleteDC(memory_dc);
            return false;
        }
    };
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        return false;
    }
    std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits.cast::<u8>(), bgra.len());
    let previous_bitmap = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
    let font = CreateFontW(
        -spec.font_px,
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        u32::from(DEFAULT_PITCH.0 | FF_DONTCARE.0),
        w!("Segoe UI"),
    );
    if font.0.is_null() {
        let _ = SelectObject(memory_dc, previous_bitmap);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        return false;
    }
    let previous_font = SelectObject(memory_dc, HGDIOBJ(font.0));
    SetBkMode(memory_dc, TRANSPARENT);
    SetTextColor(memory_dc, spec.color);
    let wide: Vec<u16> = label.encode_utf16().collect();
    let rendered = TextOutW(memory_dc, spec.x, spec.y, &wide).as_bool();
    if rendered {
        std::ptr::copy_nonoverlapping(bits.cast::<u8>(), bgra.as_mut_ptr(), bgra.len());
    }
    let _ = SelectObject(memory_dc, previous_font);
    let _ = DeleteObject(HGDIOBJ(font.0));
    let _ = SelectObject(memory_dc, previous_bitmap);
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(memory_dc);
    rendered
}

fn drag_text_units(value: &str) -> f64 {
    value
        .chars()
        .map(|ch| if ch.is_ascii() { 0.56 } else { 1.0 })
        .sum()
}

fn truncate_drag_card_text(value: &str, max_units: f64) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result = String::new();
    let mut units = 0.0;
    for ch in normalized.chars() {
        let next = if ch.is_ascii() { 0.56 } else { 1.0 };
        if units + next > max_units {
            result.push('…');
            break;
        }
        result.push(ch);
        units += next;
    }
    result
}

fn drag_card_preview_lines(value: &str) -> Vec<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut units = 0.0;
    for ch in normalized.chars() {
        let next = if ch.is_ascii() { 0.56 } else { 1.0 };
        if units + next > 7.0 && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
            if lines.len() == 3 {
                break;
            }
            units = 0.0;
        }
        line.push(ch);
        units += next;
    }
    if lines.len() < 3 && !line.is_empty() {
        lines.push(line);
    }
    if lines.len() == 3
        && drag_text_units(&normalized) > lines.iter().map(|line| drag_text_units(line)).sum()
    {
        if let Some(last) = lines.last_mut() {
            while drag_text_units(last) > 6.0 {
                last.pop();
            }
            last.push('…');
        }
    }
    lines
}

fn fill_drag_card_rect(
    canvas: &mut image::RgbaImage,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    radius: i32,
    color: image::Rgba<u8>,
) {
    for y in 0..height {
        for x in 0..width {
            if point_in_rounded_rect(x, y, width, height, radius) {
                let px = left + x;
                let py = top + y;
                if px >= 0 && py >= 0 && px < canvas.width() as i32 && py < canvas.height() as i32 {
                    canvas.put_pixel(px as u32, py as u32, color);
                }
            }
        }
    }
}

/// 前端页内 ghost 直接复用中转方格卡片；这里按同一 72×94 CSS px 结构栅格化，
/// 交给独立分层窗跨过 source HWND 隐藏边界。缺图只在卡片缩略图区画类型色占位。
fn build_drag_preview(items: &[DragOutItem]) -> Option<DragPreview> {
    let first = items.first()?;
    let dpr = first.drag_dpr.unwrap_or(1.0).clamp(1.0, 4.0);
    let scale = dpr * 1.04;
    let card_width = (72.0 * scale).round() as u32;
    let card_height = (94.0 * scale).round() as u32;
    let card_left = (12.0 * scale).round() as i32;
    let card_top = (7.0 * scale).round() as i32;
    let width = card_width + (24.0 * scale).round() as u32;
    let height = card_height + (28.0 * scale).round() as u32;
    let thumb_height = (62.0 * scale).round() as u32;
    let radius = (9.0 * scale).round() as i32;
    let light = first.drag_theme.as_deref() == Some("light");
    let card_color = if light {
        [255, 255, 255, 217]
    } else {
        [30, 30, 32, 217]
    };
    let thumb_color = if light {
        [243, 243, 244, 217]
    } else {
        [38, 38, 40, 217]
    };
    let border_color = if light {
        [225, 225, 227, 217]
    } else {
        [53, 53, 56, 217]
    };
    let text_color = if light {
        COLORREF(0x001C_1A1A)
    } else {
        COLORREF(0x00FF_FFFF)
    };
    let meta_color = if light {
        COLORREF(0x0066_6666)
    } else {
        COLORREF(0x0099_9999)
    };
    let mut canvas = image::RgbaImage::new(width, height);
    // 复刻页内 `.stage-drag-ghost` 的下沉阴影；分层窗自身无 CSS box-shadow，必须进位图。
    for (spread_css, alpha) in [(12.0, 10), (8.0, 18), (4.0, 32)] {
        let spread = (spread_css * scale).round() as i32;
        fill_drag_card_rect(
            &mut canvas,
            card_left - spread,
            card_top + (6.0 * scale).round() as i32 - spread,
            card_width as i32 + spread * 2,
            card_height as i32 + spread * 2,
            radius + spread,
            image::Rgba([0, 0, 0, alpha]),
        );
    }
    fill_drag_card_rect(
        &mut canvas,
        card_left,
        card_top,
        card_width as i32,
        card_height as i32,
        radius,
        image::Rgba(border_color),
    );
    let border = (0.5 * scale).round().max(1.0) as i32;
    fill_drag_card_rect(
        &mut canvas,
        card_left + border,
        card_top + border,
        card_width as i32 - border * 2,
        card_height as i32 - border * 2,
        (radius - border).max(1),
        image::Rgba(card_color),
    );
    for y in border as u32..thumb_height.min(height.saturating_sub(border as u32)) {
        for x in border as u32..card_width.saturating_sub(border as u32) {
            if point_in_rounded_rect(
                x as i32,
                y as i32,
                card_width as i32,
                card_height as i32,
                radius,
            ) {
                canvas.put_pixel(
                    card_left as u32 + x,
                    card_top as u32 + y,
                    image::Rgba(thumb_color),
                );
            }
        }
    }

    let preview = first
        .drag_preview
        .as_deref()
        .and_then(|encoded| base64_decode(strip_data_url(encoded)))
        .and_then(|bytes| image::load_from_memory(&bytes).ok());
    if first.r#type == "text" {
        // 文字预览稍后与两行标签一起交给 GDI，避免为每个 glyph 手写像素。
    } else if let Some(preview) = preview {
        if first.drag_preview_kind.as_deref() == Some("cover") {
            let inner_width = card_width.saturating_sub((border * 2) as u32).max(1);
            let inner_height = thumb_height.saturating_sub(border as u32).max(1);
            let mut rendered = preview
                .resize_to_fill(
                    inner_width,
                    inner_height,
                    image::imageops::FilterType::Triangle,
                )
                .to_rgba8();
            for y in 0..rendered.height() {
                for x in 0..rendered.width() {
                    if !point_in_rounded_rect(
                        border + x as i32,
                        border + y as i32,
                        card_width as i32,
                        card_height as i32,
                        radius,
                    ) {
                        rendered.get_pixel_mut(x, y).0[3] = 0;
                    }
                }
            }
            image::imageops::overlay(
                &mut canvas,
                &rendered,
                (card_left + border) as i64,
                (card_top + border) as i64,
            );
        } else {
            let wrap = (40.0 * scale).round() as i32;
            let wrap_left = card_left + (card_width as i32 - wrap) / 2;
            let wrap_top = card_top + (thumb_height as i32 - wrap) / 2;
            fill_drag_card_rect(
                &mut canvas,
                wrap_left,
                wrap_top,
                wrap,
                wrap,
                (9.0 * scale).round() as i32,
                image::Rgba(card_color),
            );
            let inner = (34.0 * scale).round() as u32;
            let rendered = preview.thumbnail(inner, inner).to_rgba8();
            let x = card_left as i64 + (card_width.saturating_sub(rendered.width()) / 2) as i64;
            let y = card_top as i64 + ((thumb_height.saturating_sub(rendered.height())) / 2) as i64;
            image::imageops::overlay(&mut canvas, &rendered, x, y);
        }
    } else {
        let color = match first.r#type.as_str() {
            "image" => [212, 83, 126, 255],
            "text" => [99, 153, 34, 255],
            _ => [55, 138, 221, 255],
        };
        let block = (28.0 * scale).round() as i32;
        let left = card_left + (card_width as i32 - block) / 2;
        let top = card_top + (thumb_height as i32 - block) / 2;
        fill_drag_card_rect(
            &mut canvas,
            left,
            top,
            block,
            block,
            (7.0 * scale).round() as i32,
            image::Rgba(color),
        );
    }

    let separator_y = card_top as u32 + thumb_height.min(card_height - 1);
    for x in card_left as u32..card_left as u32 + card_width {
        canvas.put_pixel(x, separator_y, image::Rgba(border_color));
    }
    let dot_size = (6.0 * scale).round().max(2.0) as i32;
    let dot_color = match first.r#type.as_str() {
        "image" => [212, 83, 126, 255],
        "text" => [99, 153, 34, 255],
        _ => [55, 138, 221, 255],
    };
    fill_drag_card_rect(
        &mut canvas,
        card_left + card_width as i32 - (7.0 * scale).round() as i32,
        card_top + (5.0 * scale).round() as i32,
        dot_size,
        dot_size,
        dot_size / 2,
        image::Rgba(dot_color),
    );

    let mut bgra = Vec::with_capacity((width * height * 4) as usize);
    for pixel in canvas.pixels() {
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    if first.r#type == "text" {
        let preview_text = first
            .content
            .as_deref()
            .or(first.drag_label.as_deref())
            .unwrap_or("Text");
        let font = (9.0 * scale).round().max(8.0) as i32;
        for (index, line) in drag_card_preview_lines(preview_text).iter().enumerate() {
            let _ = unsafe {
                draw_text_into_preview(
                    &mut bgra,
                    width as i32,
                    height as i32,
                    line,
                    PreviewTextSpec {
                        x: card_left + (7.0 * scale).round() as i32,
                        y: card_top
                            + (5.0 * scale).round() as i32
                            + index as i32 * (13.0 * scale).round() as i32,
                        font_px: font,
                        color: meta_color,
                    },
                )
            };
        }
    }
    let fallback_label = match first.r#type.as_str() {
        "image" => "Image",
        "text" => "Text",
        _ => "File",
    };
    let label = truncate_drag_card_text(first.drag_label.as_deref().unwrap_or(fallback_label), 7.0);
    let meta = truncate_drag_card_text(first.drag_meta.as_deref().unwrap_or(fallback_label), 8.0);
    let label_y = card_top + thumb_height as i32 + (2.0 * scale).round() as i32;
    let _ = unsafe {
        draw_text_into_preview(
            &mut bgra,
            width as i32,
            height as i32,
            &label,
            PreviewTextSpec {
                x: card_left + (6.0 * scale).round() as i32,
                y: label_y,
                font_px: (10.0 * scale).round().max(9.0) as i32,
                color: text_color,
            },
        )
    };
    let _ = unsafe {
        draw_text_into_preview(
            &mut bgra,
            width as i32,
            height as i32,
            &meta,
            PreviewTextSpec {
                x: card_left + (6.0 * scale).round() as i32,
                y: label_y + (14.0 * scale).round() as i32,
                font_px: (9.0 * scale).round().max(8.0) as i32,
                color: meta_color,
            },
        )
    };
    if items.len() > 1 {
        let badge_width = (25.0 * scale).round() as i32;
        let badge_height = (14.0 * scale).round() as i32;
        for y in 0..badge_height {
            for x in 0..badge_width {
                if point_in_rounded_rect(x, y, badge_width, badge_height, badge_height / 2) {
                    let px = card_left + (4.0 * scale).round() as i32 + x;
                    let py = card_top + (4.0 * scale).round() as i32 + y;
                    let start = ((py * width as i32 + px) * 4) as usize;
                    bgra[start..start + 4].copy_from_slice(&[212, 120, 0, 235]);
                }
            }
        }
        let count = format!("×{}", items.len());
        let _ = unsafe {
            draw_text_into_preview(
                &mut bgra,
                width as i32,
                height as i32,
                &count,
                PreviewTextSpec {
                    x: card_left + (8.0 * scale).round() as i32,
                    y: card_top + (4.0 * scale).round() as i32,
                    font_px: (9.0 * scale).round().max(8.0) as i32,
                    color: COLORREF(0x00FF_FFFF),
                },
            )
        };
    }
    // GDI 写 32-bit DIB 文字时会把 glyph 像素 alpha 清零；卡片内部恢复整体 0.85 opacity。
    for y in 0..height as i32 {
        for x in 0..width as i32 {
            if point_in_rounded_rect(
                x - card_left,
                y - card_top,
                card_width as i32,
                card_height as i32,
                radius,
            ) {
                bgra[((y * width as i32 + x) * 4 + 3) as usize] = 217;
            }
        }
    }
    Some(DragPreview {
        width: width as i32,
        height: height as i32,
        offset_x: card_left
            + (first.drag_hotspot_x.unwrap_or(12.0).clamp(4.0, 68.0) * scale).round() as i32,
        offset_y: card_top
            + (first.drag_hotspot_y.unwrap_or(12.0).clamp(4.0, 90.0) * scale).round() as i32,
        pointer_scale: dpr as f32,
        bgra,
    })
}

unsafe fn initialize_shell_drag_image(data_object: &IDataObject, preview: &DragPreview) -> bool {
    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: preview.width,
            biHeight: -preview.height, // top-down，直接复制 worker 生成的行序
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: preview.bgra.len() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(
        HDC(std::ptr::null_mut()),
        &bitmap_info,
        DIB_RGB_COLORS,
        &mut bits,
        HANDLE(std::ptr::null_mut()),
        0,
    ) {
        Ok(bitmap) => bitmap,
        Err(error) => {
            eprintln!("[dragout] create drag-image bitmap failed: {error}");
            return false;
        }
    };
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        return false;
    }
    std::ptr::copy_nonoverlapping(preview.bgra.as_ptr(), bits.cast::<u8>(), preview.bgra.len());
    let helper: IDragSourceHelper =
        match CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) {
            Ok(helper) => helper,
            Err(error) => {
                eprintln!("[dragout] Shell drag-image helper unavailable: {error}");
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                return false;
            }
        };
    let image = SHDRAGIMAGE {
        sizeDragImage: SIZE {
            cx: preview.width,
            cy: preview.height,
        },
        ptOffset: POINT {
            x: preview.offset_x,
            y: preview.offset_y,
        },
        hbmpDragImage: bitmap,
        // CLR_NONE：启用位图自身 alpha；0 是真实黑色色键，不应与 alpha 拖图混用。
        crColorKey: COLORREF(u32::MAX),
    };
    if let Err(error) = helper.InitializeFromBitmap(&image, data_object) {
        eprintln!("[dragout] Shell drag-image init failed, fallback to default cursor: {error}");
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        return false;
    }
    // InitializeFromBitmap 成功后 helper 接管 HBITMAP；只在失败分支 DeleteObject。
    true
}

// ── 入口：前端命令调用 ────────────────────────────────────────
/// 启动一次拖出。命令本体只做轻活、立即返回；构建 + 调度全在 worker 线程。
///
/// 关键：`DoDragDrop` **必须在主线程**跑——主线程已 `OleInitialize`（STA，dragdrop setup 时）、
/// 拥有前台窗口、且 mousedown 起手已持有鼠标 capture。放在 worker 线程（无窗口/无 capture）会让
/// DoDragDrop 起手 SetCapture 失败、拖拽不启动（续71 首版症状：界面消失但什么都没投放）。
/// force_hide：本次拖出由"区内重排中按热键"升级而来——用户已明确要隐藏 overlay 去外部投放，故无视 keepOpen
/// 设置强制走隐藏收场（详见 do_drag_on_main）。边界越出触发的常规拖出传 None/false，沿用 DRAGOUT_AUTO_CLOSE。
/// 本批拖出是否剪贴板来源（条目带 time = 剪贴板项；中转条目 time 为 None，见 DragOutItem 文档）。
/// 决定允许的 drop 效果：**剪贴板来源只许 COPY**——条目拖出后要保留（R39），若许 MOVE，
/// Explorer 同盘落点会把源文件直接搬走：image 的 `clip_images/` 原图、file 条目引用的用户文件，
/// 都是「条目留下、文件没了」→ 下次启动 orig_path 悬空被剥离、静默降级缩略图（续148 实测三连）。
/// 中转站来源维持 COPY|MOVE：「移出即消失」语义下条目随投放成功移除，文件搬走是自洽的（续86）。
fn is_clip_sourced(items: &[DragOutItem]) -> bool {
    items.iter().any(|it| it.time.is_some())
}

#[tauri::command]
pub fn start_drag_out(app: AppHandle, items: Vec<DragOutItem>, force_hide: Option<bool>) {
    let force_hide = force_hide.unwrap_or(false);
    std::thread::spawn(move || run_drag_out(app, items, force_hide));
}

fn run_drag_out(app: AppHandle, items: Vec<DragOutItem>, force_hide: bool) {
    let drag_session_id = items.first().and_then(|item| item.drag_session_id);
    let copy_only = is_clip_sourced(&items);
    let (formats, temp_files) = build_formats(&app, &items);
    println!(
        "[dragout] start: {} item(s) → {} format(s) force_hide={force_hide}",
        items.len(),
        formats.len()
    );
    // 若本次是从区内重排升级来的（STAGE_REORDER_ACTIVE 仍为真），任何"没走到 do_drag_on_main"的中止路径都必须
    // 在此清掉该让路标志——否则标志永久悬置，monitor/light-dismiss 永远让路、窗口再也无法正常隐藏/关闭。
    if formats.is_empty() {
        eprintln!("[dragout] 无可拖出格式，放弃");
        STAGE_REORDER_ACTIVE.store(false, Ordering::Relaxed);
        CLIP_DRAG_ACTIVE.store(false, Ordering::Relaxed); // 续110：clip 来源同理，防标志悬置
        emit_drag_preview_ready(&app, drag_session_id, "none");
        return;
    }
    let drag_preview = build_drag_preview(&items);
    let hwnd = match app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
        Some(h) => h.0 as isize,
        None => {
            eprintln!("[dragout] 取主窗口 HWND 失败");
            STAGE_REORDER_ACTIVE.store(false, Ordering::Relaxed);
            CLIP_DRAG_ACTIVE.store(false, Ordering::Relaxed); // 续110
            emit_drag_preview_ready(&app, drag_session_id, "none");
            return;
        }
    };
    let app_main = app.clone();
    // 切到主线程跑 DoDragDrop（阻塞其模态循环，期间 tao 窗口仍收消息——同文件对话框 idiom）
    let options = DragRunOptions {
        hwnd,
        force_hide,
        copy_only,
        session_id: drag_session_id,
    };
    if let Err(e) = app.run_on_main_thread(move || {
        do_drag_on_main(app_main, formats, temp_files, drag_preview, options)
    }) {
        eprintln!("[dragout] run_on_main_thread 调度失败: {e}");
        STAGE_REORDER_ACTIVE.store(false, Ordering::Relaxed);
        CLIP_DRAG_ACTIVE.store(false, Ordering::Relaxed); // 续110
        emit_drag_preview_ready(&app, drag_session_id, "none");
    }
}

/// 在主线程执行：构建 COM 对象 → 起手 DoDragDrop（持有 capture）→ 稍后隐藏 → 阻塞至投放/取消。
/// 主线程已是 OLE STA（dragdrop setup 的 OleInitialize），**不再 init/uninit**（否则破坏拖入的 OLE 状态）。
fn do_drag_on_main(
    app: AppHandle,
    formats: Vec<(u16, Vec<u8>)>,
    temp_files: Vec<PathBuf>,
    drag_preview: Option<DragPreview>,
    options: DragRunOptions,
) {
    let DragRunOptions {
        hwnd,
        force_hide,
        copy_only,
        session_id: drag_session_id,
    } = options;
    // Shell 通用对象既保存业务格式，也原样保存 drag-image helper 的 TYMED_ISTREAM 等私有格式。
    // 若极端环境下创建失败，退回旧对象保证文件/文本拖出仍可用，只损失预览。
    let data_obj: IDataObject = create_shell_drag_data_object(&formats).unwrap_or_else(|error| {
        eprintln!("[dragout] SHCreateDataObject failed, fallback to basic data object: {error}");
        DragOutDataObject {
            formats: Mutex::new(formats),
        }
        .into()
    });
    let data_obj = suppress_drop_description(data_obj);
    // 独立分层窗是正常视觉所有者：source HWND 隐藏会让系统 cursor 短暂重置，但不会影响另一个 HWND，
    // 因而卡片能跨过关闭界面的那一帧。创建失败才降级为 HCURSOR，再降级 Shell helper/默认 cursor；
    // 任何视觉失败都不能阻断文件/文本拖出。
    let native_drag_image = drag_preview.as_ref().and_then(|preview| {
        match NativeDragImageWindow::create(preview) {
            Ok(window) => Some(window),
            Err(error) => {
                eprintln!("[dragout] native drag-image window unavailable, fallback to custom cursor: {error}");
                None
            }
        }
    });
    let drag_cursor = if native_drag_image.is_none() {
        drag_preview.as_ref().and_then(|preview| {
            match unsafe { DragCursor::create(preview) } {
                Ok(cursor) => Some(std::sync::Arc::new(cursor)),
                Err(error) => {
                    eprintln!("[dragout] custom drag cursor unavailable, fallback to Shell helper: {error}");
                    None
                }
            }
        })
    } else {
        None
    };
    let shell_drag_image_ready = drag_cursor.is_none()
        && native_drag_image.is_none()
        && drag_preview
            .as_ref()
            .is_some_and(|preview| unsafe { initialize_shell_drag_image(&data_obj, preview) });
    let drag_image_mode = if drag_cursor.is_some() {
        "custom-cursor"
    } else if native_drag_image.is_some() {
        "native-window"
    } else if shell_drag_image_ready {
        "shell-helper"
    } else {
        "none"
    };
    // force_hide（区内重排中按热键升级来的拖出）：用户已明确要隐藏 overlay，无视 keepOpen 设置强制走隐藏收场。
    let auto_close = force_hide || DRAGOUT_AUTO_CLOSE.load(Ordering::Relaxed);
    println!("[dragout] DoDragDrop begin (main thread) auto_close={auto_close} force_hide={force_hide} drag_image={} drag_image_mode={drag_image_mode}", drag_image_mode != "none");
    DRAG_IN_PROGRESS.store(true, Ordering::Relaxed); // 拖动期间热键 monitor 让路（见 static 注释）
                                                     // 续88：DRAG_IN_PROGRESS 已接管让路职责，此刻才清 STAGE_REORDER_ACTIVE（本次若由区内重排升级而来）。
                                                     // 顺序关键——**先置 DRAG_IN_PROGRESS 再清 STAGE_REORDER_ACTIVE**：两标志在此无缝交接、任一时刻至少一个为真，
                                                     // 中间无空窗可被 monitor / light-dismiss 钻空提前 hide 窗口（否则 DoDragDrop 尚未起手就被隐藏→SetCapture
                                                     // 失败→松手无文件落地，正是续88 四轮反馈的症状）。非重排来源（多选/搜索直出）本就为 false，这里清是无害幂等。
    STAGE_REORDER_ACTIVE.store(false, Ordering::Relaxed);
    CLIP_DRAG_ACTIVE.store(false, Ordering::Relaxed); // 续110：clip 来源同理无缝交接（先置 DRAG_IN_PROGRESS 再清此处），幂等

    // 原生拖动期间普通 hotkey monitor 按 R13 让路；可见性切换始终由 dragout 自己独占。
    // overlay_hidden 表示裸 ShowWindow 后的真实状态；stop channel 让 DoDragDrop 终态同步收拢 worker，
    // 保证 cursor 销毁前再无迟到的 SetCursor。
    let overlay_hidden = std::sync::Arc::new(AtomicBool::new(false));
    // 自动关闭只负责拖动起手时隐藏。用户在同一次拖动中主动重新呼出后，
    // 这次显式意图优先于设置，落回 WB 时不得在收尾阶段再次关掉。
    let reshown_during_drag = std::sync::Arc::new(AtomicBool::new(false));
    let app2 = app.clone();
    let hidden = overlay_hidden.clone();
    let reshown = reshown_during_drag.clone();
    let worker_drag_cursor = drag_cursor.clone();
    let visibility_stop_requested = std::sync::Arc::new(AtomicBool::new(false));
    let worker_stop_requested = visibility_stop_requested.clone();
    let (visibility_stop_tx, visibility_stop_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let reapply_drag_cursor = || {
            if !worker_stop_requested.load(Ordering::Acquire) {
                if let Some(cursor) = &worker_drag_cursor {
                    cursor.apply();
                }
            }
        };
        if auto_close {
            match visibility_stop_rx
                .recv_timeout(std::time::Duration::from_millis(HIDE_AFTER_START_MS))
            {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
            hidden.store(true, Ordering::Release);
            if worker_stop_requested.load(Ordering::Acquire) {
                return;
            }
            // 隐藏主 HWND 会触发一次 WM_SETCURSOR/目标重命中。紧跟同一显隐操作重申本轮 cursor，
            // 避免等到落点初始化后的下一次 GiveFeedback 才重新出现；不改变现有 hide 时钟或事件来源。
            reapply_drag_cursor();
            let _ = app2.emit("hotkey-hide", ());
        }
        let is_down =
            |vk: u16| -> bool { unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000u16) != 0 } };
        // 起手视作已按下：force_hide 通常正由这组热键触发，必须先看到松开才接受下一次切换。
        let mut prev = true;
        loop {
            let keys = crate::current_hotkey_vks();
            let combo = !keys.is_empty() && keys.iter().all(|vk| is_down(*vk));
            if combo && !prev {
                if hidden.load(Ordering::Relaxed) {
                    // 只显示、不激活：鼠标仍由 OLE drag capture 持有，overlay 重新成为可投放目标。
                    unsafe {
                        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    }
                    hidden.store(false, Ordering::Release);
                    reshown.store(true, Ordering::Release);
                    if worker_stop_requested.load(Ordering::Acquire) {
                        break;
                    }
                    reapply_drag_cursor();
                    let _ = app2.emit("hotkey-show", ());
                    println!("[dragout] 拖动中按热键 → 重新显示 overlay（可拖回 WB）");
                } else {
                    unsafe {
                        ShowWindow(hwnd, SW_HIDE);
                    }
                    hidden.store(true, Ordering::Release);
                    if worker_stop_requested.load(Ordering::Acquire) {
                        break;
                    }
                    reapply_drag_cursor();
                    let _ = app2.emit("hotkey-hide", ());
                    println!("[dragout] 拖动中按热键 → 隐藏 overlay");
                }
            }
            prev = combo;
            match visibility_stop_rx
                .recv_timeout(std::time::Duration::from_millis(DRAG_HOTKEY_POLL_MS))
            {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    });

    // 剪贴板来源只许 COPY（理由见 is_clip_sourced）：Explorer 同盘落点的默认效果是 move，
    // 一旦许 MOVE 它会把 clip_images/ 原图这类「条目还在引用的文件」直接搬走。
    let allowed = if copy_only {
        DROPEFFECT_COPY
    } else {
        DROPEFFECT_COPY | DROPEFFECT_MOVE
    };
    let mut effect = DROPEFFECT(0);
    // 在进入 OLE 模态循环前先设一次，避免首次 GiveFeedback 之前闪回普通 cursor；后续回调会重申，
    // 防目标窗口的 WM_SETCURSOR 覆盖。source Drop 只在当前仍是本 cursor 时恢复起拖前形状。
    if let Some(cursor) = &drag_cursor {
        cursor.apply();
    }
    emit_drag_preview_ready(&app, drag_session_id, drag_image_mode);
    let drop_src: IDropSource = DragOutDropSource {
        drag_cursor,
        _drag_image: native_drag_image,
    }
    .into();
    let hr = unsafe { DoDragDrop(&data_obj, &drop_src, allowed, &mut effect) };
    // 先发布 stop，再唤醒 recv_timeout。worker 持有 cursor 的 Arc；即使正卡在跨线程 ShowWindow，
    // 也不会使用已销毁句柄，且返回后会在 reapply/emit 前看到 stop。不能在 OLE 主线程 join：若 worker
    // 恰在等待主 HWND 处理 ShowWindow，主线程 join 会形成互等死锁。
    visibility_stop_requested.store(true, Ordering::Release);
    let _ = visibility_stop_tx.send(());
    drop(drop_src);

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
    println!(
        "[dragout] DoDragDrop end hr={hr:?} effect={} → {effect_str}",
        effect.0
    );

    let overlay_hidden = overlay_hidden.load(Ordering::Relaxed);
    let reshown_during_drag = reshown_during_drag.load(Ordering::Relaxed);
    if finish_hidden(auto_close, overlay_hidden, reshown_during_drag) {
        // 窗口应以隐藏收场（自动关闭且未被用户重新呼出 / 当前仍处于隐藏态）：
        // 收尾隐藏 **必须走 Tauri window.hide()**（此刻 DoDragDrop 已返回、主线程空闲）。不能再用裸
        // ShowWindow(SW_HIDE)：裸 FFI 绕过 tao 的可见性状态缓存 → tao 仍以为窗口可见 → 下次热键
        // window.show() 被 tao diff 成 no-op → 窗口再也呼不出（“卡死、须重启”）。拖拽中那个裸 ShowWindow
        // 由这里的 Tauri hide() 把 tao 缓存兜回“隐藏”、与真实状态重新对齐。
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
            crate::set_webview_memory_low(&win, true);
        }
        let _ = app.emit("hotkey-hide", ());
        let _ = app.emit("drag-out-done", effect_str);
        // 续82：真正投放成功时把前台交还给落点窗口（conhost/cmd 不自我激活 → 否则无焦点像卡死）。
        // 门控 hr==DRAGDROP_S_DROP：Esc 取消/无投放不动前台。
        if hr == DRAGDROP_S_DROP {
            activate_drop_target(hwnd);
        }
    } else {
        // "保持界面"模式且收尾时可见（可能全程可见，也可能隐藏后又重新呼出）：
        // 实际状态已回到 tao 原先记录的 visible，无需额外 show 同步；
        //   不发 hotkey-hide（前端保持 visible）。只发 drag-out-done 让前端按 effect 处理条目（copy/none
        //   保留、move 移除）；区内落点（启动台/重排）由窗口 IDropTarget 的 files-dropped 分支处理。
        // 轻量 set_focus 确保 OLE 拖拽结束后 Esc 仍可用（窗口本就可见、未隐藏，无白闪风险；仍延迟+守卫，
        //   复刻 show 路径 idiom）。
        let _ = app.emit("drag-out-done", effect_str);
        if let Some(win) = app.get_webview_window("main") {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if win.is_visible().unwrap_or(false) {
                    let _ = win.set_focus();
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SendMessageTimeoutW, SMTO_ABORTIFHUNG,
    };

    struct OleTestGuard;

    impl Drop for OleTestGuard {
        fn drop(&mut self) {
            unsafe {
                OleUninitialize();
            }
        }
    }

    fn item(time: Option<i64>) -> DragOutItem {
        DragOutItem {
            r#type: "image".into(),
            content: None,
            content_file: None,
            items: None,
            orig_path: None,
            time,
            drag_preview: None,
            drag_label: None,
            drag_meta: None,
            drag_preview_kind: None,
            drag_hotspot_x: None,
            drag_hotspot_y: None,
            drag_theme: None,
            drag_dpr: None,
            drag_session_id: None,
        }
    }

    fn tracked_drag_image_options(
        fail_at: Option<DragImageInitFailure>,
    ) -> (DragImageInitOptions, Arc<DragImageResourceTracker>) {
        let tracker = Arc::new(DragImageResourceTracker::default());
        (
            DragImageInitOptions {
                fail_at,
                tracker: Some(tracker.clone()),
            },
            tracker,
        )
    }

    fn assert_drag_image_resources_zero(tracker: &DragImageResourceTracker, context: &str) {
        assert_eq!(
            tracker.hwnds.load(Ordering::Relaxed),
            0,
            "{context}: HWND leak"
        );
        assert_eq!(
            tracker.gdi_objects.load(Ordering::Relaxed),
            0,
            "{context}: GDI object leak"
        );
        assert_eq!(
            tracker.hooks.load(Ordering::Relaxed),
            0,
            "{context}: hook leak"
        );
        assert_eq!(
            tracker.timers.load(Ordering::Relaxed),
            0,
            "{context}: timer leak"
        );
        assert_eq!(
            tracker.workers.load(Ordering::Relaxed),
            0,
            "{context}: worker leak"
        );
    }

    #[test]
    fn drag_finish_visibility_respects_mode_and_current_overlay_state() {
        assert!(
            finish_hidden(true, false, false),
            "自动关闭开启且未重新呼出时，收尾应隐藏"
        );
        assert!(
            finish_hidden(false, true, false),
            "保持界面模式下，若当前仍隐藏，收尾必须同步为隐藏"
        );
        assert!(
            !finish_hidden(false, false, false),
            "保持界面模式且当前可见时，应保持可见"
        );
        assert!(
            !finish_hidden(true, false, true),
            "拖动中主动重新呼出后，自动关闭不得再次覆盖用户意图"
        );
        assert!(
            finish_hidden(true, true, true),
            "重新呼出后若又主动隐藏，仍应以当前隐藏状态收尾"
        );
    }

    /// 续148：剪贴板来源（带 time）→ COPY-only；中转来源（time=None）→ 维持 COPY|MOVE。
    /// 混合批次含任一 clip 项即按 clip 处理（前端实际不会混发，防御性判定）。
    #[test]
    fn clip_sourced_detection() {
        assert!(is_clip_sourced(&[item(Some(123))]));
        assert!(!is_clip_sourced(&[item(None)]));
        assert!(is_clip_sourced(&[item(None), item(Some(1))]));
        assert!(!is_clip_sourced(&[]));
    }

    #[test]
    fn only_drop_description_feedback_is_suppressed() {
        assert!(should_suppress_drop_description(500, 500));
        assert!(!should_suppress_drop_description(501, 500));
        assert!(!should_suppress_drop_description(0, 0));
    }

    #[test]
    fn drop_description_wrapper_keeps_business_feedback_formats() {
        let wrapped: IDataObject = DropDescriptionSuppressingDataObject {
            inner: DragOutDataObject {
                formats: Mutex::new(Vec::new()),
            }
            .into(),
            drop_description_format: 500,
        }
        .into();
        let set = |format_id: u16| {
            let handle = alloc_hglobal(&[1, 2, 3, 4]).expect("test HGLOBAL");
            let format = FORMATETC {
                cfFormat: format_id,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let medium = STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 {
                    hGlobal: HGLOBAL(handle as *mut core::ffi::c_void),
                },
                pUnkForRelease: ManuallyDrop::new(None),
            };
            unsafe { wrapped.SetData(&format, &medium, TRUE) }.expect("wrapper SetData");
            format
        };

        let description = set(500);
        assert_eq!(
            unsafe { wrapped.QueryGetData(&description) },
            DV_E_FORMATETC
        );
        let performed_effect = set(501);
        assert_eq!(unsafe { wrapped.QueryGetData(&performed_effect) }, S_OK);
    }

    #[test]
    fn stage_content_file_deserializes_without_inline_content() {
        let item: DragOutItem = serde_json::from_value(serde_json::json!({
            "type": "image",
            "content": null,
            "content_file": "deadbeef.png",
            "items": null,
            "orig_path": null,
            "time": null
        }))
        .unwrap();
        assert_eq!(item.content_file.as_deref(), Some("deadbeef.png"));
        assert!(item.content.is_none());
    }

    #[test]
    fn drag_preview_uses_css_size_scaled_by_dpr() {
        let mut source = item(None);
        source.drag_dpr = Some(2.0);
        let preview = build_drag_preview(&[source]).expect("non-empty drag should have a preview");
        assert_eq!((preview.width, preview.height), (200, 254));
        assert_eq!((preview.offset_x, preview.offset_y), (50, 40));
        assert_eq!(preview.bgra.len(), 200 * 254 * 4);
    }

    #[test]
    fn drag_preview_falls_back_when_cached_thumbnail_is_invalid() {
        let mut source = item(None);
        source.drag_preview = Some("data:image/png;base64,not-an-image".into());
        let preview = build_drag_preview(&[source])
            .expect("invalid cached thumbnail should use fallback art");
        assert_eq!((preview.width, preview.height), (100, 127));
        assert!(preview
            .bgra
            .chunks_exact(4)
            .any(|pixel| pixel == [126, 83, 212, 217]));
    }

    #[test]
    fn every_source_uses_the_same_stage_card_geometry() {
        let mut source = item(None);
        source.drag_label = Some("报告 final.txt".into());
        source.drag_meta = Some("文本".into());
        source.content = Some("第一行 第二行".into());
        source.drag_preview = Some("data:image/png;base64,not-an-image".into());
        source.drag_dpr = Some(2.0);
        let preview = build_drag_preview(&[source]).expect("Unicode stage-card preview");
        assert_eq!((preview.width, preview.height), (200, 254));
        assert_eq!(preview.pointer_scale, 2.0);
        assert!(preview.bgra.chunks_exact(4).any(|pixel| pixel[3] == 217));
        let cursor = unsafe { DragCursor::create(&preview) }.expect("card preview cursor fallback");
        drop(cursor);
    }

    #[test]
    fn layered_window_pixels_are_premultiplied_without_changing_alpha() {
        let pixels = premultiply_bgra(vec![200, 100, 50, 128, 9, 8, 7, 0, 3, 2, 1, 255]);
        assert_eq!(pixels, vec![100, 50, 25, 128, 0, 0, 0, 0, 3, 2, 1, 255]);
    }

    #[test]
    fn custom_cursor_paints_a_visible_pointer_at_the_hotspot() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        let mut pixels = preview.bgra.clone();
        paint_cursor_pointer(&preview, &mut pixels);
        let pixel = |x: usize, y: usize| {
            let start = (y * preview.width as usize + x) * 4;
            &pixels[start..start + 4]
        };
        assert_eq!(
            pixel(preview.offset_x as usize, preview.offset_y as usize + 5),
            [0, 0, 0, 255]
        );
        assert_eq!(
            pixel(preview.offset_x as usize + 3, preview.offset_y as usize + 7),
            [255, 255, 255, 255]
        );
    }

    #[test]
    fn custom_drag_cursor_accepts_2x_preview_and_restores_previous_cursor() {
        let mut source = item(None);
        source.drag_dpr = Some(2.0);
        let preview = build_drag_preview(&[source]).expect("preview");
        let previous = unsafe { GetCursor() };
        let cursor = unsafe { DragCursor::create(&preview) }.expect("custom drag cursor");
        let handle = HCURSOR(cursor.icon as *mut core::ffi::c_void);
        cursor.apply();
        assert_eq!(unsafe { GetCursor() }, handle);
        drop(cursor);
        assert_eq!(unsafe { GetCursor() }, previous);
    }

    #[test]
    fn native_drag_image_owns_a_responsive_tracker_thread() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        let (options, tracker) = tracked_drag_image_options(None);
        let window = NativeDragImageWindow::create_with_options(&preview, options)
            .expect("native drag-image window");
        assert_ne!(window.thread_id, unsafe { GetCurrentThreadId() });

        let hwnd = HWND(window.hwnd as *mut core::ffi::c_void);
        // 停掉兜底 timer 并把窗口放到错误位置，证明模拟的系统 hook 回调会经
        // TLS→最新坐标合并→窗口消息完成移动，不是刚好撞上下一次 WM_TIMER。
        unsafe {
            let _ = KillTimer(hwnd, DRAG_IMAGE_TIMER_ID);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }

        let mut hit_test = 0usize;
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_NCHITTEST,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                250,
                Some(&mut hit_test),
            )
        };
        assert_ne!(
            sent.0, 0,
            "tracker thread should keep pumping window messages"
        );
        assert_eq!(hit_test as isize, HTTRANSPARENT as isize);
        let mut cursor = POINT::default();
        unsafe {
            GetCursorPos(&mut cursor).expect("cursor position");
        }
        let target = POINT {
            x: cursor.x + 31,
            y: cursor.y + 23,
        };
        let hook_sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_DRAG_IMAGE_TEST_HOOK,
                WPARAM(target.x as usize),
                LPARAM(target.y as isize),
                SMTO_ABORTIFHUNG,
                250,
                None,
            )
        };
        assert_ne!(hook_sent.0, 0, "hook callback simulation should return");
        assert_eq!(
            tracker.last_hook_thread_id.load(Ordering::Relaxed),
            window.thread_id,
            "WH_MOUSE_LL callback must execute on the installing worker thread"
        );
        assert_eq!(
            tracker.hook_thread_mismatches.load(Ordering::Relaxed),
            0,
            "hook callback and window owner must remain the same execution context"
        );
        let expected = (target.x - preview.offset_x, target.y - preview.offset_y);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        loop {
            let mut bounds = RECT::default();
            unsafe {
                GetWindowRect(hwnd, &mut bounds).expect("drag-image bounds");
            }
            if (bounds.left, bounds.top) == expected {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "mouse hook path should move to the latest point"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(window); // Drop 必须发终止消息并 join，不得遗留跨轮次 worker。
        assert_drag_image_resources_zero(&tracker, "successful tracker lifecycle");
    }

    #[test]
    fn native_drag_image_failure_injection_releases_every_acquired_resource() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        // 故意按“失败越晚、当时存活资源越多”到“失败越早”的顺序执行。
        let cases = [
            DragImageInitFailure::SetWindowsHook,
            DragImageInitFailure::SetTimer,
            DragImageInitFailure::UpdateLayeredWindow,
            DragImageInitFailure::CreateDibSection,
            DragImageInitFailure::CreateCompatibleDc,
            DragImageInitFailure::CreateWindow,
        ];
        for failure in cases {
            let (options, tracker) = tracked_drag_image_options(Some(failure));
            let result = NativeDragImageWindow::create_with_options(&preview, options);
            assert!(result.is_err(), "{failure:?} must fail initialization");
            assert_drag_image_resources_zero(&tracker, &format!("{failure:?}"));
        }
    }

    #[test]
    fn drag_image_timer_skips_an_unchanged_cursor_position_without_hook_health_gate() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        let (options, tracker) = tracked_drag_image_options(None);
        let window = NativeDragImageWindow::create_with_options(&preview, options)
            .expect("native drag-image window");
        let hwnd = HWND(window.hwnd as *mut core::ffi::c_void);
        unsafe {
            let _ = KillTimer(hwnd, DRAG_IMAGE_TIMER_ID);
        }

        let mut verified = false;
        for _ in 0..20 {
            let mut before_cursor = POINT::default();
            unsafe { GetCursorPos(&mut before_cursor).expect("cursor before first timer") };
            let first = unsafe {
                SendMessageTimeoutW(
                    hwnd,
                    WM_TIMER,
                    WPARAM(DRAG_IMAGE_TIMER_ID),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    250,
                    None,
                )
            };
            assert_ne!(first.0, 0, "first timer dispatch should return");
            let after_first = tracker.applied_moves.load(Ordering::Relaxed);
            let mut middle_cursor = POINT::default();
            unsafe { GetCursorPos(&mut middle_cursor).expect("cursor between timers") };
            let second = unsafe {
                SendMessageTimeoutW(
                    hwnd,
                    WM_TIMER,
                    WPARAM(DRAG_IMAGE_TIMER_ID),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    250,
                    None,
                )
            };
            assert_ne!(second.0, 0, "second timer dispatch should return");
            let after_second = tracker.applied_moves.load(Ordering::Relaxed);
            let mut after_cursor = POINT::default();
            unsafe { GetCursorPos(&mut after_cursor).expect("cursor after second timer") };
            if before_cursor == middle_cursor && middle_cursor == after_cursor {
                assert_eq!(
                    after_second, after_first,
                    "unchanged timer coordinates must not call SetWindowPos again"
                );
                verified = true;
                break;
            }
        }
        assert!(
            verified,
            "cursor never stayed still long enough to verify timer deduplication"
        );
        drop(window);
        assert_drag_image_resources_zero(&tracker, "timer dedup lifecycle");
    }

    #[test]
    fn queued_move_then_close_exits_worker_without_a_post_close_move() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        let (options, tracker) = tracked_drag_image_options(None);
        let window = NativeDragImageWindow::create_with_options(&preview, options)
            .expect("native drag-image window");
        let hwnd = HWND(window.hwnd as *mut core::ffi::c_void);
        unsafe {
            let _ = KillTimer(hwnd, DRAG_IMAGE_TIMER_ID);
            PostMessageW(hwnd, WM_DRAG_IMAGE_MOVE, WPARAM(0), LPARAM(0)).expect("queue move");
            PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)).expect("queue close");
        }
        drop(window); // join 是 worker 正常退出的直接断言。
        assert_eq!(
            tracker.moves_after_close.load(Ordering::Relaxed),
            0,
            "no SetWindowPos path may run after WM_CLOSE marks the state closing"
        );
        assert_drag_image_resources_zero(&tracker, "move then close lifecycle");
    }

    #[test]
    fn hook_posted_move_queued_behind_close_is_discarded() {
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        let (options, tracker) = tracked_drag_image_options(None);
        let window = NativeDragImageWindow::create_with_options(&preview, options)
            .expect("native drag-image window");
        let hwnd = HWND(window.hwnd as *mut core::ffi::c_void);
        unsafe {
            let _ = KillTimer(hwnd, DRAG_IMAGE_TIMER_ID);
        }
        let mut cursor = POINT::default();
        unsafe { GetCursorPos(&mut cursor).expect("cursor position") };
        let target = POINT {
            x: cursor.x + 47,
            y: cursor.y + 37,
        };
        let applied_before = tracker.applied_moves.load(Ordering::Relaxed);
        unsafe {
            // TEST_HOOK 处理时才把 MOVE 投到队尾，因此队列顺序会成为 CLOSE → MOVE：
            // 专门覆盖 hook 已 PostMessage、结束流程先抵达的“飞行中消息”。
            PostMessageW(
                hwnd,
                WM_DRAG_IMAGE_TEST_HOOK,
                WPARAM(target.x as usize),
                LPARAM(target.y as isize),
            )
            .expect("queue hook callback simulation");
            PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)).expect("queue close");
        }
        drop(window);
        assert_eq!(
            tracker.applied_moves.load(Ordering::Relaxed),
            applied_before,
            "move posted by the hook behind WM_CLOSE must never reach SetWindowPos"
        );
        assert_eq!(tracker.moves_after_close.load(Ordering::Relaxed), 0);
        assert_drag_image_resources_zero(&tracker, "late hook move lifecycle");
    }

    #[test]
    fn shell_data_object_accepts_drag_image_stream_formats() {
        unsafe { OleInitialize(None) }.expect("test thread should initialize OLE STA");
        let _ole = OleTestGuard;
        let app_formats = vec![
            (CF_UNICODETEXT, vec![65, 0, 0, 0]),
            (CF_HDROP, vec![1, 2, 3, 4]),
            (CF_DIB, vec![5, 6, 7, 8]),
        ];
        let data_object = create_shell_drag_data_object(&app_formats)
            .expect("Shell data object should accept the app payload");
        let preview = build_drag_preview(&[item(None)]).expect("preview");
        assert!(
            unsafe { initialize_shell_drag_image(&data_object, &preview) },
            "Shell helper should accept the bitmap and data object"
        );

        // 初始化成功已证明 helper 的 TYMED_ISTREAM 私有 SetData 被 Shell 对象接受；再逐一回读
        // 应用的文本/文件/位图三类业务格式，防止只修预览却破坏原有投放。
        for (format_id, expected) in app_formats {
            let format = FORMATETC {
                cfFormat: format_id,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let mut medium = unsafe { data_object.GetData(&format) }
                .expect("app payload should remain readable after drag-image initialization");
            assert_eq!(medium.tymed, TYMED_HGLOBAL.0 as u32);
            unsafe {
                let handle = medium.u.hGlobal.0 as isize;
                let ptr = GlobalLock(handle);
                assert!(!ptr.is_null());
                assert_eq!(std::slice::from_raw_parts(ptr, expected.len()), expected);
                GlobalUnlock(handle);
                ReleaseStgMedium(&mut medium);
            }
        }
    }
}
