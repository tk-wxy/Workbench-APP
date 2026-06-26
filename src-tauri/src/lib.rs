mod apps;
mod dragdrop; // 中转区原生拖入（自注册 IDropTarget）
mod everything; // Everything 搜索引擎集成（可选，动态加载 DLL）
mod filesearch; // 文件系统搜索：后台预建内存索引（独立线程，零前端阻塞）

use std::os::windows::process::CommandExt;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// CREATE_NO_WINDOW：防止 cmd.exe 子进程在开发模式下弹出控制台窗口
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::{AppHandle, Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// 后台监听跳过的 seq 事件次数（set_image 可能触发多次 seq 变化）
static SKIP_CLIP_EVENTS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
/// 后台监听跳过的 seq 水位：copy_* 命令「只复制不粘贴」写回剪贴板后记下当前 seq，监听跳过
/// seq ≤ 此值的变化，使自写内容不回流到历史面板（防循环）。按 seq 水位而非计数——与跳变次数/
/// 轮询时序无关，连续复制不残留、不吞掉后续真实复制（区别于计数式 SKIP_CLIP_EVENTS）。
static SKIP_CLIP_UNTIL_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 串行化剪贴板访问：后台监听的「读」与 copy_* 的「写」共用此锁，避免两线程并发 OpenClipboard
/// 互抢导致 SetClipboardData 报 os error 1418（线程没有打开的剪贴板）。paste 路径靠写前武装
/// SKIP_CLIP_EVENTS 让监听跳过、不读，故不入此锁、行为不变。
static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());
/// 剪贴板历史落盘路径（setup 阶段写入一次，之后只读）。未初始化时 load/save 静默 no-op。
static CLIP_HISTORY_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
/// 原图落盘目录（setup 阶段初始化）。未初始化时 save_clip_image_to_disk 静默跳过。
static CLIP_IMAGE_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
/// 自定义热键——轮询用的 VK 列表（setup 按 store 落地，set_hotkey 运行时原子切换）。
/// start_hotkey_monitor 每拍读它判断 combo 是否按下；与其他锁无交集、无锁序问题。
static HOTKEY_VK_KEYS: std::sync::OnceLock<Mutex<Vec<u16>>> = std::sync::OnceLock::new();
/// 当前注册的 Shortcut（set_hotkey 切换时据此反注册旧组合）。Shortcut impl Copy+PartialEq。
static CURRENT_SHORTCUT: std::sync::OnceLock<Mutex<Shortcut>> = std::sync::OnceLock::new();

// ── 可调参数 ───────────────────────────────────────────────
/// 剪贴板后台轮询间隔（150ms：快速连续复制时两次变化落在同一采样窗口会塌缩、丢中间项，
/// 故压低采样窗口。seq 检查是 µs 级，提频几乎零成本）
const CLIP_POLL_MS: u64 = 150;
/// 剪贴板被占用（快速复制时源程序短暂锁定）时，本轮内的重试次数
const CLIP_READ_RETRIES: u32 = 4;
/// 每次读取重试的间隔
const CLIP_READ_RETRY_MS: u64 = 60;
/// 剪贴板历史缓存默认上限（设置面板可调，范围 10-100）
const CLIP_CACHE_MAX_DEFAULT: usize = 20;
/// 运行时上限：前端启动后通过 set_clip_cache_max 命令同步持久化值；改动立即生效
static CLIP_CACHE_MAX_RUNTIME: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(CLIP_CACHE_MAX_DEFAULT);
/// 图片缩略图最长边（超过则缩放，避免 IPC 传输数十 MB）
const MAX_THUMB_DIM: u32 = 1024;
/// 原图落盘上限（最长边超过此值时等比缩放后再存）；开发机截图 ≤ 3200px 不触发
const MAX_ORIG_DIM: u32 = 4096;
/// 原图缓存（clip_images/）总量上限（500MB）：解耦 janitor 超过时从最旧删到上限以下，防长期膨胀
const CLIP_IMAGE_CACHE_MAX_BYTES: u64 = 500 * 1024 * 1024;
/// 原图缓存 janitor 周期清理间隔（10 分钟）
const CLIP_IMAGE_SWEEP_MS: u64 = 10 * 60 * 1000;
/// 原图缓存 janitor 起手延迟（5s）：错开 setup 同步 load_clip_history，防空 referenced 集误删全部
const CLIP_IMAGE_SWEEP_INITIAL_MS: u64 = 5000;
/// 图片去重的 aHash 汉明距离阈值
const AHASH_MAX_HAMMING: u32 = 5;
/// 图片去重的尺寸近似阈值（px）
const AHASH_MAX_DIM_DELTA: i64 = 2;
/// 热键键态轮询间隔（25ms ≈ 40Hz；松开沿延迟上界即此值。读电平故无需防抖）
const HOTKEY_POLL_MS: u64 = 25;
/// 短按/长按分界：held ≤ 此值=短按(toggle 语义)，> 此值=长按(momentary)。
/// 250ms 落在实测 tap≤153ms 与 hold≥583ms 的安全间隔内
const HOTKEY_TAP_MAX_MS: u128 = 250;
/// 前台窗口轮询间隔（50ms）：light dismiss——窗口可见时若前台切到别的应用则自动隐藏。
/// GetForegroundWindow 是 µs 级调用，50ms 轮询近乎零成本
const FOCUS_POLL_MS: u64 = 50;

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

