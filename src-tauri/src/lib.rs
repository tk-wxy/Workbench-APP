mod apps;
mod dragdrop; // 中转区原生拖入（自注册 IDropTarget）
mod dragout; // 中转区拖出（DoDragDrop：IDataObject + IDropSource，独立 STA 线程）
mod filesearch; // 文件系统搜索：后台预建内存索引（独立线程，零前端阻塞）
mod everything; // 可选 Everything 搜索引擎（libloading 动态加载 SDK DLL）
mod clipboard; // 剪贴板子系统（历史/粘贴/复制/janitor/监听）
mod pinyin_util; // 汉字→拼音派生（增强搜索的拼音匹配，续131）

use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// CREATE_NO_WINDOW：防止 cmd.exe 子进程在开发模式下弹出控制台窗口
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// 自定义热键——轮询用的 VK 列表（setup 按 store 落地，set_hotkey 运行时原子切换）。
/// start_hotkey_monitor 每拍读它判断 combo 是否按下；与其他锁无交集、无锁序问题。
static HOTKEY_VK_KEYS: std::sync::OnceLock<Mutex<Vec<u16>>> = std::sync::OnceLock::new();
/// 当前注册的 Shortcut（set_hotkey 切换时据此反注册旧组合）。Shortcut impl Copy+PartialEq。
static CURRENT_SHORTCUT: std::sync::OnceLock<Mutex<Shortcut>> = std::sync::OnceLock::new();

/// 托盘菜单项句柄（setup 时 manage 进 app state），供 set_tray_language 运行时切换文案用。
struct TrayMenuItems {
    toggle: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

#[tauri::command]
fn set_tray_language(lang: String, app: AppHandle) -> Result<(), String> {
    let items = app.state::<TrayMenuItems>();
    let en = lang == "en";
    items
        .toggle
        .set_text(if en { "Show Window" } else { "显示窗口" })
        .map_err(|e| e.to_string())?;
    items
        .quit
        .set_text(if en { "Quit" } else { "退出" })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 供 dragout「保持界面」模式在拖动中轮询当前热键键态用（用户拖动中按热键 → 手动隐藏 overlay 去外部应用）。
/// 返回同一份 HOTKEY_VK_KEYS 快照，判据与 start_hotkey_monitor 一致；未初始化则返回空（视为无热键、不触发）。
pub fn current_hotkey_vks() -> Vec<u16> {
    HOTKEY_VK_KEYS
        .get()
        .and_then(|m| m.lock().ok().map(|k| k.clone()))
        .unwrap_or_default()
}

// ── 可调参数 ───────────────────────────────────────────────
/// 热键键态轮询间隔（25ms ≈ 40Hz；松开沿延迟上界即此值。读电平故无需防抖）
const HOTKEY_POLL_MS: u64 = 25;
/// 短按/长按分界：held ≤ 此值=短按(toggle 语义)，> 此值=长按(momentary)。
/// 250ms 落在实测 tap≤153ms 与 hold≥583ms 的安全间隔内
const HOTKEY_TAP_MAX_MS: u128 = 250;
/// 前台窗口轮询间隔（50ms）：light dismiss——窗口可见时若前台切到别的应用则自动隐藏。
/// GetForegroundWindow 是 µs 级调用，50ms 轮询近乎零成本
const FOCUS_POLL_MS: u64 = 50;


// ── 动态全屏 ───────────────────────────────────────────────
fn make_fullscreen(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").unwrap();
    let monitor = window.current_monitor()?.unwrap();
    let scale = monitor.scale_factor();

    // 通过 Windows API 获取工作区（屏幕减去任务栏）
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::SystemParametersInfoW(
            windows::Win32::UI::WindowsAndMessaging::SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut _ as *mut core::ffi::c_void),
            windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    };

    let x = rect.left;
    let y = rect.top;
    let w = (rect.right - rect.left) as u32;
    let h = (rect.bottom - rect.top) as u32;

    println!("[fullscreen] work_area: ({x},{y}) {w}×{h}, scale={scale}");

    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))?;
    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))?;

    // 补偿 outer→inner 偏移：将窗口向负方向移动半个差值，使内容区对齐屏幕原点
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let offset_x = (outer.width as i32 - inner.width as i32) / 2;
    let offset_y = (outer.height as i32 - inner.height as i32) / 2;
    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: x - offset_x,
        y: y - offset_y,
    }))?;

    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let pos = window.outer_position()?;
    println!("[fullscreen] result: outer={0}x{1}, inner={2}x{3}, pos=({4},{5}), offset=({offset_x},{offset_y})",
        outer.width, outer.height, inner.width, inner.height, pos.x, pos.y);

    // 用 Tauri 官方 set_shadow(false) 去阴影（走正规 DWM 路径），
    // 替代会破坏透明边、逼出底部蓝缝的 DWMWA_NCRENDERING_POLICY=DISABLED。
    let _ = window.set_shadow(false);

    // set_shadow(false) 下 WebView 填满外框（含隐形边框），底边会越过任务栏顶。
    // 测量实际外框，越界则等量缩减高度，使内容底边贴齐任务栏顶（不遮挡、不留缝）。
    clamp_window_bottom(&window, rect.bottom);

    Ok(())
}

