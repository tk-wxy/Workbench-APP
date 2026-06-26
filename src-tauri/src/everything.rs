// Everything 搜索引擎集成（es.exe 命令行工具）。
//
// 通过 Everything 自带的 es.exe 执行搜索，解析输出。
// 如果 es.exe 不存在，返回清晰的错误提示指引用户下载。
//
// es.exe 下载：https://www.voidtools.com/downloads/ → "Command-line Interface"

use std::path::PathBuf;
use std::process::Command;

pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

pub struct EverythingClient {
    es_path: PathBuf,
}

unsafe impl Send for EverythingClient {}
unsafe impl Sync for EverythingClient {}

impl EverythingClient {
    pub fn try_connect() -> Option<Self> {
        let es = find_es_exe()?;
        // 验证 es.exe 可执行（-h 输出帮助，不依赖 Everything 是否运行）
        match Command::new(&es).arg("-h").output() {
            Ok(o) if o.status.success() => {
                eprintln!("[everything] es.exe OK: {}", es.display());
                Some(Self { es_path: es })
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                eprintln!("[everything] es.exe -h failed: status={} stderr={}", o.status, stderr.trim());
                None
            }
            Err(e) => {
                eprintln!("[everything] es.exe spawn error: {e}");
                None
            }
        }
    }

    pub fn search(&self, query: &str, _limit: usize) -> Vec<EverythingResult> {
        let q = query.trim();
        if q.is_empty() { return Vec::new(); }
        // -n 500 让 es.exe 搜到即停，够用且不卡；500 行 ANSI 转换微秒级。
        let output = match Command::new(&self.es_path)
            .arg("-n").arg("500")
            .arg(q)
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[everything] es.exe search spawn: {e}");
                return Vec::new();
            }
        };
        if !output.status.success() {
            eprintln!("[everything] es.exe search exit={} stderr={}", output.status, String::from_utf8_lossy(&output.stderr).trim());
            return Vec::new();
        }
        // es.exe 输出使用系统 ANSI 编码（中文 Windows = GBK），不能用 from_utf8_lossy
        let text = ansi_to_utf8(&output.stdout);
        let results: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        eprintln!("[everything] query=\"{}\" → {} results", q, results.len());
        results
            .into_iter()
            .map(|path| {
                let p = std::path::Path::new(path);
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string();
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                EverythingResult { path: path.to_string(), name, ext, is_dir: false }
            })
            .collect()
    }
}

/// 查找 es.exe：Everything 进程同目录 → 注册表 → 常见路径。
pub fn find_everything_dll() -> Option<PathBuf> { find_es_exe() }

/// 公开：获取 Everything 安装目录（给前端「打开目录」按钮用）。
pub fn find_everything_exe_dir_pub() -> Option<PathBuf> { find_everything_exe_dir() }

fn find_es_exe() -> Option<PathBuf> {
    // 1) Everything 进程同目录
    if let Some(exe_dir) = find_everything_exe_dir() {
        eprintln!("[everything] exe dir: {}", exe_dir.display());
        let es = exe_dir.join("es.exe");
        if es.exists() { return Some(es); }
    }
    // 2) 注册表
    for hkey in &[HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Some(p) = reg_install_path(*hkey) {
            let es = p.join("es.exe");
            if es.exists() { return Some(es); }
        }
    }
    // 3) 常见路径
    for dir in &[
        r"C:\Program Files\Everything",
        r"C:\Program Files (x86)\Everything",
        r"D:\Program Files\Everything",
    ] {
        let es = PathBuf::from(dir).join("es.exe");
        if es.exists() { return Some(es); }
    }
    None
}

// ── 进程快照 ──

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

// ── 注册表 ──

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(hKey: isize, lpSubKey: *const u16, ulOptions: u32, samDesired: u32, phkResult: *mut isize) -> i32;
    fn RegQueryValueExW(hKey: isize, lpValueName: *const u16, lpReserved: *mut std::ffi::c_void, lpType: *mut u32, lpData: *mut u8, lpcbData: *mut u32) -> i32;
    fn RegCloseKey(hKey: isize) -> i32;
}

const HKEY_CURRENT_USER: isize = -0x7FFFFFFF - 1 + 1;
const HKEY_LOCAL_MACHINE: isize = -0x7FFFFFFF - 1 + 2;
const KEY_READ: u32 = 0x20019;
const ERROR_SUCCESS: i32 = 0;

fn reg_install_path(hkey: isize) -> Option<PathBuf> {
    let mut key: isize = 0;
    let sub: Vec<u16> = "SOFTWARE\\Everything".encode_utf16().chain(std::iter::once(0)).collect();
    if unsafe { RegOpenKeyExW(hkey, sub.as_ptr(), 0, KEY_READ, &mut key) } != ERROR_SUCCESS || key == 0 { return None; }
    let val: Vec<u16> = "InstallLocation".encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 520];
    let mut buf_len: u32 = (buf.len() * 2) as u32;
    let ret = unsafe { RegQueryValueExW(key, val.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut(), buf.as_mut_ptr() as *mut u8, &mut buf_len) };
    unsafe { RegCloseKey(key) };
    if ret != ERROR_SUCCESS { return None; }
    let clen = (buf_len as usize / 2).min(buf.len() - 1);
    buf.truncate(clen);
    String::from_utf16(&buf).ok().map(PathBuf::from)
}

// ── 编码：ANSI（系统代码页，中文 Win=GBK）→ UTF-8 ──

#[link(name = "kernel32")]
extern "system" {
    fn MultiByteToWideChar(
        CodePage: u32, dwFlags: u32, lpMultiByteStr: *const u8,
        cbMultiByte: i32, lpWideCharStr: *mut u16, cchWideChar: i32,
    ) -> i32;
}

const CP_ACP: u32 = 0; // 系统默认 ANSI 代码页

fn ansi_to_utf8(bytes: &[u8]) -> String {
    if bytes.is_empty() { return String::new(); }
    unsafe {
        // 先取所需宽字符长度
        let wlen = MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if wlen <= 0 { return String::from_utf8_lossy(bytes).to_string(); }
        let mut wide = vec![0u16; wlen as usize];
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), wlen);
        String::from_utf16_lossy(&wide)
    }
}
