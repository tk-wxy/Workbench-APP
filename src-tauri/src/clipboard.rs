//! 剪贴板子系统：历史缓存 / 后台监听 / 粘贴 / 复制 / 原图落盘 / 解耦 janitor。
//! 从 lib.rs 拆出（Phase 2，纯搬迁、零逻辑改动）。所有静态量与辅助函数模块私有；
//! 对 lib.rs 仅暴露 pub(crate) init（封装 setup 时序）与各 #[tauri::command]。

use std::os::windows::process::CommandExt;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

// CREATE_NO_WINDOW：防止 cmd.exe 子进程在开发模式下弹出控制台窗口
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
/// 剪贴板变化事件的「代数」计数器 + 条件变量（续129 事件驱动）：message-only 窗口收到
/// WM_CLIPBOARDUPDATE 即自增并唤醒监听线程。用代数而非布尔标志，是为了封住 lost wakeup——
/// 监听线程正在处理上一轮时发生的变化会让代数先行，随后的 wait 一看代数已变即刻返回、不空等，
/// 故「读取期间又复制一次」不会漏。
static CLIP_EVENT_GEN: Mutex<u64> = Mutex::new(0);
static CLIP_EVENT_CV: std::sync::Condvar = std::sync::Condvar::new();
/// 剪贴板历史落盘路径（setup 阶段写入一次，之后只读）。未初始化时 load/save 静默 no-op。
static CLIP_HISTORY_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
/// 原图落盘目录（setup 阶段初始化）。未初始化时 save_clip_image_to_disk 静默跳过。
static CLIP_IMAGE_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

// ── 可调参数 ───────────────────────────────────────────────
/// 剪贴板监听的**兜底**轮询间隔（150ms）。续129 起主路径是事件驱动（WM_CLIPBOARDUPDATE），
/// 此值降级为 condvar 等待的超时上限：监听器注册失败 / 通知意外丢失时，行为退回与续129 之前
/// 逐字节相同的 150ms 轮询。**别调大**——它是「绝不比旧版更差」的地板；seq 检查 µs 级，白等一轮近乎零成本。
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
/// hide 后焦点交还守卫的轮询间隔（GetForegroundWindow 是 µs 级调用，高频采样零成本）
const FOCUS_HANDBACK_POLL_MS: u64 = 10;
/// 焦点交还等待上限：超时则不再等、保底继续注入（与旧盲等行为一致），仅留日志证据
const FOCUS_HANDBACK_MAX_MS: u64 = 500;
/// 前台交接确认后的落定余量：前台切换先于目标线程键盘焦点落定，立即注入可能丢键
const FOCUS_HANDBACK_SETTLE_MS: u64 = 50;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ── 剪贴板后台缓存 ─────────────────────────────────────────

static CLIP_CACHE: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

/// 将 arboard 图片处理为缓存 entry：>MAX_THUMB_DIM 时缩放(Triangle) → PNG 编码 → aHash。失败返回 None。
/// 大图（>MAX_THUMB_DIM）与监听内联分支**完全一致**：保留原图、预置 `orig_path`、detached 落盘原图。
/// 续56 修复：本函数是 build_clip_entry 的回退图片路径（监听外层 has_clipboard_image 偶发误报时走到），
/// 原先只存缩略图、不设 orig_path → 大图复粘贴丢分辨率。现与内联分支对齐，任何路径都不再丢原图。
fn image_to_cache_entry(img: arboard::ImageData) -> Option<serde_json::Value> {
    let w = img.width as u32;
    let h = img.height as u32;
    let full_img = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(w, h, img.bytes.into_owned())?,
    );
    let is_large = w > MAX_THUMB_DIM || h > MAX_THUMB_DIM;
    // resize_exact 取 &self、不消耗 full_img → 大图保留 full_img 供后续落盘
    let (thumb, large_img_opt) = if is_large {
        let r = MAX_THUMB_DIM as f64 / w.max(h) as f64;
        let t = full_img.resize_exact(
            (w as f64 * r) as u32, (h as f64 * r) as u32,
            image::imageops::FilterType::Triangle,
        );
        (t, Some(full_img))
    } else {
        (full_img, None)
    };
    let mut png = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let b64 = base64_encode(&png.into_inner());
    let ah = compute_ahash(&thumb);
    let time = now_ms();
    // 预置 orig_path 路径字符串（仅大图；零 I/O，文件由下面 detached 线程真正写）
    let orig_path: Option<String> = if is_large {
        CLIP_IMAGE_DIR.get()
            .map(|d| d.join(format!("{time}.png")).to_string_lossy().into_owned())
    } else {
        None
    };
    let mut entry = serde_json::json!({
        "type":"image","content":format!("data:image/png;base64,{b64}"),
        "time":time,"w":w,"h":h,"ahash":ah
    });
    if let Some(ref p) = orig_path { entry["orig_path"] = serde_json::json!(p); }
    // 大图 detached 落盘原图（本路径无图片去重、entry 必入缓存 → 不产孤儿；spawn 即返回、不阻塞）
    if let Some(orig_img) = large_img_opt {
        std::thread::spawn(move || save_clip_image_to_disk(orig_img, w, h, time));
    }
    println!("[clipbg] image {w}×{h} cached, large={is_large} (build_clip_entry path)");
    Some(entry)
}

