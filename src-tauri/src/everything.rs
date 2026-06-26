// Everything 搜索引擎集成（SDK DLL 方案，DLL 随 app 分发）。
//
// 运行时动态加载捆绑的 Everything64.dll，通过 SDK API 查询 Everything 的全盘 NTFS 索引。
// Everything 未运行时静默回退内置引擎。
//
// 零外部依赖——Everything64.dll 放在 src-tauri/resources/ 随 exe 一起分发。

use std::path::PathBuf;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(lpFileName: *const u16) -> *mut std::ffi::c_void;
    fn FreeLibrary(hModule: *mut std::ffi::c_void) -> i32;
    fn GetProcAddress(hModule: *mut std::ffi::c_void, lpProcName: *const u8) -> *mut std::ffi::c_void;
}

// Everything SDK 函数指针类型
type FnSetSearchW = unsafe extern "system" fn(*const u16);
type FnQueryW = unsafe extern "system" fn(i32) -> i32;
type FnGetNumResults = unsafe extern "system" fn() -> u32;
type FnGetResultFileNameW = unsafe extern "system" fn(u32) -> *const u16;
type FnGetResultPathW = unsafe extern "system" fn(u32) -> *const u16;
type FnCleanUp = unsafe extern "system" fn();

pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

pub struct EverythingClient {
    dll: *mut std::ffi::c_void,
    set_search: FnSetSearchW,
    query: FnQueryW,
    get_num_results: FnGetNumResults,
    get_result_file_name: FnGetResultFileNameW,
    get_result_path: FnGetResultPathW,
    clean_up: FnCleanUp,
}

unsafe impl Send for EverythingClient {}
unsafe impl Sync for EverythingClient {}

macro_rules! load_fn {
    ($dll:expr, $name:expr, $t:ty) => {{
        let addr = unsafe { GetProcAddress($dll, concat!($name, "\0").as_ptr()) };
        if addr.is_null() { eprintln!("[everything] GetProcAddress({}) failed", $name); return None; }
        unsafe { std::mem::transmute::<*mut std::ffi::c_void, $t>(addr) }
    }};
}

impl EverythingClient {
    pub fn try_connect() -> Option<Self> {
        let dll_path = find_dll()?;
        eprintln!("[everything] loading DLL: {}", dll_path.display());
        let wide: Vec<u16> = dll_path.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let dll = unsafe { LoadLibraryW(wide.as_ptr()) };
        if dll.is_null() { eprintln!("[everything] LoadLibraryW failed"); return None; }

        let set_search = load_fn!(dll, "Everything_SetSearchW", FnSetSearchW);
        let query = load_fn!(dll, "Everything_QueryW", FnQueryW);
        let get_num_results = load_fn!(dll, "Everything_GetNumResults", FnGetNumResults);
        let get_result_file_name = load_fn!(dll, "Everything_GetResultFileNameW", FnGetResultFileNameW);
        let get_result_path = load_fn!(dll, "Everything_GetResultPathW", FnGetResultPathW);
        let clean_up = load_fn!(dll, "Everything_CleanUp", FnCleanUp);

        // 一次性配置
        let set_match_path: unsafe extern "system" fn(i32) = load_fn!(dll, "Everything_SetMatchPath", unsafe extern "system" fn(i32));
        let set_match_case: unsafe extern "system" fn(i32) = load_fn!(dll, "Everything_SetMatchCase", unsafe extern "system" fn(i32));
        let set_sort: unsafe extern "system" fn(u32) = load_fn!(dll, "Everything_SetSort", unsafe extern "system" fn(u32));
        let set_request_flags: unsafe extern "system" fn(u32) = load_fn!(dll, "Everything_SetRequestFlags", unsafe extern "system" fn(u32));
        let set_max: unsafe extern "system" fn(u32) = load_fn!(dll, "Everything_SetMax", unsafe extern "system" fn(u32));

        unsafe {
            set_match_path(0);  // 仅匹配文件名（与 Everything 本尊默认一致）
            set_match_case(0);
            set_sort(1);        // 按名称
            set_request_flags(1 | 2); // FILE_NAME | PATH
            set_max(500);
        }

        eprintln!("[everything] SDK DLL OK");
        Some(Self { dll, set_search, query, get_num_results, get_result_file_name, get_result_path, clean_up })
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<EverythingResult> {
        let q = query.trim();
        if q.is_empty() { return Vec::new(); }
        let wide: Vec<u16> = q.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { (self.set_search)(wide.as_ptr()) };
        if unsafe { (self.query)(1) } == 0 { return Vec::new(); }
        let n = unsafe { (self.get_num_results)() as usize };
        let cap = limit.min(n).min(200);
        let mut out = Vec::with_capacity(cap);
        for i in 0..n {
            if out.len() >= cap { break; }
            let path_ptr = unsafe { (self.get_result_path)(i as u32) };
            let name_ptr = unsafe { (self.get_result_file_name)(i as u32) };
            if path_ptr.is_null() && name_ptr.is_null() { continue; }
            let path = unsafe { wide_to_string(path_ptr) };
            let name = unsafe { wide_to_string(name_ptr) };
            let full = if path.is_empty() { name.clone() } else if name.is_empty() { path.clone() } else { format!("{}\\{}", path.trim_end_matches('\\'), name) };
            let ext = std::path::Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            out.push(EverythingResult { path: full, name, ext, is_dir: false });
        }
        out
    }
}

impl Drop for EverythingClient {
    fn drop(&mut self) {
        unsafe { (self.clean_up)(); FreeLibrary(self.dll); }
    }
}

unsafe fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() { return String::new(); }
    let mut len = 0usize;
    while *ptr.add(len) != 0 { len += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// 定位 Everything64.dll：app 资源目录 → exe 同目录 → Everything 安装目录。
fn find_dll() -> Option<PathBuf> {
    // 1) exe 同目录（开发/打包通用）+ resources 子目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidates = [
                dir.join("Everything64.dll"),
                dir.join("resources").join("Everything64.dll"),
            ];
            for dll in &candidates {
                if dll.exists() { eprintln!("[everything] DLL: {}", dll.display()); return Some(dll.clone()); }
            }
            // 开发模式 cargo run：exe 在 target/debug/，resources 在项目根 src-tauri/resources/
            let proj_res = dir.join("../../../src-tauri/resources/Everything64.dll");
            if proj_res.exists() { eprintln!("[everything] DLL (dev): {}", proj_res.display()); return Some(proj_res); }
        }
    }
    // 2) Everything 安装目录
    if let Some(exe_dir) = find_everything_exe_dir() {
        for name in &["Everything64.dll", "Everything.dll"] {
            let dll = exe_dir.join(name);
            if dll.exists() { return Some(dll); }
        }
    }
    None
}