/// 把窗口底边夹到工作区底（任务栏顶）。content 现在填满外框，outer.bottom 越界即缩高。
fn clamp_window_bottom(window: &tauri::WebviewWindow, work_bottom: i32) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = match window.hwnd() { Ok(h) => HWND(h.0 as *mut _), Err(_) => return };
    let mut wr = RECT::default();
    unsafe { let _ = GetWindowRect(hwnd, &mut wr); }
    let overlap = wr.bottom - work_bottom;
    if overlap <= 0 { return; }
    if let Ok(inner) = window.inner_size() {
        let new_h = inner.height.saturating_sub(overlap as u32);
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: inner.width, height: new_h }));
        println!("[fullscreen] bottom overlap {overlap}px → 缩减高度 {}→{}", inner.height, new_h);
    }
}

// ── 托盘 ───────────────────────────────────────────────────
fn tray_toggle(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            let _ = app_handle.emit("hotkey-hide", ());
        } else {
            let _ = app_handle.emit("hotkey-show", ()); // 先让前端渲染深色 CSS
            let _ = window.show();
            let win = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if win.is_visible().unwrap_or(false) { let _ = win.set_focus(); }
            });
        }
    }
}

// ── 命令 ───────────────────────────────────────────────────

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = app.emit("hotkey-hide", ());
    }
}

// overlay hide + 80ms 等合成器刷新 + Win+Shift+S 触发 Snipping Tool 区域截图。
// 不做 SetForegroundWindow：Win+Shift+S 是系统全局快捷键，无需指定目标窗口。
// light dismiss 安全：hide() 使 is_visible()=false，start_focus_watch 下次轮询 armed→false，无重复 hide。
#[tauri::command]
fn trigger_screenshot(app: AppHandle) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = app.emit("hotkey-hide", ());
    }
    std::thread::sleep(std::time::Duration::from_millis(80));

    let mut enigo = enigo::Enigo::new(&enigo::Settings::default())
        .map_err(|e| format!("enigo 初始化失败: {}", e))?;
    let _ = enigo.key(enigo::Key::Meta, Press);
    std::thread::sleep(std::time::Duration::from_millis(10));
    let _ = enigo.key(enigo::Key::Shift, Press);
    std::thread::sleep(std::time::Duration::from_millis(10));
    let _ = enigo.key(enigo::Key::S, Press);
    let _ = enigo.key(enigo::Key::S, Release);
    std::thread::sleep(std::time::Duration::from_millis(10));
    let _ = enigo.key(enigo::Key::Shift, Release);
    let _ = enigo.key(enigo::Key::Meta, Release);

    Ok(())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("无法打开: {}", e))?;
    // 续132：文件/文件夹「使用学习」——open_file 是所有打开路径的唯一漏斗，
    // 在此记录即全覆盖（reveal_in_explorer 不记，那是定位非打开）。内存 bump 同步、落盘异步。
    filesearch::record_file_open(&path);
    Ok(())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    // 在资源管理器中定位并高亮该文件。走 Shell COM API `SHOpenFolderAndSelectItems`，
    // 不再 spawn `explorer.exe /select` 子进程——后者每次都新建一个 explorer.exe 进程再让它
    // 转去跟已运行的 shell 通信开窗，进程创建/启动开销即"稍慢"来源；COM API 在本进程内直接
    // 跟 shell 通信、可复用已开窗口，明显更快。历史坑仍适用：路径先归一化为反斜杠。
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    let win_path = path.replace('/', "\\");
    unsafe {
        // is_ok() 覆盖 S_OK（首次）与 S_FALSE（已初始化，仍加了引用计数需配平）→ 两者都要 Uninit；
        // 仅 RPC_E_CHANGED_MODE 等错误码 is_ok()=false（未加引用）→ 不 Uninit，但仍可继续调用。
        let did_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let pidl = ILCreateFromPathW(&HSTRING::from(win_path.as_str()));
        if pidl.is_null() {
            if did_init { CoUninitialize(); }
            return Err(format!("无法解析路径: {}", win_path));
        }
        // apidl=None（cidl=0）+ pidl 指向文件本身 = 打开其父目录并选中该文件（标准用法）。
        let res = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        if did_init { CoUninitialize(); }
        res.map_err(|e| format!("无法打开所在目录: {}", e))?;
    }
    Ok(())
}

// ── 文件夹选择对话框（续111）─────────────────────────────────
//
// 让路标志：与 dragout 的 DRAG_IN_PROGRESS / STAGE_REORDER_ACTIVE / CLIP_DRAG_ACTIVE 同类——
// 对话框一弹出就拿走前台，start_focus_watch 的判定（可见 + armed + 前台非自己非空 → hide）会在
// 50ms 内把 overlay 隐藏掉，对话框随即变成孤儿。故对话框存续期间 light-dismiss 必须让路。
//
// 与续88 的区别：热键此处**直接让路**（既不 toggle 也不 emit 升级）。续88 的纯 JS 重排阶段不能
// 让路是因为它没有别的退出方式、让路 = 用户被困住；对话框自带 Esc / 取消按钮，用户永远有出路，
// 而 toggle 一个正挂着模态子窗口的 owner 只会制造混乱。
static DIALOG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn dialog_active() -> bool {
    DIALOG_ACTIVE.load(Ordering::Relaxed)
}

