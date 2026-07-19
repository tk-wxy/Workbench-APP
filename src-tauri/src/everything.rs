// 可选 Everything 搜索引擎接入（续57）。
//
// 设计：运行时用 libloading 动态加载 Everything 的 SDK 文件 `Everything64.dll`，通过它向后台运行的
// Everything 服务发 IPC 查询。**不硬链接**——DLL 缺失 / Everything 未运行时优雅降级（is_available()=false，
// 由 filesearch::search_files 降级回内置引擎），绝不影响应用启动。
//
// ⚠️ 前提：`Everything64.dll` 是 Everything **SDK** 的文件（与安装目录里的不是同一个），需用户从官网 SDK
// 获取后放到下列任一位置；并保持 Everything 在后台运行：
//   1. 应用资源目录（init 注册的 resource_dir，打包时 bundle.resources 落地）
//   2. 应用 exe 同目录 / 系统 PATH（按裸名 Everything64.dll 走 OS 默认 DLL 搜索）
//
// 线程安全：Everything IPC 用进程级全局缓冲（SetSearch/Query/GetResult 共享状态），多线程并发会串扰，
// 故所有调用经 CALL_LOCK 串行化。该锁与剪贴板 / 文件索引锁完全独立，无锁序问题。

use crate::filesearch::FileSearchResult;
use libloading::Library;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// Everything SDK 请求标志：要完整路径 + 文件名。
const EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME: u32 = 0x0000_0004;
/// 更新時刻も要求する（続117）。ランキングの新鮮度加点に使う。
/// **Everything 自身の索引から返る**ので、こちらがディスクを stat する必要はない
/// ——「查询命令はメモリのみ・ディスクに触れない」という鉄則を守れる唯一の入手経路。
const EVERYTHING_REQUEST_DATE_MODIFIED: u32 = 0x0000_0040;

/// FILETIME(1601-01-01 起算・100ns 単位) → Unix 秒。範囲外／未設定は 0（= 加点なし）へ落とす。
const FILETIME_UNIX_EPOCH_DIFF_SECS: u64 = 11_644_473_600;
fn filetime_to_unix(ft: u64) -> u64 {
    let secs = ft / 10_000_000;
    secs.saturating_sub(FILETIME_UNIX_EPOCH_DIFF_SECS)
}

type FnSetSearch = unsafe extern "system" fn(*const u16);
type FnVoidU32 = unsafe extern "system" fn(u32);
type FnQuery = unsafe extern "system" fn(i32) -> i32;
type FnU32 = unsafe extern "system" fn() -> u32;
type FnGetFullPath = unsafe extern "system" fn(u32, *mut u16, u32) -> u32;
type FnIsFolder = unsafe extern "system" fn(u32) -> i32;
/// `BOOL Everything_GetResultDateModified(DWORD index, FILETIME *out)`
type FnGetDateModified = unsafe extern "system" fn(u32, *mut u64) -> i32;

// 已解析的 Everything API。持有 Library 保证加载期内函数指针有效。
struct EverythingApi {
    _lib: Library,
    set_search: FnSetSearch,
    set_request_flags: FnVoidU32,
    set_max: FnVoidU32,
    query: FnQuery,
    get_num_results: FnU32,
    get_full_path: FnGetFullPath,
    is_folder: FnIsFolder,
    get_major_version: FnU32,
    get_last_error: FnU32,
    /// 続117。**必須にしない**（Option）——古い SDK DLL にこの関数が無い場合、
    /// try_load を丸ごと失敗させると Everything 連携そのものが死ぬ。
    /// 解決できなければ mtime=0 → 新鮮度加点なしに退化するだけで、他は従来どおり動く。
    get_date_modified: Option<FnGetDateModified>,
}

// 函数指针 + Library 均为 Send+Sync；并发调用另由 API 锁串行化（持锁期间调 IPC）。
unsafe impl Sync for EverythingApi {}
unsafe impl Send for EverythingApi {}

// 用 Mutex<Option<...>> 而非 OnceLock：既缓存已加载的句柄、又支持运行期丢弃重载（热更新）。
// 该锁同时充当 IPC 串行化锁（Everything 用进程级全局缓冲，并发调用会串扰）。
static API: Mutex<Option<EverythingApi>> = Mutex::new(None);
static DLL_DIR: OnceLock<PathBuf> = OnceLock::new();

