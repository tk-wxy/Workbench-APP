//! 中转区原生拖入（drag-in）：自注册 IDropTarget 接收外部文件拖放，把真实路径 emit 给前端。
//!
//! 机制（详见 DECISIONS §14）：Tauri `dragDropEnabled:false` 让 wry 不抢 OLE drop target 槽，
//! 我们在窗口树上自注册最小 IDropTarget。已验证 mid-drag「抓住文件→Ctrl+Space 呼出→悬停→松手」
//! 端到端通、拿到真实 CF_HDROP 路径，命中最深的 Chrome_RenderWidgetHostHWND。
//!
//! 耐久性：OLE **不**沿父链 walk-up（Step 0 微测：仅注册祖先 WRY_WEBVIEW 收不到）——drop 只投递给
//! 光标正下方最深窗口。故注册「顶层 + 全部子孙窗」（复刻已验证配置），**setup 时一次性注册**。
//! ⚠️ 不做「每次 show 重注册」：实测它（经 run_on_main_thread 的 Revoke/Register）虽报成功，产出的
//! target 却收不到回调、破坏正常拖入。本应用 webview 跨 hide/show 不销毁、无导航、release 无 devtools，
//! render host 整会话稳定，一次注册足够。代价：渲染进程崩溃重建（极罕见）后拖入失效到重启，可接受。

use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::{implement, Result};
use windows::Win32::Foundation::{HWND, POINTL, LPARAM, BOOL, TRUE, S_OK};
use windows::Win32::System::Com::{IDataObject, FORMATETC, STGMEDIUM, TYMED_HGLOBAL, DVASPECT_CONTENT};
use windows::Win32::System::Ole::{
    OleInitialize, RegisterDragDrop, RevokeDragDrop, ReleaseStgMedium,
    IDropTarget, IDropTarget_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW};
use tauri::{AppHandle, Emitter, Manager};

const CF_HDROP_FMT: u16 = 15;

#[derive(serde::Serialize, Clone)]
struct FilesDroppedPayload {
    paths: Vec<String>,
    x: i32,
    y: i32,
}

// 裸 extern：避开 windows-crate 版本签名猜测，直接用 HDROP 的 isize 句柄
#[link(name = "shell32")]
extern "system" {
    fn DragQueryFileW(h_drop: isize, i_file: u32, lpsz_file: *mut u16, cch: u32) -> u32;
}

// ── IDropTarget：DragEnter/Over 按是否含 CF_HDROP 决定光标，Drop 取路径 emit 给前端 ──
#[implement(IDropTarget)]
struct FileDropTarget {
    app: AppHandle,
    accept: AtomicBool, // DragEnter 判定结果，供无 IDataObject 的 DragOver 复用以保持正确光标
}

impl IDropTarget_Impl for FileDropTarget_Impl {
    fn DragEnter(&self, p_data_obj: Option<&IDataObject>, _grf: MODIFIERKEYS_FLAGS, _pt: &POINTL, pdweffect: *mut DROPEFFECT) -> Result<()> {
        let has = has_cf_hdrop(p_data_obj);
        self.accept.store(has, Ordering::Relaxed);
        set_effect(pdweffect, has);
        Ok(())
    }
    fn DragOver(&self, _grf: MODIFIERKEYS_FLAGS, _pt: &POINTL, pdweffect: *mut DROPEFFECT) -> Result<()> {
        set_effect(pdweffect, self.accept.load(Ordering::Relaxed));
        Ok(())
    }
    fn DragLeave(&self) -> Result<()> {
        self.accept.store(false, Ordering::Relaxed);
        Ok(())
    }
    fn Drop(&self, p_data_obj: Option<&IDataObject>, _grf: MODIFIERKEYS_FLAGS, pt: &POINTL, pdweffect: *mut DROPEFFECT) -> Result<()> {
        // handler 极简：取路径 + emit + 返回。不碰剪贴板 / 不 hide / 不阻塞。
        // pt 是屏幕物理像素坐标（Windows POINTL），前端需 ÷ devicePixelRatio 换算 CSS px。
        let paths = p_data_obj.map(extract_paths).unwrap_or_default();
        println!("[dragdrop] Drop {} path(s) at ({}, {})", paths.len(), pt.x, pt.y);
        let accept = !paths.is_empty();
        if accept { let _ = self.app.emit("files-dropped", FilesDroppedPayload { paths, x: pt.x, y: pt.y }); }
        self.accept.store(false, Ordering::Relaxed);
        set_effect(pdweffect, accept);
        Ok(())
    }
}

