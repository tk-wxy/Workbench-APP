use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static APP_CACHE: OnceLock<Mutex<Option<Vec<AppInfo>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    /// base64 编码的 PNG 图标（data URL 格式）
    pub icon: Option<String>,
}

// ── Windows API FFI ────────────────────────────────────────

/// SHGetFileInfoW 结果结构体
#[repr(C)]
#[allow(non_snake_case)]
struct SHFILEINFOW {
    hIcon: isize,
    iIcon: i32,
    dwAttributes: u32,
    szDisplayName: [u16; 260],
    szTypeName: [u16; 80],
}

const SHGFI_ICON: u32        = 0x0000_0100;
const SHGFI_LARGEICON: u32   = 0x0000_0000; // 32×32，与 SHGFI_ICON 组合
const SHGFI_SYSICONINDEX: u32 = 0x0000_4000; // 返回值为系统图像列表句柄，shfi.iIcon 为下标
const ILD_NORMAL: u32        = 0x0000_0000; // ImageList_GetIcon：不含 overlay mask
const SW_SHOWNORMAL: i32 = 1;

#[repr(C)]
#[allow(non_snake_case)]
struct ICONINFO {
    fIcon: i32,
    xHotspot: u32,
    yHotspot: u32,
    hbmMask: isize,
    hbmColor: isize,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(non_snake_case)]
struct BITMAPINFOHEADER {
    biSize: u32,
    biWidth: i32,
    biHeight: i32,
    biPlanes: u16,
    biBitCount: u16,
    biCompression: u32,
    biSizeImage: u32,
    biXPelsPerMeter: i32,
    biYPelsPerMeter: i32,
    biClrUsed: u32,
    biClrImportant: u32,
}

const DIB_RGB_COLORS: u32 = 0;
const COINIT_APARTMENTTHREADED: u32 = 0x2;

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pvReserved: *const std::ffi::c_void, dwCoInit: u32) -> i32;
    fn CoUninitialize();
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetFileInfoW(
        pszPath: *const u16,
        dwFileAttributes: u32,
        psfi: *mut SHFILEINFOW,
        cbFileInfo: u32,
        uFlags: u32,
    ) -> usize;

    fn ShellExecuteW(
        hwnd: isize,
        lpOperation: *const u16,
        lpFile: *const u16,
        lpParameters: *const u16,
        lpDirectory: *const u16,
        nShowCmd: i32,
    ) -> isize;
}

#[link(name = "user32")]
extern "system" {
    fn DestroyIcon(hIcon: isize) -> i32;
    fn GetIconInfo(hIcon: isize, piconinfo: *mut ICONINFO) -> i32;
}

/// Win32 BITMAP（用 GetObject 查询 HBITMAP 尺寸）
#[repr(C)]
#[allow(non_snake_case)]
struct BITMAP {
    bmType: i32,
    bmWidth: i32,
    bmHeight: i32,
    bmWidthBytes: i32,
    bmPlanes: u16,
    bmBitsPixel: u16,
    bmBits: *mut u8,
}

#[link(name = "comctl32")]
extern "system" {
    // 从系统图像列表取图标；ILD_NORMAL(0) 不含 overlay mask，返回 base icon
    fn ImageList_GetIcon(himl: isize, i: i32, flags: u32) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn GetDIBits(
        hdc: isize,
        hbm: isize,
        start: u32,
        cLines: u32,
        lpvBits: *mut u8,
        lpbmi: *mut BITMAPINFOHEADER,
        usage: u32,
    ) -> i32;
    fn DeleteObject(ho: isize) -> i32;
    fn GetObjectW(h: isize, c: i32, pv: *mut std::ffi::c_void) -> i32;
}

// ── 主逻辑 ─────────────────────────────────────────────────

#[tauri::command]
pub fn scan_start_menu() -> Vec<AppInfo> {
    let cache = APP_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap();
    if let Some(ref apps) = *guard {
        return apps.clone();
    }
    let apps = do_scan();
    *guard = Some(apps.clone());
    apps
}

#[tauri::command]
pub fn refresh_apps() -> Vec<AppInfo> {
    let cache = APP_CACHE.get_or_init(|| Mutex::new(None));
    let apps = do_scan();
    *cache.lock().unwrap() = Some(apps.clone());
    apps
}