/// 后台线程：每 CLIP_POLL_MS 对比剪贴板序列号，变化时读取+缩放+存入缓存，并推送前端。
/// 图片分支：仅 get_image 在 CLIPBOARD_LOCK 内（最小临界区），thumb/ahash/编码在锁外；
///   大图（> MAX_THUMB_DIM）判新后 detached spawn 写原图，不阻塞监听循环（防加宽采样塌缩窗口）。
/// 文件/文本分支：沿用原有逻辑，仍在锁内重试。
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
            // 跳过 copy_*「只复制不粘贴」的自写：seq ≤ 水位即自写或更早 → 不入历史面板（防循环）
            if seq <= SKIP_CLIP_UNTIL_SEQ.load(Ordering::SeqCst) {
                last_seq = seq;
                continue;
            }
            // 读剪贴板与 copy_* 的写入串行（CLIPBOARD_LOCK），防并发 OpenClipboard 撞 os error 1418
            let clip_guard = CLIPBOARD_LOCK.lock().unwrap();
            // 拿锁后重读 seq + 复核水位
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq <= SKIP_CLIP_UNTIL_SEQ.load(Ordering::SeqCst) { last_seq = seq; continue; }
            println!("[clipbg] seq changed → reading");

            // ── 图片分支：仅 get_image 在锁内，thumb/ahash/编码在锁外 ──────────────
            if has_clipboard_image() {
                // 锁内重试读取（源程序可能短暂占用剪贴板）
                let mut img_opt: Option<(image::DynamicImage, u32, u32)> = None;
                for attempt in 0..CLIP_READ_RETRIES {
                    let r = (|| -> Result<(image::DynamicImage, u32, u32), ()> {
                        let mut cb = arboard::Clipboard::new().map_err(|_| ())?;
                        let img_data = cb.get_image().map_err(|_| ())?;
                        let w = img_data.width as u32;
                        let h = img_data.height as u32;
                        let rgba = image::RgbaImage::from_raw(w, h, img_data.bytes.into_owned())
                            .ok_or(())?;
                        Ok((image::DynamicImage::ImageRgba8(rgba), w, h))
                    })();
                    match r {
                        Ok(v) => { img_opt = Some(v); break; }
                        Err(()) => {
                            if attempt + 1 < CLIP_READ_RETRIES {
                                std::thread::sleep(std::time::Duration::from_millis(CLIP_READ_RETRY_MS));
                            }
                        }
                    }
                }
                drop(clip_guard); // 读完立即释放；后续 thumb/ahash/编码 CPU 密集但不碰剪贴板句柄

                let (full_img, w, h) = match img_opt {
                    Some(v) => v,
                    None => { println!("[clipbg] clipboard busy, retry next tick"); continue; }
                };
                last_seq = seq; // 成功读到才推进

                // thumb + ahash 计算（锁外）
                // resize_exact 取 &self，不消耗 full_img → 大图保留 full_img 供后续落盘
                let is_large = w > MAX_THUMB_DIM || h > MAX_THUMB_DIM;
                let (thumb, large_img_opt) = if is_large {
                    let r = MAX_THUMB_DIM as f64 / w.max(h) as f64;
                    let t = full_img.resize_exact(
                        (w as f64 * r) as u32, (h as f64 * r) as u32,
                        image::imageops::FilterType::Triangle,
                    );
                    (t, Some(full_img)) // 保留原图，供 dedup 确认「判新」后写盘
                } else {
                    (full_img, None) // 小图：thumb == orig，content 本身即无损原图，不另落盘
                };

                let mut png = std::io::Cursor::new(Vec::new());
                if thumb.write_to(&mut png, image::ImageFormat::Png).is_err() { continue; }
                let b64 = base64_encode(&png.into_inner());
                let ah = compute_ahash(&thumb);
                let time = now_ms();

                // 预置 orig_path 路径字符串（仅大图；零 I/O，dedup 判新后才真正写文件）
                let orig_path: Option<String> = if is_large {
                    CLIP_IMAGE_DIR.get()
                        .map(|d| d.join(format!("{time}.png")).to_string_lossy().into_owned())
                } else {
                    None
                };

                let mut entry = serde_json::json!({
                    "type": "image",
                    "content": format!("data:image/png;base64,{b64}"),
                    "time": time, "w": w, "h": h, "ahash": ah
                });
                if let Some(ref p) = orig_path {
                    entry["orig_path"] = serde_json::json!(p);
                }
                println!("[clipbg] image {w}×{h} cached, large={is_large}");

                // CLIP_CACHE 锁：aHash 去重 + 插入（dedup 结果决定是否写原图文件）
                let (is_new, snap) = {
                    let mut cache = CLIP_CACHE.lock().unwrap();
                    let ew = w as i64; let eh = h as i64;
                    let dup = cache.iter().any(|e| {
                        if e["type"] != "image" { return false; }
                        let cw = e["w"].as_u64().unwrap_or(0) as i64;
                        let ch = e["h"].as_u64().unwrap_or(0) as i64;
                        let ca = e["ahash"].as_u64().unwrap_or(0);
                        (cw - ew).abs() <= AHASH_MAX_DIM_DELTA
                            && (ch - eh).abs() <= AHASH_MAX_DIM_DELTA
                            && (ah ^ ca).count_ones() <= AHASH_MAX_HAMMING
                    });
                    if dup {
                        println!("[clipbg] image skipped (dup)");
                        (false, vec![])
                    } else {
                        cache.retain(|e| e["content"] != entry["content"]);
                        cache.insert(0, entry.clone());
                        cache.truncate(CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed));
                        (true, cache.clone())
                    }
                }; // CLIP_CACHE 锁释放

                if !is_new {
                    // 被 aHash 判重：large_img_opt drop → 零孤儿文件
                    continue;
                }

                // 全部锁已释放：大图 detached 写盘（不阻塞本循环，防加宽采样塌缩窗口）
                if let Some(orig_img) = large_img_opt {
                    let t = time;
                    std::thread::spawn(move || save_clip_image_to_disk(orig_img, w, h, t));
                }
                let _ = app_handle.emit("clipboard-update", entry);
                save_clip_history(snap);

            } else {
                // ── 文件 / 文本分支：沿用原有逻辑（锁内重试 + 判空）─────────────────
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
                    Ok(None) => { last_seq = seq; drop(clip_guard); continue; }
                    Err(()) => { println!("[clipbg] clipboard busy, retry next tick"); continue; }
                };
                last_seq = seq;
                drop(clip_guard);

                let mut cache = CLIP_CACHE.lock().unwrap();
                // 去重只在同类型内：文本按 content；文件不去重
                if entry["type"] == "text" {
                    cache.retain(|e| e["content"] != entry["content"]);
                }
                cache.insert(0, entry.clone());
                cache.truncate(CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed));
                let snap = cache.clone();
                drop(cache);
                let _ = app_handle.emit("clipboard-update", entry);
                save_clip_history(snap);
            }
        }
    });
}