/// 读取当前剪贴板并构建缓存 entry。
/// - `Ok(Some)` 成功读到内容
/// - `Ok(None)` 剪贴板可访问但无可缓存内容（空 / 不支持的格式）→ 可推进 seq
/// - `Err(())`  剪贴板打不开/被占用（快速复制时源程序短暂锁定）→ 应重试，**勿推进 seq**
fn build_clip_entry() -> Result<Option<serde_json::Value>, ()> {
    // ⚠️ 三态契约的守门人（续129b）。下面每个 reader 都把「剪贴板打不开」和「没有该格式」
    // 压成同一个 None/Err（`read_clipboard_files` 尤其明显：OpenClipboard 失败也只返回 None），
    // 于是「被占用」会一路落到函数末尾的 Ok(None) → 推进 seq → **条目永久丢弃且零日志**。
    // 150ms 轮询时源程序早放开了、几乎不触发；改事件驱动后我们在通知后 µs 级就读，
    // 正撞上源程序（及被同一通知唤醒的其他监听者）仍持句柄 → 必现。
    // 故先探一次可开性：打不开 = Err（本轮重试 / 下轮再来），绝不当成「无内容」。
    build_clip_entry_inner(clipboard_openable())
}

/// 与 build_clip_entry 分开只为让「可开性 → 三态」这条判定可被确定性测试
/// （真实的"被占用"只有跨进程才构造得出来，进程内 `OpenClipboard(NULL)` 不互斥，测不了）。
fn build_clip_entry_inner(openable: bool) -> Result<Option<serde_json::Value>, ()> {
    if !openable {
        return Err(());
    }
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
    // 走到这里 = 所有 reader 都没拿到东西。但「开头探测通过、随后被别人抢走」的竞态仍在
    // （事件驱动下所有剪贴板监听者被同一条通知同时唤醒，抢句柄是常态），故复检一次：
    // 此刻打不开 → 刚才的失败是"被占用"，报 Err 去重试，而不是宣告"无内容"把条目丢掉。
    if !clipboard_openable() {
        println!("[clipbg] reader 全部落空且剪贴板已被占用 → 判为忙，重试");
        return Err(());
    }
    // 确实可开但没有我们支持的格式（此时推进 seq 是对的，否则会无限重试）。
    // 必须有日志：续129b 的教训——这条路径原本完全静默，丢条目时无迹可寻。
    println!("[clipbg] 无可缓存格式（剪贴板可开但无 图片/文件/文本）→ 跳过");
    Ok(None)
}

/// 探测剪贴板此刻能否打开。**只用来把「被占用」与「无内容」区分开**，不读任何数据。
/// 有竞态（探测通过后仍可能被别人抢走），故不是保证，只是把常见误判掰正；真正的兜底仍是重试。
fn clipboard_openable() -> bool {
    unsafe {
        if OpenClipboard(0) == 0 {
            return false;
        }
        CloseClipboard();
        true
    }
}

// ── 剪贴板变化通知：事件驱动（续129）───────────────────────────
/// 读取当前事件代数（监听线程起手取基线用）。
fn current_clip_event_gen() -> u64 {
    *CLIP_EVENT_GEN.lock().unwrap()
}

/// 记录一次剪贴板变化。**只在 wnd proc 里调**，必须极快：不读剪贴板、不取 CLIPBOARD_LOCK、
/// 不做编码——任何重活都会堵住消息循环，让后续 WM_CLIPBOARDUPDATE 延迟送达，等于退回轮询。
fn signal_clip_event() {
    if let Ok(mut gen) = CLIP_EVENT_GEN.lock() {
        *gen += 1;
    }
    CLIP_EVENT_CV.notify_all();
}

/// 等一次剪贴板变化。`seen` = 调用方上次看到的代数，返回时更新为当前代数。
/// 返回 true = 被事件唤醒（含「等待前就已发生」的情况，立即返回），false = 兜底超时。
fn wait_clip_event(seen: &mut u64, timeout_ms: u64) -> bool {
    let gen = CLIP_EVENT_GEN.lock().unwrap();
    let (gen, res) = CLIP_EVENT_CV
        .wait_timeout_while(
            gen,
            std::time::Duration::from_millis(timeout_ms),
            |g| *g == *seen,
        )
        .unwrap();
    let by_event = !res.timed_out();
    *seen = *gen;
    by_event
}