/// setup 阶段调用：登记资源目录，供加载时优先在此找 Everything64.dll。
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().resource_dir() {
        let _ = DLL_DIR.set(dir);
    }
}

// 从单个路径尝试加载并解析全部所需符号；任一缺失则视为失败。
unsafe fn try_load(path: &std::ffi::OsStr) -> Option<EverythingApi> {
    let lib = Library::new(path).ok()?;
    // 解出函数指针后拷贝出来（Symbol 借用 lib，*sym 得到 Copy 的裸指针；lib 由 struct 持有保活）。
    let set_search = *lib.get::<FnSetSearch>(b"Everything_SetSearchW\0").ok()?;
    let set_request_flags = *lib.get::<FnVoidU32>(b"Everything_SetRequestFlags\0").ok()?;
    let set_max = *lib.get::<FnVoidU32>(b"Everything_SetMax\0").ok()?;
    let query = *lib.get::<FnQuery>(b"Everything_QueryW\0").ok()?;
    let get_num_results = *lib.get::<FnU32>(b"Everything_GetNumResults\0").ok()?;
    let get_full_path = *lib
        .get::<FnGetFullPath>(b"Everything_GetResultFullPathNameW\0")
        .ok()?;
    let is_folder = *lib.get::<FnIsFolder>(b"Everything_IsFolderResult\0").ok()?;
    let get_major_version = *lib.get::<FnU32>(b"Everything_GetMajorVersion\0").ok()?;
    let get_last_error = *lib.get::<FnU32>(b"Everything_GetLastError\0").ok()?;
    // ↓ ここだけ ? を付けない（任意シンボル、上の struct 定義のコメント参照）
    let get_date_modified = lib
        .get::<FnGetDateModified>(b"Everything_GetResultDateModified\0")
        .ok()
        .map(|s| *s);
    Some(EverythingApi {
        _lib: lib,
        get_date_modified,
        set_search,
        set_request_flags,
        set_max,
        query,
        get_num_results,
        get_full_path,
        is_folder,
        get_major_version,
        get_last_error,
    })
}

// 按候选位置加载：资源目录（打包后 bundle.resources）→ exe 目录 → cwd（dev 时为 src-tauri）→ 裸名（OS 默认搜索）。
fn load_api() -> Option<EverythingApi> {
    const DLL: &str = "Everything64.dll";
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = DLL_DIR.get() {
        candidates.push(dir.join(DLL));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            candidates.push(p.join(DLL));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(DLL));
    }
    candidates.push(PathBuf::from(DLL)); // 兜底走 OS 默认 DLL 搜索
    for c in candidates {
        if let Some(api) = unsafe { try_load(c.as_os_str()) } {
            return Some(api);
        }
    }
    None
}

// 确保 API 已加载（持锁调用）。未加载则尝试一次；失败不写入 Some（下次再试，支持运行期补放 DLL）。
fn ensure_loaded(guard: &mut Option<EverythingApi>) {
    if guard.is_none() {
        *guard = load_api();
    }
}

/// 热更新：丢弃已加载的 DLL 句柄（FreeLibrary），下次查询/检测时重新加载。
/// 持 API 锁期间无任何 in-flight IPC 调用（皆串行化于此锁），故 drop Library 安全。
pub fn reload() {
    if let Ok(mut g) = API.lock() {
        *g = None;
    }
}

/// Everything 是否可用：DLL 能加载且 Everything 服务在运行（未运行时 GetMajorVersion()==0）。
pub fn is_available() -> bool {
    let mut guard = match API.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    ensure_loaded(&mut guard);
    match guard.as_ref() {
        Some(api) => unsafe { (api.get_major_version)() > 0 },
        None => false,
    }
}