/// 启动时从磁盘读取历史填充 CLIP_CACHE。必须在 start_clipboard_monitor 之前调用。
/// 文件不存在 → 无历史，静默跳过。解析失败 → 备份损坏文件，以空历史启动。
fn load_clip_history() {
    let Some(path) = CLIP_HISTORY_PATH.get() else { return; };
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return, // 文件不存在或不可读：无历史，正常启动
    };
    let parsed: serde_json::Result<serde_json::Value> = serde_json::from_str(&data);
    let v = match parsed {
        Ok(v) if v["version"].as_u64() == Some(1) => v,
        _ => {
            // 解析失败或 version 未知：备份损坏文件，空历史启动
            let backup = path.with_extension(format!("json.corrupt.{}", now_ms()));
            let _ = std::fs::rename(path, &backup);
            eprintln!("[clip] history corrupted → backed up to {:?}", backup);
            return;
        }
    };
    if let Some(items) = v["items"].as_array() {
        let mut cache = CLIP_CACHE.lock().unwrap();
        for item in items {
            let mut item = item.clone();
            // orig_path 文件不存在时去掉该字段（降级为缩略图，重启自愈）
            if let Some(path) = item["orig_path"].as_str() {
                if !std::path::Path::new(path).exists() {
                    item.as_object_mut().map(|m| m.remove("orig_path"));
                    eprintln!("[clip] orig_path 不存在，降级为缩略图");
                }
            }
            cache.push(item);
        }
        cache.truncate(CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed));
        eprintln!("[clip] loaded {} item(s) from history", cache.len());
    }
}

