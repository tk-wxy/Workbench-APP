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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    /// 是否来自用户手动添加的额外扫描目录（EXTRA_DIRS）。查询时据此加分，见 EXTRA_DIR_BONUS。
    pub extra: bool,
    /// 最終更新時刻（Unix 秒、0 = 取得不可）。続117 で追加 —— 新鮮度加点の入力。
    /// **索引に持たせる**のが要点：查询命令は「メモリのみ・ディスクに触れない」が鉄則なので、
    /// 検索のたびに stat する案は取れない。Windows のディレクトリ列挙（FindFirstFile）は
    /// ftLastWriteTime を元から返すため、索引構築時の取得はほぼ無料。
    pub mtime: u64,
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
    /// 最終更新時刻（Unix 秒、0 = 不明）。ランキング用の**内部フィールド**なので前端へは送らない
    /// （前端はプレビュー面板で get_file_info を使う。ここを serialize すると同じ事実の出所が
    /// 二つになる）。内置は索引から、Everything は SDK の DATE_MODIFIED から埋める。
    #[serde(skip)]
    pub mtime: u64,
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

/// 额外扫描目录（用户手动添加）的条目加分（续111b）。
///
/// 为什么需要：打分只看**文件名**，故同名文件（一台开发机上 README 有 436 个、index.html 79 个）
/// 得分完全相同；`sort_by` 稳定排序 → 并列时保持索引原始顺序 → 而 build_index 先走 USERPROFILE、
/// 额外目录**排在最后** → 额外目录的同名文件永远垫底，被前端 limit(50) 截掉 = 用户眼中的"加了目录
/// 却搜不到里面的东西"（实测：vue-app/index.html 排第 71/79、README.md 排第 345/436）。
/// home 排在前面纯属遍历顺序的副产品、并无道理；而"用户手动添加了这个目录"本身是明确的意图信号。
///
/// 取值 300 的依据：必须**小于**「子串命中(≥1500)」与「子序列模糊(≤1000)」两层的间距，
/// 使额外目录的模糊命中(≤1300)仍排在用户目录的子串命中(≥1500)之后——即不破坏
/// token_score 那条「直接含永远排在拆字母前」的分层不变量，只翻转同层内的并列。
/// 按条目加一次（非按 token），故与 `60 - name.len()` 短名加分同处一行之后。
const EXTRA_DIR_BONUS: i32 = 300;

// ── 分層加点の予算（続117 で明文化）──────────────────────────────────────────
//
// token_score には破ってはいけない**分層不変量**がある：「名前に直接含む(子串)」は
// 「文字をばらして拾う(子序列)」より**常に上**。単一トークン時の数値は：
//     子串命中の最小 = 2000 - 500(位置ペナルティ上限) = 1500
//     子序列の最大   = 1000（subseq_score が .min(1000) で頭打ち）
//   → 層間ギャップ = 500
// エントリ単位の加点（額外目录 / 短名 / 新鮮度）は**この 500 を食い潰してはいけない**。
// 合計が 500 を超えると「額外目录にある・短い・昨日更新した*ぼんやり一致*」が
// 「ど真ん中で名前に含む正確な一致」を追い抜く —— 検索が壊れたとしか見えない挙動になる。
//
// 複数トークン時は両層とも token 数に比例して伸びる（2 語なら子串 ≥3000 / 子序列 ≤2000、
// ギャップ 1000）一方、下の 3 つはエントリに 1 回だけ加算 —— よって**単一トークンが最も厳しい**。
// 予算はそこで満たせばよい。実際の検算は tests::layer_invariant_budget_holds が行う。
//
//   EXTRA_DIR_BONUS(300) + SHORT_NAME_BONUS_MAX(60) + RECENCY_BONUS_MAX(120) = 480 < 500 ✓
//
// ⚠️ この 3 定数のどれかを上げるときは必ず合計を再確認すること（テストが落ちる）。
const SHORT_NAME_BONUS_MAX: i32 = 60;
/// 新鮮度加点の上限（続117）。実値は recency_bonus() の階段を参照。
const RECENCY_BONUS_MAX: i32 = 120;
/// 層間ギャップ（単一トークン時）。上記 3 定数の合計はこれ未満でなければならない。
/// 参照するのはテストのみ（予算の検算に使う）だが、**予算の宣言そのもの**なので
/// #[cfg(test)] には落とさない —— 定数を触る人がここを読める場所に置いておきたい。
#[allow(dead_code)]
const LAYER_GAP: i32 = 500;

/// 更新時刻 → 新鮮度加点（続117）。
///
/// 動機：アプリには使用頻度スコア（usageScore：頻度 × 30日半減期）があるのに、**ファイルには
/// 時間軸が一切無かった**。5 分前に編集したファイルと 2015 年の同名ファイルが完全に同点で、
/// 名前の長さと走査順だけで勝負が決まっていた。「探しているのは大抵さっき触ったやつ」という
/// 極めて強い事前分布を、ランキングが全く使えていなかった。
///
/// 連続関数ではなく**階段**にした理由：連続だと僅かな時刻差で並びが揺れ、同じクエリを打ち直す
/// たびに順番が変わって見える。段にしておけば「今週のもの」の中では従来どおり関連度で決まる。
///
/// 値は上の予算内（≤ RECENCY_BONUS_MAX）。未来時刻（時計ずれ / ネットワークドライブ）は
/// age を 0 に飽和させて最上段扱い —— 負値で下駄を履かせない。
fn recency_bonus(mtime: u64, now: u64) -> i32 {
    if mtime == 0 {
        return 0; // 取得不可
    }
    let age = now.saturating_sub(mtime);
    const DAY: u64 = 86_400;
    if age <= 7 * DAY {
        RECENCY_BONUS_MAX // 120：今週触った
    } else if age <= 30 * DAY {
        70
    } else if age <= 365 * DAY {
        25
    } else {
        0
    }
}