/// RAII 守卫：保证**任何**退出路径（选中 / 取消 / COM 报错 / panic）都清掉让路标志。
/// 标志一旦悬置，light-dismiss 与热键永远让路、窗口再也无法自动隐藏——这正是 dragout 里
/// 「任何没走到 do_drag_on_main 的中止路径都必须清标志」那段注释的教训，用 Drop 从类型上根治。
struct DialogGuard;
impl Drop for DialogGuard {
    fn drop(&mut self) {
        DIALOG_ACTIVE.store(false, Ordering::Relaxed);
    }
}

/// 弹系统文件夹选择框，返回所选目录（用户取消 → Ok(None)，非错误）。
/// 供设置→搜索的「浏览…」用，取代手输路径（手输打错时 scan_dirs 的 p.exists() 会静默跳过，
/// 用户只会觉得"搜不到"而不知为何；选择器选出的目录必然存在）。
#[tauri::command]
fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    pick_path(app, true)
}

/// 弹系统**文件**选择框，返回所选文件（用户取消 → Ok(None)）。
/// 供启动台「浏览文件…」用——此前把任意文件收藏进启动台只能靠拖入（overlay 全屏覆盖时很别扭）
/// 或增强搜索命中（索引外的路径搜不到）。与 pick_folder 唯一差别是不加 FOS_PICKFOLDERS。
#[tauri::command]
fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    pick_path(app, false)
}

/// 文件 / 文件夹选择框的共用实现（`folders=true` 即加 FOS_PICKFOLDERS 变成文件夹选择器）。
/// 让路标志、owner、STA 三处约束对两者完全一致，故合并——别为了"文件版更简单"另写一份，
/// 漏掉其中任何一条都会复现续111 踩过的坑（见下方各段注释）。
fn pick_path(app: AppHandle, folders: bool) -> Result<Option<String>, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    // owner 必不可少：overlay 是 alwaysOnTop 的全屏窗口，无 owner 的对话框会被压在它**下面**——
    // 用户只看到界面卡住、根本没有对话框（比"界面消失"更糟）。owned window 永远显示在 owner 之上
    // （即使 owner 是 topmost），且模态期间 owner 自动禁用。
    // HWND 经 isize 中转：tauri 的 hwnd() 与本 crate 的 windows 版本可能不同，直接传会踩 trait 冲突
    // （同 start_focus_watch / dragout 的既有做法）。
    let owner_raw = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .ok_or_else(|| "主窗口 HWND 不可用".to_string())?;

    unsafe {
        // 本命令跑在 Tauri 命令线程（非主线程——dragout 需 run_on_main_thread 才拿得到主线程即为
        // 反证），故此处自行 STA 初始化；模态循环也因此不会卡住 tao 事件循环。
        // 绝不能学 dragout 切主线程跑：DoDragDrop 短暂尚可，文件夹对话框可能开着一分钟。
        // is_ok() 覆盖 S_OK / S_FALSE 两者都需配平 Uninit（同 reveal_in_explorer）。
        let did_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();

        DIALOG_ACTIVE.store(true, Ordering::Relaxed); // 必须先于 Show() 置位
        let guard = DialogGuard;

        let result = (|| -> Result<Option<String>, String> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("无法创建选择对话框: {e}"))?;
            let opts = dialog
                .GetOptions()
                .map_err(|e| format!("读对话框选项失败: {e}"))?;
            // FOS_PICKFOLDERS：把「文件」选择框变成「文件夹」选择框（Vista+ 标准做法）。
            // 不加即为默认的文件选择框。
            if folders {
                dialog
                    .SetOptions(opts | FOS_PICKFOLDERS)
                    .map_err(|e| format!("设置对话框选项失败: {e}"))?;
            }
            // Show 阻塞至用户确定/取消。取消返回 HRESULT_FROM_WIN32(ERROR_CANCELLED)——
            // 是正常流程不是错误，故映射为 Ok(None) 而非 Err（前端据此静默返回）。
            if dialog.Show(HWND(owner_raw as *mut _)).is_err() {
                return Ok(None);
            }
            let item = dialog
                .GetResult()
                .map_err(|e| format!("读取选择结果失败: {e}"))?;
            let pwstr = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|e| format!("读取路径失败: {e}"))?;
            let path = pwstr.to_string().map_err(|e| format!("路径解码失败: {e}"))?;
            CoTaskMemFree(Some(pwstr.0 as *const _)); // GetDisplayName 的 PWSTR 由调用方释放
            Ok(Some(path))
        })();

        drop(guard); // 先清让路标志，再 Uninit / 返回
        if did_init {
            CoUninitialize();
        }
        result
    }
}

// ── 入口 ───────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════
//  自定义热键（V2-1）—— 表驱动任意组合解析 + 运行时原子切换
//
//  两层编码：VK 供 GetAsyncKeyState 轮询（HOTKEY_VK_KEYS），Shortcut 供 RegisterHotKey
//  消费（CURRENT_SHORTCUT）。blocklist: win/super/meta（OS 吞）+ 裸 alt+space/alt+f4（OS 占用）。
//  修饰键 Ctrl/Shift/Alt 均可选（续46 起，含全无 = 纯主键；Alt 经 spike 实测可用，见 §9）；恰一个
//  主键（a-z/0-9/f1-f12/space/tab/方向键，共 54 条）。三键长短按语义由 start_hotkey_monitor 状态机天然支持。
// ════════════════════════════════════════════════════════════════════

