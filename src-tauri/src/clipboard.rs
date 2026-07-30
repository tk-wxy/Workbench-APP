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
/// 串行化历史文件写入。每个写者拿到此锁后重新抓 CLIP_CACHE 最新快照，防较旧快照后写覆盖新历史。
/// 不与 CLIP_CACHE 同时跨磁盘 I/O 持有：只在锁内 clone，随即释放缓存锁再写文件。
static CLIP_HISTORY_SAVE_LOCK: Mutex<()> = Mutex::new(());
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
/// 正在后台写盘的原图张数（续146d）。原图编码耗时可观（全屏截图实测约 0.7s，未优化构建下 3.3s），
/// 而条目早已带着 orig_path 落盘——进程若在此刻退出，原图永久丢失、拖出/粘贴静默退化成缩略图。
/// 退出前用它等一等（见 wait_pending_image_writes）。
pub(crate) static PENDING_IMAGE_WRITES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
/// 正在写盘的具体剪贴板条目 time。全局计数只供退出等待；消费降级判定必须按条目精确查询，
/// 不能让另一张图的编码遮蔽当前条目的原图丢失。
static PENDING_IMAGE_WRITE_TIMES: std::sync::LazyLock<Mutex<std::collections::HashSet<i64>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
/// 退出时最多等多久（毫秒）——够写完一两张全屏截图，又不至于让退出显得卡死。
const PENDING_WRITE_WAIT_MAX_MS: u64 = 3000;
/// 原图缓存 janitor 起手延迟（5s）：错开 setup 同步 load_clip_history，防空 referenced 集误删全部
const CLIP_IMAGE_SWEEP_INITIAL_MS: u64 = 5000;
/// 原图临时文件（{time}.png.tmp）保护期（60s，续146d 竞态修复）：save_clip_image_to_disk 走 tmp→rename
/// 原子写，中间态 .tmp 永不在 referenced 集里 → 会落进孤儿分支。若 sweep 恰插在 write 与 rename
/// 之间就会删掉在写的 .tmp、令 rename 失败、原图丢。年轻于此的 .tmp 视为「正在写盘」跳过；
/// 老于此的视为崩溃遗留可清（否则光跳过会永久泄漏）。写盘实测 <1s，60s 有充分余量。
const CLIP_TMP_GRACE_MS: u64 = 60_000;
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

/// 根据原始尺寸与原图文件状态规范化降级标记。只持久化 `true`：正常小图本来就没有
/// `orig_path`，绝不能因字段缺失被误标；旧条目尺寸也缺失时不猜测。
/// 返回 JSON 是否发生变化。`path_exists` 由调用方注入，便于纯函数测试。
fn normalize_orig_degraded(
    item: &mut serde_json::Value,
    path_exists: impl FnOnce(&str) -> bool,
) -> bool {
    if item["type"].as_str() != Some("image") {
        return false;
    }
    let is_large = item["w"].as_u64().is_some_and(|w| w > MAX_THUMB_DIM as u64)
        || item["h"].as_u64().is_some_and(|h| h > MAX_THUMB_DIM as u64);
    let degraded = match item["orig_path"].as_str() {
        Some(path) => !path_exists(path),
        None => is_large,
    };
    let was_degraded = item["orig_degraded"].as_bool() == Some(true);
    if degraded == was_degraded {
        return false;
    }
    if let Some(obj) = item.as_object_mut() {
        if degraded {
            obj.insert("orig_degraded".into(), serde_json::Value::Bool(true));
        } else {
            obj.remove("orig_degraded");
        }
    }
    true
}

/// 消费图片时确认原图不可用：幂等更新 Rust 权威缓存，锁外落盘并通知前端。
/// `time` 优先精确定位剪贴板条目；`orig_path` 仅作旧调用/同源路径兜底。
/// 新大图 entry 会先预置路径再异步写盘：只对“目标条目本身刚创建、且确有写线程”给短暂宽限，
/// 避免用全局 pending 状态误压住另一条旧图片的真实降级。
pub(crate) fn mark_clip_original_degraded(
    app: &AppHandle,
    time: Option<i64>,
    orig_path: Option<&str>,
    reason: &str,
) {
    let changed = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        let Some(item) = cache.iter_mut().find(|e| {
            e["type"].as_str() == Some("image")
                && (time.is_some_and(|t| e["time"].as_i64() == Some(t))
                    || (time.is_none()
                        && orig_path.is_some_and(|p| e["orig_path"].as_str() == Some(p))))
        }) else {
            return;
        };
        // PNG 尚在 detached 写盘时，消费可能先撞上预置但尚不存在的 orig_path。
        // 必须按目标条目的 time 精确确认，不能用全局 pending 计数误压住另一条旧图片。
        let target_write_pending = reason.ends_with("fallback")
            && item["time"].as_i64().is_some_and(|t| {
                PENDING_IMAGE_WRITE_TIMES.lock().unwrap().contains(&t)
            });
        if target_write_pending || item["orig_degraded"].as_bool() == Some(true) {
            return;
        }
        item["orig_degraded"] = serde_json::Value::Bool(true);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放；落盘与 emit 均在锁外
    let _ = save_clip_history(changed);
    let visible = app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let _ = app.emit("clipboard-original-degraded", serde_json::json!({
        "time": time,
        "origPath": orig_path,
        "reason": reason,
        "visible": visible,
    }));
}

/// 将所有仍引用原图路径的图片标为降级。用于用户主动清空原图缓存后立即同步 UI，
/// 不等到下一次消费或重启；路径 exists 检查在 CLIP_CACHE 锁外，锁内只改 JSON + 快照。
fn mark_all_clip_originals_degraded(app: &AppHandle) {
    // 路径存在性检查是磁盘 I/O：先在缓存锁外取 (time, path) 快照并判断，再回锁内应用。
    let candidates: Vec<(i64, String)> = CLIP_CACHE.lock().unwrap().iter()
        .filter_map(|item| {
            (item["type"].as_str() == Some("image")
                && item["orig_degraded"].as_bool() != Some(true))
                .then(|| Some((item["time"].as_i64()?, item["orig_path"].as_str()?.to_string())))
                .flatten()
        })
        .collect();
    let missing: std::collections::HashSet<i64> = candidates.into_iter()
        .filter_map(|(time, path)| (!std::path::Path::new(&path).exists()).then_some(time))
        .collect();
    let changed = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        let mut times = Vec::new();
        for item in cache.iter_mut() {
            if item["time"].as_i64().is_some_and(|time| missing.contains(&time))
                && item["type"].as_str() == Some("image")
                && item["orig_degraded"].as_bool() != Some(true)
            {
                item["orig_degraded"] = serde_json::Value::Bool(true);
                if let Some(time) = item["time"].as_i64() { times.push(time); }
            }
        }
        (!times.is_empty()).then(|| (cache.clone(), times))
    };
    let Some((snapshot, times)) = changed else { return; };
    let _ = save_clip_history(snapshot);
    for time in times {
        let _ = app.emit("clipboard-original-degraded", serde_json::json!({
            "time": time,
            "origPath": serde_json::Value::Null,
            "reason": "cache-cleared",
        }));
    }
}

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
        PENDING_IMAGE_WRITES.fetch_add(1, Ordering::Relaxed); // 续146d：先记账再 spawn，退出时可等
        PENDING_IMAGE_WRITE_TIMES.lock().unwrap().insert(time);
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
            // 脱敏：只记长度，不打印内容——复制的文本可能是密码管理器口令等敏感串。
            println!("[clipbg] text len={}", text.chars().count());
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
        let _guard = crate::ThreadExitGuard("clip_listener"); // M5-A
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
        let _guard = crate::ThreadExitGuard("clip_monitor"); // M5-A
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
                    PENDING_IMAGE_WRITES.fetch_add(1, Ordering::Relaxed); // 续146d：先记账再 spawn
                    PENDING_IMAGE_WRITE_TIMES.lock().unwrap().insert(t);
                    std::thread::spawn(move || save_clip_image_to_disk(orig_img, w, h, t));
                }
                let _ = app_handle.emit("clipboard-update", entry);
                let _ = save_clip_history(snap); // 监听循环 best-effort：无接收方，失败下一轮自愈

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
                let _ = save_clip_history(snap); // 监听循环 best-effort：无接收方，失败下一轮自愈
            }
        }
    });
}