/// 把历史快照原子写到磁盘（tmp → rename）。接受快照入参，自身不持任何锁。
/// 调用方必须保证 CLIP_CACHE 锁与 CLIPBOARD_LOCK 均已释放后再调用（防重入死锁）。
/// 任何磁盘错误只 eprintln，不传播、不 panic，持久化降级但 app 正常运行。
fn save_clip_history(snapshot: Vec<serde_json::Value>) {
    let Some(path) = CLIP_HISTORY_PATH.get() else { return; };
    let data = match serde_json::to_string(&serde_json::json!({"version":1,"items":snapshot})) {
        Ok(d) => d,
        Err(e) => { eprintln!("[clip] serialize error: {e}"); return; }
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &data) {
        eprintln!("[clip] write tmp error: {e}"); return;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        eprintln!("[clip] rename error: {e}"); return;
    }
    eprintln!("[clip] saved {} item(s) → {:?}", snapshot.len(), path);
}

/// 把原图 PNG 写到 clip_images/{time}.png（原子写 tmp→rename）。
/// 在 detached 线程内调用，不持任何锁。>MAX_ORIG_DIM 时等比缩放后存。失败仅 eprintln。
fn save_clip_image_to_disk(img: image::DynamicImage, w: u32, h: u32, time: i64) {
    let Some(dir) = CLIP_IMAGE_DIR.get() else { return; };
    let path = dir.join(format!("{time}.png"));
    let save_img = if w > MAX_ORIG_DIM || h > MAX_ORIG_DIM {
        let r = MAX_ORIG_DIM as f64 / w.max(h) as f64;
        img.resize_exact(
            (w as f64 * r) as u32, (h as f64 * r) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let tmp = path.with_extension("png.tmp");
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    if save_img.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
        eprintln!("[clip_img] PNG 编码失败 time={time}"); return;
    }
    if std::fs::write(&tmp, cursor.into_inner()).is_err() {
        eprintln!("[clip_img] 写临时文件失败 time={time}"); return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        eprintln!("[clip_img] rename 失败 time={time}: {e}");
    } else {
        eprintln!("[clip_img] 原图已落盘 {time}.png ({w}×{h})");
    }
}

/// 前端调用：直接返回缓存数据（毫秒级）
#[tauri::command]
fn get_clipboard_history() -> Vec<serde_json::Value> {
    CLIP_CACHE.lock().unwrap().clone()
}

/// 前端调用：按 time 字段删除缓存中的指定条目
#[tauri::command]
fn delete_clipboard_item(time: i64) {
    let snap = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        cache.retain(|e| e["time"].as_i64().unwrap_or(0) != time);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放
    save_clip_history(snap);
}

/// 前端调用：清空全部剪贴板历史缓存
#[tauri::command]
fn clear_clipboard_history() {
    {
        CLIP_CACHE.lock().unwrap().clear();
    } // CLIP_CACHE 锁在此释放
    save_clip_history(vec![]);
}

/// 前端调用：返回当前运行时缓存上限
#[tauri::command]
fn get_clip_cache_max() -> usize {
    CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed)
}

