use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 应用列表缓存（进程生命周期内只扫描一次）
static APP_CACHE: OnceLock<Mutex<Option<Vec<AppInfo>>>> = OnceLock::new();

/// 应用信息
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    /// base64 编码的 PNG 图标（data URL 格式）
    pub icon: Option<String>,
}

// ── Windows API FFI ────────────────────────────────────────

#[link(name = "shell32")]
extern "system" {
    fn ExtractIconExW(
        lpszFile: *const u16,
        nIconIndex: i32,
        phiconLarge: *mut isize,
        phiconSmall: *mut isize,
        nIcons: u32,
    ) -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn DestroyIcon(hIcon: isize) -> i32;
    fn GetIconInfo(hIcon: isize, piconinfo: *mut ICONINFO) -> i32;
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
}

#[repr(C)]
#[allow(non_snake_case)] // 镜像 Win32 ICONINFO 字段名
struct ICONINFO {
    fIcon: i32,
    xHotspot: u32,
    yHotspot: u32,
    hbmMask: isize,
    hbmColor: isize,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(non_snake_case)] // 镜像 Win32 BITMAPINFOHEADER 字段名
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

// ── 主逻辑 ─────────────────────────────────────────────────

/// 扫描开始菜单（带缓存：第一次完整扫描，后续直接返回缓存）
#[tauri::command]
pub fn scan_start_menu() -> Vec<AppInfo> {
    let cache = APP_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap();
    if let Some(ref apps) = *guard {
        return apps.clone();
    }
    // 首次扫描
    let apps = do_scan();
    *guard = Some(apps.clone());
    apps
}

/// 强制刷新应用列表（重新扫描开始菜单）
#[tauri::command]
pub fn refresh_apps() -> Vec<AppInfo> {
    let cache = APP_CACHE.get_or_init(|| Mutex::new(None));
    let apps = do_scan();
    *cache.lock().unwrap() = Some(apps.clone());
    apps
}

/// 实际扫描逻辑
fn do_scan() -> Vec<AppInfo> {
    let mut apps: Vec<AppInfo> = Vec::new();

    let dirs = vec![
        PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu"),
        PathBuf::from(
            std::env::var("APPDATA")
                .unwrap_or_default()
                .replace("Roaming", "Roaming\\Microsoft\\Windows\\Start Menu"),
        ),
    ];

    for dir in &dirs {
        if !dir.exists() {
            continue;
        }
        let entries: Vec<_> = walkdir::WalkDir::new(dir)
            .max_depth(5)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .map(|ext| ext.eq_ignore_ascii_case("lnk"))
                        .unwrap_or(false)
            })
            .collect();

        // 只取前 30 个（性能考虑）
        for entry in entries.into_iter().take(30) {
            if let Ok(lnk) = parselnk::Lnk::try_from(entry.path()) {
                let name = entry
                    .path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "未知应用".to_string());

                let target_str = match lnk.relative_path() {
                    Some(p) => p.to_string_lossy().to_string(),
                    None => continue,
                };

                if target_str.is_empty() {
                    continue;
                }

                // 尝试提取图标
                let icon = extract_icon_base64(&target_str);

                apps.push(AppInfo {
                    name,
                    path: target_str,
                    icon,
                });

                if apps.len() >= 30 {
                    break;
                }
            }
        }
    }

    // 按名称排序
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    // 同名去重
    apps.dedup_by(|a, b| a.path == b.path);

    apps
}

// ── 图标提取 ───────────────────────────────────────────────

fn extract_icon_base64(target: &str) -> Option<String> {
    let wide = str_to_wide(target);

    unsafe {
        let mut small_icon: isize = 0;
        let count = ExtractIconExW(wide.as_ptr(), 0, std::ptr::null_mut(), &mut small_icon, 1);

        if count == 0 || small_icon == 0 {
            return None;
        }

        let result = hicon_to_png(small_icon);
        DestroyIcon(small_icon);
        result
    }
}

