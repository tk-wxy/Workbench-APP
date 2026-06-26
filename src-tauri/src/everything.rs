// Everything 搜索引擎集成（通过 es.exe 命令行工具）。
//
// 不依赖 Everything SDK DLL（便携版不含），直接调用 Everything 自带的 es.exe。
// Everything 未安装 / 未运行时，自动回退内置引擎。
//
// es.exe 用法：es.exe -sort name -n 50 <query>
// 输出每行一个完整路径，按名称排序。

use std::path::PathBuf;
use std::process::Command;

/// 匹配结果（与 FileSearchResult 对齐）
pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

pub struct EverythingClient {
    es_path: PathBuf,
}

// 线程安全（只读 PathBuf + 子进程）
unsafe impl Send for EverythingClient {}
unsafe impl Sync for EverythingClient {}

impl EverythingClient {
    /// 查找 es.exe（同 Everything.exe 目录 → 注册表 → 常见路径 → 进程快照）。
    pub fn try_connect() -> Option<Self> {
        let es = find_es_exe()?;
        eprintln!("[everything] es.exe: {}", es.display());
        // 快速验证 es.exe 可用
        let output = Command::new(&es)
            .arg("-n").arg("1")
            .arg("test_query_workbench_connectivity")
            .output().ok()?;
        // 即使无结果，只要进程能跑就行
        if !output.status.success() {
            eprintln!("[everything] es.exe returned error status");
            return None;
        }
        eprintln!("[everything] es.exe OK");
        Some(Self { es_path: es })
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<EverythingResult> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let n = limit.min(50).to_string();
        let output = match Command::new(&self.es_path)
            .arg("-sort").arg("name")
            .arg("-n").arg(&n)
            .arg(q)
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[everything] es.exe spawn failed: {e}");
                return Vec::new();
            }
        };
        if !output.status.success() {
            eprintln!("[everything] es.exe exit != 0");
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|path| {
                let p = std::path::Path::new(path);
                let name = p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path)
                    .to_string();
                let ext = p.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                EverythingResult { path: path.to_string(), name, ext, is_dir: false }
            })
            .collect()
    }
}

/// 查找 es.exe：Everything.exe 同目录 → 注册表 → 常见路径 → 进程快照。
pub fn find_everything_dll() -> Option<PathBuf> {
    // 保留此函数兼容外部调用（filesearch 中的 get_search_engine）
    find_es_exe()
}

fn find_es_exe() -> Option<PathBuf> {
    // 1) 从运行中的 Everything.exe 反向查找同目录
    if let Some(exe_dir) = find_everything_exe_dir() {
        let es = PathBuf::from(&exe_dir).join("es.exe");
        if es.exists() {
            return Some(es);
        }
    }
    // 2) 注册表
    for hkey in &[HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Some(p) = reg_install_path(*hkey) {
            let es = p.join("es.exe");
            if es.exists() {
                return Some(es);
            }
        }
    }
    // 3) 常见路径
    for dir in &[
        r"C:\Program Files\Everything",
        r"C:\Program Files (x86)\Everything",
        r"D:\Program Files\Everything",
        r"D:\Program Files (x86)\Everything",
    ] {
        let es = PathBuf::from(dir).join("es.exe");
        if es.exists() {
            return Some(es);
        }
    }
    None
}

// ── 进程快照：找 Everything.exe 所在目录 ──

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

fn find_everything_exe_dir() -> Option<PathBuf> {
    let snap = unsafe { CreateToolhelp32Snapshot(2, 0) };
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
                    let hp = OpenProcess(0x1000, 0, pe.th32ProcessID);
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

// ── 注册表 ──

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hKey: isize, lpSubKey: *const u16, ulOptions: u32, samDesired: u32,
        phkResult: *mut isize,
    ) -> i32;
    fn RegQueryValueExW(
        hKey: isize, lpValueName: *const u16, lpReserved: *mut std::ffi::c_void,
        lpType: *mut u32, lpData: *mut u8, lpcbData: *mut u32,
    ) -> i32;
    fn RegCloseKey(hKey: isize) -> i32;
}

const HKEY_CURRENT_USER: isize = -0x7FFFFFFF - 1 + 1;
const HKEY_LOCAL_MACHINE: isize = -0x7FFFFFFF - 1 + 2;
const KEY_READ: u32 = 0x20019;
const ERROR_SUCCESS: i32 = 0;

fn reg_install_path(hkey: isize) -> Option<PathBuf> {
    let mut key: isize = 0;
    let sub: Vec<u16> = "SOFTWARE\\Everything"
        .encode_utf16().chain(std::iter::once(0)).collect();
    let ret = unsafe { RegOpenKeyExW(hkey, sub.as_ptr(), 0, KEY_READ, &mut key) };
    if ret != ERROR_SUCCESS || key == 0 { return None; }
    let val: Vec<u16> = "InstallLocation"
        .encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 520];
    let mut buf_len: u32 = (buf.len() * 2) as u32;
    let ret = unsafe {
        RegQueryValueExW(key, val.as_ptr(), std::ptr::null_mut(),
            std::ptr::null_mut(), buf.as_mut_ptr() as *mut u8, &mut buf_len)
    };
    unsafe { RegCloseKey(key) };
    if ret != ERROR_SUCCESS { return None; }
    let char_len = (buf_len as usize / 2).min(buf.len() - 1);
    buf.truncate(char_len);
    String::from_utf16(&buf).ok().map(PathBuf::from)
}