/// 前端调用：设置剪贴板历史缓存上限（10-100，超出自动 clamp）。
/// 立即截断现有缓存并落盘。仅取 CLIP_CACHE 锁，不进 CLIPBOARD_LOCK（无 Win32 剪贴板操作）。
#[tauri::command]
fn set_clip_cache_max(n: usize) {
    let n = n.clamp(10, 100);
    CLIP_CACHE_MAX_RUNTIME.store(n, Ordering::Relaxed);
    let snap = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        cache.truncate(n);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放，落盘 I/O 不持任何锁
    save_clip_history(snap);
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

/// 把文件路径列表以 CF_HDROP 格式写入剪贴板（DROPFILES 头 fWide=1 + UTF-16 路径、双 \0 结尾）。
/// 纯写入——不含焦点交还/Ctrl+V/skip 信号，由调用方各自处理（paste 用计数、copy 用 seq 水位）。
fn write_cf_hdrop(paths: &[String]) -> Result<(), String> {
    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(&20u32.to_ne_bytes()); // pFiles：路径数据偏移
    raw.extend_from_slice(&0u32.to_ne_bytes());  // pt.x
    raw.extend_from_slice(&0u32.to_ne_bytes());  // pt.y
    raw.extend_from_slice(&0u32.to_ne_bytes());  // fNC
    raw.extend_from_slice(&1u32.to_ne_bytes());  // fWide=1（必须：UTF-16 路径，否则 Explorer 解析失败）
    for p in paths {
        let wide: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
        for c in &wide { raw.extend_from_slice(&c.to_ne_bytes()); }
    }
    raw.push(0); raw.push(0); // 双 \0 结尾

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
    Ok(())
}

/// 将文件路径列表写回剪贴板（CF_HDROP 格式）或桌面落地 + 粘贴
#[tauri::command]
fn set_clipboard_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

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
    SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
    {
        // 仅罩 write_cf_hdrop 的 OpenClipboard…CloseClipboard；锁在此处不进 write_cf_hdrop
        // （它被已持锁的 copy_files_to_clipboard 共用，进函数会重入死锁）。下面焦点交还/Ctrl+V 在锁外
        let _g = CLIPBOARD_LOCK.lock().unwrap();
        write_cf_hdrop(&paths)?;
    }
    suppress_clip_until_now(); // 锁后水位补检：与文本路径对齐，封住 SKIP_CLIP_EVENTS 的竞态死角

    paste_ctrl_v()?;
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

// ── 焦点交还 + Ctrl/V ─────────────────────────────────────
/// hide+sleep(150ms) 之后调用，把系统剪贴板内容贴到前景窗口。
/// 三处粘贴命令共用（图片-文件夹 / 图片-其余app / 文件），消除 Ctrl+V 九行重复。
/// 锁纪律：不碰 CLIPBOARD_LOCK——调用方进入前已完成剪贴板写入并释放锁。
fn paste_ctrl_v() -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

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

#[tauri::command]
fn set_clipboard_image(app: AppHandle, base64: String, orig_path: Option<String>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    // 先隐藏窗口，再判断目标（与 set_clipboard_files 逻辑对齐）
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));

    let class1 = get_window_class(unsafe { GetForegroundWindow() }.0 as isize);
    println!("[imgpaste] foreground class=\"{class1}\"");

    if class1 == "WorkerW" || class1 == "Progman" {
        // 桌面：PNG 落地。优先用原图文件（已是 PNG，无需重编码）
        let png_bytes: Vec<u8> = if !base64.is_empty() {
            // 历史图：先尝试 orig_path 文件，失败降级 base64 缩略图
            let from_orig = orig_path.as_deref().and_then(|p| std::fs::read(p).ok());
            match from_orig {
                Some(b) => b,
                None => {
                    let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
                    base64_decode(b64).ok_or("base64 解码失败")?
                }
            }
        } else {
            // 当前图：从 arboard 读取 RGBA 再编码为 PNG（读也走锁，与监听串行；仅罩读取临界区）
            let img_data = {
                let _g = CLIPBOARD_LOCK.lock().unwrap();
                let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
                cb.get_image().map_err(|e| format!("读图: {}", e))?
            };
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

    // 资源管理器文件夹窗口：走 CF_HDROP「落地真 PNG 文件」——文件夹只接受文件(CF_HDROP)、
    // 收不下位图(CF_DIB)，故不能走下面的 set_image 分支。顺带规避大图转位图的全分辨率 RGBA
    // 解码卡顿（本分支零解码：大图直接复用已落盘原图，小图仅解一次 base64）。
    if class1 == "CabinetWClass" || class1 == "ExploreWClass" {
        // 选 PNG 文件路径：大图(有 orig_path)直接用已落盘原图，零解码、不产临时文件；
        // 小图(无 orig_path)解一次 base64 写一份 PNG（磁盘 I/O 在 CLIPBOARD_LOCK 之外）。
        // 小图临时文件落到 clip_images/、命名 workbench_clip_*.png：它不被任何 orig_path 引用，
        // 由 janitor 当孤儿清理兜底——去掉「固定 5s 延时删」那条脆弱 race（Ctrl+V 异步、CPU 负载下
        // 可能在 Explorer 读完前删掉损坏粘贴）。clip_images 不可用时退回系统 temp（极少见，交 OS 回收）。
        let png_path: String = match orig_path.as_deref() {
            Some(p) if std::path::Path::new(p).exists() => p.to_string(),
            _ if !base64.is_empty() => {
                let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
                let bytes = base64_decode(b64).ok_or("base64 解码失败")?;
                let dir = CLIP_IMAGE_DIR.get().cloned().unwrap_or_else(std::env::temp_dir);
                let tmp = dir.join(format!("workbench_clip_{}.png", now_ms()));
                std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件: {}", e))?;
                tmp.to_string_lossy().into_owned()
            }
            _ => return Err("无图片数据".into()),
        };

        // CF_HDROP 写回 + Ctrl+V，复用文件粘贴 idiom（与 set_clipboard_files 一致）：
        // 锁加在【调用方】、不进 write_cf_hdrop（防与 copy 路径重入死锁）；写前 SKIP_CLIP_EVENTS 防自写回流。
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        {
            // 仅罩 write_cf_hdrop 的 OpenClipboard…CloseClipboard 临界区；绝不跨焦点交还/Ctrl+V 持锁
            let _g = CLIPBOARD_LOCK.lock().unwrap();
            write_cf_hdrop(&[png_path])?;
        }
        suppress_clip_until_now();

        paste_ctrl_v()?;

        // 临时文件不在此删：大图用的是 clip_images/ 原图（缓存管理）；小图也写在 clip_images/、
        // 由 janitor 孤儿清理（不被任何 orig_path 引用）。无脆弱定时 race，Explorer 读多久都安全。
        return Ok(());
    }

    // 非桌面：历史图写回剪贴板，再 Ctrl+V
    if !base64.is_empty() {
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        // 锁外读文件（文件 I/O 绝不进 CLIPBOARD_LOCK）
        let rgba_from_orig: Option<(u32, u32, Vec<u8>)> = orig_path.as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| image::load_from_memory(&bytes).ok())
            .map(|img| { let r = img.to_rgba8(); let (w,h) = r.dimensions(); (w,h,r.into_raw()) });
        let (w, h, raw) = if let Some(data) = rgba_from_orig {
            println!("[imgpaste] 使用原图 {}×{}", data.0, data.1);
            data
        } else {
            let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
            let bytes = base64_decode(b64).ok_or("base64 解码失败")?;
            let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析: {}", e))?;
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            println!("[imgpaste] 降级缩略图 {w}×{h}");
            (w, h, rgba.into_raw())
        };
        {
            // 仅罩写入临界区；下面焦点交还/Ctrl+V 在锁外
            let _g = CLIPBOARD_LOCK.lock().unwrap();
            let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
            cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(raw) })
                .map_err(|e| format!("写入: {}", e))?;
        }
        suppress_clip_until_now();
    }

    paste_ctrl_v()?;
    Ok(())
}

