// Everything 搜索引擎集成（可选，需用户自行安装 Everything）。
//
// 动态加载 Everything64.dll，通过 SDK API 查询 Everything 的全盘 NTFS 索引。
// Everything 未安装 / 未运行时，自动回退内置引擎。
//
// 设计原则：
// - 零编译时依赖：DLL 运行时动态加载
// - 零 IPC 开销：一次 Query 调用拿到全部结果
// - 搜索 → 结果映射与内置 FileSearchResult 完全对齐，前端无感知
// - 使用 raw FFI（extern "system"）而非 windows crate，避免多版本 windows-core 类型冲突

use std::path::PathBuf;

// ── kernel32 / advapi32 raw FFI ──
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(lpFileName: *const u16) -> *mut std::ffi::c_void;
    fn FreeLibrary(hModule: *mut std::ffi::c_void) -> i32;
    fn GetProcAddress(hModule: *mut std::ffi::c_void, lpProcName: *const u8) -> *mut std::ffi::c_void;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hKey: isize,
        lpSubKey: *const u16,
        ulOptions: u32,
        samDesired: u32,
        phkResult: *mut isize,
    ) -> i32;
    fn RegQueryValueExW(
        hKey: isize,
        lpValueName: *const u16,
        lpReserved: *mut std::ffi::c_void,
        lpType: *mut u32,
        lpData: *mut u8,
        lpcbData: *mut u32,
    ) -> i32;
    fn RegCloseKey(hKey: isize) -> i32;
}

const HKEY_CURRENT_USER: isize = -0x7FFFFFFF - 1 + 1; // 0x80000001
const HKEY_LOCAL_MACHINE: isize = -0x7FFFFFFF - 1 + 2; // 0x80000002
const KEY_READ: u32 = 0x20019;
const ERROR_SUCCESS: i32 = 0;

// ── Everything SDK 函数指针类型 ──
type FnSetSearchW = unsafe extern "system" fn(*const u16);
type FnQueryW = unsafe extern "system" fn(i32) -> i32;
type FnGetNumResults = unsafe extern "system" fn() -> u32;
type FnGetResultFileNameW = unsafe extern "system" fn(u32) -> *const u16;
type FnGetResultPathW = unsafe extern "system" fn(u32) -> *const u16;
type FnCleanUp = unsafe extern "system" fn();
type FnSetMax = unsafe extern "system" fn(u32);
type FnSetSort = unsafe extern "system" fn(u32);

/// 匹配结果（与 FileSearchResult 对齐）
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

// Everything SDK 函数均为线程安全。
unsafe impl Send for EverythingClient {}
unsafe impl Sync for EverythingClient {}

/// 加载 DLL 中的指定函数指针。失败返回 None（不 panic）。
macro_rules! load_fn_opt {
    ($dll:expr, $name:expr, $t:ty) => {{
        let addr = unsafe { GetProcAddress($dll, concat!($name, "\0").as_ptr()) };
        if addr.is_null() {
            eprintln!("[everything] GetProcAddress({}) failed", $name);
            None
        } else {
            Some(unsafe { std::mem::transmute::<*mut std::ffi::c_void, $t>(addr) })
        }
    }};
}