/// setup 阶段**同步**读 store JSON（平凡顶层 KV）取 `clip-cache-max`。任何失败/越界 → None，
/// 调用方保留 CLIP_CACHE_MAX_DEFAULT。与 lib.rs `read_combo_from_store`（热键）同款做法。
///
/// **为什么必须同步直读文件、而不能等前端 invoke**（续145 数据丢失根因，别改回去）：
/// 前端 store 要等 WebView 起来才 load，`set_clip_cache_max` 因此**晚于 setup 几百毫秒**到达；
/// 而 `load_clip_history` 在 setup 就跑，那时 CLIP_CACHE_MAX_RUNTIME 还是默认 20 →
/// 把 100 条历史截成 20 条 → 随后**任何一次落盘**（前端那次 set_clip_cache_max 自己就会落盘，
/// 或任意一次复制）把 20 条写回磁盘 → 每次重启永久丢 80 条，且零报错。
fn read_clip_cache_max_from_store(data_dir: &std::path::Path) -> Option<usize> {
    let text = std::fs::read_to_string(data_dir.join("workbench-data.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let n = v.get("clip-cache-max")?.as_u64()? as usize;
    // 与 set_clip_cache_max 的 clamp 同界；越界视为脏值 → None（保留默认，绝不拿脏值去截历史）
    (10..=100).contains(&n).then_some(n)
}

/// 启动时从磁盘读取历史填充 CLIP_CACHE。必须在 start_clipboard_monitor 之前调用。
/// 文件不存在 → 无历史，静默跳过。解析失败 → 备份损坏文件，以空历史启动。
/// ⚠ 末尾按 CLIP_CACHE_MAX_RUNTIME 截断 → **调用前必须已落地真实上限**（见 init 步骤 2）。
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
        // 路径检查是磁盘 I/O，先在锁外规范化；正常小图无 orig_path 不算降级。
        // 恢复流程已在 load 前补齐可恢复 PNG，因此此处看到的悬空路径才是真降级。
        let mut loaded = Vec::with_capacity(items.len());
        let mut normalized = false;
        for item in items {
            let mut item = item.clone();
            if normalize_orig_degraded(&mut item, |path| std::path::Path::new(path).exists()) {
                normalized = true;
                if item["orig_degraded"].as_bool() == Some(true) {
                    eprintln!("[clip] 原图不可用，标记为缩略图降级");
                }
            }
            loaded.push(item);
        }
        let (read, snapshot) = {
            let mut cache = CLIP_CACHE.lock().unwrap();
            cache.extend(loaded);
            let read = cache.len();
            cache.truncate(CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed));
            (read, normalized.then(|| cache.clone()))
        }; // CLIP_CACHE 锁在此释放
        if let Some(snapshot) = snapshot {
            let _ = save_clip_history(snapshot); // 旧历史状态迁移 best-effort 写回
        }
        // 两个数都打：截断会在下一次落盘时把磁盘历史一起削掉（不可逆），一旦 read>kept
        // 而用户并没调低上限，就是「上限没落地」类 bug 复发（续145），日志里一眼可见。
        let kept = CLIP_CACHE.lock().unwrap().len();
        eprintln!(
            "[clip] loaded {} item(s) from history (read {}, cap {})",
            kept, read, CLIP_CACHE_MAX_RUNTIME.load(Ordering::Relaxed)
        );
    }
}

/// 把历史权威缓存原子写到磁盘（tmp → rename）。形参保留既有调用形状；写前会在串行锁内
/// 重新抓 CLIP_CACHE 最新快照，避免多个锁外写者把旧状态覆盖到新状态之上。
/// 调用方必须保证 CLIP_CACHE 锁与 CLIPBOARD_LOCK 均已释放后再调用（防重入死锁）。
fn save_clip_history(_snapshot: Vec<serde_json::Value>) -> Result<(), String> {
    let _save_guard = CLIP_HISTORY_SAVE_LOCK.lock().unwrap();
    let snapshot = CLIP_CACHE.lock().unwrap().clone();
    let Some(path) = CLIP_HISTORY_PATH.get() else { return Err("历史路径未初始化".into()); };
    let data = serde_json::to_string(&serde_json::json!({"version":1,"items":snapshot}))
        .map_err(|e| { eprintln!("[clip] serialize error: {e}"); format!("序列化失败: {e}") })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data)
        .map_err(|e| { eprintln!("[clip] write tmp error: {e}"); format!("写临时文件失败: {e}") })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| { eprintln!("[clip] rename error: {e}"); format!("落盘失败: {e}") })?;
    eprintln!("[clip] saved {} item(s) → {:?}", snapshot.len(), path);
    Ok(())
}

// ── 续148：D1 原图丢失窗口根治（raw 先落地 + 启动恢复）──────────────────────────
// 旧设计的唯一慢段是 PNG 编码（~689ms，CPU 密集）；崩在这段 = entry 已带 orig_path 落盘、
// 文件却永远不来 → 原图永久丢。但 RGBA 原始字节在本线程内存里现成，落盘它是纯 I/O
// （25MB ≈ 10-50ms）。故写盘改两段式：① 先落 {time}.raw（自描述头 + RGBA）——不可恢复窗口
// 从 ~689ms 压到本段；② PNG 编码照旧（此时已有 raw 兜底）；③ 成功删 raw。
// 崩在② → 下次启动 recover_pending_raws 从 raw 补出 PNG。崩在① 才是新的不可恢复残留
// （要归零只能同步写进监听循环、加宽采样塌缩，违反 R17/R20 既定权衡，不做）。

/// raw 恢复文件魔数。自描述布局：magic(4B) + w(u32 LE) + h(u32 LE) + RGBA(w*h*4B)。
const RAW_MAGIC: &[u8; 4] = b"WBRA";