unsafe extern "system" fn clip_listener_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wp: windows::Win32::Foundation::WPARAM,
    lp: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_CLIPBOARDUPDATE};
    if msg == WM_CLIPBOARDUPDATE {
        signal_clip_event();
        return windows::Win32::Foundation::LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

/// 独立线程：message-only 窗口 + AddClipboardFormatListener + 消息循环。
/// 这是本项目**唯一**自建消息循环的线程，故意与 tao 主事件循环、与读取线程三方隔离：
/// 它只把「变了」这一个 bit 传出去（signal_clip_event），真正的读取仍在 start_clipboard_monitor。
/// 任何一步失败都只 log 并退出线程 → 监听自动退回 CLIP_POLL_MS 轮询，功能不缺失、只是回到旧精度。
/// 不做 RemoveClipboardFormatListener/DestroyWindow：进程退出即由 OS 回收，本项目无 shutdown 钩子。
fn start_clipboard_listener() {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::DataExchange::AddClipboardFormatListener;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage,
        HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };
    std::thread::spawn(|| unsafe {
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[cliplistener] GetModuleHandleW failed: {e:?} → 退回轮询");
                return;
            }
        };
        let class = w!("WorkbenchClipboardListener");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(clip_listener_wnd_proc),
            hInstance: hinst.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            eprintln!("[cliplistener] RegisterClassW failed → 退回轮询");
            return;
        }
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            hinst,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[cliplistener] CreateWindowExW failed: {e:?} → 退回轮询");
                return;
            }
        };
        if let Err(e) = AddClipboardFormatListener(hwnd) {
            eprintln!("[cliplistener] AddClipboardFormatListener failed: {e:?} → 退回轮询");
            return;
        }
        println!("[cliplistener] 事件驱动就绪（WM_CLIPBOARDUPDATE）");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        eprintln!("[cliplistener] 消息循环退出 → 退回轮询");
    });
}

/// 后台线程：等剪贴板变化事件（兜底 CLIP_POLL_MS 超时），变化时读取+缩放+存入缓存，并推送前端。
/// 图片分支：仅 get_image 在 CLIPBOARD_LOCK 内（最小临界区），thumb/ahash/编码在锁外；
///   大图（> MAX_THUMB_DIM）判新后 detached spawn 写原图，不阻塞监听循环（防加宽采样塌缩窗口）。
/// 文件/文本分支：沿用原有逻辑，仍在锁内重试。
fn start_clipboard_monitor(app_handle: AppHandle) {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        // 事件代数基线：必须在进循环前取，之后每轮由 wait_clip_event 更新。
        let mut seen_gen = current_clip_event_gen();
        loop {
            // 续129：等事件而非盲睡。醒来后的判定完全照旧——seq 仍是唯一真相，事件只决定「多快醒」。
            let by_event = wait_clip_event(&mut seen_gen, CLIP_POLL_MS);
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq { continue; }

            // 跳过 set_clipboard_* 自身写回触发的 seq 变化
            let skip = SKIP_CLIP_EVENTS.load(Ordering::SeqCst);
            if skip > 0 {
                SKIP_CLIP_EVENTS.store(skip - 1, Ordering::SeqCst);
                last_seq = seq;
                // 有日志才查得动「复制了却没进历史」：静默跳过是续129c 之前的诊断盲区
                println!("[clipbg] 跳过自写（SKIP_CLIP_EVENTS {skip}→{}）", skip - 1);
                continue;
            }
            // 跳过自写：seq ≤ 水位即自写或更早 → 不入历史面板（防循环）
            let water = SKIP_CLIP_UNTIL_SEQ.load(Ordering::SeqCst);
            if seq <= water {
                last_seq = seq;
                println!("[clipbg] 跳过自写（seq {seq} ≤ 水位 {water}）");
                continue;
            }
            // 读剪贴板与 copy_* 的写入串行（CLIPBOARD_LOCK），防并发 OpenClipboard 撞 os error 1418
            let clip_guard = CLIPBOARD_LOCK.lock().unwrap();
            // 拿锁后重读 seq + 复核水位
            let seq = unsafe { GetClipboardSequenceNumber() };
            let water = SKIP_CLIP_UNTIL_SEQ.load(Ordering::SeqCst);
            if seq <= water {
                last_seq = seq;
                println!("[clipbg] 跳过自写（锁后复核：seq {seq} ≤ 水位 {water}）");
                continue;
            }
            println!(
                "[clipbg] seq changed → reading (wake={})",
                if by_event { "event" } else { "poll" }
            );

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
pub(crate) fn get_clipboard_history() -> Vec<serde_json::Value> {
    CLIP_CACHE.lock().unwrap().clone()
}

/// 前端调用：按 time 字段删除缓存中的指定条目
#[tauri::command]
pub(crate) fn delete_clipboard_item(time: i64) {
    let snap = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        cache.retain(|e| e["time"].as_i64().unwrap_or(0) != time);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放
    save_clip_history(snap);
}

/// 前端调用：清空全部剪贴板历史缓存
#[tauri::command]
pub(crate) fn clear_clipboard_history() {
    {
        CLIP_CACHE.lock().unwrap().clear();
    } // CLIP_CACHE 锁在此释放
    save_clip_history(vec![]);
}

/// 前端调用：返回当前运行时缓存上限
#[tauri::command]
pub(crate) fn get_clip_cache_max() -> usize {
    CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed)
}

/// 前端调用：设置剪贴板历史缓存上限（10-100，超出自动 clamp）。
/// 立即截断现有缓存并落盘。仅取 CLIP_CACHE 锁，不进 CLIPBOARD_LOCK（无 Win32 剪贴板操作）。
#[tauri::command]
pub(crate) fn set_clip_cache_max(n: usize) {
    let n = n.clamp(10, 100);
    CLIP_CACHE_MAX_RUNTIME.store(n, Ordering::Relaxed);
    let snap = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        cache.truncate(n);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放，落盘 I/O 不持任何锁
    save_clip_history(snap);
}

/// hide 后等待 OS 把前台交还给目标窗口（替代旧「盲等固定 150ms」）。
/// 根因：hide() 只是异步派发（事件循环处理 + OS 激活交接都发生在返回之后），负载高时
/// 固定延时不够，GetForegroundWindow 仍返回本窗口/NULL → Ctrl+V 注入进已隐藏的自家
/// 窗口 → 点击粘贴偶发失败。改为守卫轮询：前台既非本窗口也非 NULL 即交接完成
///（上限 FOCUS_HANDBACK_MAX_MS，超时保底继续不阻断），再留 FOCUS_HANDBACK_SETTLE_MS
/// 让目标线程键盘焦点落定（前台切换先于键盘焦点落定）。日志带 tag 便于分路径诊断。
fn wait_foreground_handback(app: &AppHandle, tag: &str) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let self_hwnd = app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    let start = std::time::Instant::now();
    let max = std::time::Duration::from_millis(FOCUS_HANDBACK_MAX_MS);
    let mut timed_out = false;
    loop {
        let fg = unsafe { GetForegroundWindow() }.0 as isize;
        if fg != 0 && fg != self_hwnd { break; }
        if start.elapsed() >= max { timed_out = true; break; }
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_HANDBACK_POLL_MS));
    }
    let waited = start.elapsed().as_millis();
    std::thread::sleep(std::time::Duration::from_millis(FOCUS_HANDBACK_SETTLE_MS));
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    println!("[{tag}] handback waited={waited}ms timeout={timed_out} fg class=\"{}\"",
        get_window_class(fg));
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

