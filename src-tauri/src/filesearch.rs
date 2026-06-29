// 文件系统搜索：双引擎（内置自建内存索引 + 可选 Everything），设置可切换。
//
// 架构命脉（违反任一条都会卡前端，见 DECISIONS §17 / CLAUDE.md 不变量）：
// 1. 内置索引建立只在独立后台线程（start_index_worker 内 spawn），永不经 Tauri 命令 / invoke / 阻塞 IPC。
// 2. 查询命令（search_files / get_index_status）只读内存 / 走 Everything IPC，绝不在命令里做磁盘遍历。
// 3. 双缓冲原子替换：新索引在后台 Vec 建好后一次性替换旧 Vec，查询永远命中完整索引。
// 4. 锁纪律：FILE_INDEX 锁只罩「替换 Vec」与「查询读 Vec」的瞬间临界区；walkdir 遍历（耗时部分）绝不持锁。
//    本锁是全新独立 Mutex，与剪贴板 CLIPBOARD_LOCK / CLIP_CACHE 无任何交集，无锁序问题。
//
// 引擎切换（续57）：
// - SEARCH_ENGINE 静态（0=内置 / 1=Everything），set_search_engine 命令切换；持久化由前端 store 负责。
// - search_files 按引擎分发：Everything 不可用（未装/未运行）时静默降级回内置，保证永远有结果。
// - 内置扫描范围 = 整个 %USERPROFILE% + 用户可配置额外根目录（set_search_dirs），改目录即触发一次后台重建。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// 内存索引条目：name_lower 预存小写，查询时不重复 to_lowercase。
#[derive(Clone)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub name_lower: String,
    pub ext: String,
    pub is_dir: bool,
}

/// 返回给前端的查询结果（不含 name_lower 内部字段）。内置与 Everything 共用此结构。
/// camelCase：前端读 `isDir`（Tauri 不会自动转换 serde 字段名，否则前端拿到 undefined→全显示为文件）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
    /// Shell 图标 base64 PNG data URL；随查询结果同步返回，省去前端二次 IPC。
    pub icon: Option<String>,
}

static FILE_INDEX: OnceLock<Mutex<Vec<IndexEntry>>> = OnceLock::new();
/// 用户可配置的额外扫描根目录（如 D:\），与 %USERPROFILE% 合并。
static EXTRA_DIRS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
/// 图标预热缓存：key（扩展名小写 或 文件夹哨兵）→ Shell 图标 base64（提取失败为 None）。
/// 与 FILE_INDEX 同样走双缓冲原子替换——耗时的 Shell 提取在后台线程建好整张表后一次性换入。
/// 查询时只读此表回填 icon，省去 search_files 现场调 Shell API 的开销（见 DECISIONS §17 图标预热）。
static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
/// 当前搜索引擎：0=内置自建索引，1=Everything。
static SEARCH_ENGINE: AtomicU8 = AtomicU8::new(0);

const ENGINE_BUILTIN: u8 = 0;
const ENGINE_EVERYTHING: u8 = 1;

const MAX_INDEX_ENTRIES: usize = 300_000; // 整个用户目录可能很大，硬顶防爆内存
const MAX_WALK_DEPTH: usize = 10; // 从 %USERPROFILE% 根算起，比旧 5 子目录方案需更深
const REBUILD_INTERVAL_SECS: u64 = 30 * 60; // 30 分钟周期重建
const INITIAL_DELAY_SECS: u64 = 3; // 避开开机高峰后再首次建索引
const QUERY_LIMIT_CAP: usize = 500; // 查询返回上限硬顶（Everything 全盘可返回大量结果，前端按引擎传不同 limit）

// 默认扫描根 = 整个用户目录；额外根目录由前端配置注入 EXTRA_DIRS。不存在的目录跳过。
fn scan_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if !home.is_empty() {
        let p = PathBuf::from(&home);
        if p.exists() {
            dirs.push(p);
        }
    }
    if let Some(lock) = EXTRA_DIRS.get() {
        if let Ok(guard) = lock.lock() {
            for p in guard.iter() {
                if p.exists() && !dirs.iter().any(|d| d == p) {
                    dirs.push(p.clone());
                }
            }
        }
    }
    dirs
}

