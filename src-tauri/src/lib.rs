mod apps;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// 50ms 防抖
static LAST_PRESS_MS: AtomicI64 = AtomicI64::new(0);
/// 后台监听跳过的 seq 事件次数（set_image 可能触发多次 seq 变化）
static SKIP_CLIP_EVENTS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ── 剪贴板后台缓存 ─────────────────────────────────────────

static CLIP_CACHE: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

/// 后台线程：每 800ms 对比剪贴板序列号，变化时读取+缩放+存入缓存，并推送前端
fn start_clipboard_monitor(app_handle: AppHandle) {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq { continue; }
            last_seq = seq;
            // 跳过 set_clipboard_image 自身触发的 seq 变化
            let skip = SKIP_CLIP_EVENTS.load(Ordering::SeqCst);
            if skip > 0 {
                SKIP_CLIP_EVENTS.store(skip - 1, Ordering::SeqCst);
                continue;
            }
            println!("[clipbg] seq changed → reading");

            // 检测顺序：图片优先（截图同时有 CF_HDROP+CF_BITMAP/DIB/DIBV5）
            let entry = if has_clipboard_image() {
                let mut cb = match arboard::Clipboard::new() {
                    Ok(c) => c, Err(_) => continue,
                };
                if let Ok(img) = cb.get_image() {
                    let w = img.width as u32; let h = img.height as u32;
                    let rgba = match image::RgbaImage::from_raw(w, h, img.bytes.to_vec()) {
                        Some(r) => r, None => continue,
                    };
                    let thumb = if w > 1024 || h > 1024 {
                        let r = 1024.0 / w.max(h) as f64;
                        image::DynamicImage::ImageRgba8(rgba)
                            .resize_exact((w as f64*r) as u32, (h as f64*r) as u32, image::imageops::FilterType::Triangle)
                    } else { image::DynamicImage::ImageRgba8(rgba) };
                    let mut png = std::io::Cursor::new(Vec::new());
                    if thumb.write_to(&mut png, image::ImageFormat::Png).is_ok() {
                        let b64 = base64_encode(&png.into_inner());
                        let ah = compute_ahash(&thumb);
                        println!("[clipbg] image {w}×{h} cached");
                        serde_json::json!({"type":"image","content":format!("data:image/png;base64,{b64}"),"time":now_ms(),"w":w,"h":h,"ahash":ah})
                    } else { continue }
                } else { continue }
            } else if let Some(paths) = read_clipboard_files() {
                if paths.is_empty() { continue; }
                let items: Vec<serde_json::Value> = paths.iter().map(|p| {
                    let name = std::path::Path::new(p).file_name()
                        .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let ext = std::path::Path::new(p).extension()
                        .map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                    let is_img = matches!(ext.as_str(), "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"ico");
                    serde_json::json!({"path":p,"name":name,"ext":ext,"isImage":is_img})
                }).collect();
                let count = items.len();
                println!("[clipbg] {} file(s) copied", count);
                serde_json::json!({"type":"file","items":items,"time":now_ms(),"count":count})
            } else {
                let mut cb = match arboard::Clipboard::new() {
                    Ok(c) => c, Err(_) => continue,
                };
                if let Ok(text) = cb.get_text() {
                    if !text.is_empty() {
                        println!("[clipbg] text: {}", text.chars().take(30).collect::<String>());
                        serde_json::json!({"type":"text","content":text,"time":now_ms()})
                    } else { continue }
                } else if let Ok(img) = cb.get_image() {
                    let w = img.width as u32; let h = img.height as u32;
                    let rgba = match image::RgbaImage::from_raw(w, h, img.bytes.to_vec()) {
                        Some(r) => r, None => continue,
                    };
                    let thumb = if w > 1024 || h > 1024 {
                        let r = 1024.0 / w.max(h) as f64;
                        image::DynamicImage::ImageRgba8(rgba)
                            .resize_exact((w as f64*r) as u32, (h as f64*r) as u32, image::imageops::FilterType::Triangle)
                    } else { image::DynamicImage::ImageRgba8(rgba) };
                    let mut png = std::io::Cursor::new(Vec::new());
                    if thumb.write_to(&mut png, image::ImageFormat::Png).is_ok() {
                        let b64 = base64_encode(&png.into_inner());
                        let ah = compute_ahash(&thumb);
                        println!("[clipbg] image {w}×{h} cached");
                        serde_json::json!({"type":"image","content":format!("data:image/png;base64,{b64}"),"time":now_ms(),"w":w,"h":h,"ahash":ah})
                    } else { continue }
                } else { continue }
            };

            let mut cache = CLIP_CACHE.lock().unwrap();

            // 图片去重：aHash 汉明距离(≤5) + 尺寸近似(±2px)
            if entry["type"] == "image" {
                let ew = entry["w"].as_u64().unwrap_or(0) as i64;
                let eh = entry["h"].as_u64().unwrap_or(0) as i64;
                let ah = entry["ahash"].as_u64().unwrap_or(0);
                let dup = cache.iter().any(|e| {
                    if e["type"] != "image" { return false; }
                    let cw = e["w"].as_u64().unwrap_or(0) as i64;
                    let ch = e["h"].as_u64().unwrap_or(0) as i64;
                    let ca = e["ahash"].as_u64().unwrap_or(0);
                    let dim_ok = (cw - ew).abs() <= 2 && (ch - eh).abs() <= 2;
                    dim_ok && (ah ^ ca).count_ones() <= 5
                });
                if dup {
                    println!("[clipbg] image skipped (dup)");
                    continue;
                }
            }

            // 去重只在同类型内：文本/图片按 content，文件类型不去重
            if entry["type"] == "text" || entry["type"] == "image" {
                cache.retain(|e| e["content"] != entry["content"]);
            }
            cache.insert(0, entry.clone());
            cache.truncate(20);
            let _ = app_handle.emit("clipboard-update", entry);
        }
    });
}