/// 剪贴板当前是否包含图片格式（CF_BITMAP / CF_DIB / CF_DIBV5）。
/// 不再用 OpenClipboard 包裹——`IsClipboardFormatAvailable` 本就无需打开剪贴板（Win32 文档），
/// 而原先的 `OpenClipboard` 在源程序（截图工具写 DIB+临时 PNG 时短暂占用句柄）会失败 → 误报
/// 「无图片」→ 大图被分流到无 orig_path 的 build_clip_entry 路径 → 复粘贴只剩缩略图（续56 根因修复）。
fn has_clipboard_image() -> bool {
    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    unsafe {
        IsClipboardFormatAvailable(CF_BITMAP) != 0
            || IsClipboardFormatAvailable(CF_DIB) != 0
            || IsClipboardFormatAvailable(CF_DIBV5) != 0
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
pub(crate) fn set_clipboard_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    println!("[filepaste] paths count={}", paths.len());
    for (i, p) in paths.iter().enumerate() {
        println!("[filepaste]   [{}] \"{}\"", i, p);
    }

    // Bug A 修复：场景判断提到写剪贴板之前，桌面直接落地不碰剪贴板
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    wait_foreground_handback(&app, "filepaste"); // 交接完成后 class 判断才可信（含日志）
    let class1 = get_window_class(unsafe { GetForegroundWindow() }.0 as isize);

    if class1 == "WorkerW" || class1 == "Progman" {
        return desktop_copy_files(&paths);
    }

    // 非桌面：CF_HDROP 写回 + Ctrl+V
    SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
    let _sg = SkipGuard; // 防中途 return/? 留下计数残留（吃掉真实复制）
    {
        // 仅罩 write_cf_hdrop 的 OpenClipboard…CloseClipboard；锁在此处不进 write_cf_hdrop
        // （它被已持锁的 copy_files_to_clipboard 共用，进函数会重入死锁）。下面焦点交还/Ctrl+V 在锁外
        let _g = CLIPBOARD_LOCK.lock().unwrap();
        write_cf_hdrop(&paths)?;
    }
    suppress_clip_until_now(); // 锁后水位补检：与文本路径对齐，封住 SKIP_CLIP_EVENTS 的竞态死角

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

#[tauri::command]
pub(crate) fn set_clipboard_image(app: AppHandle, base64: String, orig_path: Option<String>) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    // 先隐藏窗口，再判断目标（与 set_clipboard_files 逻辑对齐）
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    wait_foreground_handback(&app, "imgpaste"); // 交接完成后 class 判断才可信（含日志）

    let class1 = get_window_class(unsafe { GetForegroundWindow() }.0 as isize);

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
        let _sg = SkipGuard; // 防中途 return/? 留下计数残留（吃掉真实复制）
        {
            // 仅罩 write_cf_hdrop 的 OpenClipboard…CloseClipboard 临界区；绝不跨焦点交还/Ctrl+V 持锁
            let _g = CLIPBOARD_LOCK.lock().unwrap();
            write_cf_hdrop(&[png_path])?;
        }
        suppress_clip_until_now();

        let target = unsafe { GetForegroundWindow() };
        unsafe { let _ = SetForegroundWindow(target); }
        let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
        let _ = enigo.key(enigo::Key::Control, Press);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::V, Press);
        let _ = enigo.key(enigo::Key::V, Release);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::Control, Release);

        // 临时文件不在此删：大图用的是 clip_images/ 原图（缓存管理）；小图也写在 clip_images/、
        // 由 janitor 孤儿清理（不被任何 orig_path 引用）。无脆弱定时 race，Explorer 读多久都安全。
        return Ok(());
    }

    // 控制台窗口（cmd 经典宿主 / Windows Terminal）：文本终端只认 CF_TEXT，位图对它没有任何可
    // 解释的含义——不是 bug，是控制台本身的能力边界（脱离本应用手动复制图片再到 cmd 里 Ctrl+V 同样
    // 毫无反应）。退化为粘贴该图片的落盘路径（文本），至少给出一个可用结果而非静默无反应。
    // 落盘路径选取逻辑与上面 CabinetWClass 分支一致：大图复用已有 orig_path，小图现解一份 PNG。
    if class1 == "ConsoleWindowClass" || class1 == "CASCADIA_HOSTING_WINDOW_CLASS" {
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

        // 文本写回 idiom 同 paste_clipboard：锁仅罩写入临界区，SKIP_CLIP_EVENTS + suppress 防自写回流。
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        let _sg = SkipGuard; // 防中途 return/? 留下计数残留（吃掉真实复制）
        {
            let _g = CLIPBOARD_LOCK.lock().unwrap();
            let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
            cb.set_text(&png_path).map_err(|e| format!("剪贴板写入失败: {}", e))?;
        }
        suppress_clip_until_now();

        let target = unsafe { GetForegroundWindow() };
        unsafe { let _ = SetForegroundWindow(target); }
        let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| format!("enigo: {}", e))?;
        let _ = enigo.key(enigo::Key::Control, Press);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::V, Press);
        let _ = enigo.key(enigo::Key::V, Release);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::Control, Release);

        return Ok(());
    }

    // ── 分支③：其余 app（Paint / 聊天框等真吃位图的目标）──────────────────────────
    // 续55：整段「解码 + set_image + 焦点交还 + Ctrl+V」搬入子线程，命令本体 spawn 后立即返回。
    // 根因：大图全分辨率 RGBA 解码（3200×1998 ≈ 25MB）原在主线程同步跑，堵住热键键态轮询
    // 线程 → 「短时无法呼出」。分支①②无此问题（①走文件系统、②零解码），仅③需修。
    // 锁纪律不变：CLIPBOARD_LOCK 只罩 set_image 的 OpenClipboard…CloseClipboard 临界区；
    // 顶部 hide(主线程，class 检测依赖它，不可移)/sleep/焦点交还/enigo Ctrl+V 全在锁外。
    // 子线程无调用方可承接 ?，故各错误就地 eprintln + return（detached，仅日志）。
    std::thread::spawn(move || {
        // 历史图写回剪贴板（base64 空 = 当前图，已在剪贴板，跳过写入直接 Ctrl+V）
        if !base64.is_empty() {
            SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
            let _sg = SkipGuard; // 防中途 return/? 留下计数残留（吃掉真实复制）
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
                let bytes = match base64_decode(b64) {
                    Some(b) => b,
                    None => { eprintln!("[imgpaste] base64 解码失败"); return; }
                };
                let img = match image::load_from_memory(&bytes) {
                    Ok(i) => i,
                    Err(e) => { eprintln!("[imgpaste] 图片解析: {e}"); return; }
                };
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                println!("[imgpaste] 降级缩略图 {w}×{h}");
                (w, h, rgba.into_raw())
            };
            {
                // 仅罩写入临界区；下面焦点交还/Ctrl+V 在锁外
                let _g = CLIPBOARD_LOCK.lock().unwrap();
                let mut cb = match arboard::Clipboard::new() {
                    Ok(c) => c,
                    Err(e) => { eprintln!("[imgpaste] 剪贴板: {e}"); return; }
                };
                if let Err(e) = cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(raw) }) {
                    eprintln!("[imgpaste] 写入: {e}"); return;
                }
            }
            suppress_clip_until_now();
        }

        let target = unsafe { GetForegroundWindow() };
        unsafe { let _ = SetForegroundWindow(target); }
        let mut enigo = match enigo::Enigo::new(&enigo::Settings::default()) {
            Ok(e) => e,
            Err(e) => { eprintln!("[imgpaste] enigo: {e}"); return; }
        };
        let _ = enigo.key(enigo::Key::Control, Press);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::V, Press);
        let _ = enigo.key(enigo::Key::V, Release);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = enigo.key(enigo::Key::Control, Release);
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn paste_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    let t0 = std::time::Instant::now();
    {
        // 仅罩写入临界区；绝不跨下面的 hide/sleep/焦点交还/Ctrl+V 持锁（否则阻塞监听线程）
        let _g = CLIPBOARD_LOCK.lock().unwrap();
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板打开失败: {}", e))?;
        clipboard.set_text(&text).map_err(|e| format!("剪贴板写入失败: {}", e))?;
    }
    suppress_clip_until_now(); // 防自写内容回流历史面板（文本路径漏洞修复，对齐 set_clipboard_files/image）

    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    wait_foreground_handback(&app, "paste"); // 文本路径原先零日志，失败不可诊断；此处补齐

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

