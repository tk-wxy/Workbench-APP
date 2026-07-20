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
///
/// **续126 内存布局收紧**：原先 `path`/`name`/`name_lower`/`ext` 四个 `String` 把同一份字节
/// 存了三四遍（`name` 是 `path` 的后缀、`ext` 是 `name` 的后缀、`name_lower` 是 `name` 的小写副本），
/// 且每个 `String` 头就吃 24 B。现在只留两份实际字节（`path` 与 `name_lower`），
/// `name`/`ext` 改由偏移量切片派生 —— 见 `name()` / `ext()`。
/// 实测 241 → 158 B/条（-34%），8 万条索引下省约 6 MB。
///
/// `Box<str>` 而非 `String`：索引建好后再不修改，少存一个 capacity 字段（24→16 B/个）。
#[derive(Clone)]
pub struct IndexEntry {
    pub path: Box<str>,
    /// 文件名的小写形式。**匹配全部走它**（查询词已小写），故它必须独立存在，无法从 path 派生。
    pub name_lower: Box<str>,
    /// `name` 在 `path` 中的起始字节偏移（`path[name_off..]` == 文件名原始大小写）。
    name_off: u32,
    /// `ext` 在 `name_lower` 中的起始字节偏移（`name_lower[ext_off..]` == 小写扩展名，不含点）。
    /// 无扩展名时 == `name_lower.len()`，切出来是空串。
    ext_off: u32,
    pub is_dir: bool,
    /// 是否来自用户手动添加的额外扫描目录（EXTRA_DIRS）。查询时据此加分，见 EXTRA_DIR_BONUS。
    pub extra: bool,
    /// 路径深度（分隔符个数，续122）。索引期算一次即可——每次查询都去重扫 8 万条路径纯属浪费。
    pub depth: u8,
    /// 最后修改时间（Unix 秒，0 = 取不到）。续117 加，新鲜度加分的输入。
    /// **必须存进索引**：查询命令「只读内存、不碰磁盘」是铁律，所以不能每次查询现场 stat。
    /// Windows 的目录枚举（FindFirstFile）本来就返回 ftLastWriteTime，故索引期取它几乎免费。
    pub mtime: u64,
}

impl IndexEntry {
    /// 构造：`name`/`ext` 不单独存，只记它们在 `path`/`name_lower` 里的偏移（续126）。
    ///
    /// 两个后缀关系在极端 Unicode 下可能不成立（`to_lowercase` 会改变字节长度，
    /// 如 `İ` → 2 字符；walkdir 的根条目 path 与 file_name 也可能相等而非后缀关系）。
    /// 这类情况**不 panic 也不丢条目**，而是退化：`name_off=0`（name 取整条 path）、
    /// `ext_off=len`（ext 取空串）。代价仅限该条目的显示名/图标归类，匹配用的 name_lower 不受影响。
    fn new(path: String, name: &str, ext: &str, is_dir: bool, extra: bool, mtime: u64) -> Self {
        let name_lower = name.to_lowercase();
        let name_off = path
            .len()
            .checked_sub(name.len())
            .filter(|&i| path.is_char_boundary(i) && &path[i..] == name)
            .unwrap_or(0) as u32;
        let ext_lower = ext.to_lowercase();
        let ext_off = name_lower
            .len()
            .checked_sub(ext_lower.len())
            .filter(|&i| !ext_lower.is_empty() && name_lower.is_char_boundary(i) && name_lower[i..] == ext_lower)
            .unwrap_or(name_lower.len()) as u32;
        Self {
            depth: path_depth(&path),
            path: path.into_boxed_str(),
            name_lower: name_lower.into_boxed_str(),
            name_off,
            ext_off,
            is_dir,
            extra,
            mtime,
        }
    }

    /// 文件名（原始大小写）。从 `path` 切片派生，不占额外内存。
    pub fn name(&self) -> &str {
        &self.path[self.name_off as usize..]
    }

    /// 小写扩展名（不含点）。从 `name_lower` 切片派生，不占额外内存。
    pub fn ext(&self) -> &str {
        &self.name_lower[self.ext_off as usize..]
    }
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
    /// 图标在 `SearchResponse.icons` 表里的键（续126 ③）。
    ///
    /// **不再内联 base64**：图标按「文件夹 / 扩展名 / exe·lnk 各自路径」去重，
    /// 500 条结果通常只有 20~50 张不同的图。内联时同一张图被重复送 500 遍——
    /// 实测查询 "windows" 的 IPC 载荷 660 KB，改成键 + 去重表后 79 KB（-88%）。
    /// 前端收到后按此键回填自己的 `icon` 字段，故渲染侧代码完全不用动。
    pub icon_key: String,
    /// 最后修改时间（Unix 秒，0 = 未知）。排序用的**内部字段，不送前端**
    /// （前端预览面板走 get_file_info；这里再 serialize 一份，同一个事实就有两个出处）。
    /// 内置引擎从索引取，Everything 从 SDK 的 DATE_MODIFIED 取。
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
/// 图标缓存每隔多少轮重建做一次**全量**刷新（续128）。
/// 增量复用是按 key 命中的，而 exe/lnk 的 key 是文件路径——程序升级换了图标，
/// 只要路径没变就会一直命中旧值。这个常量把「图标陈旧」的上限钉在 12 × 30min = 6 小时。
/// 调小 = 图标更跟手但更费 Shell；调大 = 更省但陈旧窗口更长。
const ICON_CACHE_FULL_REFRESH_EVERY: u32 = 12;
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
/// 取值 300 的依据：与短名/新鲜度加分合计必须**小于相邻层带的最小间距**（见下方分层定义），
/// 使额外目录的模糊命中仍排在普通目录的子串命中之后——即不破坏 token_score 那条
/// 「直接含永远排在拆字母前」的分层不变量，只翻转同层内的并列。
/// 按条目加一次（非按 token）。⚠️ 具体数值随续121 的分层重设计而变，检算见 ENTRY_BONUS_BUDGET。
const EXTRA_DIR_BONUS: i32 = 300;

// ── 匹配质量的分层（续121 重设计）──────────────────────────────────────────
//
// 续120 之前只有「子串(2000 基准) / 子序列(≤1000)」两层，层内差异靠 `+400 前缀`
// `+200 词首` 这类**加分**表达。结果层间只剩 500 间距，而条目级加分
// （额外目录 300 + 短名 60 + 新鲜度 120 = 480）几乎占满，**再也塞不下任何东西**。
// 更要命的是「名字与查询词完全一致」这个最强信号没有专属席位，
// `Windows` 和 `amd64_microsoft-windows-cng_…` 挤在同一层，只能靠短名加分那点
// 微弱差距分胜负（续120 实测暴露）。
//
// 因此**把层拉开成显式的常量带**。层内微调（位置罚分）与条目加分，
// 必须全部塞进一个带间隙里：
//
//   L_EXACT  10000   名字（或去掉扩展名的词干）与查询词完全一致
//   L_PREFIX  7000   名字以查询词开头
//   L_WORD    5000   查询词出现在单词边界（空格/_/-/. 等）之后
//   L_SUBSTR  3000   名字里含有查询词
//   (子序列)  0..1000  字符拆开按序命中（SUBSEQ_CAP 封顶）
//
// 层内差异只有位置罚分（0..-POS_PENALTY_MAX），故各层实际跨度是 [base-500, base]，
// 最窄的相邻间隙是 子序列上限(1000) 到 L_SUBSTR 下端(2500) 的 1500。
// 条目加分合计 720 低于它（余量 780）。检算由 tests::layer_invariant_budget_holds 负责
// ——**动了常量最先挂的就是它**。
//
// 多 token 时层值随 token 数成比例放大，而条目加分每条只加一次，
// 故**单 token 永远是最紧的情形**，预算在那里满足即可。
const L_EXACT: i32 = 10_000;
const L_PREFIX: i32 = 7_000;
const L_WORD: i32 = 5_000;
const L_SUBSTR: i32 = 3_000;
const SUBSEQ_CAP: i32 = 1_000;
/// 层内位置罚分上限（查询词出现得越靠后扣得越多）。层的实际跨度 = 这个值。
const POS_PENALTY_MAX: i32 = 500;

/// 短名加分上限（续121 从 60 提到 300，且函数形从线性改为反比例）。
///
/// 为什么换形状：旧的 `MAX - min(len, MAX)` 是每字符扣 1 分的线性衰减，
/// MAX=60 时 7 字符与 60 字符最多差 53 分，压不住 WinSxS 那些
/// `amd64_microsoft-windows-…_none_88b3efd7d6c90eb9`（60+ 字符）。
/// 反比例则在短的一侧急剧起效、长的一侧趋于平坦。
const SHORT_NAME_BONUS_MAX: i32 = 300;
/// 名字长度 → 短名加分。len=7→208 / 20→133 / 60→63 / 100→41（单调递减，落在 [0, MAX]）。
fn short_name_bonus(len: usize) -> i32 {
    SHORT_NAME_BONUS_MAX * 16 / (16 + len as i32)
}

/// 新鲜度加分上限（续117）。实际取值见 recency_bonus() 的阶梯。
const RECENCY_BONUS_MAX: i32 = 120;

/// 路径浅度加分上限（续122）。
///
/// 动机：把系统根加进索引之后，"windows" 的结果里 `C:\Windows` 沉到了第 6。
/// 前 5 名是 home 下 Go 模块缓存里的 `…/golang.org/x/sys@v0.30.0/windows` 之类，
/// **名字相同即同为完全一致（L_EXACT）、名字长度也一样**，
/// 于是唯一的决胜依据只剩索引顺序（home 在前）。
///
/// 「同等匹配质量下，路径浅的才是更重要的实体」是普遍成立的信号，
/// 不是给 Windows 开的后门——`C:\Program Files\App` 排在
/// `C:\Users\me\Downloads\backup\old\App` 前面用的是同一条道理。
const PATH_DEPTH_BONUS_MAX: i32 = 200;
/// 路径深度 → 加分。depth=1→160 / 3→114 / 6→80 / 10→57（单调递减）。
/// 深度 1 与 10 差约 100 分，足够打破上面那种完全一致之间的僵局。
fn path_depth_bonus(depth: u8) -> i32 {
    PATH_DEPTH_BONUS_MAX * 4 / (4 + depth as i32)
}
/// 路径分隔符个数 = 深度。`C:\Windows` → 1，`C:\a\b\c` → 3。u8 饱和（不存在深于 255 层的路径）。
fn path_depth(path: &str) -> u8 {
    path.bytes().filter(|b| *b == b'\\' || *b == b'/').count().min(255) as u8
}

/// 条目级加分的合计上限。**必须小于相邻带的最小间隙**。
/// 只有测试引用它，但它是预算的声明本身，故不放进 #[cfg(test)]。
#[allow(dead_code)]
const ENTRY_BONUS_BUDGET: i32 =
    EXTRA_DIR_BONUS + SHORT_NAME_BONUS_MAX + RECENCY_BONUS_MAX + PATH_DEPTH_BONUS_MAX;

/// 修改时间 → 新鲜度加分（续117）。
///
/// 动机：应用有使用频次打分（usageScore：频次 × 30 天半衰期），而**文件完全没有时间维度**。
/// 5 分钟前编辑过的文件和 2015 年的同名文件完全同分，只能靠名字长短和遍历顺序决胜。
/// 「要找的多半是刚碰过的那个」是极强的先验，排序却一点没用上。
///
/// 用**阶梯**而非连续函数的理由：连续函数下微小的时间差就会让顺序抖动，
/// 同一个查询重打一遍顺序就变了。做成档位后，「本周的东西」之间仍按相关度决定。
///
/// 取值在上面的预算内（≤ RECENCY_BONUS_MAX）。未来时间（时钟偏差 / 网络盘）
/// 用 age 饱和到 0 当作最新档——不给负值垫脚。
fn recency_bonus(mtime: u64, now: u64) -> i32 {
    if mtime == 0 {
        return 0; // 取不到
    }
    let age = now.saturating_sub(mtime);
    const DAY: u64 = 86_400;
    if age <= 7 * DAY {
        RECENCY_BONUS_MAX // 120：本周碰过
    } else if age <= 30 * DAY {
        70
    } else if age <= 365 * DAY {
        25
    } else {
        0
    }
}

/// 当前时间（Unix 秒）。不碰索引，故在查询路径调用不违反铁律。
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}