#[tauri::command]
fn paste_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    let t0 = std::time::Instant::now();
    {
        // 仅罩写入临界区；绝不跨下面的 hide/sleep/焦点交还/Ctrl+V 持锁（否则阻塞监听线程）
        let _g = CLIPBOARD_LOCK.lock().unwrap();
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板打开失败: {}", e))?;
        clipboard.set_text(&text).map_err(|e| format!("剪贴板写入失败: {}", e))?;
    }
    suppress_clip_until_now(); // 防自写内容回流历史面板（文本路径漏洞修复，对齐 set_clipboard_files/image）

    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(150));

    paste_ctrl_v()?;
    println!("[paste] done at {:?}", t0.elapsed());
    Ok(())
}

// ── 只复制到剪贴板（不粘贴、不隐藏窗口）─────────────────────────
// 场景：用户没有"立刻自动粘贴"需求，只想把历史项放进当前剪贴板，自行 Ctrl+V 到想要的地方。
// 与 paste/set_clipboard_* 的区别：不 hide、不查前台、无桌面分支、无 Ctrl+V。
// 写后调 suppress_clip_until_now()，使自写内容不回流历史面板（防循环）。

/// copy_* 写回剪贴板后调用：记当前 seq 为水位，令后台监听跳过本次自写，避免自写内容回流历史面板。
fn suppress_clip_until_now() {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    let now = unsafe { GetClipboardSequenceNumber() };
    SKIP_CLIP_UNTIL_SEQ.store(now, Ordering::SeqCst);
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防 1418
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
    cb.set_text(&text).map_err(|e| format!("写入: {}", e))?;
    suppress_clip_until_now();
    Ok(())
}