impl EverythingClient {
    pub fn try_connect() -> Option<Self> {
        let dll_path = find_everything_dll()?;
        eprintln!("[everything] found DLL: {}", dll_path.display());
        let wide: Vec<u16> = dll_path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let dll = unsafe { LoadLibraryW(wide.as_ptr()) };
        if dll.is_null() {
            eprintln!("[everything] LoadLibraryW failed");
            return None;
        }
        eprintln!("[everything] LoadLibraryW OK");

        // 尝试 W 后缀，失败则尝试无后缀（部分版本差异）
        let set_search = load_fn_opt!(dll, "Everything_SetSearchW", FnSetSearchW)
            .or_else(|| load_fn_opt!(dll, "Everything_SetSearch", FnSetSearchW))?;
        let query = load_fn_opt!(dll, "Everything_QueryW", FnQueryW)
            .or_else(|| load_fn_opt!(dll, "Everything_Query", FnQueryW))?;
        let get_num_results = load_fn_opt!(dll, "Everything_GetNumResults", FnGetNumResults)?;
        let get_result_file_name = load_fn_opt!(dll, "Everything_GetResultFileNameW", FnGetResultFileNameW)?;
        let get_result_path = load_fn_opt!(dll, "Everything_GetResultPathW", FnGetResultPathW)?;
        let clean_up = load_fn_opt!(dll, "Everything_CleanUp", FnCleanUp)?;

        eprintln!("[everything] all function pointers resolved OK");

        // 一次性配置（同样尝试 W 和无后缀两种命名）
        let set_match_path: unsafe extern "system" fn(i32) =
            load_fn_opt!(dll, "Everything_SetMatchPathW", unsafe extern "system" fn(i32))
                .or_else(|| load_fn_opt!(dll, "Everything_SetMatchPath", unsafe extern "system" fn(i32)))?;
        let set_match_case: unsafe extern "system" fn(i32) =
            load_fn_opt!(dll, "Everything_SetMatchCaseW", unsafe extern "system" fn(i32))
                .or_else(|| load_fn_opt!(dll, "Everything_SetMatchCase", unsafe extern "system" fn(i32)))?;
        let set_sort: FnSetSort =
            load_fn_opt!(dll, "Everything_SetSort", FnSetSort)?;
        let set_request_flags: unsafe extern "system" fn(u32) =
            load_fn_opt!(dll, "Everything_SetRequestFlags", unsafe extern "system" fn(u32))?;
        let set_max: FnSetMax =
            load_fn_opt!(dll, "Everything_SetMax", FnSetMax)?;

        unsafe {
            set_match_path(1); // 匹配全路径
            set_match_case(0); // 不区分大小写
            set_sort(1); // 按名称升序
            set_request_flags(1 | 2); // FILE_NAME | PATH
            set_max(200);
        }

        Some(Self { dll, set_search, query, get_num_results, get_result_file_name, get_result_path, clean_up })
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<EverythingResult> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let wide: Vec<u16> = q.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { (self.set_search)(wide.as_ptr()) };

        let ok = unsafe { (self.query)(1) }; // 1 = TRUE，等待完成
        if ok == 0 {
            return Vec::new();
        }

        let n = unsafe { (self.get_num_results)() as usize };
        let cap = limit.min(n).min(50);
        let mut out = Vec::with_capacity(cap);
        for i in 0..n {
            if out.len() >= limit {
                break;
            }
            let path_ptr = unsafe { (self.get_result_path)(i as u32) };
            let name_ptr = unsafe { (self.get_result_file_name)(i as u32) };
            if path_ptr.is_null() || name_ptr.is_null() {
                continue;
            }
            let path = unsafe { wide_to_string(path_ptr) };
            let name = unsafe { wide_to_string(name_ptr) };
            if path.is_empty() || name.is_empty() {
                continue;
            }
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            out.push(EverythingResult { path, name, ext, is_dir: false });
        }
        out
    }
}

impl Drop for EverythingClient {
    fn drop(&mut self) {
        unsafe {
            (self.clean_up)();
            FreeLibrary(self.dll);
        }
    }
}