/// 主键 token（全小写）→ (GetAsyncKeyState VK 码, RegisterHotKey Code)。
/// 支持 a-z / 0-9 / f1-f12 / space / tab / up/down/left/right（54 条）。
fn key_token(tok: &str) -> Option<(u16, Code)> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_0, VK_1, VK_2, VK_3, VK_4, VK_5, VK_6, VK_7, VK_8, VK_9,
        VK_A, VK_B, VK_C, VK_D, VK_E, VK_F, VK_G, VK_H, VK_I, VK_J,
        VK_K, VK_L, VK_M, VK_N, VK_O, VK_P, VK_Q, VK_R, VK_S, VK_T,
        VK_U, VK_V, VK_W, VK_X, VK_Y, VK_Z,
        VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6,
        VK_F7, VK_F8, VK_F9, VK_F10, VK_F11, VK_F12,
        VK_SPACE, VK_TAB, VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN,
    };
    Some(match tok {
        "a" => (VK_A.0, Code::KeyA),   "b" => (VK_B.0, Code::KeyB),
        "c" => (VK_C.0, Code::KeyC),   "d" => (VK_D.0, Code::KeyD),
        "e" => (VK_E.0, Code::KeyE),   "f" => (VK_F.0, Code::KeyF),
        "g" => (VK_G.0, Code::KeyG),   "h" => (VK_H.0, Code::KeyH),
        "i" => (VK_I.0, Code::KeyI),   "j" => (VK_J.0, Code::KeyJ),
        "k" => (VK_K.0, Code::KeyK),   "l" => (VK_L.0, Code::KeyL),
        "m" => (VK_M.0, Code::KeyM),   "n" => (VK_N.0, Code::KeyN),
        "o" => (VK_O.0, Code::KeyO),   "p" => (VK_P.0, Code::KeyP),
        "q" => (VK_Q.0, Code::KeyQ),   "r" => (VK_R.0, Code::KeyR),
        "s" => (VK_S.0, Code::KeyS),   "t" => (VK_T.0, Code::KeyT),
        "u" => (VK_U.0, Code::KeyU),   "v" => (VK_V.0, Code::KeyV),
        "w" => (VK_W.0, Code::KeyW),   "x" => (VK_X.0, Code::KeyX),
        "y" => (VK_Y.0, Code::KeyY),   "z" => (VK_Z.0, Code::KeyZ),
        "0" => (VK_0.0, Code::Digit0), "1" => (VK_1.0, Code::Digit1),
        "2" => (VK_2.0, Code::Digit2), "3" => (VK_3.0, Code::Digit3),
        "4" => (VK_4.0, Code::Digit4), "5" => (VK_5.0, Code::Digit5),
        "6" => (VK_6.0, Code::Digit6), "7" => (VK_7.0, Code::Digit7),
        "8" => (VK_8.0, Code::Digit8), "9" => (VK_9.0, Code::Digit9),
        "f1"    => (VK_F1.0,  Code::F1),  "f2"  => (VK_F2.0,  Code::F2),
        "f3"    => (VK_F3.0,  Code::F3),  "f4"  => (VK_F4.0,  Code::F4),
        "f5"    => (VK_F5.0,  Code::F5),  "f6"  => (VK_F6.0,  Code::F6),
        "f7"    => (VK_F7.0,  Code::F7),  "f8"  => (VK_F8.0,  Code::F8),
        "f9"    => (VK_F9.0,  Code::F9),  "f10" => (VK_F10.0, Code::F10),
        "f11"   => (VK_F11.0, Code::F11), "f12" => (VK_F12.0, Code::F12),
        "space" => (VK_SPACE.0, Code::Space),
        "tab"   => (VK_TAB.0,   Code::Tab),
        "up"    => (VK_UP.0,    Code::ArrowUp),
        "down"  => (VK_DOWN.0,  Code::ArrowDown),
        "left"  => (VK_LEFT.0,  Code::ArrowLeft),
        "right" => (VK_RIGHT.0, Code::ArrowRight),
        _ => return None,
    })
}