/// 前端调用：直接返回缓存数据（毫秒级）
#[tauri::command]
fn get_clipboard_history() -> Vec<serde_json::Value> {
    CLIP_CACHE.lock().unwrap().clone()
}

/// 获取窗口类名
fn get_window_class(hwnd: isize) -> String {
    unsafe {
        let mut buf = [0u16; 64];
        let len = windows::Win32::UI::WindowsAndMessaging::GetClassNameW(
            windows::Win32::Foundation::HWND(hwnd as *mut _), &mut buf);
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

/// aHash(8×8): 缩至 8×8 灰度(Nearest,已缩略图二次缩放) → 求均值 → 64bit 指纹
fn compute_ahash(img: &image::DynamicImage) -> u64 {
    use image::GenericImageView;
    let small = img.resize_exact(8, 8, image::imageops::FilterType::Nearest);
    let gray = small.grayscale();
    let pixels: Vec<u8> = gray.pixels().map(|(_, _, p)| p[0]).collect();
    let mean = pixels.iter().map(|&p| p as u64).sum::<u64>() / 64;
    let mut hash: u64 = 0;
    for (i, &p) in pixels.iter().enumerate() {
        if p as u64 > mean { hash |= 1 << i; }
    }
    hash
}

/// 剪贴板当前是否包含图片格式（CF_BITMAP / CF_DIB / CF_DIBV5）
fn has_clipboard_image() -> bool {
    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    unsafe {
        if OpenClipboard(0) == 0 { return false; }
        let has = IsClipboardFormatAvailable(CF_BITMAP) != 0
               || IsClipboardFormatAvailable(CF_DIB) != 0
               || IsClipboardFormatAvailable(CF_DIBV5) != 0;
        CloseClipboard();
        has
    }
}

// ── CF_HDROP FFI ────────────────────────────────────────────
#[link(name = "user32")]
extern "system" {
    fn OpenClipboard(hWnd: isize) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn GetClipboardData(uFormat: u32) -> isize;
    fn SetClipboardData(uFormat: u32, hMem: isize) -> isize;
    fn IsClipboardFormatAvailable(uFormat: u32) -> i32;
}
#[link(name = "shell32")]
extern "system" {
    fn DragQueryFileW(hDrop: isize, iFile: u32, lpszFile: *mut u16, cch: u32) -> u32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(uFlags: u32, dwBytes: usize) -> isize;
    fn GlobalLock(hMem: isize) -> *mut u8;
    fn GlobalUnlock(hMem: isize) -> i32;
}

const CF_HDROP: u32 = 15;
const GMEM_MOVEABLE: u32 = 2;

/// 从剪贴板读取 CF_HDROP 文件路径列表
fn read_clipboard_files() -> Option<Vec<String>> {
    unsafe {
        if OpenClipboard(0) == 0 { return None; }
        if IsClipboardFormatAvailable(CF_HDROP) == 0 { CloseClipboard(); return None; }
        let h = GetClipboardData(CF_HDROP);
        if h == 0 { CloseClipboard(); return None; }
        let ptr = GlobalLock(h);
        if ptr.is_null() { CloseClipboard(); return None; }

        let count = DragQueryFileW(h, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let mut buf = [0u16; 520];
            let len = DragQueryFileW(h, i, buf.as_mut_ptr(), buf.len() as u32);
            if len > 0 {
                paths.push(String::from_utf16_lossy(&buf[..len as usize]));
            }
        }
        GlobalUnlock(h);
        CloseClipboard();
        Some(paths)
    }
}

/// 将文件路径列表写回剪贴板（CF_HDROP 格式）或桌面落地 + 粘贴
#[tauri::command]
fn set_clipboard_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    println!("[filepaste] paths count={}", paths.len());
    for (i, p) in paths.iter().enumerate() {
        println!("[filepaste]   [{}] \"{}\"", i, p);
    }

    // Bug A 修复：场景判断提到写剪贴板之前，桌面直接落地不碰剪贴板
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));
    let class1 = get_window_class(unsafe { GetForegroundWindow() }.0 as isize);
    println!("[filepaste] after hide, foreground class=\"{class1}\"");

    if class1 == "WorkerW" || class1 == "Progman" {
        return desktop_copy_files(&paths);
    }

    // 非桌面：CF_HDROP 写回 + Ctrl+V
    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(&20u32.to_ne_bytes());
    raw.extend_from_slice(&0u32.to_ne_bytes());
    raw.extend_from_slice(&0u32.to_ne_bytes());
    raw.extend_from_slice(&0u32.to_ne_bytes());
    raw.extend_from_slice(&1u32.to_ne_bytes());
    for p in &paths {
        let wide: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
        for c in &wide { raw.extend_from_slice(&c.to_ne_bytes()); }
    }
    raw.push(0); raw.push(0);

    SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, raw.len());
        if h == 0 { return Err("GlobalAlloc 失败".into()); }
        let ptr = GlobalLock(h);
        std::ptr::copy_nonoverlapping(raw.as_ptr(), ptr, raw.len());
        GlobalUnlock(h);
        OpenClipboard(0);
        EmptyClipboard();
        SetClipboardData(CF_HDROP, h);
        CloseClipboard();
    }

    let target = unsafe { GetForegroundWindow() };
    unsafe { let _ = SetForegroundWindow(target); }
    let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
    let _ = enigo.key(enigo::Key::Control, Press);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::V, Press);
    let _ = enigo.key(enigo::Key::V, Release);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::Control, Release);
    Ok(())
}