// 跳过的目录名（隐藏 / 系统 / 噪音），命中则整个子树不进入。扫整个用户目录时 appdata 剪枝尤其关键。
fn should_skip_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.')
        || matches!(
            n.as_str(),
            "node_modules"
                | "$recycle.bin"
                | "appdata"
                | "target"
                | ".git"
                | "__pycache__"
                | "system volume information"
        )
}

// 耗时部分：纯遍历构建，绝不持 FILE_INDEX 锁。
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
                // 目录命中跳过名单则剪枝整个子树
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
                continue; // 跳过隐藏文件
            }
            let is_dir = entry.file_type().is_dir();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            out.push(IndexEntry {
                path: path.to_string_lossy().to_string(),
                name_lower: name.to_lowercase(),
                name,
                ext,
                is_dir,
            });
        }
    }
    out
}

/// 后台索引线程：setup 阶段调用。永不阻塞主线程 / UI。
/// sleep(INITIAL_DELAY) 避开开机高峰 → 建索引 → 原子替换 → emit 通知 → 周期重建。
pub fn start_index_worker(app: AppHandle) {
    FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
    EXTRA_DIRS.get_or_init(|| Mutex::new(Vec::new()));
    ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(INITIAL_DELAY_SECS));
        loop {
            let dirs = scan_dirs();
            let started = Instant::now();
            let new_index = build_index(&dirs); // 耗时部分，不持锁
            let new_icons = build_icon_cache(&new_index); // 遍历后、替换前批量预热图标（后台线程，不持锁）
            let count = new_index.len();
            if let Some(lock) = FILE_INDEX.get() {
                if let Ok(mut guard) = lock.lock() {
                    *guard = new_index; // 原子替换（瞬间临界区）
                } // 立即出锁
            }
            if let Some(lock) = ICON_CACHE.get() {
                if let Ok(mut guard) = lock.lock() {
                    *guard = new_icons; // 图标缓存同样原子替换
                }
            }
            eprintln!(
                "[fileindex] ready: {} entries ({:?})",
                count,
                started.elapsed()
            );
            let _ = app.emit("file-index-ready", count); // 通知前端
            std::thread::sleep(Duration::from_secs(REBUILD_INTERVAL_SECS));
        }
    });
}

// ── 打分（内置引擎）────────────────────────────────────────────────
// 多词 AND：查询按空白拆词，每词都须命中（子串或子序列），总分为各词之和。
// 分层：子串命中（强，基线 1500+）恒高于子序列模糊（弱，≤1000），保证「直接含」永远排在「拆字母」前。

// 词边界字符：命中点前是这些字符时给词首加权（report_2024 里搜 "2024" 视作词首）。
fn is_boundary(c: char) -> bool {
    matches!(c, ' ' | '_' | '-' | '.' | '/' | '\\' | '(' | '[' | ']' | ')')
}

// 子序列模糊打分：t 的字符按序出现在 name 中即算命中；连续命中、词首命中额外加分。上限 1000。
fn subseq_score(t: &str, name: &str) -> Option<i32> {
    let mut chars = t.chars();
    let mut cur = chars.next()?;
    let mut score = 0i32;
    let mut consec = 0i32;
    let mut prev_match = false;
    let mut prev_char = ' ';
    for c in name.chars() {
        if c == cur {
            score += 10;
            if prev_match {
                consec += 1;
                score += consec * 5; // 连续命中越长越好
            } else {
                consec = 0;
            }
            if is_boundary(prev_char) {
                score += 20; // 词首命中
            }
            prev_match = true;
            match chars.next() {
                Some(n) => cur = n,
                None => return Some(score.min(1000)), // t 全部匹配完
            }
        } else {
            prev_match = false;
        }
        prev_char = c;
    }
    None // 未匹配完 t 的所有字符
}