fn do_scan() -> Vec<AppInfo> {
    // SHGetFileInfoW 需要 COM（STA），必须在调用线程初始化
    let com_hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };

    let mut apps: Vec<AppInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for dir in scan_dirs() {
        if !dir.exists() {
            continue;
        }
        let entries: Vec<_> = walkdir::WalkDir::new(&dir)
            .max_depth(5)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .map(|x| x.eq_ignore_ascii_case("lnk"))
                        .unwrap_or(false)
            })
            .collect();

        for entry in entries {
            if apps.len() >= 400 {
                break;
            }
            let lnk_path = entry.path();
            let name = match lnk_path.file_stem() {
                Some(s) => s.to_string_lossy().to_string(),
                None => continue,
            };

            if should_skip(&name) || should_skip_by_path(entry.path().to_str().unwrap_or("")) {
                continue;
            }

            // 同名只保留第一个（All Users 目录先扫，优先级更高）
            if !seen.insert(name.to_lowercase()) {
                continue;
            }

            let path_str = lnk_path.to_string_lossy().to_string();
            let icon = extract_icon_base64(&path_str);

            apps.push(AppInfo { name, path: path_str, icon });
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let with_icon = apps.iter().filter(|a| a.icon.is_some()).count();
    println!("[apps] scan done: {} apps, {} with icons", apps.len(), with_icon);
    if com_hr >= 0 { unsafe { CoUninitialize(); } }
    apps
}

fn scan_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // All Users 开始菜单（优先，系统级安装）
    dirs.push(PathBuf::from(
        r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs",
    ));

    // 当前用户开始菜单
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(format!(
            r"{}\Microsoft\Windows\Start Menu\Programs",
            appdata
        )));
    }

    // 当前用户桌面
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(format!(r"{}\Desktop", userprofile)));
    }

    // 公共桌面
    dirs.push(PathBuf::from(r"C:\Users\Public\Desktop"));

    dirs
}

/// 名称关键词黑名单（不区分大小写，contains 匹配）
const SKIP_KEYWORDS: &[&str] = &[
    // 卸载 / 安装辅助（"install " 尾部空格不误伤 "Installer"）
    "uninstall", "uninst", "unistall", "deinstall", "install ",
    // 文档 / 帮助
    "help", "readme", "release notes", "what's new", "changelog",
    "documentation", "user guide", "manual", "tutorial", "module docs", "samples",
    // 链接 / 网站
    "website", "online", "visit ", "访问",
    // 维护 / 许可
    "support", "license", "eula", "more...",
    // 关于 / 更新对话框
    "关于", "检查更新",
    // 中文卸载
    "卸载",
    // Sandboxie 子功能 / 菜单快捷方式
    "在沙盒中运行", "在沙箱中运行", "开始菜单",
];

/// 路径段黑名单——整个目录都是垃圾，直接按路径过滤
const SKIP_PATH_SEGS: &[&str] = &[
    "\\administrative tools\\",    // Windows 系统管理工具（注册表/事件查看器等）
    "\\administrative tools.lnk",  // 该目录本身的快捷方式
    "\\startup\\",                 // 开机自启动目录（非"启动应用"）
    "\\system tools\\",            // 控制面板 / Run / 任务管理器系统目录
    "\\windows kits\\",            // Windows SDK / WDK 工具包
    "\\sdk\\",                     // SDK 参考文档（MSI Afterburner SDK 等）
    "\\visual studio tools\\",     // VS 辅助命令行工具（开发者命令提示符等）
];

fn should_skip(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKIP_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

fn should_skip_by_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    SKIP_PATH_SEGS.iter().any(|seg| lower.contains(seg))
}

// ── 图标提取（SHGFI_SYSICONINDEX + ImageList_GetIcon，无 overlay）──

fn extract_icon_base64(path: &str) -> Option<String> {
    let wide = str_to_wide(path);
    unsafe {
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        // SHGFI_SYSICONINDEX：返回值为系统图像列表句柄（himl），shfi.iIcon 为图标下标。
        // 系统图像列表存 base icon；shortcut overlay 是 Shell 绘制时叠加的，
        // ImageList_GetIcon 用 ILD_NORMAL(0) 取出时不包含任何 overlay mask。
        let himl = SHGetFileInfoW(
            wide.as_ptr(), 0, &mut shfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SYSICONINDEX,
        ) as isize;

        if himl == 0 && shfi.hIcon == 0 { return None; }

        if himl != 0 {
            let clean = ImageList_GetIcon(himl, shfi.iIcon, ILD_NORMAL);
            if clean != 0 {
                if shfi.hIcon != 0 { DestroyIcon(shfi.hIcon); }
                let result = hicon_to_png(clean);
                DestroyIcon(clean);
                if result.is_some() { return result; }
            }
        }

        // Fallback：用 Shell 给的 hIcon（.lnk 带 overlay 箭头，聊胜于无）
        if shfi.hIcon == 0 { return None; }
        let result = hicon_to_png(shfi.hIcon);
        DestroyIcon(shfi.hIcon);
        result
    }
}