#[tauri::command]
fn copy_image_to_clipboard(base64: String, orig_path: Option<String>) -> Result<(), String> {
    // 优先从原图文件读取（全分辨率）；失败降级 1024px 缩略图。
    // 结果写为位图（CF_DIB）：只能粘进图片类目标（输入框/Word/画图）；
    // 文件夹/桌面只收 CF_HDROP，故往那里 Ctrl+V 无反应——Windows 固有限制，非 bug。
    // 文件 I/O 在锁外（CLIPBOARD_LOCK 只罩 set_image 临界区）。
    let (w, h, raw) = {
        let from_orig: Option<(u32, u32, Vec<u8>)> = orig_path.as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| image::load_from_memory(&bytes).ok())
            .map(|img| { let r = img.to_rgba8(); let (w,h) = r.dimensions(); (w,h,r.into_raw()) });
        if let Some(data) = from_orig {
            data
        } else {
            let b64 = if let Some(c) = base64.find(',') { &base64[c+1..] } else { &base64 };
            let bytes = base64_decode(b64).ok_or("base64 解码失败")?;
            let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析: {}", e))?;
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            (w, h, rgba.into_raw())
        }
    };
    let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防并发 OpenClipboard 撞 1418
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
    cb.set_image(arboard::ImageData {
        width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(raw),
    }).map_err(|e| format!("写入: {}", e))?;
    suppress_clip_until_now();
    Ok(())
}

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防 1418
    write_cf_hdrop(&paths)?;
    suppress_clip_until_now();
    Ok(())
}

/// 用系统文件管理器打开原图缓存目录（clip_images/）
#[tauri::command]
fn open_clip_image_dir() -> Result<(), String> {
    let dir = CLIP_IMAGE_DIR.get()
        .ok_or_else(|| "图片缓存目录未初始化".to_string())?;
    let path = dir.to_string_lossy().into_owned();
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("无法打开目录: {}", e))?;
    Ok(())
}