// 单词打分：优先子串（前缀 / 词首加权），退而求其次走子序列。
fn token_score(t: &str, name_lower: &str) -> Option<i32> {
    if let Some(pos) = name_lower.find(t) {
        let mut s = 2000 - (pos as i32).min(500); // 越靠前越高
        if pos == 0 {
            s += 400; // 前缀
        } else if name_lower[..pos]
            .chars()
            .next_back()
            .map(is_boundary)
            .unwrap_or(false)
        {
            s += 200; // 词首
        }
        return Some(s);
    }
    subseq_score(t, name_lower)
}

// 内置引擎查询：纯内存读，<5ms。多词 AND + 分层打分 + 短名优先。
fn builtin_search(query: &str, limit: usize) -> Vec<FileSearchResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let tokens: Vec<&str> = q.split_whitespace().collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let lock = match FILE_INDEX.get() {
        Some(l) => l,
        None => return Vec::new(),
    };
    let guard = match lock.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let mut scored: Vec<(i32, &IndexEntry)> = Vec::new();
    for e in guard.iter() {
        let mut total = 0i32;
        let mut all = true;
        for t in &tokens {
            match token_score(t, &e.name_lower) {
                Some(s) => total += s,
                None => {
                    all = false;
                    break;
                }
            }
        }
        if all {
            total += 60 - (e.name.len() as i32).min(60); // 短名优先（轻微）
            scored.push((total, e));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name.len().cmp(&b.1.name.len())));
    scored
        .into_iter()
        .take(limit.min(QUERY_LIMIT_CAP))
        .map(|(_, e)| FileSearchResult {
            path: e.path.clone(),
            name: e.name.clone(),
            ext: e.ext.clone(),
            is_dir: e.is_dir,
            icon: None, // 由 enrich_with_icons 统一填充
        })
        .collect()
}

/// 文件夹图标的哨兵 key——文件夹无扩展名（ext=""），用独立 key 避免与「无扩展名文件」碰撞。
/// 含 NUL 字符，永不与真实扩展名冲突。
const DIR_ICON_KEY: &str = "\0dir";

/// 图标缓存的归类 key（提取与回填两端共用，保证一致）：
/// - 文件夹 → 哨兵（共用一个文件夹图标）；
/// - .exe/.lnk → **按路径区分**（每个可执行文件/快捷方式都带各自的内嵌图标，不能按扩展名合并，
///   否则搜索结果里所有 exe 显示同一图标——这正是续68 首版的缺陷）；
/// - 其余 → 小写扩展名（同扩展名 Shell 图标相同，去重共用）。
fn icon_key(is_dir: bool, ext: &str, path: &str) -> String {
    if is_dir {
        DIR_ICON_KEY.to_string()
    } else if ext == "exe" || ext == "lnk" {
        path.to_string()
    } else {
        ext.to_lowercase()
    }
}

/// 索引建好后批量提图标（图标预热）：按「文件夹 / 扩展名」去重，每类只对一个代表路径提一次。
/// 返回 key → 图标（提取失败存 None，仍保留 key——便于「试过但无图标」与「未试过」区分）。
/// ⚠️ 耗时（Shell API），但只在后台线程、遍历完成后、替换全局索引前调用，绝不碰前台查询路径。
/// 单次 COM init 由 apps::get_file_icons 内部统管整批。
fn build_icon_cache(entries: &[IndexEntry]) -> HashMap<String, Option<String>> {
    // key → 代表路径（第一次遇到该类型时记录）
    let mut key_to_rep: HashMap<String, String> = HashMap::new();
    for e in entries {
        key_to_rep
            .entry(icon_key(e.is_dir, &e.ext, &e.path))
            .or_insert_with(|| e.path.clone());
    }
    // 批量提取去重后的代表路径
    let reps: Vec<String> = key_to_rep.values().cloned().collect();
    let path_to_icon: HashMap<String, Option<String>> =
        crate::apps::get_file_icons(reps).into_iter().collect();
    // 组装 key → icon（保留所有 key，值取代表路径的提取结果）
    key_to_rep
        .into_iter()
        .map(|(key, rep)| (key, path_to_icon.get(&rep).cloned().flatten()))
        .collect()
}