/// combo 串解析 → (轮询 VK 列表, RegisterHotKey Shortcut)。
/// 格式：全小写 '+' 分隔，修饰在前主键在后，如 "ctrl+space" / "ctrl+shift+f" / "f9"（纯主键）。修饰键可选。
fn parse_combo(combo: &str) -> Result<(Vec<u16>, Shortcut), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_SHIFT, VK_MENU};
    let lower = combo.to_lowercase();
    let tokens: Vec<&str> = lower.split('+').map(str::trim).collect();
    if tokens.iter().any(|t| matches!(*t, "win" | "super" | "meta" | "windows")) {
        return Err("不支持 Win 键".into());
    }
    // 修饰键 Ctrl/Shift/Alt 均可选（含全无 = 纯主键）；Win 仍 blocklist（OS 吞键）。
    // Alt 续46 spike 实测可用：RegisterHotKey 消费整个组合 → 前台应用收不到 Alt → 不触发菜单栏激活
    // （推翻 §9 旧「Alt 死路」结论，那来自早期 JS/rdev 录入态路线，与本架构无关）。
    let has_ctrl = tokens.iter().any(|t| matches!(*t, "ctrl" | "control"));
    let has_shift = tokens.contains(&"shift");
    let has_alt = tokens.iter().any(|t| matches!(*t, "alt" | "option"));
    let main_keys: Vec<&str> = tokens.iter()
        .copied()
        .filter(|t| !matches!(*t, "ctrl" | "control" | "shift" | "alt" | "option"))
        .collect();
    if main_keys.len() != 1 {
        return Err("需要且只能有一个主键".into());
    }
    let main_tok = main_keys[0];
    // OS 保留的裸 Alt 组合（Alt+Space=系统菜单 / Alt+F4=关窗 / Alt+Tab=窗口切换）——可注册但语义被 OS 占，禁用防脚枪。
    if has_alt && !has_ctrl && !has_shift && matches!(main_tok, "space" | "f4" | "tab") {
        return Err("Alt+Space / Alt+F4 / Alt+Tab 被系统占用".into());
    }
    let (main_vk, code) = key_token(main_tok)
        .ok_or_else(|| format!("不支持的键：{main_tok}"))?;
    let mut mods = Modifiers::empty();
    if has_ctrl { mods |= Modifiers::CONTROL; }
    if has_shift { mods |= Modifiers::SHIFT; }
    if has_alt { mods |= Modifiers::ALT; }
    let mut vk_list = Vec::new();
    if has_ctrl { vk_list.push(VK_CONTROL.0); }
    if has_shift { vk_list.push(VK_SHIFT.0); }
    if has_alt { vk_list.push(VK_MENU.0); } // VK_MENU = 通用 Alt，供 GetAsyncKeyState 轮询
    vk_list.push(main_vk); // 主键恒在；vk_list 永不为空（防 all() 恒真卡住）
    // Shortcut::new(Some(empty)) 与 None 等价（global_hotkey 内部 unwrap_or empty），无需分支
    Ok((vk_list, Shortcut::new(Some(mods), code)))
}

