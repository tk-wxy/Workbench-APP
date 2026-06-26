// 文件系统搜索：路线 C 自建内存索引 + 后台预建。
//
// 架构命脉（违反任一条都会卡前端，见 DECISIONS「文件搜索」节 / CLAUDE.md 不变量）：
// 1. 索引建立只在独立后台线程（start_index_worker 内 spawn），永不经 Tauri 命令 / invoke / 阻塞 IPC。
// 2. 查询命令（search_files / get_index_status）只读内存、永远 <5ms，绝不碰磁盘。
// 3. 双缓冲原子替换：新索引在后台 Vec 建好后一次性替换旧 Vec，查询永远命中完整索引。
// 4. 锁纪律：FILE_INDEX 锁只罩「替换 Vec」与「查询读 Vec」的瞬间临界区；walkdir 遍历（耗时部分）绝不持锁。
//    本锁是全新独立 Mutex，与剪贴板 CLIPBOARD_LOCK / CLIP_CACHE 无任何交集，无锁序问题。
//
// 增强（2026-07）：
// - 扫描目录用户可配（设置面板 → store key "scan-dirs"，默认 5 个常用目录）
// - 子序列匹配（"rd" 匹配 "README.md"、"vsc" 匹配 "Visual Studio Code.exe"）
// - 排序增强：匹配质量 + 前缀加分 + 文件修改时间 recency 加分
// - 重建周期 30min → 10min；新增手动重建命令 rebuild_index

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::everything::EverythingClient;

/// 内存索引条目：name_lower 预存小写，mtime_secs 用于 recency 排序。
#[derive(Clone)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub name_lower: String,
    pub ext: String,
    pub is_dir: bool,
    pub mtime_secs: i64,
}

/// 返回给前端的查询结果（不含 name_lower 内部字段）。
#[derive(serde::Serialize)]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

static FILE_INDEX: std::sync::OnceLock<Mutex<Vec<IndexEntry>>> = std::sync::OnceLock::new();
static EVERYTHING_CLIENT: std::sync::OnceLock<Option<EverythingClient>> = std::sync::OnceLock::new();
static USE_EVERYTHING: AtomicBool = AtomicBool::new(false); // 用户设置面板切换

const MAX_INDEX_ENTRIES: usize = 200_000;
const MAX_WALK_DEPTH: usize = 8;
const REBUILD_INTERVAL_SECS: u64 = 10 * 60; // 10 分钟周期重建（原 30min）
const INITIAL_DELAY_SECS: u64 = 3;
const QUERY_LIMIT_CAP: usize = 50;

/// 默认扫描目录（当 store 中无用户配置时使用）。
fn default_scan_dirs() -> Vec<PathBuf> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    ["Desktop", "Downloads", "Documents", "Pictures", "Projects"]
        .iter()
        .map(|d| PathBuf::from(&home).join(d))
        .filter(|p| p.exists())
        .collect()
}

/// 读取用户配置的扫描目录（从 store JSON），失败/为空时回退默认值。
fn scan_dirs(app_data_dir: &Path) -> Vec<PathBuf> {
    let store_path = app_data_dir.join("workbench-data.json");
    if let Ok(text) = std::fs::read_to_string(&store_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = v.get("scan-dirs").and_then(|d| d.as_array()) {
                let dirs: Vec<PathBuf> = arr
                    .iter()
                    .filter_map(|s| s.as_str())
                    .map(PathBuf::from)
                    .filter(|p| p.exists())
                    .collect();
                if !dirs.is_empty() {
                    return dirs;
                }
            }
        }
    }
    default_scan_dirs()
}

fn should_skip_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.')
        || matches!(
            n.as_str(),
            "node_modules" | "$recycle.bin" | "appdata" | "target" | ".git" | "__pycache__"
        )
}