/// 从预热缓存回填查询结果的 icon——纯内存查表，无任何 Shell API 调用。
/// 缓存未建立（极短启动窗口）或某 key 未命中时 icon=None，前端已有降级处理。
fn fill_icons_from_cache(mut results: Vec<FileSearchResult>) -> Vec<FileSearchResult> {
    let guard = match ICON_CACHE.get().and_then(|l| l.lock().ok()) {
        Some(g) => g,
        None => return results, // 缓存尚未建立：全部降级 icon=None
    };
    for r in &mut results {
        r.icon = guard
            .get(&icon_key(r.is_dir, &r.ext, &r.path))
            .cloned()
            .flatten();
    }
    results
}

/// 查询命令：按当前引擎分发，结果从预热缓存回填 Shell 图标（纯内存查表，不调 Shell API）。
/// 图标在后台建索引时已批量预提（build_icon_cache），查询路径只剩内存查找。
/// Everything 不可用时静默降级回内置（保证永远有结果）。
#[tauri::command]
pub fn search_files(query: String, limit: usize) -> Vec<FileSearchResult> {
    let results = if SEARCH_ENGINE.load(Ordering::Relaxed) == ENGINE_EVERYTHING {
        match crate::everything::query(&query, limit.min(QUERY_LIMIT_CAP)) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[everything] 查询失败，降级内置: {e}");
                builtin_search(&query, limit)
            }
        }
    } else {
        builtin_search(&query, limit)
    };
    fill_icons_from_cache(results)
}

/// 索引 / 引擎状态查询（前端显示「建立中…」「Everything 未运行」用）。
#[tauri::command]
pub fn get_index_status() -> serde_json::Value {
    let count = FILE_INDEX
        .get()
        .and_then(|l| l.lock().ok())
        .map(|g| g.len())
        .unwrap_or(0);
    let engine = SEARCH_ENGINE.load(Ordering::Relaxed);
    let everything_available = crate::everything::is_available();
    // ready 语义按引擎区分：内置看索引条数，Everything 看其是否可用。
    let ready = if engine == ENGINE_EVERYTHING {
        everything_available
    } else {
        count > 0
    };
    serde_json::json!({
        "ready": ready,
        "count": count,
        "engine": if engine == ENGINE_EVERYTHING { "everything" } else { "builtin" },
        "everythingAvailable": everything_available,
    })
}

/// 切换搜索引擎（"builtin" / "everything"）。持久化由前端 store 负责，本命令不写 store。
#[tauri::command]
pub fn set_search_engine(engine: String) {
    let v = if engine == "everything" {
        ENGINE_EVERYTHING
    } else {
        ENGINE_BUILTIN
    };
    SEARCH_ENGINE.store(v, Ordering::Relaxed);
}

/// 设置内置引擎的额外扫描根目录，并触发一次后台重建（仅内置引擎时）。持久化由前端 store 负责。
#[tauri::command]
pub fn set_search_dirs(dirs: Vec<String>) {
    let parsed: Vec<PathBuf> = dirs
        .into_iter()
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    let lock = EXTRA_DIRS.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut guard) = lock.lock() {
        *guard = parsed;
    }
    // 立刻在后台重建一次（不持锁遍历，建完原子替换），让新目录马上可搜。
    FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
    ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    std::thread::spawn(|| {
        let dirs = scan_dirs();
        let new_index = build_index(&dirs);
        let new_icons = build_icon_cache(&new_index); // 同步预热图标，与索引一起换入
        if let Some(lock) = FILE_INDEX.get() {
            if let Ok(mut guard) = lock.lock() {
                *guard = new_index;
            }
        }
        if let Some(lock) = ICON_CACHE.get() {
            if let Ok(mut guard) = lock.lock() {
                *guard = new_icons;
            }
        }
    });
}