/// setup 阶段同步读 store JSON（平凡顶层 KV）取 hotkey-combo。任何失败 → None，调用方兜底默认。
/// 直接读文件而非经插件——setup 早于前端、需同步落地，避免启动空窗按错键。
fn read_combo_from_store(app: &AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("workbench-data.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("hotkey-combo")?.as_str().map(|s| s.to_string())
}

/// 运行时原子切换热键：先 register(new) 成功 → 再 unregister(old) → 再更新轮询 VK 与当前 Shortcut。
/// 任一步失败则保持旧组合工作（new 注册失败直接返 Err，旧组合从未动）。不写 store——持久化
/// 由前端负责（同 set_clip_cache_max 惯例）。
#[tauri::command]
fn set_hotkey(combo: String, app: AppHandle) -> Result<(), String> {
    let (new_vk, new_shortcut) = parse_combo(&combo)?;
    let old_shortcut = *CURRENT_SHORTCUT.get().unwrap().lock().unwrap();
    if old_shortcut == new_shortcut {
        return Ok(());
    }
    app.global_shortcut()
        .register(new_shortcut)
        .map_err(|_| "组合被占用或系统不可用".to_string())?;
    let _ = app.global_shortcut().unregister(old_shortcut); // 失败仅忽略，不中断（新已生效）
    *HOTKEY_VK_KEYS.get().unwrap().lock().unwrap() = new_vk;
    *CURRENT_SHORTCUT.get().unwrap().lock().unwrap() = new_shortcut;
    Ok(())
}

// ════════════════════════════════════════════════════════════════════
//  热键监听 — GetAsyncKeyState 物理键态轮询（驱动 show/hide 的唯一真相）
//
//  为什么是轮询而非热键事件：历史上 rdev / WH_KEYBOARD_LL / RegisterHotKey 时长判定均失败
//    （根因：按键经 hook/消息队列异步投递，被 WebView2 抢焦点破坏或有 500-800ms 抖动，
//    见 DECISIONS §1/§2）。GetAsyncKeyState 读"物理键电平"，不依赖焦点、不依赖消息队列，
//    实测松开沿零丢失、MSB 无抖动、时长精度 ±一个轮询周期——是唯一走通的机制。
//
//  混合语义（见 HOTKEY_TAP_MAX_MS）：
//    · 长按 held > 阈值  → momentary：按下开、松开关
//    · 短按 held ≤ 阈值  → toggle：按下沿开、松开不关；下一次短按才关
//
//  注：Ctrl+Space 另在 setup 里 RegisterHotKey 注册，但 handler 为空——仅借其"消费"按键、
//     不漏给前台应用（IME 切换 / 编辑器补全）；show/hide 完全由本轮询驱动。
//     show/hide 复刻 §8 路径配方（emit→show→延迟 set_focus / 纯 hide+emit）。
// ════════════════════════════════════════════════════════════════════
fn start_hotkey_monitor(app: AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState; // combo VK 列表改读 HOTKEY_VK_KEYS

    std::thread::spawn(move || {
        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => { eprintln!("[hotkey] no main window, abort"); return; }
        };
        // MSB(0x8000)=当前物理按下。读"电平"而非"事件"——这是与 RegisterHotKey 的本质区别
        let is_down = |vk: u16| -> bool {
            unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000u16) != 0 }
        };

        // ── 内嵌的 show / hide 配方（复刻现有路径，不调用/不改现有 handler）──
        // show：§8 三约束——emit 先于 show（防白闪）；set_focus 延迟 50ms（防 WM_ACTIVATE 重绘）
        let show = |app: &AppHandle, window: &tauri::WebviewWindow| {
            let _ = app.emit("hotkey-show", ());
            let _ = window.show();
            let win = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if win.is_visible().unwrap_or(false) { let _ = win.set_focus(); }
            });
        };
        // hide：纯 hide + emit 同步前端（hide 路径不含焦点交还/Ctrl+V，那是粘贴专用）
        let hide = |app: &AppHandle, window: &tauri::WebviewWindow| {
            let _ = window.hide();
            let _ = app.emit("hotkey-hide", ());
        };

        let mut prev_combo = false;                          // 上一拍 Ctrl+Space 是否同时按下
        let mut down_at: Option<std::time::Instant> = None;  // 当前这次按住的起点
        let mut visible_at_press = false;                    // 按下瞬间窗口是否已可见（区分 toggle 开/关）

        println!("[hotkey] keystate monitor started poll={HOTKEY_POLL_MS}ms tap_max={HOTKEY_TAP_MAX_MS}ms (combo from HOTKEY_VK_KEYS)");

        loop {
            // combo = 当前热键的所有 VK 同时按下。整个 25ms 循环里唯一加锁处，持锁仅 µs 级、
            // 立即 drop；与剪贴板/文件索引等其它子系统的锁无交集，无锁序问题。
            let combo = {
                let keys = HOTKEY_VK_KEYS.get().unwrap().lock().unwrap();
                keys.iter().all(|vk| is_down(*vk))
            };

            // 续88：区内重排期间按热键 = "取出并隐藏"（把当前拖动的条目转移到外部应用）。此处**既不能直接 hide、
            // 也不能像原生拖出那样单纯让路**：
            //   · 直接 hide → 会在 DoDragDrop 起手前隐藏窗口 → SetCapture 失败 → 拖拽根本不启动 → 松手无文件落地
            //     （续88 四轮反馈的确切症状）；
            //   · 单纯让路 → 热键在整个区内重排期间彻底失效（续88 三轮反馈②）。
            // 正确做法：**按下沿 emit "stage-drag-hotkey"**，由前端把纯 JS 区内重排升级为原生拖出——
            // start_drag_out(force_hide=true) 会在窗口仍可见时先起手 DoDragDrop、随后由 dragout 自身隐藏 overlay。
            // monitor 在整个重排期间只 emit、绝不 toggle（含松开沿也不 hide），窗口可见性交由后续原生拖出独占。
            // 升级完成后 STAGE_REORDER_ACTIVE 转为 DRAG_IN_PROGRESS（见 dragout::do_drag_on_main 的无缝交接），
            // 下一拍即落入下方 drag_in_progress 让路分支。
            if dragout::stage_reorder_active() {
                if combo && !prev_combo {
                    let _ = app.emit("stage-drag-hotkey", ());
                    println!("[hotkey] 区内重排 + 热键 → emit stage-drag-hotkey（升级为原生拖出并隐藏）");
                }
                prev_combo = combo;
                down_at = None;
                std::thread::sleep(std::time::Duration::from_millis(HOTKEY_POLL_MS));
                continue;
            }

            // 续110：剪贴板项纯 JS 拖动阶段 + 热键 = "隐藏界面并拖到外部"。与上方区内重排分支同构——
            // 既不能直接 hide（DoDragDrop 起手前隐藏 → SetCapture 失败 → 松手无落地），也不能单纯让路
            // （热键整段失效）。按下沿 emit "clip-drag-hotkey"，前端把纯 JS ghost 升级为原生拖出
            // （start_drag_out force_hide=true，窗口仍可见时先起手 DoDragDrop、再由 dragout 自身隐藏）。
            // 升级后 CLIP_DRAG_ACTIVE 转为 DRAG_IN_PROGRESS（do_drag_on_main 无缝交接），下一拍落入下方让路分支。
            if dragout::clip_drag_active() {
                if combo && !prev_combo {
                    let _ = app.emit("clip-drag-hotkey", ());
                    println!("[hotkey] 剪贴板拖动 + 热键 → emit clip-drag-hotkey（升级为原生拖出并隐藏）");
                }
                prev_combo = combo;
                down_at = None;
                std::thread::sleep(std::time::Duration::from_millis(HOTKEY_POLL_MS));
                continue;
            }

            // 原生拖出期间（DRAG_IN_PROGRESS）让路：窗口可见性由 dragout 独占（自动隐藏 / keepOpen 自轮询
            // 手动隐藏），此处只跟踪键态、不做 show/hide toggle，避免拖动中按热键去外部时 monitor 并发操作
            // 窗口→白闪。更新 prev_combo 保证拖动结束恢复时不产生虚假边沿；清空 down_at 防遗留按下态误判。
            if dragout::drag_in_progress() {
                prev_combo = combo;
                down_at = None;
                std::thread::sleep(std::time::Duration::from_millis(HOTKEY_POLL_MS));
                continue;
            }

            // 续111：文件夹选择框存续期间让路——toggle 一个正挂着模态子窗口的 owner 只会制造混乱
            // （隐藏 owner 会留下孤儿对话框）。此处**可以**单纯让路，与续88 的重排阶段不同：对话框
            // 自带 Esc / 取消出口，让路不会把用户困住，故无需 emit 升级那套。同样更新 prev_combo /
            // 清 down_at，防对话框关闭后产生虚假边沿。
            if dialog_active() {
                prev_combo = combo;
                down_at = None;
                std::thread::sleep(std::time::Duration::from_millis(HOTKEY_POLL_MS));
                continue;
            }

            if combo && !prev_combo {
                // ── 按下沿 ──
                down_at = Some(std::time::Instant::now());
                visible_at_press = window.is_visible().unwrap_or(false);
                if !visible_at_press {
                    // 关 → 开：长按和短按在按下沿都先开（长按要即时响应，短按打开后是否保持留到松开沿判）
                    show(&app, &window);
                }
            } else if !combo && prev_combo {
                // ── 松开沿：按住时长决定语义 ──
                let held = down_at.take().map(|d| d.elapsed().as_millis()).unwrap_or(0);
                if held > HOTKEY_TAP_MAX_MS {
                    // 长按 = momentary：松开即关（无论按下时开/关）
                    hide(&app, &window);
                } else if visible_at_press {
                    // 短按 且 按下时已开（上次短按打开的）→ 本次短按关闭（toggle close）
                    hide(&app, &window);
                } else {
                    // 短按 且 按下时是关的 → 已在按下沿开过，保持显示（toggle open），无需动作
                }
            }

            prev_combo = combo;
            std::thread::sleep(std::time::Duration::from_millis(HOTKEY_POLL_MS));
        }
    });
}

