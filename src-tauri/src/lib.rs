mod apps;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static LAST_PRESS_MS: AtomicI64 = AtomicI64::new(0);
/// 后台监听跳过的 seq 事件次数（set_image 可能触发多次 seq 变化）
static SKIP_CLIP_EVENTS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

// ── 可调参数 ───────────────────────────────────────────────
/// 剪贴板后台轮询间隔（150ms：快速连续复制时两次变化落在同一采样窗口会塌缩、丢中间项，
/// 故压低采样窗口。seq 检查是 µs 级，提频几乎零成本）
const CLIP_POLL_MS: u64 = 150;
/// 剪贴板被占用（快速复制时源程序短暂锁定）时，本轮内的重试次数
const CLIP_READ_RETRIES: u32 = 4;
/// 每次读取重试的间隔
const CLIP_READ_RETRY_MS: u64 = 60;
/// 剪贴板历史缓存上限
const CLIP_CACHE_MAX: usize = 20;
/// 图片缩略图最长边（超过则缩放，避免 IPC 传输数十 MB）
const MAX_THUMB_DIM: u32 = 1024;
/// 图片去重的 aHash 汉明距离阈值
const AHASH_MAX_HAMMING: u32 = 5;
/// 图片去重的尺寸近似阈值（px）
const AHASH_MAX_DIM_DELTA: i64 = 2;
/// 热键防抖窗口（过滤 Windows key repeat 的重复 Pressed）
const HOTKEY_DEBOUNCE_MS: i64 = 50;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ── 剪贴板后台缓存 ─────────────────────────────────────────

static CLIP_CACHE: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

/// 将 arboard 图片处理为缓存 entry：>MAX_THUMB_DIM 时缩放(Triangle) → PNG 编码 → aHash。失败返回 None
fn image_to_cache_entry(img: arboard::ImageData) -> Option<serde_json::Value> {
    let w = img.width as u32;
    let h = img.height as u32;
    let rgba = image::RgbaImage::from_raw(w, h, img.bytes.into_owned())?;
    let thumb = if w > MAX_THUMB_DIM || h > MAX_THUMB_DIM {
        let r = MAX_THUMB_DIM as f64 / w.max(h) as f64;
        image::DynamicImage::ImageRgba8(rgba)
            .resize_exact((w as f64 * r) as u32, (h as f64 * r) as u32, image::imageops::FilterType::Triangle)
    } else {
        image::DynamicImage::ImageRgba8(rgba)
    };
    let mut png = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let b64 = base64_encode(&png.into_inner());
    let ah = compute_ahash(&thumb);
    println!("[clipbg] image {w}×{h} cached");
    Some(serde_json::json!({"type":"image","content":format!("data:image/png;base64,{b64}"),"time":now_ms(),"w":w,"h":h,"ahash":ah}))
}

/// 读取当前剪贴板并构建缓存 entry。
/// - `Ok(Some)` 成功读到内容
/// - `Ok(None)` 剪贴板可访问但无可缓存内容（空 / 不支持的格式）→ 可推进 seq
/// - `Err(())`  剪贴板打不开/被占用（快速复制时源程序短暂锁定）→ 应重试，**勿推进 seq**
fn build_clip_entry() -> Result<Option<serde_json::Value>, ()> {
    // 检测顺序：图片优先（截图同时有 CF_HDROP+CF_BITMAP/DIB/DIBV5）
    if has_clipboard_image() {
        let mut cb = arboard::Clipboard::new().map_err(|_| ())?;
        let img = cb.get_image().map_err(|_| ())?;
        return Ok(image_to_cache_entry(img));
    }
    if let Some(paths) = read_clipboard_files() {
        if paths.is_empty() { return Ok(None); }
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
        return Ok(Some(serde_json::json!({"type":"file","items":items,"time":now_ms(),"count":count})));
    }
    let mut cb = arboard::Clipboard::new().map_err(|_| ())?;
    if let Ok(text) = cb.get_text() {
        if !text.is_empty() {
            println!("[clipbg] text: {}", text.chars().take(30).collect::<String>());
            return Ok(Some(serde_json::json!({"type":"text","content":text,"time":now_ms()})));
        }
        return Ok(None);
    }
    if let Ok(img) = cb.get_image() {
        return Ok(image_to_cache_entry(img));
    }
    Ok(None)
}