/// 驱动器根的索引深度（续123）。
///
/// 续122 曾点名把系统根（C:\Windows 等）加进来，但用户的项目在 `D:\dev\workbench-app`，
/// **整个 D: 盘未覆盖**，于是有了「自己的项目搜不到」的反馈。点名列举是不够的
/// ——存在的驱动器必须全看。
///
/// 单个驱动器根的实测（本机，应用剪枝规则后的条数 / 遍历耗时）：
///   C:\  深度3=12,623(122ms)  深度4=44,209(597ms)  深度5=76,448(1.9s)  深度6=119,785(2.1s)
///   D:\  深度3= 4,526(232ms)  深度4=10,173(433ms)  深度5=24,148(890ms) 深度6=45,426(1.2s)
///
/// 连同 home 的整体索引实测（home 深度 10 ＋ 全部驱动器根）：
///   深度3 → 66,215 条 / 591ms / 14.6MB   ← 采用这个
///   深度4 → 103,191 条 / 1.09s / 23.7MB
///   （对比：续122 的「点名系统根 + 深度3」是 82,886 条 / 19.1MB，而且 D: 还没覆盖）
///
/// **深度 3 在覆盖和内存两方面都是上位替代**，故采用。改成从驱动器根扫之后覆盖面本就大得多，
/// 即使浅一档，`D:\dev\workbench-app`（深度 2）、`C:\Windows`、`C:\Windows\System32` 也都够得着。
/// 深度 4 以上多出来的主要是「项目内部的孙目录」，对 launcher 用途价值低，
/// 却会把条数＝内存一下子推上去。
///
/// ⚠️ home 另有一趟深度 10 的遍历，故 build_index 会**按子树剪枝**防止重复登记
/// （scan_dirs 把 home 排在前面）。
const DRIVE_ROOT_DEPTH: usize = 3;

/// 枚举要索引的驱动器根（续123）。
///
/// 测试时可置 `WORKBENCH_SCAN_DRIVES=0` 关掉——不关的话
/// `set_search_dirs_indexes_extra_dir` 会去走真实的 C:/D:，既慢又变成环境依赖
/// （与既有的替换 USERPROFILE 的做法保持一致）。
fn drive_roots() -> Vec<PathBuf> {
    if std::env::var("WORKBENCH_SCAN_DRIVES").map(|v| v == "0").unwrap_or(false) {
        return Vec::new();
    }
    ('A'..='Z')
        .map(|c| PathBuf::from(format!("{c}:\\")))
        .filter(|p| p.exists())
        .collect()
}

/// 扫描根目录清单。返回 (目录, 是否为用户手动添加的额外目录, 遍历深度)。
/// 第二项一路带进 IndexEntry.extra 供查询加分用（见 EXTRA_DIR_BONUS）。
/// 根 = 用户目录（深） + 驱动器根（浅，续123） + 用户额外目录（深）。
/// 不存在的目录跳过（故手输打错的路径会被静默忽略——续111 改用文件夹选择器后不再可能）。
fn scan_dirs() -> Vec<(PathBuf, bool, usize)> {
    let mut dirs: Vec<(PathBuf, bool, usize)> = Vec::new();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if !home.is_empty() {
        let p = PathBuf::from(&home);
        if p.exists() {
            dirs.push((p, false, MAX_WALK_DEPTH));
        }
    }
    // 驱动器根走浅的。放在 home **之后**有两个理由：
    //  ① build_index 会剪掉「先遍历过的根」的子树，若深的 home 不在前面，
    //     home 就会被驱动器根的浅遍历吃掉、只索引到浅层
    //  ② 同分时稳定排序保持先索引者在前 = 自己的文件排在上面
    for p in drive_roots() {
        if !dirs.iter().any(|(d, _, _)| d == &p) {
            dirs.push((p, false, DRIVE_ROOT_DEPTH));
        }
    }
    if let Some(lock) = EXTRA_DIRS.get() {
        if let Ok(guard) = lock.lock() {
            for p in guard.iter() {
                if p.exists() && !dirs.iter().any(|(d, _, _)| d == p) {
                    dirs.push((p.clone(), true, MAX_WALK_DEPTH));
                }
            }
        }
    }
    dirs
}

// 跳过的目录名（隐藏 / 系统 / 噪音），命中则整个子树不进入。扫整个用户目录时 appdata 剪枝尤其关键。
fn should_skip_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.') || NOISE_DIRS.contains(&n.as_str())
}

/// 噪声目录名（**两个引擎的单一真相源**，续121）。
///
/// 内置引擎在建索引时用 `should_skip_dir` 整棵剪掉，本来就生效；
/// **但 Everything 路径没有等价物**——它是全盘索引，`C:\Windows\WinSxS` 下的
/// `amd64_microsoft-windows-*` 数万条会原样灌进来，把 "windows" 的结果占满
/// （续120 实测发现）。同一份名单在 Everything 侧用作结果过滤，
/// 使「两个引擎的检索对象一致」。
///
/// ⚠️ winsxs 不会出现在内置的遍历范围（%USERPROFILE%）内，但为了不把名单拆成两份仍放这里。
/// 往这里加名字会让**两个引擎都搜不到那些内容**，添加需谨慎。
const NOISE_DIRS: &[&str] = &[
    "node_modules",
    "$recycle.bin",
    "appdata",
    "target",
    ".git",
    "__pycache__",
    "system volume information",
    "winsxs", // 续121：Everything 全盘搜索里最大的噪声来源
];

/// 路径的任一组成部分命中噪声目录即为 true（续121，用于筛 Everything 结果）。
/// 内置引擎在建索引时已排除，无需调用。
fn is_noise_path(path: &str) -> bool {
    path.split(['\\', '/'])
        .any(|seg| NOISE_DIRS.contains(&seg.to_lowercase().as_str()))
}

/// 给 Everything 查询追加噪声排除句（续121）。
///
/// **为什么光靠我们这边过滤不行**：Everything 按默认顺序（近似路径序）截 set_max 条返回，
/// 所以 "windows" 的前 5000 条会被 WinSxS 整个占满。收到结果再扔的话，
/// 实测 5000 条候选池里只剩 2 条，而 `C:\Windows` 本体压根没进池子。
/// **排除必须让 Everything 自己做，否则候选数根本保不住。**
///
/// 语法（实机验证过，见 probe_everything_exclude）：
/// - 必须带 `path:` 修饰。裸的 `!winsxs` 只看文件名，无效。
/// - 必须用 `\name\` **反斜杠界定**。写成 `!path:target` 会把 "my-target-app" 一起误伤。
/// - 有含空格的名字（system volume information），所以整体加引号。
///
/// ⚠️ 局限：用户查询含 `|`（OR）时，受 Everything 优先级影响，排除可能只作用于右侧。
/// 后面的 `is_noise_path` 过滤兜住这种漏网（双重防御；它按路径组成部分判断，不会过度匹配）。
fn everything_query_with_exclusions(query: &str) -> String {
    let mut q = String::from(query.trim());
    for d in NOISE_DIRS {
        q.push_str(&format!(" !path:\"\\{d}\\\""));
    }
    q
}