/// 编码 raw 字节流。纯函数供单测。
fn encode_raw(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(12 + rgba.len());
    v.extend_from_slice(RAW_MAGIC);
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(rgba);
    v
}

/// 解码并严格校验 raw：魔数 / 非零宽高 / 总长 == 12 + w*h*4（全程 checked 溢出安全）。
/// 任一不符 → None（= 写了一半或损坏，调用方删除放弃）。纯函数供单测。
fn decode_raw(bytes: &[u8]) -> Option<(u32, u32, &[u8])> {
    if bytes.len() < 12 || !bytes.starts_with(RAW_MAGIC) { return None; }
    let w = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let h = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
    let expect = (w as usize).checked_mul(h as usize)?.checked_mul(4)?.checked_add(12)?;
    (w > 0 && h > 0 && bytes.len() == expect).then_some((w, h, &bytes[12..]))
}

/// `{time}.raw` 文件名 → time。恢复循环只认这个形态，别的文件一律不碰。纯函数供单测。
fn raw_name_time(name: &str) -> Option<i64> {
    name.strip_suffix(".raw")?.parse().ok()
}

/// PNG 编码 + 原子写（tmp→rename）到 path。抽自 save_clip_image_to_disk，启动恢复复用。
fn write_png_atomic(img: &image::DynamicImage, path: &std::path::Path, time: i64) -> Result<(), ()> {
    let tmp = path.with_extension("png.tmp");
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    if img.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
        eprintln!("[clip_img] PNG 编码失败 time={time}"); return Err(());
    }
    if std::fs::write(&tmp, cursor.into_inner()).is_err() {
        eprintln!("[clip_img] 写临时文件失败 time={time}"); return Err(());
    }
    std::fs::rename(&tmp, path).map_err(|e| { eprintln!("[clip_img] rename 失败 time={time}: {e}"); })
}

/// 把原图写到 clip_images/（续148 两段式：raw 先落地兜底 → PNG tmp→rename → 删 raw）。
/// 在 detached 线程内调用，不持任何锁。>MAX_ORIG_DIM 时等比缩放后存。失败仅 eprintln。
fn save_clip_image_to_disk(img: image::DynamicImage, w: u32, h: u32, time: i64) {
    // 计数守卫：编码/写盘中途任何 early-return 都要减回去，否则退出时会白等满超时
    struct WriteGuard(i64);
    impl Drop for WriteGuard {
        fn drop(&mut self) {
            PENDING_IMAGE_WRITE_TIMES.lock().unwrap().remove(&self.0);
            PENDING_IMAGE_WRITES.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let _wg = WriteGuard(time);
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
    // ① raw 先落地（纯 I/O 快段）。存 MAX_ORIG_DIM 钳制后的图——与 PNG 内容同源，
    //    恢复补出的 PNG 与未崩溃时一致。失败不阻断：退回旧设计的全窗口命运，仍继续编码。
    let raw_path = dir.join(format!("{time}.raw"));
    let rgba = save_img.to_rgba8();
    let (sw, sh) = (rgba.width(), rgba.height());
    if std::fs::write(&raw_path, encode_raw(sw, sh, rgba.as_raw())).is_err() {
        eprintln!("[clip_img] raw 落地失败 time={time}（本张丧失崩溃保护，继续编码）");
    }
    // ② PNG 编码（慢段，现有 raw 兜底）
    let ok = write_png_atomic(&save_img, &path, time).is_ok();
    // ③ 成功删 raw；失败留着 → 下次启动 recover_pending_raws 再补
    if ok {
        let _ = std::fs::remove_file(&raw_path);
        eprintln!("[clip_img] 原图已落盘 {time}.png ({w}×{h})");
    }
}

/// 启动恢复（续148）：把上次崩溃/强杀时「raw 已落地、PNG 没来得及编码」的原图补回来。
/// 纯文件级匹配（不看 entry）：{time}.raw ↔ {time}.png 配对。同步执行，**必须在
/// load_clip_history 之前**——PNG 补齐后，load 的悬空 orig_path 摘除才不会误摘。
/// 正常启动零代价（readdir 无 .raw 即返）；只有崩溃后那次启动才付出重编码耗时。
fn recover_pending_raws() {
    let Some(dir) = CLIP_IMAGE_DIR.get() else { return; };
    recover_pending_raws_in(dir);
}

/// 恢复主体与全局目录解耦，供端到端单测（临时目录驱动）。
fn recover_pending_raws_in(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return; };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let Some(time) = raw_name_time(&name) else { continue; };
        let raw_path = ent.path();
        let png_path = dir.join(format!("{time}.png"));
        if png_path.exists() {
            // 崩在「rename 成功 ↔ 删 raw」之间：PNG 已好，raw 纯多余
            let _ = std::fs::remove_file(&raw_path);
            continue;
        }
        // PNG 缺 → 从 raw 重编码补出。raw 损坏（写了一半）→ 删除放弃
        // （= 旧设计整个 689ms 窗口的命运，如今只剩 raw 落地前 ~10-50ms 段才有此结局）。
        let img = std::fs::read(&raw_path).ok()
            .and_then(|bytes| decode_raw(&bytes).map(|(w, h, rgba)| (w, h, rgba.to_vec())))
            .and_then(|(w, h, rgba)| image::RgbaImage::from_raw(w, h, rgba))
            .map(image::DynamicImage::ImageRgba8);
        match img {
            Some(img) => {
                if write_png_atomic(&img, &png_path, time).is_ok() {
                    eprintln!("[clip_img] 崩溃恢复：{time}.png 已从 raw 补回");
                } // 编码/写盘失败的错误已在 write_png_atomic 内打过；raw 照删（留着下轮也同样失败）
            }
            None => eprintln!("[clip_img] raw 损坏/写了一半，放弃恢复 time={time}"),
        }
        let _ = std::fs::remove_file(&raw_path);
    }
}