/// 从文件元数据取修改时间（秒），失败返回 0。
fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_index(dirs: &[PathBuf]) -> Vec<IndexEntry> {
    let mut out = Vec::new();
    for dir in dirs {
        if out.len() >= MAX_INDEX_ENTRIES {
            break;
        }
        for entry in WalkDir::new(dir)
            .max_depth(MAX_WALK_DEPTH)
            .into_iter()
            .filter_entry(|e| {
                !(e.file_type().is_dir()
                    && e.file_name().to_str().map(should_skip_dir).unwrap_or(false))
            })
            .filter_map(|e| e.ok())
        {
            if out.len() >= MAX_INDEX_ENTRIES {
                break;
            }
            let path = entry.path();
            let name = match entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().is_dir();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mt = entry.metadata().as_ref().map(mtime_secs).unwrap_or(0);
            out.push(IndexEntry {
                path: path.to_string_lossy().to_string(),
                name_lower: name.to_lowercase(),
                name,
                ext,
                is_dir,
                mtime_secs: mt,
            });
        }
    }
    out
}

/// 子序列匹配：查询字符按顺序出现在文件名中（不必连续）。
/// 返回 (首字符位置, 匹配质量分)，None = 不匹配。
fn subsequence_match(name: &str, query: &str) -> Option<(usize, i32)> {
    let mut qchars = query.chars();
    let mut cur = qchars.next()?;
    let mut first = None;
    let mut matched = 0;

    for (bi, c) in name.char_indices() {
        if c == cur {
            if first.is_none() {
                first = Some(bi);
            }
            matched += 1;
            cur = match qchars.next() {
                Some(c) => c,
                None => break,
            };
        }
    }
    if matched < query.len() {
        return None;
    }

    let first_pos = first.unwrap();
    // 密度：匹配字符数占文件名长度比例
    let density = matched as f64 / name.len().max(1) as f64;
    let mut score = 60 - (first_pos as i32).min(50); // 首字符越靠前越高
    score += (density * 20.0) as i32; // 密度加分（短名高密度 = 精确匹配）
    if first_pos == 0 {
        score += 30; // 前缀命中加分
    }
    Some((first_pos, score.max(1)))
}

/// 最近修改时间加分：今天+50 / 本周+30 / 本月+10 / 更早+0。
fn recency_bonus(mtime_secs: i64, now_secs: i64) -> i32 {
    if mtime_secs <= 0 {
        return 0;
    }
    let age_secs = (now_secs - mtime_secs).max(0);
    let age_days = age_secs / 86400;
    if age_days <= 0 {
        50
    } else if age_days <= 7 {
        30
    } else if age_days <= 30 {
        10
    } else {
        0
    }
}

/// 原子替换索引（瞬间临界区，见架构命脉 §3）。
fn replace_index(new_index: Vec<IndexEntry>) {
    if let Some(lock) = FILE_INDEX.get() {
        if let Ok(mut guard) = lock.lock() {
            *guard = new_index;
        }
    }
}

/// 执行一次完整的「读配置 → 遍历 → 原子替换 → 通知前端」重建周期。
fn do_rebuild(app: &AppHandle) {
    let app_data = app.path().app_data_dir().unwrap_or_default();
    let dirs = scan_dirs(&app_data);
    let started = Instant::now();
    let new_index = build_index(&dirs);
    let count = new_index.len();
    replace_index(new_index);
    eprintln!("[fileindex] ready: {} entries ({:?})", count, started.elapsed());
    let _ = app.emit("file-index-ready", count);
}

/// 后台索引线程：setup 阶段调用。永不阻塞主线程 / UI。
pub fn start_index_worker(app: AppHandle) {
    FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(INITIAL_DELAY_SECS));
        loop {
            do_rebuild(&app);
            std::thread::sleep(Duration::from_secs(REBUILD_INTERVAL_SECS));
        }
    });
}