// 耗时部分：纯遍历构建，绝不持 FILE_INDEX 锁。
// dirs 的第二项 = 该根是否为用户手动添加的额外目录，逐条记进 IndexEntry.extra（查询时加分用）。
fn build_index(dirs: &[(PathBuf, bool, usize)]) -> Vec<IndexEntry> {
    let mut out = Vec::new();
    // 已登记的路径（小写）。**根之间会重叠，剪枝挡不住所有情形**（续131c）：
    // `covered` 那套只处理「后来的根**包含**先前的根」（走到那个目录节点就整树剪掉），
    // 而额外扫描目录几乎总是**嵌套在**先前的根里面——例如额外目录 `D:\dev\mcdownloader`
    // 落在盘符根 `D:\`（深度 3）之下，`D:\dev\mcdownloader\src` 正好深度 3：
    // 盘符根那轮收一次，额外目录那轮再收一次 → **同一路径两条索引**。
    //
    // 后果不止是列表里多一行：前端 `enhKey` 用 `"fs:" + path` 当 React key，
    // 重复路径 = 重复 key = 列表 reconciliation 错乱（旧行残留、段表头错位）。
    // 故这里按路径兜底去重，与剪枝互补：剪枝省遍历开销，去重保正确性。
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 已经遍历过的根。后续的根（如驱动器根）若包含它们，就整棵子树剪掉，
    // **防止重复登记**（续123）。因为 home 走得深、驱动器根走得浅，
    // 顺序必须是「深的根在前」—— scan_dirs 就是按这个顺序返回的。
    let mut covered: Vec<PathBuf> = Vec::new();
    // 额外目录的小写前缀表。`extra` 标记**必须按路径前缀判定，不能按"哪个根收的它"**（续131c）：
    // 去重之后，一个路径由谁先收到是不确定的（盘符根可能先于额外目录收走它），
    // 而 `extra=false` 会让它丢掉 EXTRA_DIR_BONUS —— 那正是续111b 修好的
    // 「加了额外扫描目录却搜不到里面的内容」。按前缀判定与顺序无关，怎么去重都不会错。
    let extra_prefixes: Vec<String> = dirs
        .iter()
        .filter(|(_, is_extra, _)| *is_extra)
        .map(|(d, _, _)| d.to_string_lossy().to_lowercase())
        .collect();
    for (dir, _is_extra, depth) in dirs {
        if out.len() >= MAX_INDEX_ENTRIES {
            break;
        }
        let already = covered.clone();
        for entry in WalkDir::new(dir)
            // 深度按根区分（续122）：home 深，驱动器根浅
            .max_depth(*depth)
            .into_iter()
            .filter_entry(|e| {
                if !e.file_type().is_dir() {
                    return true;
                }
                // 目录命中跳过名单则剪枝整个子树
                if e.file_name().to_str().map(should_skip_dir).unwrap_or(false) {
                    return false;
                }
                // 若正是先前遍历过的根，则整棵子树跳过（续123）
                !already.iter().any(|c| c == e.path())
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
            // mtime：walkdir 的 DirEntry::metadata() 在 Windows 上会复用目录枚举时的
            // WIN32_FIND_DATA，几乎不产生额外 syscall（实测可跑 measure_real_rebuild 确认）。
            // 取不到就退化为 0 = 不加分。
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let path_s = path.to_string_lossy().to_string();
            // 去重按小写比（Windows 路径大小写不敏感），登记仍用原始大小写
            let key = path_s.to_lowercase();
            if !seen.insert(key.clone()) {
                continue; // 先前的根已收过这条，跳过（见函数顶部 seen 的说明）
            }
            let is_extra = extra_prefixes.iter().any(|p| key.starts_with(p.as_str()));
            out.push(IndexEntry::new(path_s, &name, &ext, is_dir, is_extra, mtime));
        }
        covered.push(dir.clone());
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
        let mut round: u32 = 0;
        loop {
            let dirs = scan_dirs();
            let started = Instant::now();
            let new_index = build_index(&dirs); // 耗时部分，不持锁
            // 图标预热（续128 改为增量）：取上一轮缓存的快照当基线，只提本轮新出现的 key。
            // 每 ICON_CACHE_FULL_REFRESH_EVERY 轮传空表做一次全刷——否则 exe/lnk 是按路径做 key 的，
            // 程序升级换了图标后会**永远**停在旧图上。全刷把陈旧上限钉死在约 6 小时。
            let base = if round.is_multiple_of(ICON_CACHE_FULL_REFRESH_EVERY) {
                HashMap::new()
            } else {
                ICON_CACHE
                    .get()
                    .and_then(|l| l.lock().ok())
                    .map(|g| g.clone()) // 快照后立即出锁：下面的 Shell 提取绝不持锁
                    .unwrap_or_default()
            };
            let icon_started = Instant::now();
            let new_icons = build_icon_cache(&new_index, &base); // 遍历后、替换前预热（后台线程，不持锁）
            let icon_ms = icon_started.elapsed();
            let reused = new_icons.len().saturating_sub(
                new_icons.keys().filter(|k| !base.contains_key(*k)).count(),
            );
            let icon_total = new_icons.len();
            round = round.wrapping_add(1);
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
                "[fileindex] ready: {} entries ({:?}) / 图标 {} key（复用 {}，新提 {}，耗时 {:?}）",
                count,
                started.elapsed(),
                icon_total,
                reused,
                icon_total - reused,
                icon_ms
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

// 子序列模糊打分：t 的字符按序出现在 name 中即算命中；连续命中、词首命中额外加分。上限 SUBSEQ_CAP。
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
                None => return Some(score.min(SUBSEQ_CAP)), // t 全部匹配完
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
    // 完全一致也看**去掉扩展名的词干**（续121）。查 "report" 时
    // `report.md` 就是要找的东西本身，不该和 `report_draft.md` 挤在同一层、
    // 靠短名加分那点微弱差距分胜负。
    let stem = name_lower.rsplit_once('.').map(|(a, _)| a).unwrap_or(name_lower);
    if name_lower == t || stem == t {
        return Some(L_EXACT);
    }
    if let Some(pos) = name_lower.find(t) {
        // 层内唯一的调整轴 = 出现位置（越靠后扣越多）。跨度收在 POS_PENALTY_MAX 内。
        let refine = -(pos as i32).min(POS_PENALTY_MAX);
        let base = if pos == 0 {
            L_PREFIX
        } else if name_lower[..pos]
            .chars()
            .next_back()
            .map(is_boundary)
            .unwrap_or(false)
        {
            L_WORD
        } else {
            L_SUBSTR
        };
        return Some(base + refine);
    }
    subseq_score(t, name_lower)
}

/// 单条目的综合得分（续117 从 builtin_search 抽出）。任一 token 未命中则返回 None。
///
/// 抽出理由：**为了在不碰全局状态（FILE_INDEX / EXTRA_DIRS / USERPROFILE）的前提下测排序**。
/// 既有的端到端测试会改写这些全局量，因而带着「只此一个、别并行加测」的约束，
/// 排序的回归测试没法搭在它上面。这里做成纯函数后，就能手工构造 IndexEntry 自由验证。
fn entry_score(tokens: &[&str], e: &IndexEntry, now: u64) -> Option<i32> {
    let mut total = 0i32;
    for t in tokens {
        total += token_score(t, &e.name_lower)?; // 有一个不中就算不匹配（多词 AND）
    }
    // ↓ 条目级加分。合计必须小于相邻带的最小间隙（见分层预算注释 ENTRY_BONUS_BUDGET）
    total += short_name_bonus(e.name().len()); // 短名优先（续121 改为反比例形、加强）
    if e.extra {
        total += EXTRA_DIR_BONUS; // 用户手动添加的目录 = 明确意图信号，翻转同名并列（见常量注释）
    }
    total += recency_bonus(e.mtime, now); // 续117：同层内优先最近碰过的
    total += path_depth_bonus(e.depth); // 续122：同等匹配质量下优先浅路径
    Some(total)
}

// 内置引擎查询：纯内存读，<5ms。多词 AND + 分层打分 + 短名优先 + 新鲜度。
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
    // 新鲜度加分用的当前时间只取一次（循环里每条都调 SystemTime::now 是浪费）
    let now = now_unix();
    let mut scored: Vec<(i32, &IndexEntry)> = Vec::new();
    for e in guard.iter() {
        if let Some(total) = entry_score(&tokens, e, now) {
            scored.push((total, e));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name().len().cmp(&b.1.name().len())));
    scored
        .into_iter()
        .take(limit.min(QUERY_LIMIT_CAP))
        .map(|(_, e)| FileSearchResult {
            path: e.path.to_string(),
            name: e.name().to_string(),
            ext: e.ext().to_string(),
            is_dir: e.is_dir,
            icon_key: String::new(), // 由 attach_icons 统一填充
            mtime: e.mtime,
        })
        .collect()
}

/// 把 Everything 的结果**用与内置相同的尺子重排**（续117）。
///
/// 为什么需要：`search_files` 的 Everything 分支完全没走 `token_score`，
/// 而是原样返回 Everything 自己的默认顺序。也就是说**切换引擎会静默改变排序的语义**，
/// 短名优先和新鲜度都不生效，而 UI 上没有任何说明。
///
/// 局限（说实话）：候选集本身是 Everything 用 `set_max` 截断之后的，
/// 所以这是「按 Everything 默认序取前 N 再按相关度重排」，而非「相关度前 N」。
/// 要完全对齐需要取回全量，全盘搜索下不现实。可见部分的顺序是一致的。
///
/// 不加额外目录加分——Everything 看的是全盘，EXTRA_DIRS 这个概念对不上。
fn rerank_everything(mut results: Vec<FileSearchResult>, query: &str) -> Vec<FileSearchResult> {
    let q = query.trim().to_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().collect();
    if tokens.is_empty() {
        return results;
    }
    // 先滤掉噪声路径（续121）。**在收窄候选池之前**做，所以即使 5000 条池子被 WinSxS 占满，
    // 实际候选数也不至于归零。选择排除而非降权，是因为内置引擎在建索引时就排除了同样的东西，
    // **要让两个引擎的检索对象保持一致**。
    results.retain(|r| !is_noise_path(&r.path));
    let now = now_unix();
    let score_of = |r: &FileSearchResult| -> i32 {
        let name_lower = r.name.to_lowercase();
        let mut total = 0i32;
        for t in &tokens {
            match token_score(t, &name_lower) {
                Some(s) => total += s,
                // Everything 的语法（`ext:`、通配符等）下，文件名里可能根本不含查询词。
                // 不丢弃，放到最末尾。
                None => return i32::MIN,
            }
        }
        total += short_name_bonus(r.name.len());
        total += recency_bonus(r.mtime, now);
        total += path_depth_bonus(path_depth(&r.path)); // 续122（Everything 侧从路径现算）
        total
    };
    // 用 sort_by_cached_key：score_of 内部要 to_lowercase，别让它在每次比较时重算。
    // 降序用 Reverse 表达 —— ⚠️ **不能用符号取反(-score)**：未命中的哨兵是 i32::MIN，
    // 而 -i32::MIN 超出 i32 范围会 overflow panic（`ext:txt` 这类 Everything 语法会实际踩到，
    // 已被测试捕获）。同分按名字短的在前（与内置的 tie-break 保持一致）。
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
///
/// **续128 增量化**：`prev` 传上一轮的缓存，其中已有的 key 直接搬过来、不再碰 Shell。
/// 起因是实测发现这个函数每轮要跑 **8.5~9.5 秒 / 1958 个 key**，而 `start_index_worker`
/// 每 30 分钟重建一次索引就连带全量重跑一次——绝大多数 key 是扩展名（`.txt` 的图标不会变），
/// 一个常驻后台的工具没有理由每半小时花 9 秒重新提一遍同样的图。
/// 传空表即退化为全量提取（首轮 / 周期性全刷）。
fn build_icon_cache(
    entries: &[IndexEntry],
    prev: &HashMap<String, Option<String>>,
) -> HashMap<String, Option<String>> {
    // key → 代表路径（第一次遇到该类型时记录）
    let mut key_to_rep: HashMap<String, String> = HashMap::new();
    for e in entries {
        key_to_rep
            .entry(icon_key(e.is_dir, e.ext(), &e.path))
            .or_insert_with(|| e.path.to_string());
    }
    // 复用上一轮已提过的 key；**只有本轮新出现的 key 才去调 Shell**。
    // 反过来，上一轮有、本轮索引里已不存在的 key 自然不会进 out —— 缓存不会无限增长。
    let mut out: HashMap<String, Option<String>> = HashMap::with_capacity(key_to_rep.len());
    let mut missing: Vec<(String, String)> = Vec::new();
    for (key, rep) in key_to_rep {
        match prev.get(&key) {
            Some(icon) => {
                out.insert(key, icon.clone());
            }
            None => missing.push((key, rep)),
        }
    }
    if !missing.is_empty() {
        let reps: Vec<String> = missing.iter().map(|(_, rep)| rep.clone()).collect();
        let path_to_icon: HashMap<String, Option<String>> =
            crate::apps::get_file_icons(reps).into_iter().collect();
        for (key, rep) in missing {
            out.insert(key, path_to_icon.get(&rep).cloned().flatten());
        }
    }
    out
}

/// 查询响应（续126 ③）：结果表 + **去重后的**图标表。
///
/// 拆成两段的唯一理由是 IPC 载荷：图标本就按扩展名去重存在 ICON_CACHE 里，
/// 却在序列化时被每条结果各复制一份。见 `FileSearchResult.icon_key`。
#[derive(serde::Serialize)]
pub struct SearchResponse {
    pub results: Vec<FileSearchResult>,
    /// key → base64 PNG data URL。只含本次结果实际用到的键；
    /// 提取失败的键**不进表**（前端取不到即降级为矢量字形，与此前 icon=None 同义）。
    pub icons: HashMap<String, String>,
}

/// 给结果标注 icon_key，并从预热缓存收集这批结果用到的图标——纯内存查表，无 Shell API 调用。
/// 缓存未建立（极短启动窗口）时 icons 为空表，前端已有降级处理。
fn attach_icons(mut results: Vec<FileSearchResult>) -> SearchResponse {
    for r in &mut results {
        r.icon_key = icon_key(r.is_dir, &r.ext, &r.path);
    }
    let mut icons = HashMap::new();
    if let Some(guard) = ICON_CACHE.get().and_then(|l| l.lock().ok()) {
        for r in &results {
            if icons.contains_key(&r.icon_key) {
                continue; // 去重：这正是本次改动的全部意义
            }
            if let Some(Some(ic)) = guard.get(&r.icon_key) {
                icons.insert(r.icon_key.clone(), ic.clone());
            }
        }
    }
    SearchResponse { results, icons }
}

/// 从 Everything **先取回来做评估**的候选数（续120）。与返回条数（limit）是两回事。
///
/// 为什么必须分开：续117 前后都是把 limit(=200) 直接当 set_max 传给 Everything，
/// 也就是**先按 Everything 自己的默认序（近似名字序）截前 200 条，再只在这 200 条里排序**。
/// 想要的文件若排在 Everything 序的第 3000 位，排序算法再好也**根本看不到**。
/// 问题不在条数少，而在**候选集本身就是错的**
/// （用户反馈：Everything 找到 7 万条，增强搜索只出几百条）。
///
/// 取 5000 的依据（本机实测，debug 构建、查询 "windows"／Everything 侧 7 万条以上）：
///   200 条 → 查询 13ms + rerank 0.3ms ／ 5000 条 → 查询 43ms + rerank 3.6ms
/// 在已防抖 150ms 的异步命令里，46ms 体感不出来；release 只会更快。
/// 而 20000 条是 136ms + 16ms，已吃进防抖窗口，故不采用。
/// **返回条数没有增加**，所以 IPC 载荷与 DOM 节点数不变（那才是真正的瓶颈：
/// 图标按每条约 1KB 随结果同发，且列表没有虚拟化）。
const EVERYTHING_CANDIDATE_POOL: usize = 5000;

/// 查询命令：按当前引擎分发，结果从预热缓存回填 Shell 图标（纯内存查表，不调 Shell API）。
/// 图标在后台建索引时已批量预提（build_icon_cache），查询路径只剩内存查找。
/// Everything 不可用时静默降级回内置（保证永远有结果）。
#[tauri::command]
pub fn search_files(query: String, limit: usize) -> SearchResponse {
    let want = limit.min(QUERY_LIMIT_CAP);
    let results = if SEARCH_ENGINE.load(Ordering::Relaxed) == ENGINE_EVERYTHING {
        // 续120：**广取 → 评估 → 收窄再返回**。
        // 内置引擎本来就是先评估整个索引再 take(limit)，现在两边形状一致了
        // ——「先截断再评估」的只有 Everything 这条路。
        // 续121：噪声排除放在 **Everything 侧的查询语句**里做（收到结果再扔的话，
        // 池子会被噪声占满、实际候选数归零。见 everything_query_with_exclusions）
        match crate::everything::query(
            &everything_query_with_exclusions(&query),
            EVERYTHING_CANDIDATE_POOL,
        ) {
            // 续117：用与内置相同的尺子重排后再返回（说明见 rerank_everything）
            Ok(r) => {
                let mut ranked = rerank_everything(r, &query);
                ranked.truncate(want); // ← 在填图标之前截断（下面的 fill 只需处理要返回的那些）
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
    attach_icons(results)
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

    /// 分层预算的检算（续117）。条目级加分的合计不得超过层间间隙。
    /// **动了常量最先挂的就是它**——一旦超出，就会出现「模糊匹配盖过精确匹配」这种
    /// 只看症状根本查不到原因的坏法。
    #[test]
    fn layer_invariant_budget_holds() {
        // 各带的实际范围是 [base - POS_PENALTY_MAX, base]。要求相邻带的最小间隙
        // 大于条目加分的合计——小于的话，「额外目录里的、短的、最近的*弱匹配*」
        // 就会盖过「高一层的强匹配」，看起来就是搜索坏了。
        let bands = [SUBSEQ_CAP, L_SUBSTR, L_WORD, L_PREFIX, L_EXACT];
        let mut min_gap = i32::MAX;
        for w in bands.windows(2) {
            // 下层带的上端 = w[0]（子序列即其封顶值），上层带的下端 = w[1] - 位置罚分
            let gap = (w[1] - POS_PENALTY_MAX) - w[0];
            assert!(gap > 0, "带 {} 与 {} 发生重叠", w[0], w[1]);
            min_gap = min_gap.min(gap);
        }
        assert!(
            ENTRY_BONUS_BUDGET < min_gap,
            "条目加分合计 {ENTRY_BONUS_BUDGET} 不小于最小带间隙 {min_gap}。\
             要么调低 EXTRA_DIR_BONUS / SHORT_NAME_BONUS_MAX / RECENCY_BONUS_MAX / PATH_DEPTH_BONUS_MAX 之一，\
             要么把带常量拉开。"
        );
    }

    /// 短名加分的函数形（续121 从线性改反比例）。检查**单调递减**，
    /// 以及旧线性形拉不开的差距现在确实拉开了。
    #[test]
    fn short_name_bonus_shape() {
        assert_eq!(short_name_bonus(0), SHORT_NAME_BONUS_MAX, "len=0 时取最大值");
        let lens = [0usize, 4, 7, 20, 60, 100, 300];
        for w in lens.windows(2) {
            assert!(
                short_name_bonus(w[0]) >= short_name_bonus(w[1]),
                "不是单调递减: len={} → {} vs len={} → {}",
                w[0], short_name_bonus(w[0]), w[1], short_name_bonus(w[1])
            );
        }
        // 续120 实测中出问题的那组对比：`Windows`(7 字符) 与 WinSxS 的长名(60 字符)。
        // 旧形（MAX=60 的线性）下最多只差 53 分，压不下去。
        let d = short_name_bonus(7) - short_name_bonus(60);
        assert!(d > 100, "短名加分太弱（7 字符 vs 60 字符 只差 {d}）");
        assert!(short_name_bonus(1000) >= 0, "超长名字也不能变成负数");
    }

    /// 路径浅度加分（续122）。复现它当初打破僵局的那个真实场景。
    #[test]
    fn path_depth_breaks_exact_match_ties() {
        assert_eq!(path_depth("C:\\Windows"), 1);
        assert_eq!(path_depth("C:/a/b/c"), 3, "正斜杠分隔也要算");
        // 单调递减且非负
        let d: Vec<i32> = [1u8, 3, 6, 10, 20, 200].iter().map(|x| path_depth_bonus(*x)).collect();
        for w in d.windows(2) {
            assert!(w[0] >= w[1], "不是单调递减: {d:?}");
        }
        assert!(*d.last().unwrap() >= 0);

        // 续122 里真实发生过的僵局：把系统根加进索引之后，"windows" 的结果中
        // `C:\Windows` 输给了 home 下 Go 模块缓存里的 5 个同名目录、沉到第 6。
        // 两边都是完全一致、名字长度也相同，唯一的决胜依据只剩索引顺序。
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let mut shallow = ent("windows", now - 900 * DAY, false);
        shallow.path = "C:\\Windows".into();
        shallow.depth = path_depth(&shallow.path);
        let mut deep = ent("windows", now - 900 * DAY, false);
        deep.path = "C:\\Users\\me\\go\\pkg\\mod\\golang.org\\x\\sys@v0.30.0\\windows".into();
        deep.depth = path_depth(&deep.path);

        let a = entry_score(&["windows"], &shallow, now).unwrap();
        let b = entry_score(&["windows"], &deep, now).unwrap();
        assert!(a > b, "浅路径没能胜出（C:\\Windows {a} vs go 模块 {b}）");
    }

    /// 索引范围的构成（续123）。这里一坏就直接表现为「本该有的东西搜不到」，
    /// 所以把顺序与深度这两个前提钉死。
    #[test]
    fn scan_dirs_covers_drives_with_home_first() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 在驱动器遍历开启的状态下检查（显式置位，避免受其他测试关闭它的影响）
        std::env::set_var("WORKBENCH_SCAN_DRIVES", "1");
        let dirs = scan_dirs();
        assert!(!dirs.is_empty(), "一个根都没有");

        // ① home 必须在**最前**。build_index 会剪掉「先遍历过的根的子树」，
        //    home 若排到后面就会被驱动器根的浅遍历吃掉，只能索引到浅层。
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if !home.is_empty() && PathBuf::from(&home).exists() {
            assert_eq!(dirs[0].0, PathBuf::from(&home), "home 不在最前: {:?}", dirs[0].0);
            assert_eq!(dirs[0].2, MAX_WALK_DEPTH, "home 必须走深度遍历");
        }

        // ② 驱动器根已加入，且分配到的是浅深度
        let drives: Vec<_> = dirs.iter().filter(|(_, _, d)| *d == DRIVE_ROOT_DEPTH).collect();
        assert!(!drives.is_empty(), "一个驱动器根都没加进来: {dirs:?}");
        assert!(
            DRIVE_ROOT_DEPTH < MAX_WALK_DEPTH,
            "驱动器根不比 home 浅就失去意义了"
        );

        // ③ 关闭开关确实生效（测试隔离的生命线）
        std::env::set_var("WORKBENCH_SCAN_DRIVES", "0");
        assert!(drive_roots().is_empty(), "WORKBENCH_SCAN_DRIVES=0 没能停掉驱动器遍历");
        std::env::remove_var("WORKBENCH_SCAN_DRIVES");
    }

    /// 噪声路径判定（续121）。从 Everything 的全盘结果里滤掉 WinSxS 之类。
    #[test]
    fn noise_path_detection() {
        assert!(is_noise_path("C:\\Windows\\WinSxS\\amd64_microsoft-windows-cng_31bf.txt"));
        assert!(is_noise_path("C:/Windows/winsxs/x"), "正斜杠分隔也要认");
        assert!(is_noise_path("D:\\proj\\node_modules\\react\\index.js"));
        assert!(is_noise_path("C:\\Users\\me\\AppData\\Local\\x.log"));
        // 正常路径不能被滤掉——这里误伤就会变成「本该有的文件搜不到」
        assert!(!is_noise_path("C:\\Windows\\System32\\cmd.exe"));
        assert!(!is_noise_path("D:\\dev\\workbench-app\\src\\App.tsx"));
        // 不能因子串误伤（只是名字里含 "target" 是另一回事）
        assert!(!is_noise_path("D:\\dev\\my-target-app\\main.rs"));
        assert!(is_noise_path("D:\\dev\\rustproj\\target\\debug\\x.exe"), "作为完整路径段则应滤掉");
    }

    /// **用于串行化那些会碰进程级状态（环境变量 / FILE_INDEX / EXTRA_DIRS）的测试。**
    ///
    /// Rust 测试默认并行。USERPROFILE 和 WORKBENCH_SCAN_DRIVES 都是进程全局的，
    /// 一边正「关掉驱动器遍历以保持隔离」时另一边把它打开，隔离那侧就会去走真实的 C:/D:，
    /// 既变慢又让条数断言变成环境依赖而失败。**以后再加这类测试必须取这把锁。**
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // 测试用的 IndexEntry 构造（不碰全局状态，可以放心并行增加）。
    // depth 从路径算出——写死常量的话就没法测 path_depth_bonus 的效果了。
    fn ent(name: &str, mtime: u64, extra: bool) -> IndexEntry {
        // 扩展名按真实规则从名字派生（续126 起 ext 是 name_lower 的切片，
        // 硬塞空串会让 ent 造出与 build_index 不一致的条目）
        let ext = std::path::Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        IndexEntry::new(format!("C:\\x\\{name}"), name, &ext, false, extra, mtime)
    }

    /// `name()`/`ext()` 的切片派生必须与「独立存字符串」时代完全等价（续126）。
    /// 这是内存瘦身的正确性基石：偏移量算错不会 panic，只会静默地让搜索结果显示错误的名字
    /// 或把图标归错类——比崩溃更难发现，所以要钉死。
    #[test]
    fn index_entry_derives_name_and_ext() {
        let e = IndexEntry::new("C:\\dev\\App\\Report.MD".into(), "Report.MD", "md", false, false, 0);
        assert_eq!(e.name(), "Report.MD", "name 必须保持原始大小写");
        assert_eq!(e.name_lower.as_ref(), "report.md");
        assert_eq!(e.ext(), "md");

        // 无扩展名 → ext 为空串（而非 panic 或越界）
        let d = IndexEntry::new("C:\\dev\\workbench-app".into(), "workbench-app", "", true, false, 0);
        assert_eq!(d.name(), "workbench-app");
        assert_eq!(d.ext(), "", "无扩展名应切出空串");

        // 中文名（多字节）：偏移量按字节算，切片必须落在字符边界上
        let c = IndexEntry::new("D:\\项目\\报告.txt".into(), "报告.txt", "txt", false, false, 0);
        assert_eq!(c.name(), "报告.txt");
        assert_eq!(c.ext(), "txt");

        // 退化路径：name 不是 path 的后缀（walkdir 根条目等）→ name_off=0，取整条 path，不 panic
        let r = IndexEntry::new("C:\\".into(), "不是后缀", "", true, false, 0);
        assert_eq!(r.name(), "C:\\", "后缀关系不成立时退化为整条 path");

        // 退化路径：to_lowercase 改变字节长度时 ext 关系可能不成立 → 退化为空串，不 panic
        let t = IndexEntry::new("C:\\x\\İ.TXT".into(), "İ.TXT", "TXT", false, false, 0);
        assert!(t.ext() == "txt" || t.ext().is_empty(), "要么正确派生、要么干净退化，不得越界");
    }

    /// 图标缓存增量复用（续128）：上一轮已有的 key 必须原样搬过来，
    /// 且**本轮索引里没有的 key 不得留下**（否则缓存会随程序常驻无限增长）。
    ///
    /// 这里不能靠「跑得快不快」来验证——那是环境依赖。改为用一个**不可能被 Shell 提取出来的
    /// 哨兵值**：若结果里还是这个哨兵，就证明它是搬过来的而非重新提取的。
    #[test]
    fn icon_cache_reuses_previous_round() {
        let idx = vec![
            IndexEntry::new("C:\\x\\a.txt".into(), "a.txt", "txt", false, false, 0),
            IndexEntry::new("C:\\x\\b.txt".into(), "b.txt", "txt", false, false, 0),
        ];
        let sentinel = Some("data:image/png;base64,SENTINEL".to_string());
        let mut prev = HashMap::new();
        prev.insert("txt".to_string(), sentinel.clone());
        // 上一轮残留的、本轮索引里已不存在的 key
        prev.insert("zzz-gone".to_string(), Some("stale".to_string()));

        let out = build_icon_cache(&idx, &prev);
        assert_eq!(out.get("txt"), Some(&sentinel), "命中的 key 必须复用、不重新提取");
        assert!(!out.contains_key("zzz-gone"), "本轮索引里没有的 key 不得留下（防无限增长）");
        assert_eq!(out.len(), 1, "两个 .txt 去重后只应有一个 key");

        // 空基线 = 全量提取路径（首轮 / 周期性全刷）。这里只验证它不 panic 且 key 齐全，
        // 图标值取决于运行环境（CI 上可能提不到），故不断言具体内容。
        let full = build_icon_cache(&idx, &HashMap::new());
        assert!(full.contains_key("txt"), "全量路径也必须产出该 key");
    }

    /// 诊断用（默认 #[ignore]：
    ///   cargo test --lib measure_icon_payload -- --ignored --nocapture）
    ///
    /// 量化「图标随结果内联」的 IPC 载荷代价（续126 ③ 的依据）。
    /// 建真实索引 + 真实图标预热缓存，跑一次满额查询，对比两种编码：
    ///   ① 现状：每条结果内联自己的 base64 图标（同扩展名的重复 N 遍）
    ///   ② 改后：结果只带 iconKey，图标去重后单独一张表
    #[test]
    #[ignore]
    fn measure_icon_payload() {
        let dirs = scan_dirs();
        let idx = build_index(&dirs);
        println!("索引 {} 条，开始预热图标缓存（慢）…", idx.len());
        let t = Instant::now();
        let cache = build_icon_cache(&idx, &HashMap::new());
        let cold = t.elapsed();
        println!("图标缓存（冷，全量）: {} key / {:.2?}", cache.len(), cold);
        // 续128：第二轮传上一轮缓存当基线，应当几乎全部命中复用
        let t2 = Instant::now();
        let again = build_icon_cache(&idx, &cache);
        let warm = t2.elapsed();
        let fresh = again.keys().filter(|k| !cache.contains_key(*k)).count();
        println!(
            "图标缓存（热，增量）: {} key / {:.2?} / 需新提 {} 个 → 省下 {:.0}%",
            again.len(), warm, fresh,
            (1.0 - warm.as_secs_f64() / cold.as_secs_f64().max(1e-9)) * 100.0
        );
        // 缓存本身的常驻内存（base64 字符串 + key）
        let bytes: usize = cache.iter().map(|(k, v)| k.len() + v.as_ref().map_or(0, |s| s.len())).sum();
        println!("图标缓存常驻内存: 约 {:.1} MB", bytes as f64 / 1_048_576.0);

        FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
        *FILE_INDEX.get().unwrap().lock().unwrap() = idx;
        ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        *ICON_CACHE.get().unwrap().lock().unwrap() = cache;

        for q in ["e", "windows", "config"] {
            let resp = attach_icons(builtin_search(q, QUERY_LIMIT_CAP));
            if resp.results.is_empty() {
                continue;
            }
            // ② 改后的**真实**载荷（就是前端实际收到的那份 JSON）
            let keyed = serde_json::to_string(&resp).unwrap_or_default().len();

            // ① 改前的等价载荷：把去重表摊回每条结果里内联
            let inline: usize = serde_json::to_string(&resp.results).unwrap_or_default().len()
                + resp
                    .results
                    .iter()
                    .map(|r| resp.icons.get(&r.icon_key).map_or(0, |ic| ic.len() + 10))
                    .sum::<usize>();

            println!(
                "\n[{q}] {} 条 / 去重后图标 {} 张",
                resp.results.len(), resp.icons.len()
            );
            println!("  ① 内联（改前）:   {:>8.1} KB", inline as f64 / 1024.0);
            println!("  ② key+表（现行）: {:>8.1} KB   → 削减 {:.0}%",
                keyed as f64 / 1024.0,
                (1.0 - keyed as f64 / inline as f64) * 100.0);
        }
        println!();
    }

    /// 用**真实字符串**验证分层前提本身（续117）。
    /// layer_invariant_budget_holds 只是数值检算，若有人改了 token_score / subseq_score 的内部
    /// 导致层边界移位，那个测试会毫无察觉地通过。这个测试补上那个洞。
    #[test]
    fn token_score_layer_bounds_hold() {
        // 各层用**真实字符串**验证是否落在预期的带里。只看常量的检算（上一个测试）
        // 在 token_score 内部改动导致层归属变化时会漏检。
        assert_eq!(token_score("report", "report"), Some(L_EXACT), "名字原样相等");
        assert_eq!(token_score("report", "report.md"), Some(L_EXACT), "去掉扩展名的词干相等");
        assert_eq!(token_score("report", "report_draft.md"), Some(L_PREFIX), "前缀匹配");
        // 单词边界（紧跟 _ 之后）。会比 L_WORD 低一个位置罚分
        let word = token_score("report", "my_report.md").expect("应当命中");
        assert!(word <= L_WORD && word > L_WORD - POS_PENALTY_MAX, "落在词首带之外: {word}");
        // 非边界位置（紧跟字母之后）
        let sub = token_score("report", "xreport.md").expect("应当命中");
        assert!(sub <= L_SUBSTR && sub > L_SUBSTR - POS_PENALTY_MAX, "落在子串带之外: {sub}");

        // 位置罚分的饱和：查询词出现在 500 字符之后也不会跌破下端
        let far = format!("{}rpt.md", "x".repeat(600));
        let lo = token_score("rpt", &far).expect("子串命中，必然有值");
        assert_eq!(lo, L_SUBSTR - POS_PENALTY_MAX, "位置罚分没有饱和: {lo}");

        // 子序列的**最好**情形：所有字符都命中词首、一路加到封顶。
        // 用 "aaa...a" 去匹配 "a_a_a_..."——下划线使它构不成子串，只能落到子序列。
        let q = "a".repeat(60);
        let name = "a_".repeat(60);
        let hi = token_score(&q, &name).expect("应当作为子序列命中");
        assert_eq!(hi, SUBSEQ_CAP, "这个输入应当触到封顶（没触到说明测试太松）: {hi}");

        // 续120 暴露的真实案例：`Windows` 被 `amd64_microsoft-windows-cng_…` 淹没。
        // 有了完全一致带之后，即使把条目加分全用上也不该被反超。
        let win = token_score("windows", "windows").unwrap();
        let sxs = token_score("windows", "amd64_microsoft-windows-cng_31bf3856ad364e35_10.0.22621.4746").unwrap();
        assert!(
            win > sxs + ENTRY_BONUS_BUDGET,
            "完全一致 {win} 没有超过 长名词首一致 {sxs} + 加分上限 {ENTRY_BONUS_BUDGET}"
        );
    }

    /// 续117 的核心：新鲜度**只允许改变同层内的顺序**。
    /// 若「昨天改过的*模糊匹配*」压过「一年前的*名字里直接含有*」，
    /// 在用户看来搜索就是坏的。这里用真实的打分函数验证预算检算
    /// （layer_invariant_budget_holds）在数值上保证的那个性质。
    ///
    /// ⚠️ **必须贴着边界构造**。用朴素例子（短查询）时子串约 2200 对子序列约 500，
    /// 差距太大，即使把预算撑破也照样通过
    /// （实际做逆向验证把 RECENCY_BONUS_MAX 调到 200 时，只有这个测试通过了，暴露了它太松）。
    /// 因此**两侧都取最坏／最好情形**：
    ///   子串侧 = 位置罚分饱和 + 长名致短名加分为 0 + 旧 + 普通目录
    ///   子序列侧 = 封顶 + 额外目录 + 今日更新
    /// 余量很小，预算稍微超一点就会立刻失败。
    #[test]
    fn recency_never_crosses_match_layers() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let q = "a".repeat(60);
        let tokens = [q.as_str()];

        // 子序列侧：能触到封顶的长名（短名加分≈0）+ 额外目录 + 今日更新
        let fuzzy_fresh = ent(&"a_".repeat(60), now, true);

        // 子串侧：查询词出现在第 600 字符（位置罚分饱和）+ 10 年前 + 普通目录
        let exact_old = ent(&format!("{}{}.md", "x".repeat(600), q), now - 3650 * DAY, false);

        let f = entry_score(&tokens, &fuzzy_fresh, now).expect("子序列应当命中");
        let x = entry_score(&tokens, &exact_old, now).expect("子串应当命中");
        // 期望值由常量组装（写死数字的话，每次调整带常量都得回来改一遍）
        assert_eq!(
            f,
            SUBSEQ_CAP
                + short_name_bonus(fuzzy_fresh.name().len())
                + EXTRA_DIR_BONUS
                + RECENCY_BONUS_MAX
                + path_depth_bonus(fuzzy_fresh.depth),
            "子序列侧没有构成预期的最好情形"
        );
        assert_eq!(
            x,
            L_SUBSTR - POS_PENALTY_MAX
                + short_name_bonus(exact_old.name().len())
                + path_depth_bonus(exact_old.depth),
            "子串侧没有构成预期的最坏情形"
        );
        assert!(
            x > f,
            "分层不变量被破坏：旧的子串匹配({x}) 输给了新的子序列匹配({f})。\
             检查条目级加分的合计是不是吃掉了带间隙。"
        );
    }

    /// 该起效的地方要起效：**同名同层**时新的排在前面（这正是续117 的目的）。
    /// 没有这条就分辨不出「保守到实际什么也没发生」的改动。
    #[test]
    fn recency_breaks_ties_among_same_name() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let fresh = ent("report.md", now - 2 * DAY, false); // 今週
        let stale = ent("report.md", now - 800 * DAY, false); // 2 年以上前
        let a = entry_score(&["report"], &fresh, now).unwrap();
        let b = entry_score(&["report"], &stale, now).unwrap();
        assert!(a > b, "同名同层下新的应当在前（{a} vs {b}）");
        assert_eq!(a - b, RECENCY_BONUS_MAX, "差值应恰为新鲜度加分（其余因素完全相同）");
    }

    /// mtime 取不到（0）时排名也不能坏。网络盘等场景真实存在。
    /// 「取不到时间 = 按最旧处理」，其余加分照常生效。
    #[test]
    fn missing_mtime_degrades_gracefully() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY;
        let unknown = ent("report.md", 0, false);
        let ancient = ent("report.md", now - 3650 * DAY, false);
        assert_eq!(
            entry_score(&["report"], &unknown, now).unwrap(),
            entry_score(&["report"], &ancient, now).unwrap(),
            "mtime 未知应与最旧同分（即不加分）"
        );
        // 额外目录加分与 mtime 相互独立、照常生效（不破坏续111b 的修复）
        let unknown_extra = ent("report.md", 0, true);
        assert!(
            entry_score(&["report"], &unknown_extra, now).unwrap()
                > entry_score(&["report"], &unknown, now).unwrap(),
            "mtime 未知时 EXTRA_DIR_BONUS 仍应生效"
        );
    }

    fn res(name: &str, mtime: u64) -> FileSearchResult {
        FileSearchResult {
            path: format!("C:\\x\\{name}"),
            name: name.to_string(),
            ext: String::new(),
            is_dir: false,
            icon_key: String::new(),
            mtime,
        }
    }

    /// Everything 结果的重排（续117）。切换引擎后排序的**语义**不应改变。
    #[test]
    fn rerank_everything_matches_builtin_semantics() {
        const DAY: u64 = 86_400;
        let now = now_unix();
        // 模拟 Everything 的默认顺序（如名字序），故意把「好候选放在后面」再传进去
        let input = vec![
            res("zzz_unrelated_but_contains_report_deep_in_name.md", now - 900 * DAY),
            res("r_e_p_o_r_t.md", now),            // 只能子序列命中（再新也该垫底）
            res("report.md", now - 900 * DAY),     // **完全一致**、旧（续121 起升到最上）
            res("report_final.md", now - 900 * DAY), // 前缀、旧
            res("report_draft.md", now - DAY),     // 前缀、本周（同为前缀时新的在前）
        ];
        let out = rerank_everything(input, "report");
        let names: Vec<&str> = out.iter().map(|r| r.name.as_str()).collect();
        // ① 子序列匹配必须垫底（分层不变量，走 Everything 也不能破）
        assert_eq!(
            names.last(),
            Some(&"r_e_p_o_r_t.md"),
            "子序列匹配没有排在最后: {names:?}"
        );
        // ② 两个前缀匹配都应排在「只在名字中间命中」的 zzz_... 之前
        let i_zzz = names.iter().position(|n| n.starts_with("zzz")).unwrap();
        let i_rep = names.iter().position(|n| *n == "report.md").unwrap();
        let i_draft = names.iter().position(|n| *n == "report_draft.md").unwrap();
        let i_final = names.iter().position(|n| *n == "report_final.md").unwrap();
        assert!(i_draft < i_zzz && i_final < i_zzz, "前缀匹配排在了位置罚分组之后: {names:?}");
        // ③ **完全一致必须最上**（续121）。哪怕它旧，也不能被更新的前缀匹配挤下去。
        //    续117~120 期间两者同层，而短名加分的差距(很小)不敌新鲜度(120)，
        //    于是 `report_draft.md`(本周) 反超了 `report.md`(900天前)。
        //    「要找的东西本身排第二」显然是错的，续121 新设 L_EXACT 带解决了它。
        assert_eq!(i_rep, 0, "完全一致没有排在第一: {names:?}");
        // ④ **同层内由新鲜度决定**（续117 的目的仍然保持）。
        //    这两个前缀匹配名字长度接近，差别只在修改时间。
        assert!(
            i_draft < i_final,
            "同层（前缀）内新鲜度没有起作用: {names:?}"
        );
    }

    /// 续120 的核心：**不是「先截断再评估」，而是「广取、评估、再截断」**。
    ///
    /// 修复前把 limit(200) 直接当 set_max 传给 Everything，
    /// 于是按 Everything 默认序排在 201 名之后的最优解**根本无从出现**。
    /// 这里构造「最优解位于候选池末尾」的情形，验证即使只返回少量条数也能捞到它。
    /// search_files 整体依赖 SEARCH_ENGINE 与 Everything 本体，
    /// 故这里直接验证其核心——rerank→truncate 的先后顺序。
    #[test]
    fn ranking_happens_before_truncation() {
        // 模拟 Everything 的默认顺序：前 299 条是只在名字中间命中的长名字，
        // 只有最后 1 条是完整的前缀匹配（＝真正想要的那个）。
        let mut pool: Vec<FileSearchResult> = (0..299)
            .map(|i| res(&format!("zzz_archive_{i:04}_report_backup_old.md"), 0))
            .collect();
        pool.push(res("report.md", 0)); // 把最优解放在候选池的**最末尾**
        assert_eq!(pool.len(), 300);

        let mut ranked = rerank_everything(pool, "report");
        ranked.truncate(10); // 只返回 10 条

        assert_eq!(
            ranked[0].name, "report.md",
            "位于候选池末尾的最优解没被捞到——说明在评估之前就截断了: {:?}",
            ranked.iter().map(|r| r.name.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(ranked.len(), 10, "返回条数应与 truncate 一致");
    }

    /// Everything 语法（`ext:` 等）下文件名不含查询词的结果**不能被丢弃**。
    /// 丢了就会变成「Everything 里搜得到，本应用里却消失」这种最糟的行为。
    #[test]
    fn rerank_everything_keeps_non_name_matches() {
        let input = vec![res("alpha.txt", 0), res("beta.txt", 0)];
        let out = rerank_everything(input, "ext:txt");
        assert_eq!(out.len(), 2, "名字未命中的结果被丢弃了");
    }

    /// 空查询时不重排（原样尊重 Everything 侧的顺序）。
    #[test]
    fn rerank_everything_noop_on_empty_query() {
        let input = vec![res("b.txt", 0), res("a.txt", 0)];
        let out = rerank_everything(input, "   ");
        assert_eq!(out[0].name, "b.txt", "空查询时不得改动顺序");
    }

    /// 新鲜度阶梯本身（续117）。检查档位边界，以及未来时间不给垫脚。
    #[test]
    fn recency_bonus_steps() {
        const DAY: u64 = 86_400;
        let now = 20_000 * DAY; // 足够大的基准时刻（减去 10 年也不会变负）
        assert_eq!(recency_bonus(0, now), 0, "mtime 取不到则不加分");
        assert_eq!(recency_bonus(now, now), RECENCY_BONUS_MAX, "此刻 = 最高档");
        assert_eq!(recency_bonus(now - 7 * DAY, now), RECENCY_BONUS_MAX, "恰好 7 天仍属最高档");
        assert_eq!(recency_bonus(now - 7 * DAY - 1, now), 70, "超过 7 天落到下一档");
        assert_eq!(recency_bonus(now - 30 * DAY, now), 70);
        assert_eq!(recency_bonus(now - 30 * DAY - 1, now), 25);
        assert_eq!(recency_bonus(now - 365 * DAY, now), 25);
        assert_eq!(recency_bonus(now - 365 * DAY - 1, now), 0, "超过 1 年不加分");
        // 时钟偏差 / 网络盘导致时间戳在未来，这是真实会发生的。
        // saturating_sub 让 age 饱和到 0 → 最高档。既不 panic 也不会出现负加分。
        assert_eq!(recency_bonus(now + 9999 * DAY, now), RECENCY_BONUS_MAX, "未来时间饱和到最高档");
    }

    /// 嵌套根不得产生重复条目（续131c）。
    ///
    /// 复刻用户真机上的形态：额外扫描目录 `D:\dev\mcdownloader` 落在盘符根 `D:\`（深度 3）之下，
    /// 而 `D:\dev\mcdownloader\src` 正好是深度 3 —— 盘符根收一次、额外目录再收一次。
    /// 症状不止是列表多一行：前端 `enhKey` 拿 path 当 React key，重复 key 会让整个结果列表
    /// reconciliation 错乱（旧行残留在顶部、段表头错位）。
    ///
    /// 直接测 `build_index`（纯函数、只吃入参），**不碰 FILE_INDEX/USERPROFILE 等全局量**，
    /// 故可与其他测试并行，不受 `set_search_dirs_indexes_extra_dir` 的「只此一个」约束。
    #[test]
    fn nested_roots_do_not_duplicate_entries() {
        let base = std::env::temp_dir().join("wb_idx_nested_test");
        let extra = base.join("dev").join("mcdownloader");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(extra.join("src").join("deep")).unwrap();
        fs::write(extra.join("src").join("shallow.txt"), b"x").unwrap();
        fs::write(extra.join("src").join("deep").join("deep.txt"), b"x").unwrap();

        // 盘符根那样的浅遍历在前，额外目录（深）在后 —— scan_dirs 的真实顺序
        let dirs = vec![(base.clone(), false, 3), (extra.clone(), true, MAX_WALK_DEPTH)];
        let idx = build_index(&dirs);

        let paths: Vec<String> = idx.iter().map(|e| e.path.to_string()).collect();
        let mut uniq = paths.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(paths.len(), uniq.len(), "索引出现重复路径：{paths:?}");

        // 深度 3 的浅遍历够不到 deep.txt，额外目录的深遍历必须补上
        assert!(
            idx.iter().any(|e| e.name() == "deep.txt"),
            "额外目录的深层文件缺失：{paths:?}"
        );
        // extra 标记按路径前缀判定 → 无论被哪个根先收走都不能丢
        // （丢了就是续111b 那个「加了额外目录却搜不到」的回归）
        for e in idx.iter().filter(|e| e.path.contains("mcdownloader")) {
            assert!(e.extra, "额外目录下的条目丢了 extra 标记：{}", e.path);
        }
        assert!(
            idx.iter().any(|e| e.name() == "src" && e.extra),
            "被浅遍历先收走的 src 也必须带 extra 标记：{paths:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// 额外目录端到端契约（跑真实的 set_search_dirs 命令，含其后台重建与图标预热）：
    /// 调用后，EXTRA_DIRS 里的文件必须在有限时间内出现在 FILE_INDEX，且能被 builtin_search 查到。
    /// 用临时目录顶掉 USERPROFILE，避免测试真去遍历 18 万条的真实用户目录（快 + 可复现）。
    /// ⚠️ 用了全局 OnceLock（FILE_INDEX/EXTRA_DIRS）与 USERPROFILE 环境变量，故只此一个测试、勿并行加测。
    #[test]
    fn set_search_dirs_indexes_extra_dir() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        // 关掉驱动器遍历以保持隔离（续123）。不关的话会去走真实的 C:/D:，
        // 测试既慢又变成环境依赖。
        std::env::set_var("WORKBENCH_SCAN_DRIVES", "0");

        // ① 纯遍历层：scan_dirs + build_index
        EXTRA_DIRS.get_or_init(|| Mutex::new(Vec::new()));
        *EXTRA_DIRS.get().unwrap().lock().unwrap() = vec![extra.clone()];
        let idx = build_index(&scan_dirs());
        let names: Vec<&str> = idx.iter().map(|e| e.name()).collect();
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

    /// Everything 查询路径的端到端诊断（续117b）。**需要 Everything 本体处于运行状态**，
    /// 故默认 #[ignore]：
    ///   cargo test --lib everything_query_e2e -- --ignored --nocapture
    ///
    /// 续117 当时本机的 Everything 服务没启动，只能验到 FFI 符号存在。这里要验三点：
    ///   ① DATE_MODIFIED 是否真的返回了（mtime 全是 0 的话新鲜度加分就是死的）
    ///   ② rerank 是否保住分层不变量（子串匹配在子序列匹配之上）
    ///   ③ `ext:` 等 Everything 语法下**是否会 panic**——续117 修的 -i32::MIN 溢出
    ///      正是这条路径，一旦回归这里立刻失败。
    #[test]
    #[ignore]
    fn everything_query_e2e() {
        if !crate::everything::is_available() {
            println!("Everything 不可用（未启动 / 无 DLL）。跳过本诊断。");
            return;
        }
        let prev = SEARCH_ENGINE.load(Ordering::Relaxed);
        SEARCH_ENGINE.store(ENGINE_EVERYTHING, Ordering::Relaxed);

        // ── ① 普通查询：mtime 是否返回 & 排序 ──
        let q = "readme";
        let raw = crate::everything::query(q, 30).expect("Everything 查询失败");
        let with_mtime = raw.iter().filter(|r| r.mtime > 0).count();
        println!("\n[{q}] Everything 原始结果 {} 条 / 其中带 mtime 的 {}", raw.len(), with_mtime);
        assert!(
            raw.is_empty() || with_mtime > 0,
            "有结果却全部 mtime=0——DATE_MODIFIED 请求没生效（新鲜度加分整体失效）"
        );

        let now = now_unix();
        println!("  ── rerank 后的前 10（[层] 名字 / 修改） ──");
        let ranked = rerank_everything(raw, q);
        for r in ranked.iter().take(10) {
            let layer = if r.name.to_lowercase().contains(q) { "子串  " } else { "子序列" };
            let age = if r.mtime > 0 {
                format!("{}天前", now.saturating_sub(r.mtime) / 86_400)
            } else {
                "未知".to_string()
            };
            println!("    [{layer}] {:<44} {age}", r.name);
        }
        // ② 分层不变量：子串匹配必在子序列匹配之上
        let first_subseq = ranked.iter().position(|r| !r.name.to_lowercase().contains(q));
        let last_substr = ranked.iter().rposition(|r| r.name.to_lowercase().contains(q));
        if let (Some(fs), Some(ls)) = (first_subseq, last_substr) {
            assert!(ls < fs, "分层不变量被破坏：子序列匹配({fs}) 排在了子串匹配({ls}) 之上");
            println!("  ✓ 分层不变量 OK（子串到第 {ls} 位 / 子序列从第 {fs} 位开始）");
        }

        // ── ③ Everything 语法：续117 修的溢出 panic 就在这条路径 ──
        // 名字里不含查询词，于是 score_of 返回哨兵 i32::MIN。
        // 修复前这里会因 `-i32::MIN` 触发 attempt to negate with overflow 而崩溃。
        for syntax in ["ext:txt", "*.md", "size:>1mb"] {
            let r = search_files(syntax.to_string(), 20);
            println!("  [{syntax}] {} 条（未 panic，跑完）", r.results.len());
        }
        println!("  ✓ Everything 语法下无 panic（续117 的 -i32::MIN 溢出未回归）\n");

        SEARCH_ENGINE.store(prev, Ordering::Relaxed);
    }

    /// 诊断用（默认 #[ignore]：cargo test --lib diagnose_coverage -- --ignored --nocapture）
    ///
    /// 排查「自己的项目目录搜不出来」的成因（续123 调查）。
    /// 看两点：**它到底在不在索引里**（范围问题），还是在索引里却排不上来（排序问题）。
    /// 混淆这两者就会改错地方。
    #[test]
    #[ignore]
    fn diagnose_coverage() {
        let dirs = scan_dirs();
        println!("\n① 当前索引范围:");
        for (d, extra, depth) in &dirs {
            println!("   {:<40} extra={extra} 深度={depth}", d.display());
        }

        // 固定驱动器一览（只取存在的根）
        println!("\n② 本机驱动器及其是否已被索引覆盖:");
        for letter in 'A'..='Z' {
            let root = PathBuf::from(format!("{letter}:\\"));
            if !root.exists() {
                continue;
            }
            let covered = dirs.iter().any(|(d, _, _)| d.starts_with(&root));
            println!("   {}:\\  {}", letter, if covered { "部分覆盖" } else { "★未覆盖" });
        }

        let idx = build_index(&dirs);
        println!("\n③ 索引 {} 条。特定路径是否在其中:", idx.len());
        for probe in [
            "D:\\dev\\workbench-app",
            "D:\\dev",
            "C:\\Windows",
        ] {
            let hit = idx.iter().any(|e| e.path.eq_ignore_ascii_case(probe));
            println!("   {:<32} {}", probe, if hit { "在索引里" } else { "★不在索引里" });
        }

        FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
        *FILE_INDEX.get().unwrap().lock().unwrap() = idx;
        for q in ["workbench", "workbench-app", "dev"] {
            let r = builtin_search(q, 5);
            println!("\n   [{q}] → {} 条", r.len());
            for x in &r {
                println!("       {}", x.path);
            }
        }
        println!();
    }

    /// 诊断用（默认 #[ignore]：cargo test --lib measure_drive_cost -- --ignored --nocapture）
    ///
    /// 把全部固定驱动器纳入索引的代价估算（续123）。
    /// 内存是瓶颈，所以先按深度测条数再定范围。
    #[test]
    #[ignore]
    fn measure_drive_cost() {
        println!("\n按深度索引驱动器根时的条数（已应用剪枝规则）");
        println!("{:<8} | {:>9} | {:>9} | {:>9} | {:>9}", "根", "深度3", "深度4", "深度5", "深度6");
        println!("{}", "-".repeat(56));
        for letter in 'A'..='Z' {
            let root = PathBuf::from(format!("{letter}:\\"));
            if !root.exists() {
                continue;
            }
            let mut cells = Vec::new();
            for d in [3usize, 4, 5, 6] {
                let t = Instant::now();
                let n = WalkDir::new(&root)
                    .max_depth(d)
                    .into_iter()
                    .filter_entry(|e| {
                        !(e.file_type().is_dir()
                            && e.file_name().to_str().map(should_skip_dir).unwrap_or(false))
                    })
                    .filter_map(|e| e.ok())
                    .filter(|e| !e.file_name().to_str().unwrap_or(".").starts_with('.'))
                    .count();
                cells.push((n, t.elapsed()));
            }
            println!(
                "{letter}:\\      | {:>9} | {:>9} | {:>9} | {:>9}",
                cells[0].0, cells[1].0, cells[2].0, cells[3].0
            );
            println!(
                "  (走査)  | {:>9.1?} | {:>9.1?} | {:>9.1?} | {:>9.1?}",
                cells[0].1, cells[1].1, cells[2].1, cells[3].1
            );
        }
        println!();
    }

    /// 诊断用（默认 #[ignore]：
    ///   cargo test --lib probe_builtin_system_roots -- --ignored --nocapture）
    ///
    /// 验证续122/123 的成效：内置引擎查 "windows" 时 `C:\Windows` 能否排到前面。
    /// 真实走一遍 scan_dirs → build_index → 替换 FILE_INDEX → builtin_search。
    ///
    /// ⚠️ 会碰 FILE_INDEX 与环境变量这类进程级状态，
    /// **不能和 `set_search_dirs_indexes_extra_dir` 在同一进程里跑**
    /// （那个测试会改写 USERPROFILE 和驱动器遍历开关）。
    /// 默认 #[ignore]，所以普通 `cargo test` 不会冲突。
    #[test]
    #[ignore]
    fn probe_builtin_system_roots() {
        let dirs = scan_dirs();
        println!("\n参与索引的根（续123 起为全部驱动器根）:");
        for (d, extra, depth) in &dirs {
            println!("  {:<44} extra={extra} 深度={depth}", d.display());
        }
        let t = Instant::now();
        let idx = build_index(&dirs);
        let build_ms = t.elapsed();
        let bytes: usize = std::mem::size_of::<IndexEntry>() * idx.len()
            + idx.iter().map(|e| e.path.len() + e.name_lower.len()).sum::<usize>();
        println!(
            "\n索引: {} 条 / 构建 {:.2?} / 估算 {:.1} MB",
            idx.len(), build_ms, bytes as f64 / 1_048_576.0
        );

        FILE_INDEX.get_or_init(|| Mutex::new(Vec::new()));
        *FILE_INDEX.get().unwrap().lock().unwrap() = idx;

        for q in ["windows", "program files", "system32"] {
            let r = builtin_search(q, 8);
            println!("\n  [{q}] → 前 {} 名:", r.len());
            for x in &r {
                println!("      {}", x.path);
            }
        }
        println!();
    }

    /// 诊断用（默认 #[ignore]：cargo test --lib measure_index_scope -- --ignored --nocapture）
    ///
    /// 估算能否扩大内置引擎的**覆盖范围**（续122 调查）。
    /// 用户反馈：「搜 "windows" 却出不来 C:\Windows」——这不是排序问题，
    /// 而是索引本来只看 %USERPROFILE%，那条记录**根本不存在**。
    ///
    /// 扩范围有两个约束，这里都要测：
    ///   ① 遍历耗时（虽在后台，但每 30 分钟跑一次）
    ///   ② **内存**——整个应用的目标是 ~30MB。IndexEntry 把同一份字符串
    ///      在 path/name/name_lower/ext 里存了三四遍，条数直接换算成内存。
    #[test]
    #[ignore]
    fn measure_index_scope() {
        // 单条 IndexEntry 的堆占用实测（结构体本身 + 两个 Box<str> 缓冲区；续126 起 name/ext 是切片，不占额外内存）
        let est = |v: &Vec<IndexEntry>| -> usize {
            std::mem::size_of::<IndexEntry>() * v.len()
                + v.iter()
                    .map(|e| e.path.len() + e.name_lower.len())
                    .sum::<usize>()
        };

        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let candidates: Vec<(&str, PathBuf)> = vec![
            ("%USERPROFILE%（现状）", PathBuf::from(&home)),
            ("C:\\Windows", PathBuf::from("C:\\Windows")),
            ("C:\\Program Files", PathBuf::from("C:\\Program Files")),
            ("C:\\Program Files (x86)", PathBuf::from("C:\\Program Files (x86)")),
            ("C:\\ProgramData", PathBuf::from("C:\\ProgramData")),
        ];

        println!("\n索引范围候选（应用现行剪枝规则 should_skip_dir / 深度 {MAX_WALK_DEPTH}）");
        println!("{:<26} | {:>9} | {:>9} | {:>10}", "根", "条数", "遍历", "估算内存");
        println!("{}", "-".repeat(64));
        let mut total_n = 0usize;
        let mut total_b = 0usize;
        let mut total_t = Duration::ZERO;
        for (label, dir) in &candidates {
            if !dir.exists() {
                println!("{label:<26} | (不存在)");
                continue;
            }
            let t = Instant::now();
            let idx = build_index(&[(dir.clone(), false, MAX_WALK_DEPTH)]);
            let el = t.elapsed();
            let bytes = est(&idx);
            println!(
                "{label:<26} | {:>9} | {:>7.2?} | {:>7.1} MB",
                idx.len(), el, bytes as f64 / 1_048_576.0
            );
            total_n += idx.len();
            total_b += bytes;
            total_t += el;
        }
        println!("{}", "-".repeat(64));
        println!(
            "{:<26} | {:>9} | {:>7.2?} | {:>7.1} MB   ← 全部加起来",
            "合计", total_n, total_t, total_b as f64 / 1_048_576.0
        );
        println!("  当前上限 MAX_INDEX_ENTRIES = {MAX_INDEX_ENTRIES}");

        // ── 收浅深度的效果（续122 的核心假设）────────────────────────────
        // 离 home 越远，「深层文件」的价值越低。想要的是
        // `C:\Windows` 这个文件夹（深度 1），而不是
        // `C:\Windows\System32\drivers\etc\hosts`。
        // 收窄深度应该能让条数＝内存骤降。这里验证它。
        println!("\n把系统根浅索引时的条数（按深度）");
        println!("{:<26} | {:>8} | {:>8} | {:>8} | {:>8}", "根", "深度2", "深度3", "深度4", "深度10");
        println!("{}", "-".repeat(70));
        for (label, dir) in candidates.iter().skip(1) {
            if !dir.exists() {
                continue;
            }
            let mut cells = Vec::new();
            for d in [2usize, 3, 4, 10] {
                let n = WalkDir::new(dir)
                    .max_depth(d)
                    .into_iter()
                    .filter_entry(|e| {
                        !(e.file_type().is_dir()
                            && e.file_name().to_str().map(should_skip_dir).unwrap_or(false))
                    })
                    .filter_map(|e| e.ok())
                    .filter(|e| !e.file_name().to_str().unwrap_or(".").starts_with('.'))
                    .count();
                cells.push(n);
            }
            println!(
                "{label:<26} | {:>8} | {:>8} | {:>8} | {:>8}",
                cells[0], cells[1], cells[2], cells[3]
            );
        }
        // ※ 用行连接符（\ 换行）会让全角空格留在行首被 clippy 报警，故拆成多条输出
        println!("  ※ IndexEntry 在 path/name/name_lower/ext 里重复存了同一份字符串。");
        println!("     name 是 path 的后缀，ext 是 name 的后缀，name_lower 是 name 的副本——");
        println!("     压缩表示后，同样条数可以显著降低内存占用。\n");
    }

    /// 诊断用（默认 #[ignore]：cargo test --lib probe_everything_exclude -- --ignored --nocapture）
    ///
    /// 续121 发现的问题：噪声排除若放在**我们这侧过滤**，
    /// 从 Everything 取回的 5000 条里有 4998 条是 WinSxS，扔完只剩 2 条。
    /// 只要「Everything 默认序的前 5000 条」被噪声占满，扩大池子也没用，
    /// 而 `C:\Windows` 本体压根就不在其中。
    /// → 排除必须下推到 **Everything 侧的查询语法**。这里就是对该语法的实证。
    #[test]
    #[ignore]
    fn probe_everything_exclude() {
        if !crate::everything::is_available() {
            println!("Everything 未启动。");
            return;
        }
        // 要验证的点：
        //  ① 必须带 `path:` 修饰（裸的否定只看文件名）
        //  ② 不带界定符的 `!path:target` 会**过度匹配**（连 "my-target-app" 也被排除），
        //     必须像 `\target\` 那样按完整路径段括起来
        //  ③ 含空格的名字（system volume information）需要引号
        //  ④ 用实际的完整排除句集时，`C:\Windows` 能否进入候选
        let full: String = NOISE_DIRS.iter().map(|d| format!(" !path:\"\\{d}\\\"")).collect();
        for q in [
            "windows".to_string(),
            "windows !path:winsxs".to_string(),
            "windows !winsxs".to_string(),
            r#"windows !path:"\winsxs\""#.to_string(),
            r#"windows !path:"\target\""#.to_string(), // ② 用于确认不会过度匹配
            format!("windows{full}"),
        ] {
            let q = q.as_str();
            match crate::everything::query(q, 20) {
                Ok(r) => {
                    println!("\n查询 {q:?} → {} 条", r.len());
                    for x in r.iter().take(8) {
                        println!("    {}", x.path);
                    }
                }
                Err(e) => println!("\n查询 {q:?} → 失败: {e}"),
            }
        }
        println!();
    }

    /// 诊断用（默认 #[ignore]，手动执行：
    ///   cargo test --lib measure_result_limit_cost -- --ignored --nocapture）
    ///
    /// 用数字判断「结果条数上限能不能放开」的测量（续120 调查）。
    /// 上限有三道：前端 ENH_FILE_LIMIT_EVERYTHING → Rust QUERY_LIMIT_CAP
    /// → Everything set_max。真正卡住的是**前端那一道**。
    ///
    /// 把代价拆开分别测：
    ///   ① Everything 查询本体（IPC + 字符串转换）
    ///   ② 填图标（**每条都要 clone 一份 base64 PNG 字符串**）
    ///   ③ JSON 序列化（经 IPC 送到 webview 的实际载荷）
    /// 若 ③ 占主导，那在提高上限之前得先做「图标另走一趟」之类的设计改动。
    #[test]
    #[ignore]
    fn measure_result_limit_cost() {
        if !crate::everything::is_available() {
            println!("Everything 未启动，无法测量。");
            return;
        }
        let prev = SEARCH_ENGINE.load(Ordering::Relaxed);
        SEARCH_ENGINE.store(ENGINE_EVERYTHING, Ordering::Relaxed);
        let q = "windows"; // 用户反馈里的查询（Everything 侧有 7 万条以上）

        println!("\n各条数上限下的代价（查询: {q:?}）");
        println!("{:>7} | {:>9} | {:>9} | {:>9} | {:>11}", "上限", "查询", "rerank", "JSON化", "JSON大小");
        println!("{}", "-".repeat(60));
        for &n in &[200usize, 500, 1000, 5000, 20000] {
            let t0 = Instant::now();
            let raw = match crate::everything::query(q, n) {
                Ok(r) => r,
                Err(e) => { println!("{n:>7} | 查询失败: {e}"); continue; }
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

        // 单个图标的 base64 大小——它是「提高上限后 JSON 膨胀」的主因。
        // ICON_CACHE 由后台 worker 构建，测试里是空的，所以直接现取来测。
        // get_file_info 自己会初始化 COM，可以直接调用
        for ext in ["txt", "exe", "png"] {
            let probe = std::env::temp_dir().join(format!("wb_iconprobe.{ext}"));
            let _ = std::fs::write(&probe, b"x");
            let sz = crate::apps::get_file_info(probe.to_string_lossy().to_string())
                .ok()
                .and_then(|i| i.icon)
                .map(|s| s.len())
                .unwrap_or(0);
            println!("  .{ext} 图标的 base64 长度: {} B", sz);
            let _ = std::fs::remove_file(&probe);
        }
        println!("  ↑ 上限为 N 时，JSON 大约按 N × (图标长度 + 路径长度) 膨胀");

        // 用真实数据验证续120 的效果：扩大候选池后，返回的 10 条内容是否真的变了。
        // 若不变，说明「先截断再评估」结果相同，即这次改动没有意义。
        println!("\n候选池大小如何改变返回的前 10 条（查询: {q:?}，含排除句）");
        for &pool in &[200usize, EVERYTHING_CANDIDATE_POOL] {
            if let Ok(r) = crate::everything::query(&everything_query_with_exclusions(q), pool) {
                let got = r.len();
                let mut ranked = rerank_everything(r, q);
                ranked.truncate(10);
                println!("  候选 {got:>5} 条 → 前 10 名:");
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
        let idx = build_index(&[(home, false, MAX_WALK_DEPTH)]);
        let walk = t1.elapsed();
        let exe_lnk = idx.iter().filter(|e| e.ext() == "exe" || e.ext() == "lnk").count();
        let t2 = Instant::now();
        let icons = build_icon_cache(&idx, &HashMap::new());
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
        let new_icons = build_icon_cache(&new_index, &HashMap::new()); // 同步预热图标，与索引一起换入
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