// ════════════════════════════════════════════════════════════════════
//  焦点监听 — light dismiss（点击外部应用时自动隐藏，免再按快捷键）
//
//  为什么轮询前台窗口而非 WindowEvent::Focused：与 start_hotkey_monitor 同理，本项目
//  对窗口/焦点信号一贯用物理轮询、不信事件——show 路径的 set_focus 是 50ms 延迟异步的，
//  focus 事件在这套 dance 里会抖动误触发；focus:false + WebView2 焦点怪癖见 DECISIONS §1。
//  GetForegroundWindow 是即时真值、µs 级、不经消息队列。
//
//  arm-after-focus 状态机（防呼出瞬间误关）：
//    · 窗口不可见            → disarm
//    · 前台 == 本窗口        → arm（确认真正拿到了焦点）
//    · 已 arm 且 前台 != 本窗口 → 用户切走了 → hide + emit + disarm
//  好处：show 的 set_focus 未落地前前台还是上一个应用，未 arm 故不会误关；若 set_focus
//  彻底失败则永不 arm、永不乱关（优雅降级，用户仍可 Esc/快捷键关）。
//  隐藏复用纯 hide()+emit("hotkey-hide") 路径，不碰焦点交还/粘贴流程。
// ════════════════════════════════════════════════════════════════════
fn start_focus_watch(app: AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    std::thread::spawn(move || {
        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => { eprintln!("[focus] no main window, abort"); return; }
        };
        // 本窗口 HWND 指针值。只与前台窗口比较整数，避免 windows-core 版本 trait 冲突
        let my_hwnd = match window.hwnd() {
            Ok(h) => h.0 as isize,
            Err(e) => { eprintln!("[focus] hwnd 不可用: {e:?}"); return; }
        };

        let mut armed = false;
        println!("[focus] light-dismiss watch started poll={FOCUS_POLL_MS}ms");

        loop {
            // 续88：区内重排阶段窗口全程可见、由拖动独占——light-dismiss 若在升级为原生拖出之前
            // 就因前台瞬时切走而自行 hide()，会打断整个手势（ghost/让路 transform 永久卡死，且
            // 因从未真正调用 start_drag_out，「拖到外部目标」这个操作本身也没发生）。让路但保持
            // armed 状态，重排结束后继续正常侦测（不清 armed，防止重排期间的假前台切换污染状态）。
            // 续111：文件夹选择框存续期间同样让路——它拿走前台，不让路则 50ms 内 overlay 被
            // 自动隐藏、对话框变孤儿。同样不清 armed（对话框关闭后继续正常侦测）。
            if dragout::drag_in_progress()
                || dragout::stage_reorder_active()
                || dragout::clip_drag_active()
                || dialog_active()
            {
                std::thread::sleep(std::time::Duration::from_millis(FOCUS_POLL_MS));
                continue;
            }
            if window.is_visible().unwrap_or(false) {
                let fg = unsafe { GetForegroundWindow() }.0 as isize;
                if fg == my_hwnd {
                    armed = true;
                } else if armed && fg != 0 {
                    // 前台切到另一个真实窗口（fg==0 是切换瞬间的空窗，不误关）→ light dismiss
                    let _ = window.hide();
                    let _ = app.emit("hotkey-hide", ());
                    armed = false;
                    println!("[focus] foreground lost → auto hide");
                }
            } else {
                armed = false;
            }
            std::thread::sleep(std::time::Duration::from_millis(FOCUS_POLL_MS));
        }
    });
}