/// 桌面场景：SHFileOperation 拷贝文件到桌面（CF_HDROP 不被 WorkerW 接受）
fn desktop_copy_files(paths: &[String]) -> Result<(), String> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop};
    use windows::Win32::System::Com::CoTaskMemFree;

    // 获取桌面路径
    let desktop_path = unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_Desktop, Default::default(), None)
            .map_err(|e| format!("SHGetKnownFolderPath: {e:?}"))?;
        let s = raw.to_string().map_err(|_| "桌面路径转换失败")?;
        let _ = CoTaskMemFree(Some(raw.0 as *mut _));
        s
    };
    let mut dest: Vec<u16> = desktop_path.encode_utf16().collect();
    dest.push(0); dest.push(0); // 双 \0 结尾

    // 源路径（\0 分隔，双 \0 结尾）
    let mut src = String::new();
    for p in paths { src.push_str(p); src.push('\0'); }
    src.push('\0');
    let src_wide: Vec<u16> = src.encode_utf16().collect();

    // raw FFI SHFileOperationW（windows crate 的 SHFILEOPSTRUCTW 类型不兼容）
    #[repr(C)]
    struct SHFILEOPSTRUCTW_RAW {
        hwnd: isize, wFunc: u32, pFrom: *const u16, pTo: *const u16,
        fFlags: u16, fAnyOperationsAborted: i32, hNameMappings: isize,
        lpszProgressTitle: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" { fn SHFileOperationW(lpFileOp: *mut SHFILEOPSTRUCTW_RAW) -> i32; }

    let mut op = SHFILEOPSTRUCTW_RAW {
        hwnd: 0, wFunc: 2/*FO_COPY*/, pFrom: src_wide.as_ptr(), pTo: dest.as_ptr(),
        fFlags: 0x40/*FOF_NOCONFIRMMKDIR*/|0x0040/*FOF_ALLOWUNDO*/,
        fAnyOperationsAborted: 0, hNameMappings: 0, lpszProgressTitle: std::ptr::null(),
    };

    println!("[desktop] copying {} file(s) to \"{desktop_path}\"", paths.len());
    unsafe {
        let ret = SHFileOperationW(&mut op);
        if ret != 0 { return Err(format!("SHFileOperation: 错误码 {ret}")); }
        if op.fAnyOperationsAborted != 0 { println!("[desktop] user cancelled"); }
    }
    println!("[desktop] copy done");
    Ok(())
}