// ── 进程快照：找 Everything.exe 位置 ──

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
    fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
    fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
    fn CloseHandle(hObject: isize) -> i32;
    fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
    fn QueryFullProcessImageNameW(hProcess: isize, dwFlags: u32, lpExeName: *mut u16, lpdwSize: *mut u32) -> i32;
}

#[repr(C)] #[allow(non_snake_case)]
struct PROCESSENTRY32W {
    dwSize: u32, cntUsage: u32, th32ProcessID: u32, th32DefaultHeapID: usize,
    th32ModuleID: u32, cntThreads: u32, th32ParentProcessID: u32,
    pcPriClassBase: i32, dwFlags: u32, szExeFile: [u16; 260],
}

fn find_everything_exe_dir() -> Option<PathBuf> {
    let snap = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snap == 0 || snap == -1 { return None; }
    let mut pe = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cntUsage: 0, th32ProcessID: 0, th32DefaultHeapID: 0, th32ModuleID: 0,
        cntThreads: 0, th32ParentProcessID: 0, pcPriClassBase: 0, dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut found = None;
    unsafe {
        if Process32FirstW(snap, &mut pe) != 0 {
            loop {
                let name = String::from_utf16_lossy(&pe.szExeFile).trim_end_matches('\0').to_string();
                if name.eq_ignore_ascii_case("everything.exe") || name.eq_ignore_ascii_case("everything64.exe") {
                    let hp = OpenProcess(0x1000, 0, pe.th32ProcessID);
                    if hp != 0 {
                        let mut buf = vec![0u16; 520];
                        let mut len = buf.len() as u32;
                        if QueryFullProcessImageNameW(hp, 0, buf.as_mut_ptr(), &mut len) != 0 {
                            let exe = String::from_utf16_lossy(&buf[..len as usize]).trim_end_matches('\0').to_string();
                            if let Some(parent) = std::path::Path::new(&exe).parent() {
                                found = Some(parent.to_path_buf());
                            }
                        }
                        CloseHandle(hp);
                    }
                    if found.is_some() { break; }
                }
                if Process32NextW(snap, &mut pe) == 0 { break; }
            }
        }
        CloseHandle(snap);
    }
    found
}

/// 兼容旧接口（filesearch 调用）。
pub fn find_everything_exe_dir_pub() -> Option<PathBuf> { find_everything_exe_dir() }