/// 退出前等待后台原图写盘收尾（最多 PENDING_WRITE_WAIT_MAX_MS）。
/// 只等、不阻断：超时就照常退出（丢一张原图 ≠ 值得卡住退出）。
/// **救不了强杀**（`tauri dev` 重建时进程被直接终止），那种情况下原图仍会丢——属已知边界。
pub(crate) fn wait_pending_image_writes() {
    let t = std::time::Instant::now();
    loop {
        let n = PENDING_IMAGE_WRITES.load(Ordering::Relaxed);
        if n == 0 {
            return;
        }
        if t.elapsed().as_millis() >= PENDING_WRITE_WAIT_MAX_MS as u128 {
            eprintln!("[clip_img] 退出前仍有 {n} 张原图未写完，超时放弃等待");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

/// 前端调用：直接返回缓存数据（毫秒级）
#[tauri::command]
pub(crate) fn get_clipboard_history() -> Vec<serde_json::Value> {
    // 性能优化步骤2：image 条目**剥掉 content**（≤1024px base64，动辄每条数 MB，30 条就把渲染进程
    // JS 堆撑到 200MB+）。前端只用缩略图显示（按 time 走 get_clip_thumbnail），真正需要原文时
    // （复制/粘贴/拖出/入中转）按 time 走 get_clip_content 现取。其余字段（time/orig_path/w/h/ahash）保留。
    CLIP_CACHE
        .lock()
        .unwrap()
        .iter()
        .map(|e| {
            if e["type"] == "image" {
                let mut e = e.clone();
                if let Some(obj) = e.as_object_mut() {
                    obj.remove("content");
                }
                e
            } else {
                e.clone()
            }
        })
        .collect()
}

/// 按 time 取某条剪贴板项的 content（图片 base64 data URL / 文本正文）。
/// get_clipboard_history 对图片剥了 content，前端在真正需要原文的动作里按 time 现取——
/// CLIP_CACHE 是权威、始终带完整 content。仅取 CLIP_CACHE 锁、零 Win32 剪贴板操作（不进 CLIPBOARD_LOCK）。
pub(crate) fn clip_content_by_time(time: i64) -> Option<String> {
    CLIP_CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["time"].as_i64() == Some(time))
        .and_then(|e| e["content"].as_str().map(|s| s.to_string()))
}

/// 前端按需取回某条 image 的完整 content（性能优化步骤2）。找不到 = None（条目已被挤出/删除）。
#[tauri::command]
pub(crate) fn get_clip_content(time: i64) -> Option<String> {
    clip_content_by_time(time)
}

/// 前端调用：按 time 字段删除缓存中的指定条目。
/// 返回 `Result` 让落盘失败能上报前端（续147）：前端乐观移除后若这里 Err，会从权威缓存回同步，
/// 不再「前端删了、磁盘没删 → 重启复活」。
#[tauri::command]
pub(crate) fn delete_clipboard_item(time: i64) -> Result<(), String> {
    let snap = {
        let mut cache = CLIP_CACHE.lock().unwrap();
        cache.retain(|e| e["time"].as_i64().unwrap_or(0) != time);
        cache.clone()
    }; // CLIP_CACHE 锁在此释放
    save_clip_history(snap)
}

/// 前端调用：清空全部剪贴板历史缓存。返回 `Result` 同 delete（续147）。
#[tauri::command]
pub(crate) fn clear_clipboard_history() -> Result<(), String> {
    {
        CLIP_CACHE.lock().unwrap().clear();
    } // CLIP_CACHE 锁在此释放
    save_clip_history(vec![])
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
    let _ = save_clip_history(snap); // best-effort：前端设定后已重拉历史，此处失败非致命
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
    fn GlobalFree(hMem: isize) -> isize; // 写入失败时回收未交给系统的 HGLOBAL，防泄漏
}

const CF_HDROP: u32 = 15;
const CF_DIB: u32 = 8;          // 设备无关位图（图片类目标：画图/Word/Chrome/聊天框）
const CF_UNICODETEXT: u32 = 13; // UTF-16 文本（控制台/纯文本目标：粘贴路径字符串）
const GMEM_MOVEABLE: u32 = 2;

/// 在【已 OpenClipboard + EmptyClipboard 的】剪贴板上挂一种格式（供多格式并挂复用）。
/// alloc HGLOBAL → 拷贝字节 → SetClipboardData；成功后系统接管句柄（不可再 Free），
/// 失败则 GlobalFree 回收防泄漏。**绝不自行 Open/Empty/Close**——由调用方统一管理会话。
fn set_clip_fmt(fmt: u32, bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if h == 0 { return Err(format!("GlobalAlloc 失败 (fmt={fmt})")); }
        let ptr = GlobalLock(h);
        if ptr.is_null() { GlobalFree(h); return Err(format!("GlobalLock 失败 (fmt={fmt})")); }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        GlobalUnlock(h);
        if SetClipboardData(fmt, h) == 0 { GlobalFree(h); return Err(format!("SetClipboardData 失败 (fmt={fmt})")); }
    }
    Ok(())
}

/// 构造 CF_HDROP 的 DROPFILES 载荷字节（fWide=1 UTF-16 路径、双 \0 结尾）。纯字节、不碰剪贴板，
/// 供 `write_cf_hdrop`（单格式写入）与 `copy_image_to_clipboard`（多格式并挂）共用。
fn build_hdrop_bytes(paths: &[String]) -> Vec<u8> {
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
    raw
}

/// RGBA（image crate 输出：top-down、每像素 R,G,B,A）→ CF_DIB 字节：
/// BITMAPINFOHEADER(40B, 32bpp BI_RGB) + 像素区。CF_DIB 惯例像素 **bottom-up** 排列、每像素 **BGRA**。
/// 截图不透明(A=255)；带透明的图，A 通道由粘贴目标各自解释（多数按不透明处理，与 Windows 常态一致）。
fn rgba_to_cf_dib(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = (w as usize) * 4;
    let img_size = stride * (h as usize);
    let mut out = Vec::with_capacity(40 + img_size);
    out.extend_from_slice(&40u32.to_le_bytes());              // biSize
    out.extend_from_slice(&(w as i32).to_le_bytes());         // biWidth
    out.extend_from_slice(&(h as i32).to_le_bytes());         // biHeight（正 = bottom-up）
    out.extend_from_slice(&1u16.to_le_bytes());               // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes());              // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes());               // biCompression = BI_RGB
    out.extend_from_slice(&(img_size as u32).to_le_bytes());  // biSizeImage
    out.extend_from_slice(&0i32.to_le_bytes());               // biXPelsPerMeter
    out.extend_from_slice(&0i32.to_le_bytes());               // biYPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes());               // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes());               // biClrImportant
    for y in (0..h as usize).rev() {                          // 底行在前
        let row = &rgba[y * stride..y * stride + stride];
        for px in row.chunks_exact(4) {
            out.push(px[2]); // B
            out.push(px[1]); // G
            out.push(px[0]); // R
            out.push(px[3]); // A
        }
    }
    out
}

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
    let raw = build_hdrop_bytes(paths);

    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, raw.len());
        if h == 0 { return Err("GlobalAlloc 失败".into()); }
        let ptr = GlobalLock(h);
        if ptr.is_null() { GlobalFree(h); return Err("GlobalLock 失败".into()); }
        std::ptr::copy_nonoverlapping(raw.as_ptr(), ptr, raw.len());
        GlobalUnlock(h);
        // OpenClipboard 失败（被占用）→ 我们仍持有 h，必须 GlobalFree 否则泄漏；且绝不能静默返回 Ok
        //（那正是「三态契约」要防的写入侧静默丢失——写没成却报成功，上层推进 seq、条目凭空消失）。
        if OpenClipboard(0) == 0 { GlobalFree(h); return Err("OpenClipboard 失败（剪贴板被占用）".into()); }
        EmptyClipboard();
        // SetClipboardData 成功后系统接管 h（不可再 Free）；失败则所有权仍在我们手里，需 Free。
        let set_ok = SetClipboardData(CF_HDROP, h) != 0;
        CloseClipboard();
        if !set_ok { GlobalFree(h); return Err("SetClipboardData 失败".into()); }
    }
    Ok(())
}