/// 删除 clip_images/ 内全部文件（不删目录本身）。
/// 当前会话 entry 的 orig_path 变悬空 → paste 自动降级缩略图；重启后 load_clip_history 去掉该字段（自愈）。
#[tauri::command]
fn clear_clip_image_cache() -> Result<(), String> {
    let Some(dir) = CLIP_IMAGE_DIR.get() else { return Ok(()); };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// 从原图文件名 `{time}.png` 解析出 time（i64 ms），用于「最旧先删」排序；非该格式返回 None。
fn parse_clip_image_time(name: &str) -> Option<i64> {
    name.strip_suffix(".png")?.parse::<i64>().ok()
}

/// 解耦 janitor：清理 clip_images/ 缓存（孤儿清理 + 总量封顶），自包含、零改剪贴板写路径。
///
/// 两步：① 删掉文件名未被任何 CLIP_CACHE 条目 orig_path 引用的孤儿；② 剩余被引用文件总和超
/// CLIP_IMAGE_CACHE_MAX_BYTES 时，从最旧（文件名内嵌 {time} 升序，解析失败兜底 mtime）删到 ≤ 上限
/// （被删条目优雅降级缩略图，非数据丢失）。
///
/// 铁律：**绝不取 CLIPBOARD_LOCK**（磁盘 I/O 与 Win32 剪贴板锁正交）；CLIP_CACHE 锁仅
/// snapshot-and-release 收集被引用文件名后立即释放、锁块内零 fs 调用，绝不持锁跨文件操作。
/// 全程 best-effort：任何 fs/锁错误 log + 跳过，绝不 panic、绝不阻塞。
fn sweep_clip_image_cache() {
    let Some(dir) = CLIP_IMAGE_DIR.get() else { return; };
    if !dir.exists() { return; }

    // ① 快照被引用文件名集合（snapshot-and-release：锁块内无任何 fs 调用，出锁后才 list/delete）
    let referenced: std::collections::HashSet<String> = {
        let cache = match CLIP_CACHE.lock() {
            Ok(c) => c,
            Err(e) => { eprintln!("[clip_sweep] CLIP_CACHE 锁失败，跳过本轮: {e}"); return; }
        };
        cache.iter()
            .filter_map(|e| e["orig_path"].as_str())
            .filter_map(|p| std::path::Path::new(p).file_name()
                .map(|n| n.to_string_lossy().into_owned()))
            .collect()
    }; // CLIP_CACHE 锁在此释放

    // ② 列目录：孤儿（文件名不在 referenced）直接删；被引用的记 (文件名, 大小, 排序键)
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => { eprintln!("[clip_sweep] read_dir 失败，跳过本轮: {e}"); return; }
    };
    let mut kept: Vec<(String, u64, i64)> = Vec::new();
    let mut orphans = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue; };
        if !referenced.contains(&name) {
            if std::fs::remove_file(&path).is_ok() { orphans += 1; }
            continue;
        }
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        // 排序键：优先文件名内嵌 {time}；解析失败兜底 mtime（再失败兜底 0，视作最旧先删）
        let sort_key = parse_clip_image_time(&name).unwrap_or_else(|| {
            meta.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });
        kept.push((name, size, sort_key));
    }
    if orphans > 0 { eprintln!("[clip_sweep] 清理孤儿原图 {orphans} 个"); }

    // ③ 总量封顶：被引用文件总和超上限时，从最旧删到 ≤ 上限
    let total: u64 = kept.iter().map(|(_, s, _)| *s).sum();
    if total <= CLIP_IMAGE_CACHE_MAX_BYTES { return; }
    kept.sort_by_key(|(_, _, k)| *k); // 升序：最旧先删
    let mut remaining = total;
    for (name, size, _) in &kept {
        if remaining <= CLIP_IMAGE_CACHE_MAX_BYTES { break; }
        if std::fs::remove_file(dir.join(name)).is_ok() {
            remaining = remaining.saturating_sub(*size);
        }
    }
    eprintln!("[clip_sweep] 总量封顶：{total} → {remaining} bytes（上限 {CLIP_IMAGE_CACHE_MAX_BYTES}）");
}

/// 解耦 janitor 后台线程（仿 start_index_worker idiom）：起手延迟错开 setup，之后周期 sweep。
/// 解析不到 clip_images 目录 → 降级 no-op、线程不启动。
fn start_clip_image_janitor() {
    if CLIP_IMAGE_DIR.get().is_none() { return; } // 目录未初始化：降级 no-op
    std::thread::spawn(|| {
        // 首次 sweep 必须在 load_clip_history 填充 CLIP_CACHE 之后（否则空 referenced 集误删全部）
        std::thread::sleep(std::time::Duration::from_millis(CLIP_IMAGE_SWEEP_INITIAL_MS));
        loop {
            sweep_clip_image_cache();
            std::thread::sleep(std::time::Duration::from_millis(CLIP_IMAGE_SWEEP_MS));
        }
    });
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
            // 立即 drop；与 CLIPBOARD_LOCK/FILE_INDEX 等无交集，无锁序问题。
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
            hide_window, open_file, reveal_in_explorer, trigger_screenshot, paste_clipboard,
            set_clipboard_image, get_clipboard_history, set_clipboard_files,
            delete_clipboard_item, clear_clipboard_history,
            copy_text_to_clipboard, copy_image_to_clipboard, copy_files_to_clipboard,
            get_clip_cache_max, set_clip_cache_max,
            open_clip_image_dir, clear_clip_image_cache,
            filesearch::search_files, filesearch::get_index_status,
            filesearch::get_scan_dirs, filesearch::rebuild_index,
            filesearch::set_search_engine, filesearch::get_search_engine,
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
            // 历史路径与原图目录初始化（load 必须先于 start_clipboard_monitor）
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                let _ = CLIP_HISTORY_PATH.set(data_dir.join("clip_history.json"));
                let images_dir = data_dir.join("clip_images");
                let _ = std::fs::create_dir_all(&images_dir);
                let _ = CLIP_IMAGE_DIR.set(images_dir);
            }
            load_clip_history();
            start_clipboard_monitor(app.handle().clone());
            start_clip_image_janitor(); // 解耦 janitor：周期清理 clip_images/（孤儿 + 总量封顶），不进 CLIPBOARD_LOCK
            dragdrop::register_drag_drop(app); // 中转区原生拖入
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
