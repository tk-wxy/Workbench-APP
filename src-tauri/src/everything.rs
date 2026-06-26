// Everything 搜索引擎集成（IPC 窗口消息协议）。
//
// 通过 SendMessage(WM_COPYDATA) 直接与 Everything 进程通信。
// 零外部依赖，适用于所有版本（安装版/便携版），只需 Everything 正在运行。

use std::path::PathBuf;

#[link(name = "user32")]
extern "system" {
    fn RegisterWindowMessageW(lpString: *const u16) -> u32;
    fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> isize;
    fn SendMessageW(hWnd: isize, Msg: u32, wParam: usize, lParam: isize) -> isize;
    fn GetWindowThreadProcessId(hWnd: isize, lpdwProcessId: *mut u32) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
    fn CloseHandle(hObject: isize) -> i32;
    fn VirtualAllocEx(hProcess: isize, lpAddress: isize, dwSize: usize, flAllocationType: u32, flProtect: u32) -> isize;
    fn VirtualFreeEx(hProcess: isize, lpAddress: isize, dwSize: usize, dwFreeType: u32) -> i32;
    fn WriteProcessMemory(hProcess: isize, lpBaseAddress: isize, lpBuffer: *const u8, nSize: usize, lpNumberOfBytesWritten: *mut usize) -> i32;
    fn ReadProcessMemory(hProcess: isize, lpBaseAddress: isize, lpBuffer: *mut u8, nSize: usize, lpNumberOfBytesRead: *mut usize) -> i32;
    fn QueryFullProcessImageNameW(hProcess: isize, dwFlags: u32, lpExeName: *mut u16, lpdwSize: *mut u32) -> i32;
}

const WM_COPYDATA: u32 = 0x004A;
const MEM_COMMIT: u32 = 0x1000;
const MEM_RELEASE: u32 = 0x8000;
const PAGE_READWRITE: u32 = 0x04;
const PROCESS_VM_OPERATION: u32 = 0x0008;
const PROCESS_VM_READ: u32 = 0x0010;
const PROCESS_VM_WRITE: u32 = 0x0020;

// Everything IPC 命令码
const IPC_SET_SEARCH: usize = 1;
const IPC_GET_NUM_FILES: usize = 0x105;
const IPC_GET_NUM_FOLDERS: usize = 0x104;
const IPC_GET_RESULT_PATH: usize = 0x10C;
const IPC_GET_RESULT_FILENAME: usize = 0x10D;

pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_dir: bool,
}

pub struct EverythingClient {
    hwnd: isize,
    pid: u32,
    hproc: isize,
    ipc_msg: u32,
}

unsafe impl Send for EverythingClient {}
unsafe impl Sync for EverythingClient {}