// ── 只复制到剪贴板（不粘贴、不隐藏窗口）─────────────────────────
// 场景：用户没有"立刻自动粘贴"需求，只想把历史项放进当前剪贴板，自行 Ctrl+V 到想要的地方。
// 与 paste/set_clipboard_* 的区别：不 hide、不查前台、无桌面分支、无 Ctrl+V。
// 写后调 suppress_clip_until_now()，使自写内容不回流历史面板（防循环）。

/// RAII 兜底（续129c）：确保 `SKIP_CLIP_EVENTS` 不会因写入路径中途 `?`/`return` 而留下残留。
/// 4 个 `store(2)` 站点全都有提前退出路径（`write_cf_hdrop(&paths)?`、base64 解码失败 return…），
/// 残留会去吃掉后面最多 2 次**真实**复制，症状是"复制了却没进历史"且**毫无日志**。
/// 正常路径由 `suppress_clip_until_now` 提前清零，故 Drop 时通常已是 0、不打印。
struct SkipGuard;
impl Drop for SkipGuard {
    fn drop(&mut self) {
        let residual = SKIP_CLIP_EVENTS.swap(0, Ordering::SeqCst);
        if residual > 0 {
            eprintln!("[clipbg] 写入路径提前退出，清理 SKIP_CLIP_EVENTS 残留 {residual}");
        }
    }
}

