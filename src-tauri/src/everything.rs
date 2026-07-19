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
/// 一并请求修改时间（续117），用于排序的新鲜度加分。
/// **它来自 Everything 自己的索引**，我们不需要去 stat 磁盘
/// ——这是能守住「查询命令只读内存、不碰磁盘」这条铁律的唯一取值途径。
const EVERYTHING_REQUEST_DATE_MODIFIED: u32 = 0x0000_0040;

/// FILETIME(自 1601-01-01 起、100ns 为单位) → Unix 秒。越界／未设置一律落到 0（= 不加分）。
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
    /// 续117。**不设为必需**（Option）——旧版 SDK DLL 里若没有这个函数，
    /// 让 try_load 整体失败会把 Everything 集成本身搞死。
    /// 解析不到就退化成 mtime=0 → 没有新鲜度加分而已，其余照常工作。
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
    // ↓ 只有这里不加 ?（可选符号，见上面 struct 定义处的注释）
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
        // 只在符号可用时才请求修改时间（白立标志只会给 Everything 增加无谓的工作，
        // 用不了时就维持原来的标志）
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
            // 修改时间（续117）。取不到就退化为 0 = 不加新鲜度分。
            let mtime = match api.get_date_modified {
                Some(f) => {
                    let mut ft: u64 = 0;
                    if f(i, &mut ft) != 0 {
                        filetime_to_unix(ft)
                    } else {
                        0 // 只有这一条取不到（文件夹等情况）
                    }
                }
                None => 0, // 旧版 SDK DLL
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

    /// FILETIME → Unix 秒（续117）。边界与异常值下不得出错。
    #[test]
    fn filetime_conversion() {
        // 恰好 Unix epoch = 自 1601 起 11644473600 秒
        assert_eq!(filetime_to_unix(FILETIME_UNIX_EPOCH_DIFF_SECS * 10_000_000), 0);
        // 再往后 1 天
        assert_eq!(
            filetime_to_unix((FILETIME_UNIX_EPOCH_DIFF_SECS + 86_400) * 10_000_000),
            86_400
        );
        // 0（未设置 / 取值失败）落到 0。用的是 saturating_sub，不会回绕成负数
        assert_eq!(filetime_to_unix(0), 0, "未设置的 FILETIME 应落到 0 = 不加分");
        // 1601~1970 之间的值也饱和到 0（在 recency_bonus 侧与「未知」同等对待）
        assert_eq!(filetime_to_unix(1_000 * 10_000_000), 0);
    }

    /// 诊断用（默认 #[ignore]，手动执行：
    ///   cargo test --lib everything::tests::probe_sdk_symbols -- --ignored --nocapture）
    ///
    /// 看实机的 Everything64.dll 是否真的导出了续117 用到的可选符号
    /// `Everything_GetResultDateModified`。
    /// 即使 Everything 本体（服务）没运行，DLL 加载与符号解析仍可确认
    /// ——查询路径本身在无头环境下驱动不了，所以这里就是机械验证能到达的边界。
    #[test]
    #[ignore]
    fn probe_sdk_symbols() {
        let api = load_api();
        match api {
            None => println!("加载不到 Everything64.dll（候选路径里没有）。无法判定。"),
            Some(a) => {
                println!("DLL 加载成功");
                println!(
                    "  Everything_GetResultDateModified: {}",
                    if a.get_date_modified.is_some() {
                        "存在 → 新鲜度加分可生效"
                    } else {
                        "不存在 → 退化为 mtime=0（只按相关度排序，其余功能不受影响）"
                    }
                );
                let ver = unsafe { (a.get_major_version)() };
                println!(
                    "  Everything_GetMajorVersion: {ver}{}",
                    if ver == 0 { "（= 服务未启动，查询路径无法验证）" } else { "" }
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