// 应用扫描后台预建（同 filesearch 文件索引架构）：setup 阶段 spawn，短延迟后调用现有
// scan_start_menu（含 APP_CACHE 缓存 + COM init 在本线程自包含），扫完一次性 emit 给前端。
// 目的：把几百次 SHGetFileInfoW 提图标的耗时挪到呼出之前，消除「首次 visible 时同步扫描」的卡顿。
// 前端兜底：若 emit 错过/未到，window 首次 visible 时 apps 仍空则 invoke scan_start_menu（命中缓存、近乎瞬时）。
fn start_apps_worker(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1)); // 应用扫描比文件索引轻，1s 即可
        let started = std::time::Instant::now();
        // 续128 两段式：.lnk 那批先 emit 一次，UWP（约 2s）扫完再 emit 完整列表。
        // 前端的 apps-ready 监听本就是覆盖式 setApps，第二次直接顶掉第一次，无需改动前端。
        let partial_app = app.clone();
        let apps = apps::scan_start_menu_staged(|partial| {
            println!("[apps] stage 1 (.lnk): {} apps in {:?}", partial.len(), started.elapsed());
            let _ = partial_app.emit("apps-ready", partial.to_vec());
        });
        println!("[apps] background scan done: {} apps in {:?}", apps.len(), started.elapsed());
        let _ = app.emit("apps-ready", apps);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            apps::scan_start_menu, apps::refresh_apps,
            apps::launch_app, apps::get_file_info, apps::get_file_icons, apps::resolve_lnk, apps::get_stage_thumbnail, apps::check_stage_paths, apps::get_large_icon,
            apps::open_stage_thumb_dir, apps::clear_stage_thumb_cache,
            hide_window, open_file, reveal_in_explorer, trigger_screenshot, pick_folder, pick_file,
            clipboard::paste_clipboard,
            clipboard::set_clipboard_image, clipboard::get_clipboard_history, clipboard::set_clipboard_files,
            clipboard::delete_clipboard_item, clipboard::clear_clipboard_history,
            clipboard::copy_text_to_clipboard, clipboard::copy_image_to_clipboard, clipboard::copy_files_to_clipboard,
            clipboard::get_clip_cache_max, clipboard::set_clip_cache_max,
            clipboard::open_clip_image_dir, clipboard::clear_clip_image_cache,
            filesearch::search_files, filesearch::get_index_status,
            filesearch::set_search_engine, filesearch::set_search_dirs,
            pinyin_util::to_pinyin_batch,
            everything::reload_everything,
            dragout::start_drag_out,
            dragout::get_dragout_auto_close, dragout::set_dragout_auto_close, dragout::set_stage_reorder_active,
            dragout::set_clip_drag_active,
            set_hotkey, set_tray_language
        ])
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // handler 故意为空：注册 Ctrl+Space 仅为"消费"该键、不漏给前台应用；
                // 真正的 show/hide 由 start_hotkey_monitor 的物理键态轮询驱动（见该函数注释）
                .with_handler(|_app, _shortcut, _event| {})
                .build(),
        )
        .setup(|app| {
            // 自定义热键：同步读 store 落地（避免启动空窗按错键），失败/未知 combo 兜底默认 Ctrl+Space。
            // 注册仅用于"消费"该键（防漏给前台：IME 切换 / 编辑器补全）；实际 show/hide 由下面的
            // 物理键态轮询驱动（长按 momentary + 短按 toggle）。
            let combo_str = read_combo_from_store(app.handle()).unwrap_or_else(|| "ctrl+space".into());
            let (vk_keys, shortcut) =
                parse_combo(&combo_str).unwrap_or_else(|_| parse_combo("ctrl+space").unwrap());
            HOTKEY_VK_KEYS.set(Mutex::new(vk_keys)).ok();
            CURRENT_SHORTCUT.set(Mutex::new(shortcut)).ok();
            app.global_shortcut().register(shortcut)?;
            start_hotkey_monitor(app.handle().clone());
            start_focus_watch(app.handle().clone()); // light dismiss：点外部应用自动隐藏
            if let Err(e) = make_fullscreen(app) { eprintln!("全屏设置失败: {}", e); }
            // 剪贴板子系统初始化（路径→load→monitor→janitor 时序封装在 clipboard::init 内）
            let data_dir = app.path().app_data_dir().expect("app_data_dir unavailable");
            clipboard::init(app.handle(), &data_dir);
            filesearch::init_file_usage(&data_dir); // 文件使用学习：装载持久化的打开记录（续132）
            apps::init_thumb_cache(&data_dir); // 中转区图片缩略图落盘缓存（续99c：重启秒开）
            dragdrop::register_drag_drop(app); // 中转区原生拖入
            everything::init(app.handle()); // 可选 Everything：登记资源目录供加载 SDK DLL
            filesearch::start_index_worker(app.handle().clone()); // 文件系统索引：独立后台线程，零前端阻塞
            start_apps_worker(app.handle().clone()); // 应用扫描后台预建：消除首次呼出卡顿（emit apps-ready）

            let toggle_item = MenuItemBuilder::with_id("toggle", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&MenuBuilder::new(app).item(&toggle_item).separator().item(&quit_item).build()?)
                .tooltip("Workbench App")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "toggle" => tray_toggle(app),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            app.manage(TrayMenuItems { toggle: toggle_item, quit: quit_item });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Workbench App 时出错");
}