/// 将文件路径列表写回剪贴板（CF_HDROP 格式）或桌面落地 + 粘贴
#[tauri::command]
pub(crate) fn set_clipboard_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    use enigo::Direction::{Press, Release};
    use enigo::Keyboard;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    // 脱敏：只记条数，不逐条打印完整文件路径（可能泄露目录结构/文件名）。
    println!("[filepaste] paths count={}", paths.len());

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
        CoTaskMemFree(Some(raw.0 as *mut _)); // 释放 SHGetKnownFolderPath 分配的缓冲（返回 unit）
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
pub(crate) fn set_clipboard_image(app: AppHandle, base64: String, orig_path: Option<String>, time: Option<i64>) -> Result<(), String> {
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
                    if orig_path.is_some() {
                        mark_clip_original_degraded(&app, time, orig_path.as_deref(), "paste-fallback");
                    }
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
                if orig_path.is_some() {
                    mark_clip_original_degraded(&app, time, orig_path.as_deref(), "paste-fallback");
                }
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
                if orig_path.is_some() {
                    mark_clip_original_degraded(&app, time, orig_path.as_deref(), "paste-fallback");
                }
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
                if orig_path.is_some() {
                    mark_clip_original_degraded(&app, time, orig_path.as_deref(), "paste-fallback");
                }
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
pub(crate) fn copy_image_to_clipboard(app: AppHandle, base64: String, orig_path: Option<String>, time: Option<i64>) -> Result<(), String> {
    // 「只复制」按钮：一次性把图片以**多种剪贴板格式并挂**，让任意粘贴目标各取所需——
    //   · CF_DIB       位图 → 画图/Word/Chrome/聊天框（内嵌图片）
    //   · CF_HDROP     文件 → 桌面/资源管理器（粘出 PNG 文件）
    //   · CF_UNICODETEXT 路径 → cmd/Terminal（粘出路径文本）
    // 不隐藏窗口、不 Ctrl+V（区别于 set_clipboard_image 四分叉的「取走粘贴」），故无需检测前台。
    // Windows 剪贴板原生支持多格式共存，目标程序按自身能力挑最合适的一种。
    //
    // 落一个 PNG 文件（CF_HDROP + 文本路径都指向它）：大图复用已落盘 orig_path（零重编码）；
    // 无 orig 的小图现解 base64 写一份 workbench_clip_*.png 到 clip_images/——不被任何 orig_path
    // 引用，由 janitor 当孤儿清理兜底（与 set_clipboard_image 的资源管理器分支同款，无脆弱定时 race）。
    let png_path: String = match orig_path.as_deref() {
        Some(p) if std::path::Path::new(p).exists() => p.to_string(),
        _ if !base64.is_empty() => {
            if orig_path.is_some() {
                mark_clip_original_degraded(&app, time, orig_path.as_deref(), "consume-fallback");
            }
            let b64 = if let Some(c) = base64.find(',') { &base64[c + 1..] } else { &base64 };
            let bytes = base64_decode(b64).ok_or("base64 解码失败")?;
            let dir = CLIP_IMAGE_DIR.get().cloned().unwrap_or_else(std::env::temp_dir);
            let tmp = dir.join(format!("workbench_clip_{}.png", now_ms()));
            std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件: {}", e))?;
            tmp.to_string_lossy().into_owned()
        }
        _ => return Err("无图片数据".into()),
    };

    // CF_DIB 用的 RGBA：从刚确定的 png_path 单路解码（一条来源，避免 orig/base64 两套分支）。
    // 文件 I/O 与解码都在锁外（CLIPBOARD_LOCK 只罩下面的 Open…Close 临界区）。
    let (w, h, raw) = {
        let bytes = std::fs::read(&png_path).map_err(|e| format!("读图: {}", e))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析: {}", e))?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        (w, h, rgba.into_raw())
    };
    let dib = rgba_to_cf_dib(w, h, &raw);
    let hdrop = build_hdrop_bytes(std::slice::from_ref(&png_path));
    let mut text: Vec<u8> = Vec::with_capacity((png_path.len() + 1) * 2);
    for c in png_path.encode_utf16().chain(std::iter::once(0)) { text.extend_from_slice(&c.to_ne_bytes()); }

    // 单个 Open/Empty/Set×3/Close 会话内挂全部格式（不可分次 Open——第二次 Open 需重新 Empty 会
    // 抹掉前一次写入）。SKIP_CLIP_EVENTS + suppress 防自写内容回流历史面板（同其余 copy_* 路径）。
    SKIP_CLIP_EVENTS.store(2, Ordering::SeqCst);
    let _sg = SkipGuard; // 防中途 return/? 留下计数残留（吃掉真实复制）
    {
        let _guard = CLIPBOARD_LOCK.lock().unwrap(); // 与监听读串行，防并发 OpenClipboard 撞 1418
        unsafe {
            if OpenClipboard(0) == 0 { return Err("OpenClipboard 失败（剪贴板被占用）".into()); }
            EmptyClipboard();
        }
        // 任一格式失败即中止：已挂上的格式其句柄已交给系统（不回收），未挂的在 set_clip_fmt 内已 Free。
        let r = set_clip_fmt(CF_DIB, &dib)
            .and_then(|_| set_clip_fmt(CF_HDROP, &hdrop))
            .and_then(|_| set_clip_fmt(CF_UNICODETEXT, &text));
        unsafe { CloseClipboard(); }
        r?;
    }
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
/// 当前会话里仍引用已删原图的 entry 会立即持久化 `orig_degraded`，前端同步显示缩略图降级。
#[tauri::command]
pub(crate) fn clear_clip_image_cache(app: AppHandle) -> Result<(), String> {
    let Some(dir) = CLIP_IMAGE_DIR.get() else { return Ok(()); };
    // 最多等待现有写线程正常收尾；若超时则拒绝清空，避免命令返回后 PNG 又被补写回来。
    wait_pending_image_writes();
    let pending = PENDING_IMAGE_WRITES.load(Ordering::Relaxed);
    if pending > 0 {
        return Err(format!("仍有 {pending} 张原图正在写入，请稍后重试"));
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取图片缓存失败: {e}"))?;
    let mut failures = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if let Err(e) = std::fs::remove_file(&path) {
                    failures.push(format!("{}: {e}", path.display()));
                }
            }
            Err(e) => failures.push(format!("读取目录项失败: {e}")),
        }
    }
    mark_all_clip_originals_degraded(&app);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("部分图片缓存未能删除: {}", failures.join("; ")))
    }
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
/// 续146d：判定一个未被引用的临时文件（`.tmp` / 续148 的 `.raw`）是否应保留（正在写盘、别当孤儿删）。
/// 非临时后缀恒 false（正常孤儿逻辑照走）；临时文件年轻于保护期则保留；年龄读不出 → 保守判「可删」
/// （与本次修复前的旧行为一致，不因 mtime 偶发读失败而永久泄漏）。抽出纯函数只为可确定性测试。
/// `.raw` 同款：写盘线程先落 raw 再慢速编码 PNG（续148），sweep 插在期间删 raw 会毁掉崩溃恢复源；
/// 老的 .raw = 崩溃且启动恢复也失败的残留 → 照孤儿清。
fn tmp_write_in_flight(name: &str, age_ms: Option<u128>) -> bool {
    (name.ends_with(".tmp") || name.ends_with(".raw"))
        && age_ms.is_some_and(|a| a < CLIP_TMP_GRACE_MS as u128)
}

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
            // 续146d：在写的 .tmp（{time}.png.tmp）也永不在 referenced 里，但删它会打断 tmp→rename。
            // 年轻的 .tmp = 正在写盘 → 跳过；老的 .tmp = 崩溃遗留 → 照孤儿清（防泄漏）。
            let age_ms = entry.metadata().ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_millis());
            if tmp_write_in_flight(&name, age_ms) { continue; }
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
        let _guard = crate::ThreadExitGuard("clip_image_janitor"); // M5-A
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
    let mut r = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b0=c[0]; let b1=if c.len()>1{c[1]}else{0}; let b2=if c.len()>2{c[2]}else{0};
        let n=(b0 as u32)<<16|(b1 as u32)<<8|b2 as u32;
        r.push(C[((n>>18)&0x3F) as usize] as char); r.push(C[((n>>12)&0x3F) as usize] as char);
        if c.len()>1{r.push(C[((n>>6)&0x3F) as usize] as char)}else{r.push('=')}
        if c.len()>2{r.push(C[(n&0x3F) as usize] as char)}else{r.push('=')}
    }
    r
}