fn hicon_to_png(hicon: isize) -> Option<String> {
    unsafe {
        let mut ii = ICONINFO {
            fIcon: 0,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: 0,
            hbmColor: 0,
        };

        if GetIconInfo(hicon, &mut ii) == 0 {
            return None;
        }

        let hdc = CreateCompatibleDC(0);
        if hdc == 0 {
            DeleteObject(ii.hbmColor);
            DeleteObject(ii.hbmMask);
            return None;
        }

        // 获取位图尺寸
        let mut bih = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: 0,
            biHeight: 0,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        let ret = GetDIBits(hdc, ii.hbmColor, 0, 0, std::ptr::null_mut(), &mut bih, DIB_RGB_COLORS);
        let width = bih.biWidth;
        let height = if bih.biHeight < 0 { -bih.biHeight } else { bih.biHeight };

        if width <= 0 || height <= 0 || ret == 0 {
            DeleteDC(hdc);
            DeleteObject(ii.hbmColor);
            DeleteObject(ii.hbmMask);
            return None;
        }

        // 分配缓冲区并读取像素
        let row_size = ((width * 32 + 31) / 32) * 4;
        let buf_size = (row_size * height) as usize;
        let mut pixels: Vec<u8> = vec![0u8; buf_size];

        bih.biHeight = height; // positive = bottom-up

        let ret = GetDIBits(
            hdc,
            ii.hbmColor,
            0,
            height as u32,
            pixels.as_mut_ptr(),
            &mut bih,
            DIB_RGB_COLORS,
        );

        DeleteDC(hdc);
        DeleteObject(ii.hbmColor);
        DeleteObject(ii.hbmMask);

        if ret == 0 {
            return None;
        }

        // BGRA → RGBA 转换
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height as usize {
            let row_start = y * row_size as usize;
            for x in 0..width as usize {
                let off = row_start + x * 4;
                if off + 4 <= pixels.len() {
                    // BGRA → RGBA
                    rgba.push(pixels[off + 2]); // R
                    rgba.push(pixels[off + 1]); // G
                    rgba.push(pixels[off]);     // B
                    rgba.push(pixels[off + 3]); // A
                }
            }
        }

        // 编码为 PNG
        encode_png_base64(width as u32, height as u32, &rgba)
    }
}

// ── PNG 编码（最小实现，不依赖 image crate）────────────────

fn encode_png_base64(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    use std::io::Write;

    // 使用 flate2 压缩（已在依赖树中）
    let mut compressed = Vec::new();
    {
        let mut enc = flate2::write::ZlibEncoder::new(&mut compressed, flate2::Compression::best());
        // 逐行写入，每行前加 filter byte (0 = None)
        let row_bytes = (width * 4) as usize;
        for y in 0..height as usize {
            let start = y * row_bytes;
            let _ = enc.write_all(&[0u8]); // filter: none
            let _ = enc.write_all(&rgba[start..start + row_bytes]);
        }
        let _ = enc.finish();
    }

    // 构建 PNG 文件
    let mut png = Vec::new();

    // PNG signature
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk
    let mut ihdr_data = Vec::new();
    ihdr_data.extend_from_slice(&width.to_be_bytes());
    ihdr_data.extend_from_slice(&height.to_be_bytes());
    ihdr_data.extend_from_slice(&[8u8, 6, 0, 0, 0]); // bit depth=8, color type=6(RGBA), compression/filter/interlace=0
    write_png_chunk(&mut png, b"IHDR", &ihdr_data);

    // IDAT chunk
    write_png_chunk(&mut png, b"IDAT", &compressed);

    // IEND chunk
    write_png_chunk(&mut png, b"IEND", &[]);

    // Base64 编码
    let b64 = base64_encode(&png);
    Some(format!("data:image/png;base64,{b64}"))
}

fn write_png_chunk(buf: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    use std::io::Write;
    let crc = crc32(name, data);
    let _ = buf.write_all(&(data.len() as u32).to_be_bytes());
    let _ = buf.write_all(name);
    let _ = buf.write_all(data);
    let _ = buf.write_all(&crc.to_be_bytes());
}

fn crc32(name: &[u8; 4], data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in name.iter().chain(data.iter()) {
        crc ^= b as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        let n = (b0 as u32) << 16 | (b1 as u32) << 8 | b2 as u32;
        result.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// 启动应用程序
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("无法启动应用: {}", e))?;
    Ok(())
}

/// 获取文件/文件夹元信息
#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// 文件类型扩展名（小写），如 "pdf", "docx"
    pub ext: String,
}

#[tauri::command]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let meta = p.metadata().map_err(|e| format!("{}", e))?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    Ok(FileInfo {
        path,
        name,
        is_dir: meta.is_dir(),
        size: meta.len(),
        ext,
    })
}

fn str_to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