/// 从 \0 结尾的 UTF-16 指针转 Rust String。
unsafe fn wide_to_string(ptr: *const u16) -> String {
    let len = {
        let mut p = ptr;
        let mut l = 0usize;
        while *p != 0 { p = p.add(1); l += 1; }
        l
    };
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// 定位 Everything DLL：注册表 → 常见路径 → Everything 进程路径。
pub fn find_everything_dll() -> Option<std::path::PathBuf> {
    // 1) 注册表
    for hkey in &[HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Some(p) = reg_install_path(*hkey) {
            eprintln!("[everything] reg install path: {}", p.display());
            for name in &["Everything64.dll", "Everything.dll"] {
                let dll = p.join(name);
                if dll.exists() {
                    return Some(dll);
                }
            }
        }
    }
    // 2) 常见路径
    for candidate in &[
        r"C:\Program Files\Everything\Everything64.dll",
        r"C:\Program Files\Everything\Everything.dll",
        r"C:\Program Files (x86)\Everything\Everything64.dll",
        r"C:\Program Files (x86)\Everything\Everything.dll",
    ] {
        let p = std::path::PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    // 3) Everything 进程路径：查找 Everything.exe 所在目录
    if let Some(exe_dir) = find_everything_exe_dir() {
        eprintln!("[everything] exe dir: {}", exe_dir.display());
        for name in &["Everything64.dll", "Everything.dll"] {
            let dll = PathBuf::from(&exe_dir).join(name);
            eprintln!("[everything]   try: {}", dll.display());
            if dll.exists() {
                return Some(dll);
            }
        }
    }
    eprintln!("[everything] DLL not found (reg + paths + process)");
    None
}

/// 通过 Toolhelp32 快照查找 Everything.exe 进程，取其所在目录。
fn find_everything_exe_dir() -> Option<std::path::PathBuf> {
    // 使用 kernel32 CreateToolhelp32Snapshot + Process32First/Next
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> *mut std::ffi::c_void;
        fn Process32FirstW(hSnapshot: *mut std::ffi::c_void, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: *mut std::ffi::c_void, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut std::ffi::c_void;
        fn QueryFullProcessImageNameW(
            hProcess: *mut std::ffi::c_void, dwFlags: u32,
            lpExeName: *mut u16, lpdwSize: *mut u32,
        ) -> i32;
    }
    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    let snap = unsafe { CreateToolhelp32Snapshot(2/*TH32CS_SNAPPROCESS*/, 0) };
    if snap.is_null() || snap as isize == -1 {
        return None;
    }
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
                let name = String::from_utf16_lossy(&pe.szExeFile);
                let name = name.trim_end_matches('\0');
                if name.eq_ignore_ascii_case("everything.exe") || name.eq_ignore_ascii_case("everything64.exe") {
                    // 打开进程取完整路径
                    let hp = OpenProcess(0x1000/*PROCESS_QUERY_LIMITED_INFORMATION*/, 0, pe.th32ProcessID);
                    if !hp.is_null() {
                        let mut buf = vec![0u16; 520];
                        let mut len = buf.len() as u32;
                        if QueryFullProcessImageNameW(hp, 0, buf.as_mut_ptr(), &mut len) != 0 {
                            let exe_path = String::from_utf16_lossy(&buf[..len as usize]);
                            let exe_path = exe_path.trim_end_matches('\0').to_string();
                            eprintln!("[everything] Everything.exe at: {}", exe_path);
                            if let Some(parent) = std::path::Path::new(&exe_path).parent() {
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

fn reg_install_path(hkey: isize) -> Option<PathBuf> {
    let mut key: isize = 0;
    let sub: Vec<u16> = "SOFTWARE\\Everything"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let ret = unsafe { RegOpenKeyExW(hkey, sub.as_ptr(), 0, KEY_READ, &mut key) };
    if ret != ERROR_SUCCESS || key == 0 {
        return None;
    }
    let val: Vec<u16> = "InstallLocation"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut buf = vec![0u16; 520];
    let mut buf_len: u32 = (buf.len() * 2) as u32;
    let ret = unsafe {
        RegQueryValueExW(
            key,
            val.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut u8,
            &mut buf_len,
        )
    };
    unsafe { RegCloseKey(key) };
    if ret != ERROR_SUCCESS {
        return None;
    }
    let char_len = (buf_len as usize / 2).min(buf.len() - 1);
    buf.truncate(char_len);
    String::from_utf16(&buf).ok().map(PathBuf::from)
}