impl EverythingClient {
    pub fn try_connect() -> Option<Self> {
        // 注册 IPC 消息
        let ipc_name: Vec<u16> = "EVERYTHING_IPC\0".encode_utf16().collect();
        let ipc_msg = unsafe { RegisterWindowMessageW(ipc_name.as_ptr()) };
        if ipc_msg == 0 {
            eprintln!("[everything] RegisterWindowMessage failed");
            return None;
        }

        // 找 Everything 窗口
        let cls: Vec<u16> = "EVERYTHING_TASKBAR_NOTIFICATION\0".encode_utf16().collect();
        let hwnd = unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) };
        if hwnd == 0 {
            eprintln!("[everything] Everything window not found");
            return None;
        }

        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let hproc = unsafe { OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, 0, pid) };
        if hproc == 0 {
            eprintln!("[everything] OpenProcess failed pid={pid}");
            return None;
        }

        eprintln!("[everything] IPC connected hwnd={hwnd} pid={pid} msg={ipc_msg}");
        Some(Self { hwnd, pid, hproc, ipc_msg })
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<EverythingResult> {
        if query.trim().is_empty() { return Vec::new(); }

        // 1) 发送搜索查询
        self.ipc_write_command(IPC_SET_SEARCH, query.as_bytes());

        // 2) 取结果数量
        let nf = self.ipc_read_u32(IPC_GET_NUM_FILES);
        let nd = self.ipc_read_u32(IPC_GET_NUM_FOLDERS);
        let total = (nf + nd) as usize;
        if total == 0 { return Vec::new(); }

        // 3) 取每条结果
        let cap = limit.min(total).min(50);
        let mut out = Vec::with_capacity(cap);
        for i in 0..total {
            if out.len() >= limit { break; }
            let path = self.ipc_read_result_string(IPC_GET_RESULT_PATH, i);
            let name = self.ipc_read_result_string(IPC_GET_RESULT_FILENAME, i);
            if path.is_empty() && name.is_empty() { continue; }
            let full = if path.is_empty() { name.clone() }
                else if name.is_empty() { path.clone() }
                else { format!("{}\\{}", path.trim_end_matches('\\'), name) };
            let ext = std::path::Path::new(&name).extension()
                .and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            out.push(EverythingResult { path: full, name, ext, is_dir: false });
        }
        out
    }

    /// 发送命令（仅写入，无返回值）。
    fn ipc_write_command(&self, cmd: usize, data: &[u8]) {
        let remote = self.alloc(data.len().max(1));
        if remote == 0 { return; }
        unsafe { WriteProcessMemory(self.hproc, remote, data.as_ptr(), data.len(), std::ptr::null_mut()) };
        let cds = CopyData { dwData: cmd, cbData: data.len() as u32, lpData: remote };
        unsafe { SendMessageW(self.hwnd, WM_COPYDATA, 0, &cds as *const _ as isize) };
        unsafe { VirtualFreeEx(self.hproc, remote, 0, MEM_RELEASE) };
    }

    /// 查询 u32：Everything 将结果写到远程缓冲区，我们读回。
    fn ipc_read_u32(&self, cmd: usize) -> u32 {
        let remote = self.alloc(4);
        if remote == 0 { return 0; }
        let zero: [u8; 4] = [0; 4];
        unsafe { WriteProcessMemory(self.hproc, remote, zero.as_ptr(), 4, std::ptr::null_mut()) };
        let cds = CopyData { dwData: cmd, cbData: 4, lpData: remote };
        unsafe { SendMessageW(self.hwnd, WM_COPYDATA, 0, &cds as *const _ as isize) };
        let mut buf = [0u8; 4];
        unsafe { ReadProcessMemory(self.hproc, remote, buf.as_mut_ptr(), 4, std::ptr::null_mut()) };
        unsafe { VirtualFreeEx(self.hproc, remote, 0, MEM_RELEASE) };
        u32::from_ne_bytes(buf)
    }

    /// 查询字符串结果：wParam=索引，结果写到远程缓冲区。
    fn ipc_read_result_string(&self, cmd: usize, index: usize) -> String {
        let cap = 520 * 2; // 520 wchars
        let remote = self.alloc(cap);
        if remote == 0 { return String::new() };
        // 零填缓冲区
        let zeros = vec![0u8; cap];
        unsafe { WriteProcessMemory(self.hproc, remote, zeros.as_ptr(), cap, std::ptr::null_mut()) };
        let cds = CopyData { dwData: cmd, cbData: cap as u32, lpData: remote };
        unsafe { SendMessageW(self.hwnd, WM_COPYDATA, index, &cds as *const _ as isize) };
        let mut buf = vec![0u16; cap / 2];
        unsafe { ReadProcessMemory(self.hproc, remote, buf.as_mut_ptr() as *mut u8, cap, std::ptr::null_mut()) };
        unsafe { VirtualFreeEx(self.hproc, remote, 0, MEM_RELEASE) };
        String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string()
    }

    fn alloc(&self, size: usize) -> isize {
        unsafe { VirtualAllocEx(self.hproc, 0, size.max(1), MEM_COMMIT, PAGE_READWRITE) }
    }
}

impl Drop for EverythingClient {
    fn drop(&mut self) {
        if self.hproc != 0 { unsafe { CloseHandle(self.hproc) }; }
    }
}

#[repr(C)]
#[allow(non_snake_case)]
struct CopyData { dwData: usize, cbData: u32, lpData: isize }

/// 诊断用：返回 Everything.exe 路径。
pub fn find_everything_dll() -> Option<PathBuf> {
    let cls: Vec<u16> = "EVERYTHING_TASKBAR_NOTIFICATION\0".encode_utf16().collect();
    let hwnd = unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) };
    if hwnd == 0 { return None; }
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    let hp = unsafe { OpenProcess(0x1000, 0, pid) };
    if hp == 0 { return None; }
    let mut buf = vec![0u16; 520];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(hp, 0, buf.as_mut_ptr(), &mut len) };
    unsafe { CloseHandle(hp) };
    if ok == 0 { return None; }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]).trim_end_matches('\0')))
}
