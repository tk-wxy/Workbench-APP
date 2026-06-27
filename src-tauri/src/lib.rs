mod apps;
mod dragdrop; // 中转区原生拖入（自注册 IDropTarget）
mod filesearch; // 文件系统搜索：后台预建内存索引（独立线程，零前端阻塞）
mod everything; // 可选 Everything 搜索引擎（libloading 动态加载 SDK DLL）
mod clipboard; // 剪贴板子系统（历史/粘贴/复制/janitor/监听）

use std::os::windows::process::CommandExt;
use std::sync::Mutex;

// CREATE_NO_WINDOW：防止 cmd.exe 子进程在开发模式下弹出控制台窗口
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// 自定义热键——轮询用的 VK 列表（setup 按 store 落地，set_hotkey 运行时原子切换）。
/// start_hotkey_monitor 每拍读它判断 combo 是否按下；与其他锁无交集、无锁序问题。
static HOTKEY_VK_KEYS: std::sync::OnceLock<Mutex<Vec<u16>>> = std::sync::OnceLock::new();
/// 当前注册的 Shortcut（set_hotkey 切换时据此反注册旧组合）。Shortcut impl Copy+PartialEq。
static CURRENT_SHORTCUT: std::sync::OnceLock<Mutex<Shortcut>> = std::sync::OnceLock::new();

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
    Ok(())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    // explorer /select,"<path>" 在资源管理器中选中并高亮该文件
    let cmd = format!("explorer.exe /select,\"{}\"", path);
    std::process::Command::new("cmd")
        .args(["/c", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("无法打开所在目录: {}", e))?;
    Ok(())
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
        let apps = apps::scan_start_menu(); // 复用现有逻辑 + 缓存，后台线程执行
        println!("[apps] background scan: {} apps in {:?}", apps.len(), started.elapsed());
        let _ = app.emit("apps-ready", apps);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            apps::scan_start_menu, apps::refresh_apps,
            apps::launch_app, apps::get_file_info, apps::resolve_lnk,
            hide_window, open_file, reveal_in_explorer, trigger_screenshot,
            clipboard::paste_clipboard,
            clipboard::set_clipboard_image, clipboard::get_clipboard_history, clipboard::set_clipboard_files,
            clipboard::delete_clipboard_item, clipboard::clear_clipboard_history,
            clipboard::copy_text_to_clipboard, clipboard::copy_image_to_clipboard, clipboard::copy_files_to_clipboard,
            clipboard::get_clip_cache_max, clipboard::set_clip_cache_max,
            clipboard::open_clip_image_dir, clipboard::clear_clip_image_cache,
            filesearch::search_files, filesearch::get_index_status,
            filesearch::set_search_engine, filesearch::set_search_dirs,
            everything::reload_everything,
            set_hotkey
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Workbench App 时出错");
}
