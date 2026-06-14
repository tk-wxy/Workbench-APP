mod apps;

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// 50ms 防抖：过滤同一物理按键的重复 Pressed 事件
static LAST_PRESS_MS: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ── 动态全屏 ───────────────────────────────────────────────
fn make_fullscreen(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").unwrap();
    let monitor = window.current_monitor()?.unwrap();
    let size = monitor.size();
    let pos = monitor.position();
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: size.width, height: size.height }))?;
    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos.x, y: pos.y }))?;
    Ok(())
}

// ── 托盘 ───────────────────────────────────────────────────
fn tray_toggle(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            let _ = app_handle.emit("hotkey-hide", ());
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app_handle.emit("hotkey-show", ());
        }
    }
}

// ── 命令 ───────────────────────────────────────────────────

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        println!("[hotkey] hide_window called from frontend, is_visible={}", window.is_visible().unwrap_or(false));
        let _ = window.hide();
    }
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| format!("无法打开: {}", e))?;
    Ok(())
}

#[tauri::command]
fn read_clipboard() -> serde_json::Value {
    let start = std::time::Instant::now();
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return serde_json::json!({"type": "empty"}),
    };
    if let Ok(text) = clipboard.get_text() {
        println!("[clipboard] read text in {:?}", start.elapsed());
        if !text.is_empty() {
            return serde_json::json!({"type": "text", "content": text});
        }
    }
    if let Ok(img) = clipboard.get_image() {
        let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec());
        if let Some(rgba) = rgba {
            let mut png_buf = std::io::Cursor::new(Vec::new());
            if image::DynamicImage::ImageRgba8(rgba).write_to(&mut png_buf, image::ImageFormat::Png).is_ok() {
                let b64 = base64_encode(&png_buf.into_inner());
                return serde_json::json!({"type": "image", "content": format!("data:image/png;base64,{b64}")});
            }
        }
    }
    serde_json::json!({"type": "empty"})
}

#[tauri::command]
fn set_clipboard_image(base64: String) -> Result<(), String> {
    let b64_data = if let Some(comma) = base64.find(',') { &base64[comma + 1..] } else { &base64 };
    let bytes = base64_decode(b64_data).ok_or("base64 解码失败")?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析失败: {}", e))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板打开失败: {}", e))?;
    clipboard.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(rgba.into_raw()) })
        .map_err(|e| format!("剪贴板图片写入失败: {}", e))?;
    Ok(())
}

#[tauri::command]
fn paste_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板打开失败: {}", e))?;
    clipboard.set_text(text).map_err(|e| format!("剪贴板写入失败: {}", e))?;
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(120));
    use enigo::Direction::{Click, Press, Release};
    use enigo::Keyboard;
    let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
    let _ = enigo.key(enigo::Key::Control, Press);
    let _ = enigo.key(enigo::Key::Unicode('v'), Click);
    let _ = enigo.key(enigo::Key::Control, Release);
    Ok(())
}

// ── 入口 ───────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            apps::scan_start_menu, apps::refresh_apps,
            apps::launch_app, apps::get_file_info,
            hide_window, open_file, paste_clipboard,
            read_clipboard, set_clipboard_image
        ])
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut.mods != Modifiers::ALT || shortcut.key != Code::F1 { return; }
                    if event.state != ShortcutState::Pressed { return; }

                    let t = now_ms();
                    let last = LAST_PRESS_MS.swap(t, Ordering::SeqCst);
                    if t - last < 50 {
                        return; // 过滤同一次物理按键的重复事件
                    }
                    let window = app.get_webview_window("main").unwrap();
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                        println!("[hotkey] toggle → hide");
                        let _ = app.emit("hotkey-hide", ());
                    } else {
                        let _ = window.show();
                        println!("[hotkey] toggle → show");
                        let _ = app.emit("hotkey-show", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.global_shortcut().register(Shortcut::new(Some(Modifiers::ALT), Code::F1))?;
            println!("[hotkey] Alt+F1 registered (pure toggle)");
            if let Err(e) = make_fullscreen(app) { eprintln!("全屏设置失败: {}", e); }

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

// ── base64 ─────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    const C: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut r = String::with_capacity((data.len()+2)/3*4);
    for c in data.chunks(3) {
        let b0=c[0]; let b1=if c.len()>1{c[1]}else{0}; let b2=if c.len()>2{c[2]}else{0};
        let n=(b0 as u32)<<16|(b1 as u32)<<8|b2 as u32;
        r.push(C[((n>>18)&0x3F) as usize] as char); r.push(C[((n>>12)&0x3F) as usize] as char);
        if c.len()>1{r.push(C[((n>>6)&0x3F) as usize] as char)}else{r.push('=')}
        if c.len()>2{r.push(C[(n&0x3F) as usize] as char)}else{r.push('=')}
    }
    r
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut buf=Vec::with_capacity(s.len()*3/4); let mut a=0u32; let mut b=0u32;
    for c in s.chars() {
        let v=match c{'A'..='Z'=>c as u32-65,'a'..='z'=>c as u32-71,'0'..='9'=>c as u32+4,'+'=>62,'/'=>63,'='=>break,_=>continue};
        a=(a<<6)|v; b+=6; if b>=8{b-=8; buf.push((a>>b) as u8)}
    }
    Some(buf)
}