pub(crate) fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut buf=Vec::with_capacity(s.len()*3/4); let mut a=0u32; let mut b=0u32;
    for c in s.chars() {
        let v=match c{'A'..='Z'=>c as u32-65,'a'..='z'=>c as u32-71,'0'..='9'=>c as u32+4,'+'=>62,'/'=>63,'='=>break,_=>continue};
        a=(a<<6)|v; b+=6; if b>=8{b-=8; buf.push((a>>b) as u8)}
    }
    Some(buf)
}

/// 续143：把中转区图片项物化成**持久** PNG 文件、返回路径——供「拖图片项到启动台」加入收藏。
/// 与 dragout::image_to_file 的区别：那份产 temp 文件（OLE 拖出后即弃），启动台收藏是长期项，不能指向
/// 会被清理的 temp、也不能指向 janitor 管上限的 clip_images/（会被从旧删到上限以下）。故写到独立的
/// app_data/launcher_images/（无 janitor、随收藏长存）。取图优先 orig_path 全图（大图），否则 base64 content。
#[tauri::command]
pub(crate) fn save_image_as_launcher_file(
    app: AppHandle,
    base64: Option<String>,
    orig_path: Option<String>,
) -> Result<String, String> {
    let bytes: Vec<u8> = match orig_path.as_deref() {
        Some(op) if std::path::Path::new(op).exists() => {
            std::fs::read(op).map_err(|e| format!("读原图失败: {e}"))?
        }
        _ => {
            let raw = base64.as_deref().ok_or("图片无内容")?;
            // 去 data-url 前缀（content 形如 "data:image/png;base64,...."），否则前缀会被解码成垃圾字节
            let stripped = match raw.find(',') {
                Some(i) if raw[..i].contains("base64") => &raw[i + 1..],
                _ => raw,
            };
            base64_decode(stripped).ok_or("base64 解码失败")?
        }
    };
    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 不可用: {e}"))?
        .join("launcher_images");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    let path = dir.join(format!("clip_{}.png", now_ms()));
    std::fs::write(&path, &bytes).map_err(|e| format!("写文件失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// ── 启动入口（封装 setup 时序，顺序不可变）──────────────────────
/// 剪贴板子系统初始化：路径 → 上限 → load_clip_history → start_clipboard_monitor → janitor。
/// 顺序绝对不能变：① 路径必须最先（load/save 依赖 OnceLock）；② **上限必须先于 load**
/// （load 末尾按上限截断，用默认 20 去截会永久削掉磁盘历史，续145）；③ load 必须在 monitor 之前
/// （否则监听写盘会用空缓存覆盖磁盘历史）；④ janitor 靠起手 5s 软时序错开 load，防误删原图。
pub(crate) fn init(app: &AppHandle, data_dir: &std::path::Path) {
    // 1. 路径初始化（必须最先）
    let _ = std::fs::create_dir_all(data_dir);
    let history_path = data_dir.join("clip_history.json");
    let image_dir = data_dir.join("clip_images");
    let _ = std::fs::create_dir_all(&image_dir);
    let _ = CLIP_HISTORY_PATH.set(history_path);
    let _ = CLIP_IMAGE_DIR.set(image_dir);
    // 2. 历史上限同步落地（必须在 load 之前）：前端 set_clip_cache_max 晚几百毫秒才到，
    //    等它就来不及了——load 已用默认 20 截过，随后任一次落盘即把磁盘历史永久削到 20。
    if let Some(n) = read_clip_cache_max_from_store(data_dir) {
        CLIP_CACHE_MAX_RUNTIME.store(n, Ordering::Relaxed);
        eprintln!("[clip] 历史上限按 store 落地：{n}");
    }
    // 2.5 崩溃恢复（续148）：上次死亡时 raw 已落地但 PNG 未编码的原图补回来。
    //     必须在 load 之前——PNG 补齐后，load 的悬空 orig_path 摘除才不会误摘。
    recover_pending_raws();
    // 3. 读历史（必须在 monitor 之前，否则监听写盘会覆盖磁盘历史）
    load_clip_history();
    // 4. 启动事件通知源（续129）。放在 monitor 之前只为让 monitor 一起手就有事件可等；
    //    二者无强时序依赖——它失败也只是 monitor 退回 CLIP_POLL_MS 轮询。
    start_clipboard_listener();
    // 5. 启动监听（必须在 load 之后）
    start_clipboard_monitor(app.clone());
    // 6. 启动 janitor（sleep CLIP_IMAGE_SWEEP_INITIAL_MS=5s 软时序错开，保证 load 完成再 sweep）
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

    #[test]
    fn orig_degraded_normalization_distinguishes_small_and_lost_originals() {
        // 正常小图从来不需要 orig_path，不能误标。
        let mut small = serde_json::json!({"type":"image","w":800,"h":600});
        assert!(!normalize_orig_degraded(&mut small, |_| false));
        assert_ne!(small["orig_degraded"].as_bool(), Some(true));
        let mut boundary = serde_json::json!({"type":"image","w":1024,"h":1024});
        assert!(!normalize_orig_degraded(&mut boundary, |_| false));

        // 旧大图没留下路径，但尺寸能证明原图曾被缩小 → 标记降级。
        let mut large = serde_json::json!({"type":"image","w":1025,"h":600});
        assert!(normalize_orig_degraded(&mut large, |_| false));
        assert_eq!(large["orig_degraded"].as_bool(), Some(true));
        assert!(!normalize_orig_degraded(&mut large, |_| false)); // 幂等

        // 悬空路径保留，供状态识别/未来恢复；路径恢复后清掉标记。
        let mut missing = serde_json::json!({
            "type":"image","w":2000,"h":1200,"orig_path":"C:/lost.png"
        });
        assert!(normalize_orig_degraded(&mut missing, |_| false));
        assert_eq!(missing["orig_path"].as_str(), Some("C:/lost.png"));
        assert_eq!(missing["orig_degraded"].as_bool(), Some(true));
        assert!(normalize_orig_degraded(&mut missing, |_| true));
        assert_ne!(missing["orig_degraded"].as_bool(), Some(true));

        // 尺寸和路径都没有的旧条目不猜；非图片完全不碰。
        let mut unknown = serde_json::json!({"type":"image"});
        assert!(!normalize_orig_degraded(&mut unknown, |_| false));
        let mut text = serde_json::json!({"type":"text","orig_degraded":true});
        assert!(!normalize_orig_degraded(&mut text, |_| false));
    }

    /// 续146d 竞态回归钉：janitor 孤儿判定必须放过「正在写盘」的 .tmp，又不能永久漏掉崩溃遗留的 .tmp。
    #[test]
    fn tmp_grace_protects_in_flight_not_stale() {
        // .tmp 且年轻 → 正在写，保留
        assert!(tmp_write_in_flight("1730000000000.png.tmp", Some(0)));
        assert!(tmp_write_in_flight("1730000000000.png.tmp", Some(CLIP_TMP_GRACE_MS as u128 - 1)));
        // .tmp 但超期 → 崩溃遗留，可清
        assert!(!tmp_write_in_flight("1730000000000.png.tmp", Some(CLIP_TMP_GRACE_MS as u128)));
        assert!(!tmp_write_in_flight("1730000000000.png.tmp", Some(u128::MAX)));
        // .tmp 但 mtime 读不出 → 保守可清（同修复前旧行为，绝不因偶发读失败永久泄漏）
        assert!(!tmp_write_in_flight("1730000000000.png.tmp", None));
        // 非 .tmp → 恒 false，正常孤儿逻辑不受影响
        // 续148：.raw 同款在写保护（写盘线程先落 raw 再编码 PNG，sweep 不得删在写的恢复源）
        assert!(tmp_write_in_flight("1730000000000.raw", Some(0)));
        assert!(tmp_write_in_flight("1730000000000.raw", Some(CLIP_TMP_GRACE_MS as u128 - 1)));
        assert!(!tmp_write_in_flight("1730000000000.raw", Some(CLIP_TMP_GRACE_MS as u128)));
        assert!(!tmp_write_in_flight("1730000000000.png", Some(0)));
        assert!(!tmp_write_in_flight("orphan.png", None));
    }

    /// 续148：raw 恢复文件编解码——roundtrip 保真；魔数错/截断/尺寸不符/零宽高/溢出 一律拒。
    #[test]
    fn raw_codec_roundtrip_and_rejects() {
        let rgba = vec![7u8; 4 * 4 * 4]; // 4×4 图
        let bytes = encode_raw(4, 4, &rgba);
        let (w, h, back) = decode_raw(&bytes).expect("合法 raw 必须解码");
        assert_eq!((w, h), (4, 4));
        assert_eq!(back, &rgba[..]);
        // 魔数错
        let mut bad = bytes.clone(); bad[0] = b'X';
        assert!(decode_raw(&bad).is_none());
        // 截断（写了一半）：少 1 字节 / 只有头的前半截
        assert!(decode_raw(&bytes[..bytes.len() - 1]).is_none());
        assert!(decode_raw(&bytes[..8]).is_none());
        // 尺寸字段与实长不符
        assert!(decode_raw(&encode_raw(8, 8, &rgba)).is_none());
        // 零宽高
        assert!(decode_raw(&encode_raw(0, 4, &[])).is_none());
        // 尺寸溢出（u32 极大值相乘）不得 panic、必须拒
        assert!(decode_raw(&encode_raw(u32::MAX, u32::MAX, &[])).is_none());
    }

    /// 续148 诊断：分段计时真实写盘路径（3200×1987 大图，debug 构建）。
    /// 目的：实测「raw 落地」距起点多久——它决定崩溃窗口的实际宽度。
    /// 手动跑：cargo test write_path_stage_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn write_path_stage_timing() {
        let dir = std::env::temp_dir()
            .join(format!("wb_timing_{}_{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (3200u32, 1987u32);
        let img = image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_pixel(w, h, image::Rgba([128, 64, 32, 255])));

        let t0 = std::time::Instant::now();
        let rgba = img.to_rgba8();
        let t_rgba = t0.elapsed();

        let raw_bytes = encode_raw(w, h, rgba.as_raw());
        let t_encode_raw = t0.elapsed();

        std::fs::write(dir.join("x.raw"), &raw_bytes).unwrap();
        let t_raw_written = t0.elapsed();

        write_png_atomic(&img, &dir.join("x.png"), 1).unwrap();
        let t_png_done = t0.elapsed();

        eprintln!("to_rgba8: {t_rgba:?} | +encode_raw: {t_encode_raw:?} | +raw落盘: {t_raw_written:?} | +PNG完成: {t_png_done:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 续148：恢复循环只认 `{time}.raw` 形态，别的文件一律不碰。
    #[test]
    fn raw_name_parse() {
        assert_eq!(raw_name_time("1730000000000.raw"), Some(1730000000000));
        assert_eq!(raw_name_time("1730000000000.png"), None);
        assert_eq!(raw_name_time("1730000000000.png.tmp"), None);
        assert_eq!(raw_name_time("abc.raw"), None);
        assert_eq!(raw_name_time(".raw"), None);
    }

    /// 续148：恢复闭环端到端（临时目录驱动）——raw 在/PNG 缺 → 补出 PNG 且像素逐字节一致；
    /// PNG 已在 → raw 纯多余被删；raw 损坏（写了一半）→ 删除且不产 PNG。
    #[test]
    fn recover_pending_raws_end_to_end() {
        let dir = std::env::temp_dir()
            .join(format!("wb_recover_test_{}_{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255])));
        let rgba = img.to_rgba8();
        // 情形1：raw 在、PNG 缺 → 应恢复
        std::fs::write(dir.join("100.raw"), encode_raw(8, 8, rgba.as_raw())).unwrap();
        // 情形2：PNG 已在 → raw 应被当多余删掉
        std::fs::write(dir.join("200.raw"), encode_raw(8, 8, rgba.as_raw())).unwrap();
        write_png_atomic(&img, &dir.join("200.png"), 200).unwrap();
        // 情形3：raw 写了一半（截断）→ 应删除且不产 PNG
        std::fs::write(dir.join("300.raw"), &encode_raw(8, 8, rgba.as_raw())[..20]).unwrap();

        recover_pending_raws_in(&dir);

        // 1：PNG 补回、raw 已删、解码像素与原图逐字节一致（PNG 无损）
        let back = image::open(dir.join("100.png")).unwrap().to_rgba8();
        assert_eq!(back.as_raw(), rgba.as_raw());
        assert!(!dir.join("100.raw").exists());
        // 2：raw 已删、PNG 原样保留
        assert!(!dir.join("200.raw").exists());
        assert!(dir.join("200.png").exists());
        // 3：raw 已删、不产 PNG
        assert!(!dir.join("300.raw").exists());
        assert!(!dir.join("300.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多格式并挂（copy_image_to_clipboard）的 CF_DIB 载荷回归钉：BITMAPINFOHEADER 关键字段 +
    /// RGBA→BGRA 换序 + bottom-up 行序。这三点任一错，粘出来就是偏色/上下颠倒/尺寸错乱。
    #[test]
    fn rgba_to_cf_dib_header_and_bgra_bottom_up() {
        // 2×2，top-down RGBA；四像素取不同值以钉住换序与行序
        let rgba: Vec<u8> = vec![
            10, 20, 30, 255, /*(0,0)*/ 11, 21, 31, 255, /*(1,0) 顶行*/
            12, 22, 32, 255, /*(0,1)*/ 13, 23, 33, 255, /*(1,1) 底行*/
        ];
        let dib = rgba_to_cf_dib(2, 2, &rgba);
        assert_eq!(dib.len(), 40 + 16, "40B 头 + 2×2×4B 像素");
        assert_eq!(&dib[0..4], &40u32.to_le_bytes(), "biSize");
        assert_eq!(&dib[4..8], &2i32.to_le_bytes(), "biWidth");
        assert_eq!(&dib[8..12], &2i32.to_le_bytes(), "biHeight 正 = bottom-up");
        assert_eq!(&dib[12..14], &1u16.to_le_bytes(), "biPlanes");
        assert_eq!(&dib[14..16], &32u16.to_le_bytes(), "biBitCount");
        assert_eq!(&dib[16..20], &0u32.to_le_bytes(), "biCompression=BI_RGB");
        assert_eq!(&dib[20..24], &16u32.to_le_bytes(), "biSizeImage");
        // 像素：底行(y=1)在前，每像素 BGRA
        let expected: Vec<u8> = vec![
            32, 22, 12, 255, /*(0,1)*/ 33, 23, 13, 255, /*(1,1)*/
            30, 20, 10, 255, /*(0,0)*/ 31, 21, 11, 255, /*(1,0)*/
        ];
        assert_eq!(&dib[40..], &expected[..], "BGRA 换序 + bottom-up 行序");
    }

    /// CF_HDROP 载荷回归钉：DROPFILES 头（pFiles=20 偏移、fWide=1）+ UTF-16 路径 + 双 \0 结尾。
    #[test]
    fn build_hdrop_bytes_dropfiles_layout() {
        let raw = build_hdrop_bytes(std::slice::from_ref(&"C:\\a.png".to_string()));
        assert_eq!(&raw[0..4], &20u32.to_ne_bytes(), "pFiles 偏移");
        assert_eq!(&raw[16..20], &1u32.to_ne_bytes(), "fWide=1（UTF-16 路径）");
        // 路径区：UTF-16「C:\a.png」+ \0，再补一个 \0 结尾 → 末尾必是 4 字节全 0（两个 u16 NUL）
        assert_eq!(&raw[raw.len() - 4..], &[0u8, 0, 0, 0], "路径 NUL + 列表双 \\0 结尾");
        let path16: Vec<u16> = "C:\\a.png".encode_utf16().collect();
        let mut path_bytes = Vec::new();
        for c in &path16 { path_bytes.extend_from_slice(&c.to_ne_bytes()); }
        assert_eq!(&raw[20..20 + path_bytes.len()], &path_bytes[..], "UTF-16 路径正文");
    }

    /// 续145 数据丢失根因的回归钉：历史上限必须能在 setup 阶段**直接从 store 文件**读出来。
    /// 这条一旦破（读不出 → None → 保留默认 20），`load_clip_history` 就会把用户设成 100 的
    /// 历史截成 20，并在下一次落盘时永久写回磁盘——零报错、每次重启丢一批。
    #[test]
    fn clip_cache_max_read_from_store_file() {
        let dir = std::env::temp_dir().join(format!("wb_clipmax_test_{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("workbench-data.json");

        // 正常值：读得出、原样返回（这是修复前拿不到、于是退回 20 的那个值）
        std::fs::write(&store, r#"{"theme":"dark","clip-cache-max":100}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), Some(100));

        // 下界/上界都算合法（与 set_clip_cache_max 的 clamp 同界）
        std::fs::write(&store, r#"{"clip-cache-max":10}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), Some(10));

        // 越界/类型不对/键缺失/文件损坏 → None，调用方保留默认，绝不拿脏值去截历史
        std::fs::write(&store, r#"{"clip-cache-max":9}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None, "越界值不得被采纳");
        std::fs::write(&store, r#"{"clip-cache-max":101}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None, "越界值不得被采纳");
        std::fs::write(&store, r#"{"clip-cache-max":"100"}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None, "字符串不得被当数字");
        std::fs::write(&store, r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None, "键缺失 → 默认");
        std::fs::write(&store, "{ not json").unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None, "损坏文件 → 默认");

        // 文件不存在 → None（首次安装）
        std::fs::remove_file(&store).unwrap();
        assert_eq!(read_clip_cache_max_from_store(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
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

#[cfg(test)]
mod probe_png {
    /// 探针（续146d）：量原图 PNG 编码耗时——它决定「orig_path 已落盘、文件却还没写完」这个
    /// 危险窗口有多宽。窗口内进程退出 → 原图永久丢失，拖出/粘贴静默退化成 1024px 缩略图。
    /// 跑：`cargo test --lib probe_png -- --ignored --nocapture`
    ///
    /// 实测（本机，全屏截图 3192×1970）：
    /// - 依赖未优化：**3328 ms**
    /// - png/miniz_oxide/flate2/image 开 opt-level=3（现设置）：**689 ms**，4.8×
    ///
    /// **`CompressionType::Fast` 已实测证伪、别再试**：耗时与体积与默认完全相同（3367ms/7237KB
    /// vs 3195ms/7237KB），该参数在当前 image 版本下对本路径无效。真正的杠杆只有优化级别。
    #[test]
    #[ignore]
    fn png_encode_cost_by_size() {
        for (w, h) in [(1095u32, 631u32), (1512, 839), (3192, 1970)] {
            // 造带图案的图：纯色会被压到接近 0，测不出真实代价
            let mut buf = image::RgbaImage::new(w, h);
            for (x, y, p) in buf.enumerate_pixels_mut() {
                *p = image::Rgba([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 239) as u8, 255]);
            }
            let img = image::DynamicImage::ImageRgba8(buf);
            let t = std::time::Instant::now();
            let mut cur = std::io::Cursor::new(Vec::<u8>::new());
            img.write_to(&mut cur, image::ImageFormat::Png).unwrap();
            println!(
                "{w}×{h}: 编码 {} ms, 产出 {} KB",
                t.elapsed().as_millis(),
                cur.into_inner().len() / 1024
            );
        }
    }
}
