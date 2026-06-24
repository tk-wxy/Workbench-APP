// 文件系统搜索：路线 C 自建内存索引 + 后台预建。
//
// 架构命脉（违反任一条都会卡前端，见 DECISIONS「文件搜索」节 / CLAUDE.md 不变量）：
// 1. 索引建立只在独立后台线程（start_index_worker 内 spawn），永不经 Tauri 命令 / invoke / 阻塞 IPC。
// 2. 查询命令（search_files / get_index_status）只读内存、永远 <5ms，绝不碰磁盘。
// 3. 双缓冲原子替换：新索引在后台 Vec 建好后一次性替换旧 Vec，查询永远命中完整索引。
// 4. 锁纪律：FILE_INDEX 锁只罩「替换 Vec」与「查询读 Vec」的瞬间临界区；walkdir 遍历（耗时部分）绝不持锁。
//    本锁是全新独立 Mutex，与剪贴板 CLIPBOARD_LOCK / CLIP_CACHE 无任何交集，无锁序问题。

use std::path::PathBuf;
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

/// 返回给前端的查询结果（不含 name_lower 内部字段）。
#[derive(serde::Serialize)]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

static FILE_INDEX: OnceLock<Mutex<Vec<IndexEntry>>> = OnceLock::new();

const MAX_INDEX_ENTRIES: usize = 200_000;
const MAX_WALK_DEPTH: usize = 8; // 防极深目录树爆炸
const REBUILD_INTERVAL_SECS: u64 = 30 * 60; // 30 分钟周期重建
const INITIAL_DELAY_SECS: u64 = 3; // 避开开机高峰后再首次建索引
const QUERY_LIMIT_CAP: usize = 50; // 查询返回上限硬顶

// 默认扫描目录（按优先级；截断时桌面 > 下载 > 文档 > 图片 > 项目）。不存在的目录跳过。
fn scan_dirs() -> Vec<PathBuf> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let candidates = ["Desktop", "Downloads", "Documents", "Pictures", "Projects"];
    candidates
        .iter()
        .map(|d| PathBuf::from(&home).join(d))
        .filter(|p| p.exists())
        .collect()
}

// 跳过的目录名（隐藏 / 系统 / 噪音），命中则整个子树不进入。
fn should_skip_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.')
        || matches!(
            n.as_str(),
            "node_modules" | "$recycle.bin" | "appdata" | "target" | ".git" | "__pycache__"
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
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(INITIAL_DELAY_SECS));
        loop {
            let dirs = scan_dirs();
            let started = Instant::now();
            let new_index = build_index(&dirs); // 耗时部分，不持锁
            let count = new_index.len();
            if let Some(lock) = FILE_INDEX.get() {
                if let Ok(mut guard) = lock.lock() {
                    *guard = new_index; // 原子替换（瞬间临界区）
                } // 立即出锁
            }
            eprintln!("[fileindex] ready: {} entries ({:?})", count, started.elapsed());
            let _ = app.emit("file-index-ready", count); // 通知前端
            std::thread::sleep(Duration::from_secs(REBUILD_INTERVAL_SECS));
        }
    });
}

/// 查询命令：纯内存读，<5ms。简化打分（子串命中 + 越靠前 + 越短名 + 前缀加分）。
#[tauri::command]
pub fn search_files(query: String, limit: usize) -> Vec<FileSearchResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
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
        if let Some(pos) = e.name_lower.find(&q) {
            let mut score = 100 - (pos as i32).min(50); // 越靠前越高
            score += 30 - (e.name.len() as i32).min(30); // 名越短越高
            if pos == 0 {
                score += 20; // 前缀加分
            }
            scored.push((score, e));
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