/// 后台线程：每 CLIP_POLL_MS 对比剪贴板序列号，变化时读取+缩放+存入缓存，并推送前端
fn start_clipboard_monitor(app_handle: AppHandle) {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(CLIP_POLL_MS));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq { continue; }

            // 跳过 set_clipboard_* 自身写回触发的 seq 变化
            let skip = SKIP_CLIP_EVENTS.load(Ordering::SeqCst);
            if skip > 0 {
                SKIP_CLIP_EVENTS.store(skip - 1, Ordering::SeqCst);
                last_seq = seq;
                continue;
            }
            println!("[clipbg] seq changed → reading");

            // 快速复制时源程序可能短暂占用剪贴板，读取瞬时失败。本轮内快速重试几次；
            // 仍失败则【不推进 last_seq】，留到下个轮询周期重试——避免"复制过快→读取失败
            // →seq 已消费→该条目永久不显示"。
            let mut built: Result<Option<serde_json::Value>, ()> = Err(());
            for attempt in 0..CLIP_READ_RETRIES {
                match build_clip_entry() {
                    Ok(opt) => { built = Ok(opt); break; }
                    Err(()) => {
                        if attempt + 1 < CLIP_READ_RETRIES {
                            std::thread::sleep(std::time::Duration::from_millis(CLIP_READ_RETRY_MS));
                        }
                    }
                }
            }
            let entry = match built {
                Ok(Some(e)) => e,
                Ok(None) => { last_seq = seq; continue; }       // 可访问但无内容：推进，避免重复尝试
                Err(()) => { println!("[clipbg] clipboard busy, retry next tick"); continue; } // 不推进 → 下轮重试
            };
            last_seq = seq; // 成功读到内容才推进

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
                    let dim_ok = (cw - ew).abs() <= AHASH_MAX_DIM_DELTA && (ch - eh).abs() <= AHASH_MAX_DIM_DELTA;
                    dim_ok && (ah ^ ca).count_ones() <= AHASH_MAX_HAMMING
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
            cache.truncate(CLIP_CACHE_MAX);
            let _ = app_handle.emit("clipboard-update", entry);
        }
    });
}

/// 前端调用：直接返回缓存数据（毫秒级）
#[tauri::command]
fn get_clipboard_history() -> Vec<serde_json::Value> {
    CLIP_CACHE.lock().unwrap().clone()
}

/// 前端调用：按 time 字段删除缓存中的指定条目
#[tauri::command]
fn delete_clipboard_item(time: i64) {
    CLIP_CACHE.lock().unwrap().retain(|e| e["time"].as_i64().unwrap_or(0) != time);
}