/// 写回剪贴板后调用：记当前 seq 为水位，令后台监听跳过本次自写，避免自写内容回流历史面板。
///
/// **两层防护的交接点（续129c）**：写入前的 `SKIP_CLIP_EVENTS.store(2)` 负责保护
/// 「水位还没抬起来」的那段窗口（写完 CloseClipboard 到本函数之间，监听可能抢到锁去读自写内容）；
/// 本函数抬起水位后，判定改由 seq 水位接管——它与跳变次数/唤醒时序**无关**，是更强的保证。
/// 故此处必须把计数清零：`store(2)` 是按"最多 2 次 seq 跳变"预设的，而一次唤醒只消费 1 个，
/// **没被消费完的残留会去吃掉下一次真实复制**（§6 记载的老坑）。续129 改事件驱动后
/// 自写通常只产生 1 次通知 → 残留几乎必然发生 → 症状即"粘贴过之后，下一次复制没进历史"。
fn suppress_clip_until_now() {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    let now = unsafe { GetClipboardSequenceNumber() };
    SKIP_CLIP_UNTIL_SEQ.store(now, Ordering::SeqCst);
    // 水位已接管本次自写的判定 → 计数使命完成，清零，绝不留给下一次真实复制去吃。
    let residual = SKIP_CLIP_EVENTS.swap(0, Ordering::SeqCst);
    if residual > 0 {
        println!("[clipbg] 自写完成，清理 SKIP_CLIP_EVENTS 残留 {residual}（判定已交给 seq 水位）");
    }
}

#[tauri::command]
pub(crate) fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防 1418
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
    cb.set_text(&text).map_err(|e| format!("写入: {}", e))?;
    suppress_clip_until_now();
    Ok(())
}

#[tauri::command]
pub(crate) fn copy_image_to_clipboard(base64: String, orig_path: Option<String>) -> Result<(), String> {
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
pub(crate) fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防 1418
    write_cf_hdrop(&paths)?;
    suppress_clip_until_now();
    Ok(())
}