// ── 动态全屏 ───────────────────────────────────────────────
fn make_fullscreen(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").unwrap();
    let scale = window.current_monitor()?.unwrap().scale_factor();

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
        let _ = window.hide();
        let _ = app.emit("hotkey-hide", ());
        println!("[hotkey] hide_window: is_visible={}", window.is_visible().unwrap_or(false));
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
        let w = img.width as u32;
        let h = img.height as u32;
        let rgba = image::RgbaImage::from_raw(w, h, img.bytes.to_vec());
        if let Some(rgba) = rgba {
            // 大图缩放：最长边 > 1024px 时缩至 1024px，Triangle 滤镜追求速度
            const MAX_DIM: u32 = 1024;
            let thumb = if w > MAX_DIM || h > MAX_DIM {
                let ratio = MAX_DIM as f64 / w.max(h) as f64;
                let tw = (w as f64 * ratio) as u32;
                let th = (h as f64 * ratio) as u32;
                println!("[clipboard] image {w}×{h} → thumbnail {tw}×{th} in {:?}", start.elapsed());
                image::DynamicImage::ImageRgba8(rgba).resize_exact(tw, th, image::imageops::FilterType::Triangle)
            } else {
                image::DynamicImage::ImageRgba8(rgba)
            };
            let mut png_buf = std::io::Cursor::new(Vec::new());
            if thumb.write_to(&mut png_buf, image::ImageFormat::Png).is_ok() {
                let b64 = base64_encode(&png_buf.into_inner());
                return serde_json::json!({"type": "image", "content": format!("data:image/png;base64,{b64}")});
            }
        }
    }
    serde_json::json!({"type": "empty"})
}

/// 仅读文本（跳过图片），供轮询使用，避免每次读图编码的开销
#[tauri::command]
fn read_clipboard_text() -> serde_json::Value {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return serde_json::json!({"type": "empty"}),
    };
    if let Ok(text) = clipboard.get_text() {
        if !text.is_empty() {
            return serde_json::json!({"type": "text", "content": text});
        }
    }
    serde_json::json!({"type": "empty"})
}

#[tauri::command]
fn set_clipboard_image(app: AppHandle, base64: String) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    // 历史图片：缩略图写回剪贴板（当前图已在剪贴板中，跳过）
    if !base64.is_empty() {
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
        let bytes = base64_decode(b64).ok_or("base64 解码失败")?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析: {}", e))?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
        cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(rgba.into_raw()) })
            .map_err(|e| format!("写入: {}", e))?;
        println!("[paste] thumbnail {w}×{h} written back");
    }

    println!("[paste] image → hide → Ctrl+V");
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));
    let target = unsafe { GetForegroundWindow() };
    unsafe { let _ = SetForegroundWindow(target); }

    let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
    let _ = enigo.key(enigo::Key::Control, Press);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::V, Press);
    let _ = enigo.key(enigo::Key::V, Release);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::Control, Release);
    Ok(())
}

#[tauri::command]
fn paste_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    let t0 = std::time::Instant::now();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板打开失败: {}", e))?;
    clipboard.set_text(&text).map_err(|e| format!("剪贴板写入失败: {}", e))?;

    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));

    unsafe {
        let hwnd = GetForegroundWindow();
        let _ = SetForegroundWindow(hwnd);
    }

    let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
    let _ = enigo.key(enigo::Key::Control, Press);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::V, Press);
    let _ = enigo.key(enigo::Key::V, Release);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _ = enigo.key(enigo::Key::Control, Release);
    println!("[paste] done at {:?}", t0.elapsed());
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
            read_clipboard, read_clipboard_text, set_clipboard_image, get_clipboard_history, set_clipboard_files
        ])
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut.mods != Modifiers::CONTROL || shortcut.key != Code::Space { return; }
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
                        let _ = window.set_focus();
                        println!("[hotkey] toggle → show");
                        let _ = app.emit("hotkey-show", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.global_shortcut().register(Shortcut::new(Some(Modifiers::CONTROL), Code::Space))?;
            println!("[hotkey] Ctrl+Space registered (pure toggle)");
            if let Err(e) = make_fullscreen(app) { eprintln!("全屏设置失败: {}", e); }
            start_clipboard_monitor(app.handle().clone());

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