/// 前端调用：清空全部剪贴板历史缓存
#[tauri::command]
fn clear_clipboard_history() {
    CLIP_CACHE.lock().unwrap().clear();
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
    use windows::Win32::UI::Shell::{
        SHGetKnownFolderPath, FOLDERID_Desktop,
        FOF_RENAMEONCOLLISION, FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_NOERRORUI,
    };
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
    #[allow(non_snake_case)] // 镜像 Win32 SHFILEOPSTRUCTW 字段名
    struct SHFILEOPSTRUCTW_RAW {
        hwnd: isize, wFunc: u32, pFrom: *const u16, pTo: *const u16,
        fFlags: u16, fAnyOperationsAborted: i32, hNameMappings: isize,
        lpszProgressTitle: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" { fn SHFileOperationW(lpFileOp: *mut SHFILEOPSTRUCTW_RAW) -> i32; }

    // RENAMEONCOLLISION = 承重 flag：同名时自动生成 "X (2).ext"（对齐 Explorer 原生 Ctrl+V 行为）。
    // NOCONFIRMATION/NOCONFIRMMKDIR/NOERRORUI 抑制确认与错误弹窗，全静默落地。
    // FILEOP_FLAGS.0 是 u32，Win32 SHFILEOPSTRUCTW.fFlags 实为 WORD(u16)，强转（组合值 0x0618 在 u16 范围内）
    let flags = (FOF_RENAMEONCOLLISION | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI).0 as u16;
    let mut op = SHFILEOPSTRUCTW_RAW {
        hwnd: 0, wFunc: 2/*FO_COPY*/, pFrom: src_wide.as_ptr(), pTo: dest.as_ptr(),
        fFlags: flags,
        fAnyOperationsAborted: 0, hNameMappings: 0, lpszProgressTitle: std::ptr::null(),
    };

    println!("[desktop] copying {} file(s) to \"{desktop_path}\", fFlags={flags:#06x}", paths.len());
    unsafe {
        let ret = SHFileOperationW(&mut op);
        // NOERRORUI 静默错误，必须打日志便于诊断静默失败
        println!("[desktop] SHFileOperation ret={ret} aborted={}", op.fAnyOperationsAborted);
        if ret != 0 { return Err(format!("SHFileOperation: 错误码 {ret}")); }
        if op.fAnyOperationsAborted != 0 { println!("[desktop] 操作被中止 (aborted)"); }
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
fn set_clipboard_image(app: AppHandle, base64: String) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    // 先隐藏窗口，再判断目标（与 set_clipboard_files 逻辑对齐）
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));

    let class1 = get_window_class(unsafe { GetForegroundWindow() }.0 as isize);
    println!("[imgpaste] foreground class=\"{class1}\"");

    if class1 == "WorkerW" || class1 == "Progman" {
        // 桌面：PNG 写临时文件 → SHFileOperation 落地
        let png_bytes: Vec<u8> = if !base64.is_empty() {
            let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
            base64_decode(b64).ok_or("base64 解码失败")?
        } else {
            // 当前图：从 arboard 读取 RGBA 再编码为 PNG
            let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
            let img_data = cb.get_image().map_err(|e| format!("读图: {}", e))?;
            let rgba_img = image::RgbaImage::from_raw(
                img_data.width as u32, img_data.height as u32, img_data.bytes.into_owned(),
            ).ok_or("图片构造失败")?;
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(rgba_img)
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|e| format!("PNG编码: {}", e))?;
            png.into_inner()
        };
        let tmp = std::env::temp_dir().join(format!("workbench_{}.png", now_ms()));
        std::fs::write(&tmp, &png_bytes).map_err(|e| format!("写临时文件: {}", e))?;
        let tmp_str = tmp.to_string_lossy().into_owned();
        let result = desktop_copy_files(&[tmp_str]);
        let _ = std::fs::remove_file(&tmp);
        return result;
    }

    // 非桌面：历史图写回剪贴板，再 Ctrl+V
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
        println!("[imgpaste] thumbnail {w}×{h} written back");
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