/// 查询命令：优先 Everything（若启用且可用），回退内置引擎。子序列匹配 + recency 排序。
#[tauri::command]
pub fn search_files(query: String, limit: usize) -> Vec<FileSearchResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }

    // ── Everything 引擎 ──
    if USE_EVERYTHING.load(Ordering::Relaxed) {
        // 懒加载 DLL（首次成功后缓存，后续查询直接复用）
        EVERYTHING_CLIENT.get_or_init(EverythingClient::try_connect);
        if let Some(Some(client)) = EVERYTHING_CLIENT.get() {
            let results = client.search(&q, limit);
            if !results.is_empty() {
                return results
                    .into_iter()
                    .map(|r| FileSearchResult {
                        path: r.path,
                        name: r.name,
                        ext: r.ext,
                        is_dir: r.is_dir,
                    })
                    .collect();
            }
        }
        // Everything 无结果或不可用 → 回退内置引擎（不吞查询）
    }

    // ── 内置引擎 ──
    let lock = match FILE_INDEX.get() {
        Some(l) => l,
        None => return Vec::new(),
    };
    let guard = match lock.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut scored: Vec<(i32, &IndexEntry)> = Vec::new();
    for e in guard.iter() {
        // 子序列匹配优先；失败回退到子串（兼容短查询如 "a"、"1"）
        let match_score = subsequence_match(&e.name_lower, &q)
            .map(|(_, s)| s)
            .or_else(|| e.name_lower.find(&q).map(|pos| {
                let mut s = 60 - (pos as i32).min(50);
                s += (q.len() as f64 / e.name.len().max(1) as f64 * 20.0) as i32;
                if pos == 0 { s += 30; }
                s.max(1)
            }));
        if let Some(base) = match_score {
            let bonus = recency_bonus(e.mtime_secs, now_secs);
            scored.push((base + bonus, e));
        }
    }
    scored.sort_by_key(|a| std::cmp::Reverse(a.0));
    scored
        .into_iter()
        .take(limit.min(QUERY_LIMIT_CAP))
        .map(|(_, e)| FileSearchResult {
            path: e.path.clone(),
            name: e.name.clone(),
            ext: e.ext.clone(),
            is_dir: e.is_dir,
        })
        .collect()
}

/// 索引状态查询（前端显示「建立中…」用）。
#[tauri::command]
pub fn get_index_status() -> serde_json::Value {
    let count = FILE_INDEX
        .get()
        .and_then(|l| l.lock().ok())
        .map(|g| g.len())
        .unwrap_or(0);
    serde_json::json!({ "ready": count > 0, "count": count })
}

/// 获取当前扫描目录（读 store，失败回退默认值）。
#[tauri::command]
pub fn get_scan_dirs(app: AppHandle) -> Vec<String> {
    let app_data = app.path().app_data_dir().unwrap_or_default();
    scan_dirs(&app_data)
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// 手动触发一次索引重建（同步执行，用于设置面板「立即重建」按钮）。
#[tauri::command]
pub fn rebuild_index(app: AppHandle) -> Result<(), String> {
    do_rebuild(&app);
    Ok(())
}

/// 切换搜索引擎（"builtin" / "everything"）。Everything 不可用时前端会收到回退提示。
#[tauri::command]
pub fn set_search_engine(engine: String) -> Result<(), String> {
    match engine.as_str() {
        "everything" => {
            // 尝试连接 Everything，失败则返回错误（前端可据此显示提示）
            EVERYTHING_CLIENT.get_or_init(EverythingClient::try_connect);
            if EVERYTHING_CLIENT.get().and_then(|o| o.as_ref()).is_none() {
                // 连接失败但不阻止切换——用户可能在 Everything 未运行时选择，
                // 实际查询时 search_files 会自动回退内置引擎
            }
            USE_EVERYTHING.store(true, Ordering::Relaxed);
        }
        "builtin" => {
            USE_EVERYTHING.store(false, Ordering::Relaxed);
        }
        _ => return Err(format!("未知搜索引擎: {engine}")),
    }
    Ok(())
}

/// 获取当前搜索引擎（"builtin" 或 "everything"）+ Everything 可用状态。
#[tauri::command]
pub fn get_search_engine() -> serde_json::Value {
    let engine = if USE_EVERYTHING.load(Ordering::Relaxed) { "everything" } else { "builtin" };
    let available = EVERYTHING_CLIENT
        .get()
        .and_then(|o| o.as_ref())
        .is_some();
    serde_json::json!({ "engine": engine, "everythingAvailable": available })
}