/// 現在時刻（Unix 秒）。索引には触れないので查询パスで呼んでも鉄則違反にならない。
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 扫描根目录清单。返回 (目录, 是否为用户手动添加的额外目录)——第二项一路带进 IndexEntry.extra
/// 供查询加分用（见 EXTRA_DIR_BONUS）。默认根 = 整个用户目录；额外根由前端经 set_search_dirs 注入。
/// 不存在的目录跳过（故手输打错的路径会被静默忽略——续111 改用文件夹选择器后不再可能）。
fn scan_dirs() -> Vec<(PathBuf, bool)> {
    let mut dirs: Vec<(PathBuf, bool)> = Vec::new();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if !home.is_empty() {
        let p = PathBuf::from(&home);
        if p.exists() {
            dirs.push((p, false));
        }
    }
    if let Some(lock) = EXTRA_DIRS.get() {
        if let Ok(guard) = lock.lock() {
            for p in guard.iter() {
                if p.exists() && !dirs.iter().any(|(d, _)| d == p) {
                    dirs.push((p.clone(), true));
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
// dirs 的第二项 = 该根是否为用户手动添加的额外目录，逐条记进 IndexEntry.extra（查询时加分用）。
fn build_index(dirs: &[(PathBuf, bool)]) -> Vec<IndexEntry> {
    let mut out = Vec::new();
    for (dir, is_extra) in dirs {
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
            // mtime：walkdir の DirEntry::metadata() は Windows ではディレクトリ列挙時の
            // WIN32_FIND_DATA を再利用するため追加の syscall はほぼ発生しない（実測は
            // measure_real_rebuild で確認できる）。取得できなければ 0 = 加点なしに退化。
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(IndexEntry {
                path: path.to_string_lossy().to_string(),
                name_lower: name.to_lowercase(),
                name,
                ext,
                is_dir,
                extra: *is_extra,
                mtime,
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

/// エントリ 1 件の総合スコア（続117 で builtin_search から抽出）。全トークンが命中しなければ None。
///
/// 抽出理由：**グローバル（FILE_INDEX / EXTRA_DIRS / USERPROFILE）に触れずにランキングを
/// テストするため**。既存の端到端テストはそれらを書き換えるので「これ 1 本だけ・並行に増やすな」
/// という制約付きで、ランキングの回帰をそこに相乗りさせられない。ここが純関数なら
/// IndexEntry を手で組んで自由に検証できる。
fn entry_score(tokens: &[&str], e: &IndexEntry, now: u64) -> Option<i32> {
    let mut total = 0i32;
    for t in tokens {
        total += token_score(t, &e.name_lower)?; // 1 つでも外れたら不一致（多词 AND）
    }
    // ↓ エントリ単位の加点 3 種。合計は必ず LAYER_GAP 未満（分層予算の注釈を参照）
    total += SHORT_NAME_BONUS_MAX - (e.name.len() as i32).min(SHORT_NAME_BONUS_MAX); // 短名优先（轻微）
    if e.extra {
        total += EXTRA_DIR_BONUS; // 用户手动添加的目录 = 明确意图信号，翻转同名并列（见常量注释）
    }
    total += recency_bonus(e.mtime, now); // 続117：最近触ったものを同層内で優先
    Some(total)
}

// 内置引擎查询：纯内存读，<5ms。多词 AND + 分层打分 + 短名优先 + 新鮮度。
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
    // 新鮮度加点用に一度だけ現在時刻を取る（ループ内で毎回 SystemTime::now は無駄）
    let now = now_unix();
    let mut scored: Vec<(i32, &IndexEntry)> = Vec::new();
    for e in guard.iter() {
        if let Some(total) = entry_score(&tokens, e, now) {
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
            mtime: e.mtime,
        })
        .collect()
}

/// Everything の結果を**内置と同じ物差しで並べ直す**（続117）。
///
/// なぜ必要か：`search_files` は Everything 分岐で `token_score` を一切通しておらず、
/// Everything 自身の既定順序をそのまま返していた。つまり**引擎を切り替えると並び順の
/// 意味が黙って変わり**、短名優先も新鮮度も効かない。UI 上その説明はどこにも無い。
///
/// 限界（正直に）：候補集合そのものは Everything が `set_max` で切った後のものなので、
/// 「関連度上位 N」ではなく「Everything の既定順で上位 N を関連度で並べ直したもの」。
/// 完全に揃えるには全件取得が要るが、全盘検索でそれは非現実的。可視部分の順序は揃う。
///
/// 額外目录加点は付けない —— Everything は全盘を見るので EXTRA_DIRS という概念が対応しない。
fn rerank_everything(mut results: Vec<FileSearchResult>, query: &str) -> Vec<FileSearchResult> {
    let q = query.trim().to_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().collect();
    if tokens.is_empty() {
        return results;
    }
    let now = now_unix();
    let score_of = |r: &FileSearchResult| -> i32 {
        let name_lower = r.name.to_lowercase();
        let mut total = 0i32;
        for t in &tokens {
            match token_score(t, &name_lower) {
                Some(s) => total += s,
                // Everything の構文（`ext:` やワイルドカード等）ではファイル名に
                // クエリ語が現れないことがある。落とさずに最下位へ置く。
                None => return i32::MIN,
            }
        }
        total += SHORT_NAME_BONUS_MAX - (r.name.len() as i32).min(SHORT_NAME_BONUS_MAX);
        total += recency_bonus(r.mtime, now);
        total
    };
    // sort_by_cached_key：score_of は都度 to_lowercase する（比較のたびに再計算させない）。
    // 降順は Reverse で表す —— ⚠️ **符号反転(-score)は使えない**：非命中の番兵が i32::MIN で、
    // -i32::MIN は i32 に収まらず overflow パニックになる（`ext:txt` のような Everything 構文で
    // 実際に踏む。テストで検出済み）。同点は名前の短い順（内置の tie-break と揃える）。
    results.sort_by_cached_key(|r| (std::cmp::Reverse(score_of(r)), r.name.len()));
    results
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

/// Everything から**一旦引き取って評価する**候補数（続120）。返す件数（limit）とは別物。
///
/// なぜ分ける必要があったか：続117 以前も以後も、Everything へは limit(=200) をそのまま
/// set_max として渡していた。つまり **Everything 自身の既定順（ほぼ名前順）で上位 200 件を
/// 切り取ってから、その中だけで並べ替えていた**。欲しいファイルが Everything 順で 3000 番目に
/// あれば、ランキングがどれだけ良くても**そもそも見えない**。件数が少ないのが問題なのではなく、
/// **候補集合が的外れ**だったという話（ユーザー報告：Everything は 7 万件見つけているのに
/// 増強検索には数百件しか出ない）。
///
/// 5000 の根拠（本機実測、debug ビルド・クエリ "windows"／Everything 側 7 万件超）：
///   200 件 → クエリ 13ms + rerank 0.3ms ／ 5000 件 → クエリ 43ms + rerank 3.6ms
/// 150ms デバウンス済みの非同期コマンド内で 46ms は体感に出ない。release ではさらに速い。
/// 一方 20000 件は 136ms + 16ms で、デバウンス幅に食い込むので採らない。
/// **返す件数は増えない**ので IPC ペイロードと DOM ノード数は据え置き（そこが本当の律速：
/// アイコンが 1 件約 1KB で結果に同梱され、かつリストは仮想化されていない）。
const EVERYTHING_CANDIDATE_POOL: usize = 5000;

/// 查询命令：按当前引擎分发，结果从预热缓存回填 Shell 图标（纯内存查表，不调 Shell API）。
/// 图标在后台建索引时已批量预提（build_icon_cache），查询路径只剩内存查找。
/// Everything 不可用时静默降级回内置（保证永远有结果）。
#[tauri::command]
pub fn search_files(query: String, limit: usize) -> Vec<FileSearchResult> {
    let want = limit.min(QUERY_LIMIT_CAP);
    let results = if SEARCH_ENGINE.load(Ordering::Relaxed) == ENGINE_EVERYTHING {
        // 続120：**広く取って → 評価して → 狭めて返す**。
        // 内置エンジンは元から索引全体を評価してから take(limit) しているので同じ形になった
        // ——「切ってから評価する」形になっていたのは Everything 経路だけ。
        match crate::everything::query(&query, EVERYTHING_CANDIDATE_POOL) {
            // 続117：内置と同じ物差しで並べ直してから返す（rerank_everything の説明を参照）
            Ok(r) => {
                let mut ranked = rerank_everything(r, &query);
                ranked.truncate(want); // ← アイコン埋めより前に切る（下の fill は返す分だけで済む）
                ranked
            }
            Err(e) => {
                eprintln!("[everything] 查询失败，降级内置: {e}");
                builtin_search(&query, want)
            }
        }
    } else {
        builtin_search(&query, want)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 分層予算の検算（続117）。エントリ単位の加点 3 種の合計が層間ギャップを超えないこと。
    /// **定数をいじると真っ先に落ちるのがこれ** —— 超えた瞬間「ぼんやり一致が正確な一致を
    /// 追い抜く」という、症状だけ見ても原因に辿り着けない壊れ方をする。
    #[test]
    fn layer_invariant_budget_holds() {
        let sum = EXTRA_DIR_BONUS + SHORT_NAME_BONUS_MAX + RECENCY_BONUS_MAX;
        assert!(
            sum < LAYER_GAP,
            "エントリ単位加点の合計 {sum} が層間ギャップ {LAYER_GAP} 以上。\
             額外目录にある短い最近のファイルが、名前に直接含む一致を追い抜く。\
             どれかの定数を下げること。"
        );
        // ギャップの由来自体も固定しておく（token_score / subseq_score をいじったとき気づけるように）
        let substring_worst = 2000 - 500; // 位置ペナルティ最大の子串命中
        let subseq_best = 1000; // subseq_score の .min(1000)
        assert_eq!(substring_worst - subseq_best, LAYER_GAP, "層間ギャップの前提が変わっている");
    }

    // テスト用の IndexEntry 組み立て（グローバルに触れないので並行に増やしてよい）
    fn ent(name: &str, mtime: u64, extra: bool) -> IndexEntry {
        IndexEntry {
            path: format!("C:\\x\\{name}"),
            name: name.to_string(),
            name_lower: name.to_lowercase(),
            ext: String::new(),
            is_dir: false,
            extra,
            mtime,
        }
    }

    /// LAYER_GAP=500 という前提そのものを**実際の文字列で**裏取りする（続117）。
    /// layer_invariant_budget_holds は数値の突き合わせなので、token_score / subseq_score の
    /// 中身をいじって層の境界がずれた場合は素通りしてしまう。こちらがその穴を塞ぐ。
    #[test]
    fn token_score_layer_bounds_hold() {
        // 子串命中の**最悪**ケース：クエリが 500 文字目以降に現れ、位置ペナルティが飽和する。
        // 非現実的な長さだが、式が許す下限はここ。
        let far = format!("{}rpt.md", "x".repeat(600));
        let lo = token_score("rpt", &far).expect("子串なので必ず命中");
        assert!(lo >= 1500, "子串命中の下限が 1500 を割った（LAYER_GAP の前提が崩れる）: {lo}");

        // 子序列の**最良**ケース：全文字が word-start に当たり続けて頭打ちに達する。
        // "a_a_a_..." に対して "aaa...a" —— 下線のせいで子串にはならず子序列へ落ちる。
        let q = "a".repeat(60);
        let name = "a_".repeat(60);
        let hi = token_score(&q, &name).expect("子序列として命中するはず");
        assert!(hi <= 1000, "子序列の上限 1000 を超えた（LAYER_GAP の前提が崩れる）: {hi}");
        assert_eq!(hi, 1000, "この入力は頭打ちに達するはず（達していないとテストが緩い）: {hi}");

        assert_eq!(lo - hi, LAYER_GAP, "実測した層間ギャップが LAYER_GAP と食い違う");
    }

    /// 続117 の本丸：新鮮度は**同層内の並びしか動かしてはいけない**。
    /// 「昨日更新した*ぼんやり一致*」が「1 年前の*名前に直接含む一致*」を追い抜いたら、
    /// ユーザーから見て検索が壊れている。予算計算（layer_invariant_budget_holds）が
    /// 数値の上で保証している性質を、実際のスコア関数で確かめる。
    ///
    /// ⚠️ **境界ギリギリで組むこと**。素朴な例（短いクエリ）だと子串 ~2200 対 子序列 ~500 と
    /// 差が開きすぎて、予算を壊しても素通りしてしまう（実際 RECENCY_BONUS_MAX=200 に
    /// 上げる逆検証でこのテストだけ通ってしまい、緩さが露呈した）。
    /// そこで**両側とも最悪／最良ケース**で組む：
    ///   子串側 = 位置ペナルティ飽和・長名で短名加点ゼロ・古い・通常目录 → ちょうど 1500
    ///   子序列側 = 頭打ち 1000 ＋ 額外目录 300 ＋ 今日更新 120 → 1420
    /// 余裕はわずか 80。予算を少しでも超えれば即座に落ちる。
    #[test]
    fn recency_never_crosses_match_layers() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let q = "a".repeat(60);
        let tokens = [q.as_str()];

        // 子序列側：頭打ちに達する長名（＝短名加点は 0）＋ 額外目录 ＋ 今日更新
        let mut fuzzy_fresh = ent("", now, true);
        let fname = "a_".repeat(60);
        fuzzy_fresh.name = fname.clone();
        fuzzy_fresh.name_lower = fname;

        // 子串側：クエリが 600 文字目に現れる（位置ペナルティ飽和）＋ 10 年前 ＋ 通常目录
        let mut exact_old = ent("", now - 3650 * DAY, false);
        let xname = format!("{}{}.md", "x".repeat(600), q);
        exact_old.name = xname.clone();
        exact_old.name_lower = xname;

        let f = entry_score(&tokens, &fuzzy_fresh, now).expect("子序列は命中するはず");
        let x = entry_score(&tokens, &exact_old, now).expect("子串は命中するはず");
        assert_eq!(f, 1000 + EXTRA_DIR_BONUS + RECENCY_BONUS_MAX, "子序列側が想定の最良ケースになっていない");
        assert_eq!(x, 1500, "子串側が想定の最悪ケースになっていない");
        assert!(
            x > f,
            "分層不変量が破れた：古い子串一致({x}) が 新しい子序列一致({f}) に負けている。\
             エントリ単位加点の合計が LAYER_GAP を食い潰していないか確認すること。"
        );
    }

    /// 効くべきところでは効くこと：**同名・同層**なら新しい方が上（続117 の狙いそのもの）。
    /// これが無いと「安全側に倒して実質何も起きていない」変更と区別できない。
    #[test]
    fn recency_breaks_ties_among_same_name() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let fresh = ent("report.md", now - 2 * DAY, false); // 今週
        let stale = ent("report.md", now - 800 * DAY, false); // 2 年以上前
        let a = entry_score(&["report"], &fresh, now).unwrap();
        let b = entry_score(&["report"], &stale, now).unwrap();
        assert!(a > b, "同名同層では新しい方が上のはず（{a} vs {b}）");
        assert_eq!(a - b, RECENCY_BONUS_MAX, "差は新鮮度加点ちょうどのはず（他の要素は同一）");
    }

    /// mtime 取得不可（0）でも順位が壊れないこと。ネットワークドライブ等で実際に起こる。
    /// 「時刻が取れない = 最古扱い」で、他の加点は従来どおり効く。
    #[test]
    fn missing_mtime_degrades_gracefully() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let unknown = ent("report.md", 0, false);
        let ancient = ent("report.md", now - 3650 * DAY, false);
        assert_eq!(
            entry_score(&["report"], &unknown, now).unwrap(),
            entry_score(&["report"], &ancient, now).unwrap(),
            "mtime 不明は最古と同点（加点なし）であるべき"
        );
        // 額外目录の加点は mtime とは独立に効き続ける（続111b の修正を壊さない）
        let unknown_extra = ent("report.md", 0, true);
        assert!(
            entry_score(&["report"], &unknown_extra, now).unwrap()
                > entry_score(&["report"], &unknown, now).unwrap(),
            "mtime 不明でも EXTRA_DIR_BONUS は効くべき"
        );
    }

    fn res(name: &str, mtime: u64) -> FileSearchResult {
        FileSearchResult {
            path: format!("C:\\x\\{name}"),
            name: name.to_string(),
            ext: String::new(),
            is_dir: false,
            icon: None,
            mtime,
        }
    }

    /// Everything 結果の並べ直し（続117）。引擎を切り替えても順序の**意味**が変わらないこと。
    #[test]
    fn rerank_everything_matches_builtin_semantics() {
        const DAY: u64 = 86_400;
        let now = now_unix();
        // Everything の既定順（名前順など）を模して、わざと「良い候補が後ろ」の並びで渡す
        let input = vec![
            res("zzz_unrelated_but_contains_report_deep_in_name.md", now - 900 * DAY),
            res("r_e_p_o_r_t.md", now),           // 子序列でしか当たらない（新しくても下位のはず）
            res("report.md", now - 900 * DAY),    // 子串・短名・古い
            res("report_draft.md", now - 1 * DAY),// 子串・やや長い・今週
        ];
        let out = rerank_everything(input, "report");
        let names: Vec<&str> = out.iter().map(|r| r.name.as_str()).collect();
        // ① 子序列一致は必ず最下位（分層不変量。Everything 経由でも崩れてはいけない）
        assert_eq!(
            names.last(),
            Some(&"r_e_p_o_r_t.md"),
            "子序列一致が最下位に来ていない: {names:?}"
        );
        // ② 前缀一致の 2 件が、名前の途中でしか当たらない zzz_... より上
        let i_zzz = names.iter().position(|n| n.starts_with("zzz")).unwrap();
        let i_rep = names.iter().position(|n| *n == "report.md").unwrap();
        let i_draft = names.iter().position(|n| *n == "report_draft.md").unwrap();
        assert!(i_rep < i_zzz && i_draft < i_zzz, "前缀一致が位置ペナルティ組より下: {names:?}");
        // ③ **同層内では新鮮度が決める**（続117 の狙いそのもの）。
        //    ここでは report_draft.md（今週）が report.md（900日前）より上に来る。
        //    ⚠️ 設計上の取捨：短名加点は「轻微」(差 6) なのに対し新鮮度は 120 なので、
        //    完全一致の短い名前でも 1 年以上放置されていれば、新しい長い名前に抜かれる。
        //    「探しているのは大抵さっき触ったやつ」という前提を採る以上これは意図どおり。
        //    もし「完全一致は常に最上位」にしたくなったら、専用の加点を足すのではなく
        //    **層を分ける**こと（加点で殴ると LAYER_GAP の予算を食い潰す）。
        assert!(
            i_draft < i_rep,
            "同層内で新鮮度が効いていない（続117 の主目的）: {names:?}"
        );
    }

    /// 続120 の本丸：**「切ってから評価」ではなく「広く取って評価してから切る」**こと。
    ///
    /// 修正前は Everything に limit(200) をそのまま set_max として渡していたため、
    /// Everything 既定順で 201 番目以降にある最良一致は**存在自体が見えなかった**。
    /// ここでは「最良一致が候補の末尾にいる」状況を作り、返す件数を絞っても
    /// それが拾えることを確認する。search_files 全体は SEARCH_ENGINE / Everything 本体に
    /// 依存するので、その中核である rerank→truncate の順序を直接検証する。
    #[test]
    fn ranking_happens_before_truncation() {
        // Everything の既定順を模す：先頭 299 件は名前の途中でしか当たらない長い名前、
        // 最後の 1 件だけが完全な前缀一致（＝本当に欲しいもの）。
        let mut pool: Vec<FileSearchResult> = (0..299)
            .map(|i| res(&format!("zzz_archive_{i:04}_report_backup_old.md"), 0))
            .collect();
        pool.push(res("report.md", 0)); // 候補プールの**最後**に最良一致
        assert_eq!(pool.len(), 300);

        let mut ranked = rerank_everything(pool, "report");
        ranked.truncate(10); // 返すのは 10 件だけ

        assert_eq!(
            ranked[0].name, "report.md",
            "候補の末尾にあった最良一致が拾えていない —— 評価より前に切ってしまっている: {:?}",
            ranked.iter().map(|r| r.name.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(ranked.len(), 10, "返す件数は truncate どおりであるべき");
    }

    /// Everything の構文（`ext:` 等）でファイル名にクエリ語が出ない結果を**落とさない**こと。
    /// 落とすと「Everything では検索できるのに本アプリでは消える」という最悪の挙動になる。
    #[test]
    fn rerank_everything_keeps_non_name_matches() {
        let input = vec![res("alpha.txt", 0), res("beta.txt", 0)];
        let out = rerank_everything(input, "ext:txt");
        assert_eq!(out.len(), 2, "名前に当たらない結果が捨てられている");
    }

    /// 空クエリでは並べ替えない（Everything 側の順序をそのまま尊重）。
    #[test]
    fn rerank_everything_noop_on_empty_query() {
        let input = vec![res("b.txt", 0), res("a.txt", 0)];
        let out = rerank_everything(input, "   ");
        assert_eq!(out[0].name, "b.txt", "空クエリで並びを触ってはいけない");
    }

    /// 新鮮度の階段そのもの（続117）。境界と、未来時刻で下駄を履かせないことを見る。
    #[test]
    fn recency_bonus_steps() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY; // 十分大きい基準時刻（10年前を引いても負にならない）
        assert_eq!(recency_bonus(0, now), 0, "mtime 取得不可は加点なし");
        assert_eq!(recency_bonus(now, now), RECENCY_BONUS_MAX, "今 = 最上段");
        assert_eq!(recency_bonus(now - 7 * DAY, now), RECENCY_BONUS_MAX, "7日ちょうどは最上段に含む");
        assert_eq!(recency_bonus(now - 7 * DAY - 1, now), 70, "7日超で次段へ");
        assert_eq!(recency_bonus(now - 30 * DAY, now), 70);
        assert_eq!(recency_bonus(now - 30 * DAY - 1, now), 25);
        assert_eq!(recency_bonus(now - 365 * DAY, now), 25);
        assert_eq!(recency_bonus(now - 365 * DAY - 1, now), 0, "1年超は加点なし");
        // 時計ずれ / ネットワークドライブで未来時刻になることは実際にある。
        // saturating_sub で age=0 に飽和 → 最上段。パニックも負値加点も起こさない。
        assert_eq!(recency_bonus(now + 9999 * DAY, now), RECENCY_BONUS_MAX, "未来時刻は最上段に飽和");
    }

    /// 额外目录端到端契约（跑真实的 set_search_dirs 命令，含其后台重建与图标预热）：
    /// 调用后，EXTRA_DIRS 里的文件必须在有限时间内出现在 FILE_INDEX，且能被 builtin_search 查到。
    /// 用临时目录顶掉 USERPROFILE，避免测试真去遍历 18 万条的真实用户目录（快 + 可复现）。
    /// ⚠️ 用了全局 OnceLock（FILE_INDEX/EXTRA_DIRS）与 USERPROFILE 环境变量，故只此一个测试、勿并行加测。
    #[test]
    fn set_search_dirs_indexes_extra_dir() {
        let base = std::env::temp_dir().join("wb_idx_test");
        let home = base.join("home");
        let extra = base.join("extra");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(home.join("sub")).unwrap();
        fs::create_dir_all(extra.join("sub")).unwrap();
        fs::write(home.join("sub").join("home_marker.txt"), b"x").unwrap();
        fs::write(extra.join("sub").join("zzmarker_extra.txt"), b"x").unwrap();
        // 复刻续111b 的 bug 形态：同名文件 home 里一大堆、额外目录里一个（真机上 README 有 436 个）。
        // 打分只看文件名 → 全部同分 → 稳定排序保持索引顺序 → 额外目录（遍历在后）永远垫底 → 被 limit 截掉。
        for i in 0..60 {
            let d = home.join(format!("proj{i}"));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("dupname.md"), b"x").unwrap();
        }
        fs::write(extra.join("dupname.md"), b"x").unwrap();
        std::env::set_var("USERPROFILE", &home);

        // ① 纯遍历层：scan_dirs + build_index
        EXTRA_DIRS.get_or_init(|| Mutex::new(Vec::new()));
        *EXTRA_DIRS.get().unwrap().lock().unwrap() = vec![extra.clone()];
        let idx = build_index(&scan_dirs());
        let names: Vec<&str> = idx.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"home_marker.txt"), "USERPROFILE 未进索引: {names:?}");
        assert!(names.contains(&"zzmarker_extra.txt"), "额外目录未进索引: {names:?}");

        // ② 命令层：set_search_dirs 的后台重建是否真把新目录换进 FILE_INDEX
        *EXTRA_DIRS.get().unwrap().lock().unwrap() = Vec::new();
        set_search_dirs(vec![extra.to_string_lossy().to_string()]);
        let mut hit = false;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            if !builtin_search("zzmarker_extra", 10).is_empty() {
                hit = true;
                break;
            }
        }
        assert!(hit, "set_search_dirs 调用后 10s 内仍搜不到额外目录里的文件");

        // ③ 排名回归（续111b）：61 个同名 dupname.md 里，额外目录那个必须排进前列而非垫底。
        // 修复前它恒排第 61（索引顺序），被前端 ENH_FILE_LIMIT_BUILTIN=50 截掉 = "加了目录搜不到内容"。
        let all = builtin_search("dupname", 1000);
        let rank = all
            .iter()
            .position(|r| r.path.contains("extra"))
            .expect("同名竞争中额外目录的文件完全没命中");
        assert_eq!(all.len(), 61, "同名文件应共 61 个（home 60 + extra 1）");
        assert!(
            rank == 0,
            "额外目录的同名文件应因 EXTRA_DIR_BONUS 排第 1，实际排第 {}",
            rank + 1
        );
    }

    /// Everything クエリ経路の端到端診断（続117b）。**Everything 本体が起動している必要がある**
    /// ため既定 #[ignore]：
    ///   cargo test --lib everything_query_e2e -- --ignored --nocapture
    ///
    /// 続117 の時点では本機で Everything サービスが止まっており、FFI シンボルの存在までしか
    /// 確認できていなかった。ここで検証したいのは 3 点：
    ///   ① DATE_MODIFIED が実際に返ってきているか（mtime が 0 だらけなら新鮮度加点は死んでいる）
    ///   ② rerank が分層不変量を保っているか（子串一致が子序列一致より上）
    ///   ③ `ext:` 等の Everything 構文で**パニックしない**か —— 続117 で修した -i32::MIN
    ///      overflow がまさにこの経路。回帰したら即座にここで落ちる。
    #[test]
    #[ignore]
    fn everything_query_e2e() {
        if !crate::everything::is_available() {
            println!("Everything が利用不可（未起動 / DLL 無し）。この診断はスキップ。");
            return;
        }
        let prev = SEARCH_ENGINE.load(Ordering::Relaxed);
        SEARCH_ENGINE.store(ENGINE_EVERYTHING, Ordering::Relaxed);

        // ── ① 通常クエリ：mtime が返っているか & 並び ──
        let q = "readme";
        let raw = crate::everything::query(q, 30).expect("Everything クエリが失敗");
        let with_mtime = raw.iter().filter(|r| r.mtime > 0).count();
        println!("\n[{q}] Everything 生結果 {} 件 / うち mtime あり {}", raw.len(), with_mtime);
        assert!(
            raw.is_empty() || with_mtime > 0,
            "結果があるのに mtime が全件 0 —— DATE_MODIFIED 要求が効いていない（新鮮度加点が丸ごと死ぬ）"
        );

        let now = now_unix();
        println!("  ── rerank 後の上位 10（[層] 名前 / 更新） ──");
        let ranked = rerank_everything(raw, q);
        for r in ranked.iter().take(10) {
            let layer = if r.name.to_lowercase().contains(q) { "子串  " } else { "子序列" };
            let age = if r.mtime > 0 {
                format!("{}日前", now.saturating_sub(r.mtime) / 86_400)
            } else {
                "不明".to_string()
            };
            println!("    [{layer}] {:<44} {age}", r.name);
        }
        // ② 分層不変量：子串一致は必ず子序列一致より上
        let first_subseq = ranked.iter().position(|r| !r.name.to_lowercase().contains(q));
        let last_substr = ranked.iter().rposition(|r| r.name.to_lowercase().contains(q));
        if let (Some(fs), Some(ls)) = (first_subseq, last_substr) {
            assert!(ls < fs, "分層不変量が破れた：子序列一致({fs}) が子串一致({ls}) より上にいる");
            println!("  ✓ 分層不変量 OK（子串は {ls} 番目まで / 子序列は {fs} 番目から）");
        }

        // ── ③ Everything 構文：続117 で修した overflow パニックの経路 ──
        // 名前にクエリ語が現れないので score_of が番兵 i32::MIN を返す。
        // 修正前はここで `-i32::MIN` により attempt to negate with overflow で落ちた。
        for syntax in ["ext:txt", "*.md", "size:>1mb"] {
            let r = search_files(syntax.to_string(), 20);
            println!("  [{syntax}] {} 件（パニックせず完走）", r.len());
        }
        println!("  ✓ Everything 構文でパニックなし（続117 の -i32::MIN overflow 回帰なし）\n");

        SEARCH_ENGINE.store(prev, Ordering::Relaxed);
    }

    /// 診断用（既定 #[ignore]、手動実行：
    ///   cargo test --lib measure_result_limit_cost -- --ignored --nocapture）
    ///
    /// 「結果件数の上限を開けられるか」を数字で判断するための計測（続120 調査）。
    /// 上限は 3 段ある：前端 ENH_FILE_LIMIT_EVERYTHING(200) → Rust QUERY_LIMIT_CAP(500)
    /// → Everything set_max。実効的に効いているのは**前端の 200**。
    ///
    /// コストの内訳を分けて測る：
    ///   ① Everything クエリ本体（IPC ＋ 文字列変換）
    ///   ② アイコン埋め（**1 件ごとに base64 PNG 文字列を clone する**）
    ///   ③ JSON シリアライズ（IPC で webview へ渡る実際のペイロード）
    /// ③ が支配的なら、上限を上げる前に「アイコンを別便にする」等の設計変更が要る。
    #[test]
    #[ignore]
    fn measure_result_limit_cost() {
        if !crate::everything::is_available() {
            println!("Everything 未起動のため計測不能。");
            return;
        }
        let prev = SEARCH_ENGINE.load(Ordering::Relaxed);
        SEARCH_ENGINE.store(ENGINE_EVERYTHING, Ordering::Relaxed);
        let q = "windows"; // ユーザー報告のクエリ（Everything 側では 7 万件超）

        println!("\n件数上限ごとのコスト（クエリ: {q:?}）");
        println!("{:>7} | {:>9} | {:>9} | {:>9} | {:>11}", "上限", "クエリ", "rerank", "JSON化", "JSONサイズ");
        println!("{}", "-".repeat(60));
        for &n in &[200usize, 500, 1000, 5000, 20000] {
            let t0 = Instant::now();
            let raw = match crate::everything::query(q, n) {
                Ok(r) => r,
                Err(e) => { println!("{n:>7} | クエリ失敗: {e}"); continue; }
            };
            let got = raw.len();
            let t_query = t0.elapsed();

            let t1 = Instant::now();
            let ranked = rerank_everything(raw, q);
            let t_rank = t1.elapsed();

            let t2 = Instant::now();
            let json = serde_json::to_string(&ranked).unwrap_or_default();
            let t_json = t2.elapsed();

            println!(
                "{got:>7} | {:>9.2?} | {:>9.2?} | {:>9.2?} | {:>8.1} KB",
                t_query, t_rank, t_json, json.len() as f64 / 1024.0
            );
        }

        // アイコン 1 個あたりの base64 サイズ ——「上限を上げたときの JSON 増分」の主因。
        // ICON_CACHE はバックグラウンドワーカーが作るのでテストでは空。実測は直接取る。
        // get_file_info は自前で COM を初期化するのでそのまま呼べる
        for ext in ["txt", "exe", "png"] {
            let probe = std::env::temp_dir().join(format!("wb_iconprobe.{ext}"));
            let _ = std::fs::write(&probe, b"x");
            let sz = crate::apps::get_file_info(probe.to_string_lossy().to_string())
                .ok()
                .and_then(|i| i.icon)
                .map(|s| s.len())
                .unwrap_or(0);
            println!("  .{ext} アイコンの base64 長: {} B", sz);
            let _ = std::fs::remove_file(&probe);
        }
        println!("  ↑ 上限 N のとき JSON はおよそ N × (アイコン長 + パス長) だけ膨らむ");

        // 続120 の効果を実データで：候補プールを広げると、返す 10 件の中身が実際に変わるか。
        // 変わらなければ「切ってから評価」でも結果は同じ＝この変更に意味が無かったことになる。
        println!("\n候補プールの広さが、返す上位 10 件をどう変えるか（クエリ: {q:?}）");
        for &pool in &[200usize, EVERYTHING_CANDIDATE_POOL] {
            if let Ok(r) = crate::everything::query(q, pool) {
                let got = r.len();
                let mut ranked = rerank_everything(r, q);
                ranked.truncate(10);
                println!("  候補 {got:>5} 件 → 上位 10:");
                for x in &ranked {
                    println!("      {}", x.name);
                }
            }
        }
        println!();

        SEARCH_ENGINE.store(prev, Ordering::Relaxed);
    }

    /// 诊断用（默认 #[ignore]，手动跑：cargo test measure_real_rebuild -- --ignored --nocapture）：
    /// 量真实用户目录的「遍历」与「图标预热」各自耗时——set_search_dirs 的后台重建要把这两步全跑完
    /// 才会原子替换 FILE_INDEX，这段时间内新加的目录搜不到。
    #[test]
    #[ignore]
    fn measure_real_rebuild() {
        let home = PathBuf::from(std::env::var("USERPROFILE").unwrap());
        let t1 = Instant::now();
        let idx = build_index(&[(home, false)]);
        let walk = t1.elapsed();
        let exe_lnk = idx.iter().filter(|e| e.ext == "exe" || e.ext == "lnk").count();
        let t2 = Instant::now();
        let icons = build_icon_cache(&idx);
        println!(
            "遍历: {walk:?} / {} 条（其中 exe+lnk {exe_lnk} 个 → 每个单独提图标）\n图标预热: {:?} / {} key\n合计: {:?}",
            idx.len(),
            t2.elapsed(),
            icons.len(),
            t1.elapsed()
        );
    }
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
        let started = Instant::now();
        let dirs = scan_dirs();
        let new_index = build_index(&dirs);
        let new_icons = build_icon_cache(&new_index); // 同步预热图标，与索引一起换入
        let (total, extra) = (new_index.len(), new_index.iter().filter(|e| e.extra).count());
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
        // 与 start_index_worker 的 [fileindex] ready 同款日志。此前本重建**完全静默**——
        // 排查「加了目录搜不到」时无从判断是没重建、还是重建了但没收进去（续111b 诊断的实际阻力）。
        eprintln!(
            "[fileindex] set_search_dirs 重建完成: {total} 条（额外目录 {extra} 条）({:?})",
            started.elapsed()
        );
    });
}