// ════════════════════════════════════════════════════════════════════
//  EXPERIMENTAL SPIKE — GetAsyncKeyState 物理键态轮询验证（可整段删除回退）
//
//  目的：验证"按住 Ctrl+Space→显示，松开→隐藏"是否可行。历史上 rdev / WH_KEYBOARD_LL /
//    RegisterHotKey 时长判定均失败（根因：按键经 hook/消息队列异步投递，被焦点抢占破坏或
//    有 500-800ms 抖动，见 DECISIONS §1/§2）。本 spike 改用 GetAsyncKeyState 读"物理键电平"，
//    不依赖焦点、不依赖消息队列——这是文档里从未试过的机制。
//
//  激活：设环境变量 WORKBENCH_SPIKE=1 再启动；未设时本段完全不运行，现有逻辑零改动。
//    ⚠️ spike 模式下跳过生产热键注册（见 setup），避免 toggle 与 spike 抢同一 Ctrl+Space、
//       互相 hide/show 污染测量。现有 handler 闭包代码一字未改。
//
//  不接入现有交互：show/hide 在本函数内"复刻"现有 show 路径配方（emit→show→延迟 set_focus），
//    但不调用、不修改现有 handler/toggle/set_focus。
// ════════════════════════════════════════════════════════════════════
fn spike_keystate_monitor(app: AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SPACE};
    /// spike 轮询间隔（25ms ≈ 40Hz，边沿延迟上界即此值）
    const SPIKE_POLL_MS: u64 = 25;
    /// 短按/长按分界：held ≤ 此值算短按(toggle 语义)，> 此值算长按(momentary 语义)。
    /// 默认 250ms 落在实测 tap≤153ms 与 hold≥583ms 的安全间隔内
    const SPIKE_TAP_MAX_MS: u128 = 250;

    std::thread::spawn(move || {
        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => { eprintln!("[spike] no main window, abort"); return; }
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

        println!("[spike] started poll={SPIKE_POLL_MS}ms tap_max={SPIKE_TAP_MAX_MS}ms keys=Ctrl+Space");
        println!("[spike] 混合语义: 长按>阈值=按下开/松开关(momentary)；短按≤阈值=toggle(松开不关，下次短按才关)");

        loop {
            let combo = is_down(VK_CONTROL.0) && is_down(VK_SPACE.0);

            if combo && !prev_combo {
                // ── 按下沿 ──
                down_at = Some(std::time::Instant::now());
                visible_at_press = window.is_visible().unwrap_or(false);
                if !visible_at_press {
                    // 关 → 开：长按和短按在按下沿都先开（长按要响应，短按打开后是否保持留到松开沿判）
                    show(&app, &window);
                }
                println!("[spike] DOWN  visible_before={visible_at_press}");
            } else if !combo && prev_combo {
                // ── 松开沿：按住时长决定语义 ──
                let held = down_at.take().map(|d| d.elapsed().as_millis()).unwrap_or(0);
                if held > SPIKE_TAP_MAX_MS {
                    // 长按 = momentary：松开即关（无论按下时开/关）
                    hide(&app, &window);
                    println!("[spike] UP held={held}ms HOLD → hide(momentary)");
                } else if visible_at_press {
                    // 短按 且 按下时已开（上次短按打开的）→ 本次短按关闭（toggle close）
                    hide(&app, &window);
                    println!("[spike] UP held={held}ms TAP(was-open) → hide(toggle close)");
                } else {
                    // 短按 且 按下时是关的 → 已在按下沿开过，保持显示（toggle open）
                    println!("[spike] UP held={held}ms TAP(was-closed) → keep(toggle open)");
                }
            }

            prev_combo = combo;
            std::thread::sleep(std::time::Duration::from_millis(SPIKE_POLL_MS));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            apps::scan_start_menu, apps::refresh_apps,
            apps::launch_app, apps::get_file_info,
            hide_window, open_file, paste_clipboard,
            set_clipboard_image, get_clipboard_history, set_clipboard_files,
            delete_clipboard_item, clear_clipboard_history
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
                    if t - last < HOTKEY_DEBOUNCE_MS {
                        return; // 过滤同一次物理按键的重复事件
                    }
                    let window = app.get_webview_window("main").unwrap();
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                        println!("[hotkey] toggle → hide");
                        let _ = app.emit("hotkey-hide", ());
                    } else {
                        let _ = app.emit("hotkey-show", ()); // 先让前端渲染深色 CSS
                        let _ = window.show();
                        println!("[hotkey] toggle → show");
                        let win = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            if win.is_visible().unwrap_or(false) { let _ = win.set_focus(); }
                        });
                    }
                })
                .build(),
        )
        .setup(|app| {
            // EXPERIMENTAL（验证第 2 轮）：env 注入在本机 npm run tauri dev 链路不生效，
            // 故反转为"默认直接跑 spike"，无需任何环境变量。
            // 恢复生产 toggle：设 WORKBENCH_NOSPIKE=1，或直接回退本 spike commit。
            if std::env::var("WORKBENCH_NOSPIKE").is_ok() {
                app.global_shortcut().register(Shortcut::new(Some(Modifiers::CONTROL), Code::Space))?;
                println!("[hotkey] Ctrl+Space registered (pure toggle)");
            } else {
                println!("[spike] ⚡ 默认激活：跳过生产热键注册，仅运行 keystate spike（恢复 toggle 请设 WORKBENCH_NOSPIKE=1 或回退本 commit）");
                spike_keystate_monitor(app.handle().clone());
            }
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