/// 用系统文件管理器打开原图缓存目录（clip_images/）
#[tauri::command]
pub(crate) fn open_clip_image_dir() -> Result<(), String> {
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
pub(crate) fn clear_clip_image_cache() -> Result<(), String> {
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

// ── 启动入口（封装 setup 时序，顺序不可变）──────────────────────
/// 剪贴板子系统初始化：路径 → load_clip_history → start_clipboard_monitor → janitor。
/// 顺序绝对不能变：① 路径必须最先（load/save 依赖 OnceLock）；② load 必须在 monitor 之前
/// （否则监听写盘会用空缓存覆盖磁盘历史）；③ janitor 靠起手 5s 软时序错开 load，防误删原图。
pub(crate) fn init(app: &AppHandle, data_dir: &std::path::Path) {
    // 1. 路径初始化（必须最先）
    let _ = std::fs::create_dir_all(data_dir);
    let history_path = data_dir.join("clip_history.json");
    let image_dir = data_dir.join("clip_images");
    let _ = std::fs::create_dir_all(&image_dir);
    let _ = CLIP_HISTORY_PATH.set(history_path);
    let _ = CLIP_IMAGE_DIR.set(image_dir);
    // 2. 读历史（必须在 monitor 之前，否则监听写盘会覆盖磁盘历史）
    load_clip_history();
    // 3. 启动事件通知源（续129）。放在 monitor 之前只为让 monitor 一起手就有事件可等；
    //    二者无强时序依赖——它失败也只是 monitor 退回 CLIP_POLL_MS 轮询。
    start_clipboard_listener();
    // 4. 启动监听（必须在 load 之后）
    start_clipboard_monitor(app.clone());
    // 5. 启动 janitor（sleep CLIP_IMAGE_SWEEP_INITIAL_MS=5s 软时序错开，保证 load 完成再 sweep）
    start_clip_image_janitor();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CLIP_EVENT_GEN 是全局的，而 cargo test 默认并行跑同一进程：不串行化的话，别的用例的
    /// signal 会把「超时用例」提前唤醒 → 偶发假失败。故三个用例整体串行。
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 续129 事件驱动的核心不变量：**在 wait 之前就发生的变化不能被吞掉**。
    /// 这条如果破了，症状正是本次要修的「复制两个少一个」——只是从轮询塌缩换成 lost wakeup，
    /// 而且更难复现。故用代数（而非布尔/裸 Condvar::wait）实现，并在此钉死。
    #[test]
    fn clip_event_before_wait_is_not_lost() {
        let _g = serial();
        let mut seen = current_clip_event_gen();
        signal_clip_event(); // 变化发生在 wait 之前
        let t = std::time::Instant::now();
        // 超时给足 2s：若实现有 lost wakeup，这里必然等满 2s 且返回 false
        let by_event = wait_clip_event(&mut seen, 2000);
        assert!(by_event, "wait 之前发生的事件被吞掉了（lost wakeup）");
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "应立即返回而非等满超时");
    }

    /// 无事件时必须按超时返回，且报告 by_event=false —— 这是「退回轮询」的降级路径。
    #[test]
    fn clip_event_times_out_without_signal() {
        let _g = serial();
        let mut seen = current_clip_event_gen();
        let t = std::time::Instant::now();
        let by_event = wait_clip_event(&mut seen, 120);
        assert!(!by_event, "无事件却报告被事件唤醒");
        assert!(t.elapsed() >= std::time::Duration::from_millis(100), "提前返回，未真正等待");
    }

    /// 续129b 回归钉死：剪贴板**被别人占着**时，build_clip_entry 必须报 `Err`（可重试），
    /// 绝不能报 `Ok(None)`（"无内容"）——后者会让调用方推进 seq，**条目永久丢弃且零日志**。
    /// 这正是续129 首版把「图片/文件/文件夹全都进不了历史」引爆的那条路径。
    /// 只断言"被占用"这一个方向：我们自己持着句柄，故必然打不开，不受外部环境影响、不会 flaky。
    /// 续129c 回归钉死：自写写完、水位抬起后，`SKIP_CLIP_EVENTS` 必须归零。
    /// `store(2)` 是按"最多 2 次 seq 跳变"预设的，但**一次唤醒只消费 1 个**；没消费完的残留
    /// 会去吃掉下一次**真实**复制 → "粘贴过之后，下一次复制没进历史"。事件驱动下自写通常
    /// 只产生 1 次通知，残留几乎必然发生，故这条必须钉死。
    #[test]
    fn suppress_clears_skip_counter_residual() {
        let _g = serial();
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        suppress_clip_until_now();
        assert_eq!(
            SKIP_CLIP_EVENTS.load(Ordering::SeqCst),
            0,
            "水位已接管自写判定，计数残留必须清零，否则会吃掉下一次真实复制"
        );
    }

    /// 续129c 回归钉死：写入路径中途 `?`/`return`（如 `write_cf_hdrop(&paths)?` 失败）时，
    /// SkipGuard 必须在 Drop 里清掉计数——否则残留会静默吃掉后续最多 2 次真实复制。
    #[test]
    fn skip_guard_clears_residual_on_early_return() {
        let _g = serial();
        SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
        {
            let _sg = SkipGuard; // 模拟写入路径提前退出：guard 随作用域析构
        }
        assert_eq!(
            SKIP_CLIP_EVENTS.load(Ordering::SeqCst),
            0,
            "提前退出未清计数 → 残留会吃掉真实复制"
        );
    }

    /// 💀 别再试「在另一个线程 OpenClipboard 占住、看主线程是否读不到」来构造这个前提：
    /// `OpenClipboard(NULL)` 是**按任务/进程**关联的，同进程另一线程照样能打开并读到内容
    /// （续129b 实测：holder 线程持着句柄，主线程 build_clip_entry 仍返回 Ok(Some(text))）。
    /// 真实的"被占用"只在跨进程发生。故这里直接对判定本身断言。
    #[test]
    fn busy_clipboard_reports_err_not_empty() {
        let _g = serial();
        let r = build_clip_entry_inner(false);
        assert!(
            r.is_err(),
            "剪贴板打不开时报了 {r:?}（应为 Err）——误判成 Ok(None)「无内容」会推进 seq、静默丢条目"
        );
    }

    /// 探针（碰真实系统剪贴板，故 #[ignore]，用 `cargo test -- --ignored probe_clipboard_listener --nocapture` 跑）：
    /// 验证 AddClipboardFormatListener 真的把 WM_CLIPBOARDUPDATE 送到了，并量出「复制 → 醒来」延迟。
    /// 这是续129 唯一能在无 GUI 环境下端到端证伪的点——上面三个单测只证明 condvar 语义，不证明通知真的来。
    #[test]
    #[ignore]
    fn probe_clipboard_listener() {
        let _g = serial();
        start_clipboard_listener();
        std::thread::sleep(std::time::Duration::from_millis(300)); // 等注册落地
        let mut seen = current_clip_event_gen();

        // 单次复制：量延迟
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        cb.set_text("workbench probe A").expect("set_text A");
        let t = std::time::Instant::now();
        let by_event = wait_clip_event(&mut seen, 3000);
        let lat = t.elapsed();
        println!("[probe] 单次复制 → 唤醒: by_event={by_event} 延迟={lat:?}");
        assert!(by_event, "WM_CLIPBOARDUPDATE 未送达 → 事件驱动没生效（会静默退回轮询）");

        // 快速连发：150ms 轮询下 B 会被 C 覆盖而塌缩；事件驱动应收到多次独立通知
        let g0 = current_clip_event_gen();
        for s in ["probe B", "probe C", "probe D"] {
            cb.set_text(s).expect("set_text");
            std::thread::sleep(std::time::Duration::from_millis(30)); // 30ms « 150ms 轮询窗口
        }
        std::thread::sleep(std::time::Duration::from_millis(300)); // 等通知排空
        let got = current_clip_event_gen() - g0;
        println!("[probe] 30ms 间隔连发 3 次 → 收到 {got} 次通知（轮询模式下这 3 次会塌缩成 1）");
        assert!(got >= 3, "连发 3 次只收到 {got} 次通知，塌缩仍在");
    }

    /// 探针（碰真实系统剪贴板，#[ignore]）：量「残留塌缩窗口」——事件驱动把「醒来延迟」压到 µs 后，
    /// 剩下的丢条目风险只剩「读取本身还没读完，源头就被下一次复制覆盖」。读取耗时即该窗口的宽度。
    /// 注意只量到「字节已读出剪贴板」为止：此后内容已是我们的副本，再被覆盖也不丢。
    #[test]
    #[ignore]
    fn probe_read_latency() {
        let _g = serial();
        let mut cb = arboard::Clipboard::new().expect("clipboard");

        cb.set_text("workbench probe text").expect("set_text");
        let t = std::time::Instant::now();
        let r = build_clip_entry();
        println!("[probe] 文本读取耗时={:?} ok={}", t.elapsed(), r.is_ok());

        // 3200×2000 ≈ 开发机截图尺寸，代表最坏情况
        let (w, h) = (3200usize, 2000usize);
        let bytes = vec![128u8; w * h * 4];
        // 换新句柄：上面 build_clip_entry 内部另开过剪贴板，复用旧 cb 会撞 os error 1418
        std::thread::sleep(std::time::Duration::from_millis(100));
        // set_image 多步、open 窗口长，易与外部（含正在运行的本 app 实例）抢句柄撞 1418 —— 重试几次；
        // 仍失败就跳过图片测量而非让整个探针失败（这不是被测对象）。
        let mut placed = false;
        for _ in 0..5 {
            let mut cb2 = arboard::Clipboard::new().expect("clipboard2");
            match cb2.set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: bytes.clone().into(),
            }) {
                Ok(()) => {
                    placed = true;
                    break;
                }
                Err(e) => {
                    println!("[probe] set_image 重试中: {e}");
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
        if !placed {
            println!("[probe] 图片放置失败（剪贴板被外部占用），跳过图片测量");
            return;
        }
        let mut cb3 = arboard::Clipboard::new().expect("clipboard3");
        let t = std::time::Instant::now();
        let img = cb3.get_image().expect("get_image");
        println!(
            "[probe] 图片 {}×{} 读出剪贴板耗时={:?}",
            img.width,
            img.height,
            t.elapsed()
        );
    }

    /// 处理一轮期间连发多次变化，只需醒来一次（代数一次性追平），但绝不能永远追不上。
    #[test]
    fn clip_event_gen_advances_monotonically() {
        let _g = serial();
        let mut seen = current_clip_event_gen();
        signal_clip_event();
        signal_clip_event();
        signal_clip_event();
        assert!(wait_clip_event(&mut seen, 2000));
        assert_eq!(seen, current_clip_event_gen(), "代数未追平，下轮会空转");
    }
}