fn hicon_to_png(hicon: isize) -> Option<String> {
    unsafe {
        let mut ii: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut ii) == 0 { return None; }
        if ii.hbmColor == 0 { DeleteObject(ii.hbmMask); return None; }

        let hdc = CreateCompatibleDC(0);
        if hdc == 0 { DeleteObject(ii.hbmColor); DeleteObject(ii.hbmMask); return None; }

        // GetObject 获取尺寸（GetDIBits cLines=0 在此系统不填 biWidth/biHeight）
        let mut bm: BITMAP = std::mem::zeroed();
        let go_ret = GetObjectW(
            ii.hbmColor,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut BITMAP as *mut std::ffi::c_void,
        );
        let width = bm.bmWidth;
        let height = bm.bmHeight;
        if go_ret == 0 || width <= 0 || height <= 0 {
            DeleteDC(hdc); DeleteObject(ii.hbmColor); DeleteObject(ii.hbmMask);
            return None;
        }

        let mut bih: BITMAPINFOHEADER = std::mem::zeroed();
        bih.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bih.biWidth = width;
        bih.biHeight = -height; // top-down，行序与 PNG 一致
        bih.biPlanes = 1;
        bih.biBitCount = 32;
        bih.biCompression = 0; // BI_RGB

        let row_size = ((width * 32 + 31) / 32) * 4;
        let mut pixels = vec![0u8; (row_size * height) as usize];
        let p_ret = GetDIBits(hdc, ii.hbmColor, 0, height as u32, pixels.as_mut_ptr(), &mut bih, DIB_RGB_COLORS);
        DeleteDC(hdc); DeleteObject(ii.hbmColor); DeleteObject(ii.hbmMask);
        if p_ret == 0 { return None; }

        // BGRA → RGBA
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height as usize {
            let rs = y * row_size as usize;
            for x in 0..width as usize {
                let o = rs + x * 4;
                if o + 4 <= pixels.len() {
                    rgba.push(pixels[o + 2]);
                    rgba.push(pixels[o + 1]);
                    rgba.push(pixels[o]);
                    rgba.push(pixels[o + 3]);
                }
            }
        }
        encode_png_base64(width as u32, height as u32, &rgba)
    }
}

// ── PNG 编码 ───────────────────────────────────────────────

fn encode_png_base64(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    use std::io::Write;

    let mut compressed = Vec::new();
    {
        let mut enc = flate2::write::ZlibEncoder::new(&mut compressed, flate2::Compression::best());
        let row_bytes = (width * 4) as usize;
        for y in 0..height as usize {
            let start = y * row_bytes;
            let _ = enc.write_all(&[0u8]);
            let _ = enc.write_all(&rgba[start..start + row_bytes]);
        }
        let _ = enc.finish();
    }

    let mut png = Vec::new();
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8u8, 6, 0, 0, 0]);
    write_png_chunk(&mut png, b"IHDR", &ihdr);
    write_png_chunk(&mut png, b"IDAT", &compressed);
    write_png_chunk(&mut png, b"IEND", &[]);

    Some(format!("data:image/png;base64,{}", base64_encode(&png)))
}

fn write_png_chunk(buf: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    use std::io::Write;
    let _ = buf.write_all(&(data.len() as u32).to_be_bytes());
    let _ = buf.write_all(name);
    let _ = buf.write_all(data);
    let _ = buf.write_all(&crc32(name, data).to_be_bytes());
}

fn crc32(name: &[u8; 4], data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in name.iter().chain(data.iter()) {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn base64_encode(data: &[u8]) -> String {
    const C: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut r = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        let n = (b0 as u32) << 16 | (b1 as u32) << 8 | b2 as u32;
        r.push(C[((n >> 18) & 0x3F) as usize] as char);
        r.push(C[((n >> 12) & 0x3F) as usize] as char);
        r.push(if chunk.len() > 1 { C[((n >> 6) & 0x3F) as usize] as char } else { '=' });
        r.push(if chunk.len() > 2 { C[(n & 0x3F) as usize] as char } else { '=' });
    }
    r
}

// ── 应用启动（ShellExecuteW，支持 .lnk 和 .exe）──────────

#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    let file = str_to_wide(&path);
    let verb = str_to_wide("open");
    unsafe {
        let ret = ShellExecuteW(
            0,
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        if ret as i32 <= 32 {
            return Err(format!("ShellExecuteW failed: {}", ret as i32));
        }
    }
    Ok(())
}

// ── 文件信息 ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub ext: String,
}

#[tauri::command]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let meta = p.metadata().map_err(|e| format!("{}", e))?;
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    Ok(FileInfo { path, name, is_dir: meta.is_dir(), size: meta.len(), ext })
}

fn str_to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