/// 查询 Everything。失败（DLL 缺失 / 未运行 / 查询出错）返回 Err，调用方降级内置引擎。
pub fn query(q: &str, limit: usize) -> Result<Vec<FileSearchResult>, String> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut guard = API.lock().map_err(|_| "API lock poisoned".to_string())?;
    ensure_loaded(&mut guard);
    let api = guard
        .as_ref()
        .ok_or_else(|| "Everything64.dll 未找到或加载失败".to_string())?;
    unsafe {
        if (api.get_major_version)() == 0 {
            return Err("Everything 未运行".to_string());
        }
        let wide: Vec<u16> = q.encode_utf16().chain(std::iter::once(0)).collect();
        (api.set_search)(wide.as_ptr());
        // 更新時刻はシンボルが取れたときだけ要求する（不要なフラグを立てても Everything 側の
        // 仕事が増えるだけなので、使えないときは従来どおりのフラグに留める）
        let want_mtime = api.get_date_modified.is_some();
        (api.set_request_flags)(if want_mtime {
            EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME | EVERYTHING_REQUEST_DATE_MODIFIED
        } else {
            EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME
        });
        (api.set_max)(limit as u32);
        if (api.query)(1) == 0 {
            return Err(format!(
                "Everything_Query 失败 (err {})",
                (api.get_last_error)()
            ));
        }
        let num = (api.get_num_results)();
        let mut out = Vec::with_capacity(num as usize);
        let mut buf = [0u16; 1024];
        for i in 0..num {
            let n = (api.get_full_path)(i, buf.as_mut_ptr(), buf.len() as u32);
            if n == 0 {
                continue;
            }
            let path = String::from_utf16_lossy(&buf[..n as usize]);
            let is_dir = (api.is_folder)(i) != 0;
            let p = std::path::Path::new(&path);
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            // 更新時刻（続117）。取れなければ 0 = 新鮮度加点なしへ退化。
            let mtime = match api.get_date_modified {
                Some(f) => {
                    let mut ft: u64 = 0;
                    if f(i, &mut ft) != 0 {
                        filetime_to_unix(ft)
                    } else {
                        0 // この 1 件だけ取れなかった（フォルダ等）
                    }
                }
                None => 0, // 古い SDK DLL
            };
            out.push(FileSearchResult {
                path,
                name,
                ext,
                is_dir,
                icon: None, // 由 filesearch::fill_icons_from_cache 从预热缓存回填
                mtime,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FILETIME → Unix 秒（続117）。境界と異常値で破綻しないこと。
    #[test]
    fn filetime_conversion() {
        // Unix epoch ちょうど = 1601 から 11644473600 秒
        assert_eq!(filetime_to_unix(FILETIME_UNIX_EPOCH_DIFF_SECS * 10_000_000), 0);
        // その 1 日後
        assert_eq!(
            filetime_to_unix((FILETIME_UNIX_EPOCH_DIFF_SECS + 86_400) * 10_000_000),
            86_400
        );
        // 0（未設定 / 取得失敗）は 0 へ。saturating_sub なので負に回り込まない
        assert_eq!(filetime_to_unix(0), 0, "未設定の FILETIME は 0 = 加点なしへ落ちるべき");
        // 1601〜1970 の間の値も 0 へ飽和（recency_bonus 側で「不明」と同じ扱いになる）
        assert_eq!(filetime_to_unix(1_000 * 10_000_000), 0);
    }

    /// 診断用（既定 #[ignore]、手動実行：
    ///   cargo test --lib everything::tests::probe_sdk_symbols -- --ignored --nocapture）
    ///
    /// 実機の Everything64.dll が続117 で追加した任意シンボル
    /// `Everything_GetResultDateModified` を実際に export しているかを見る。
    /// Everything 本体（サービス）が動いていなくても DLL のロードとシンボル解決は確認できる
    /// ——クエリ経路そのものは無頭環境では driveできないので、ここまでが機械的に検証できる限界。
    #[test]
    #[ignore]
    fn probe_sdk_symbols() {
        let api = load_api();
        match api {
            None => println!("Everything64.dll をロードできず（候補パスに無い）。判定不能。"),
            Some(a) => {
                println!("DLL ロード成功");
                println!(
                    "  Everything_GetResultDateModified: {}",
                    if a.get_date_modified.is_some() {
                        "あり → 新鮮度加点が効く"
                    } else {
                        "無し → mtime=0 に退化（関連度のみで並ぶ。他機能は従来どおり）"
                    }
                );
                let ver = unsafe { (a.get_major_version)() };
                println!(
                    "  Everything_GetMajorVersion: {ver}{}",
                    if ver == 0 { "（= サービス未起動。クエリ経路は検証不可）" } else { "" }
                );
            }
        }
    }
}

/// 重新加载 Everything（热更新）：丢弃旧 DLL 句柄，返回重载后是否可用。
/// 用于运行期替换 DLL / 启动 Everything 后无需重启应用即可生效。
#[tauri::command]
pub fn reload_everything() -> bool {
    reload();
    is_available()
}