/// 设置 pdwEffect 出参（光标反馈）：可接收→COPY，否则→NONE
fn set_effect(pdweffect: *mut DROPEFFECT, accept: bool) {
    unsafe { if !pdweffect.is_null() { *pdweffect = if accept { DROPEFFECT_COPY } else { DROPEFFECT_NONE }; } }
}

fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP_FMT,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn has_cf_hdrop(obj: Option<&IDataObject>) -> bool {
    let Some(obj) = obj else { return false; };
    unsafe { obj.QueryGetData(&hdrop_format()) == S_OK }
}

fn extract_paths(obj: &IDataObject) -> Vec<String> {
    unsafe {
        match obj.GetData(&hdrop_format()) {
            Ok(medium) => {
                let paths = paths_from_stgmedium(&medium);
                ReleaseStgMedium(&medium as *const _ as *mut STGMEDIUM);
                paths
            }
            Err(_) => vec![],
        }
    }
}

unsafe fn paths_from_stgmedium(medium: &STGMEDIUM) -> Vec<String> {
    let h_drop = medium.u.hGlobal.0 as isize; // HDROP == 该 HGLOBAL 句柄
    let count = DragQueryFileW(h_drop, u32::MAX, std::ptr::null_mut(), 0);
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let mut buf = [0u16; 520];
        let n = DragQueryFileW(h_drop, i, buf.as_mut_ptr(), buf.len() as u32);
        if n > 0 { out.push(String::from_utf16_lossy(&buf[..n as usize])); }
    }
    out
}

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len as usize])
}

unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let vec = &mut *(lparam.0 as *mut Vec<HWND>);
    vec.push(hwnd);
    TRUE
}

/// 在「顶层 + 全部子孙窗」上幂等注册（先 Revoke 再 Register）。必须在已 OleInitialize 的主线程调用。
fn do_register(app: &AppHandle) {
    let window = match app.get_webview_window("main") { Some(w) => w, None => return };
    let top: HWND = match window.hwnd() { Ok(h) => HWND(h.0 as *mut _), Err(_) => return };

    let mut targets: Vec<HWND> = vec![top];
    unsafe { let _ = EnumChildWindows(top, Some(enum_child), LPARAM(&mut targets as *mut _ as isize)); }

    // 单个共享 target 注册到所有 HWND（各 AddRef）；本地 ref 在函数末尾 drop，OLE 持有至下次 Revoke。
    let target: IDropTarget = FileDropTarget { app: app.clone(), accept: AtomicBool::new(false) }.into();
    let mut ok = 0;
    for h in &targets {
        unsafe {
            let _ = RevokeDragDrop(*h); // 清旧注册（未注册会报错，忽略）→ 幂等
            if RegisterDragDrop(*h, &target).is_ok() { ok += 1; }
        }
    }
    println!("[dragdrop] registered on {ok}/{} window(s) (top class=[{}])", targets.len(), class_of(top));
}

/// setup 阶段调用（主线程）：OleInitialize（RegisterDragDrop 要求之，仅 CoInitializeEx 会
/// CO_E_NOTINITIALIZED）+ 一次性注册。必须在主线程 = 窗口属主线程，回调才会被投递。
pub fn register_drag_drop(app: &tauri::App) {
    unsafe {
        let hr = OleInitialize(None);
        println!("[dragdrop] OleInitialize -> {hr:?}");
    }
    do_register(app.handle());
}
