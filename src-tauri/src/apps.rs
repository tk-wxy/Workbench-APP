use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static APP_CACHE: OnceLock<Mutex<Option<Vec<AppInfo>>>> = OnceLock::new();

// ── 中转区图片缩略图落盘缓存（续99c：重启秒开）──
/// 缓存目录（app_data/stage_thumbs），setup 时 init_thumb_cache 设定；未设定时降级为纯内存生成（不落盘）。
static STAGE_THUMB_DIR: OnceLock<PathBuf> = OnceLock::new();
const STAGE_THUMB_MAX_DIM: u32 = 160; // 卡片显示 72px，@2x DPI ≈ 144，取 160 留余量
/// 剪贴板列表缩略图边长（性能优化步骤1）。剪贴板卡片比中转 72px 卡片宽（`.clip-image` width:100%/
/// max-height:120px），故取高于 stage 的 160。1024→400 使解码位图/GPU 纹理面积降到 ≈1/7
/// （1024²≈1.05M px → 400²≈160K px），这是 GPU 进程内存膨胀（80→864MB 实测）的主因。调大=更清晰更费显存。
/// 改这个常量会自动失效旧缓存（下方缓存文件名含本值），无需手动清 stage_thumbs/。
const CLIP_THUMB_MAX_DIM: u32 = 400;
const STAGE_THUMB_CACHE_MAX_BYTES: u64 = 50 * 1024 * 1024; // 缓存目录总量上限 50MB，超出从最旧删
const STAGE_THUMB_SWEEP_INITIAL_MS: u64 = 8_000;   // 起手延迟错开 setup
const STAGE_THUMB_SWEEP_MS: u64 = 30 * 60 * 1000;  // 之后每 30 分钟 sweep 一次

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    /// base64 编码的 PNG 图标（data URL 格式）
    pub icon: Option<String>,
    /// 是否为 UWP / Packaged App（续125）。true 时 `path` 不是文件系统路径而是
    /// `shell:AppsFolder\<AUMID>` —— 它只对 ShellExecuteW 有意义，
    /// 「打开所在目录」「复制到剪贴板」这类按真实路径办事的操作对它无效，前端须据此置灰。
    pub packaged: bool,
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

// ── Jumbo（256px）图标：预览面板的「大图标」用（续115）──
// SHGFI_LARGEICON 只有 32px，放进预览放大 3 倍会糊（@200%DPI 尤其明显）。
// 系统图像列表另有 SHIL_JUMBO 一档（256px），即 Explorer「超大图标」视图所用。
// 取法：先用 SHGFI_SYSICONINDEX 拿到图标在系统列表里的下标 iIcon（与档位无关），
// 再向 SHGetImageList 要 JUMBO 档的列表句柄，用同一个 iIcon 取出大图。
const SHIL_JUMBO: i32 = 0x4;

/// 预览大图标从 JUMBO 256px 缩到此上限再返回（续136 内存优化）。
///
/// 预览面板显示 88px(CSS)，@200%DPI = 176 物理像素——256px 是**过采样**。
/// 缩到 192px（覆盖到 ~218% DPI 仍不糊，而本机 200% 下 192 > 176 = 略上采样、绝对清晰），
/// renderer 里每张已解码位图 256²→192²（省 ~43%）、base64 体积也随之变小。
/// **只作用于大图标路径**（extract_large_icon_base64 → Some）；32px 小图标 / UWP 磁贴传 None、不缩。
const PREVIEW_ICON_MAX: u32 = 192;

#[repr(C)]
struct GUID { data1: u32, data2: u16, data3: u16, data4: [u8; 8] }
// IID_IImageList {46EB5926-582E-4017-9FDF-E8998DAA0950}
const IID_IIMAGELIST: GUID = GUID {
    data1: 0x46EB_5926, data2: 0x582E, data3: 0x4017,
    data4: [0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50],
};

#[link(name = "shell32")]
extern "system" {
    // 返回的 IImageList* 可直接当 HIMAGELIST 传给 ImageList_GetIcon（Windows 上两者可互换，
    // 是既有的通行做法）；故此处只当不透明句柄用，不做任何 COM 方法调用。
    fn SHGetImageList(iImageList: i32, riid: *const GUID, ppv: *mut isize) -> i32;
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
    let apps = do_scan(|_| {});
    *guard = Some(apps.clone());
    apps
}

/// 两段式扫描（续128）：`.lnk` 那批一扫完就先回调一次，之后才去枚举 UWP。
///
/// 起因是续125 把 UWP 枚举串在 `.lnk` 之后，实测 +1.94s ——`apps-ready` 整体晚到约 2 秒，
/// 而那 2 秒里 `.lnk` 那批（占绝大多数、且是用户最常用的）其实早就备好了，干等没有意义。
/// 后台 worker 用它先把第一批送给前端渲染，UWP 扫完再补发一次完整列表。
///
/// 命中缓存时**不回调**：此时无需分段，调用方直接拿到完整列表。
pub fn scan_start_menu_staged(on_partial: impl FnOnce(&[AppInfo])) -> Vec<AppInfo> {
    let cache = APP_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap();
    if let Some(ref apps) = *guard {
        return apps.clone();
    }
    let apps = do_scan(on_partial);
    *guard = Some(apps.clone());
    apps
}

fn do_scan(on_partial: impl FnOnce(&[AppInfo])) -> Vec<AppInfo> {
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
            if apps.len() >= MAX_APPS {
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

            apps.push(AppInfo { name, path: path_str, icon, packaged: false });
        }
    }

    // 续128：.lnk 这批已备好，先交出去（UWP 枚举还要约 2 秒，没必要让前端干等）。
    // 排序放在这里而不是只在末尾做一次——半成品也得是按名字排好的，否则前端先渲染出一个
    // 乱序列表、2 秒后又整个重排，比晚 2 秒更难看。
    sort_by_name(&mut apps);
    on_partial(&apps);

    // UWP / Packaged Apps（续125）。放在 .lnk 之后：`seen` 已被 .lnk 填过，
    // 同名冲突时保留 .lnk 那条 —— 它的 path 是真实文件路径，能力严格更强（可 reveal、可复制）。
    let packaged_count = if apps.len() < MAX_APPS {
        let before = apps.len();
        for app in scan_packaged_apps() {
            if apps.len() >= MAX_APPS {
                break;
            }
            if should_skip(&app.name) {
                continue;
            }
            if !seen.insert(app.name.to_lowercase()) {
                continue;
            }
            apps.push(app);
        }
        apps.len() - before
    } else {
        0
    };

    sort_by_name(&mut apps);
    let with_icon = apps.iter().filter(|a| a.icon.is_some()).count();
    println!(
        "[apps] scan done: {} apps ({} packaged), {} with icons",
        apps.len(), packaged_count, with_icon
    );
    if com_hr >= 0 { unsafe { CoUninitialize(); } }
    apps
}

/// 应用列表总条数上限（.lnk + UWP 合计）。续125 前是硬编码 400 且只有 .lnk 一路。
const MAX_APPS: usize = 600;

/// 按名字（不区分大小写）排序。续128 起要排两次——半成品交出去前一次、补完 UWP 后一次，
/// 故抽成函数，避免两处规则各写一遍将来改歪。
fn sort_by_name(apps: &mut [AppInfo]) {
    apps.sort_by_key(|a| a.name.to_lowercase());
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

// ── UWP / Packaged Apps（续125）────────────────────────────
//
// 背景：UWP 应用不是 .lnk，开始菜单目录里根本没有它们的文件，所以 `scan_start_menu`
// 从来看不到「计算器」「设置」「照片」这些 Windows 自带应用。Windows 自己的搜索能搜到，
// 靠的是 shell 命名空间里的虚拟文件夹 `shell:AppsFolder`。
//
// 三点与 .lnk 路线的本质差异：
// ① 没有文件路径 —— 标识是 AUMID（`PackageFamilyName!AppId`），
//    我们存成 `shell:AppsFolder\<AUMID>` 交给 ShellExecuteW（免去引 IApplicationActivationManager）。
// ② 图标取不到 —— SHGetFileInfoW 对 AUMID 无从下手，得走 IShellItemImageFactory 拿磁贴图。
// ③ 这两点合起来意味着 `AppInfo.packaged=true` 的条目**没有真实路径**，
//    前端凡是按路径办事的操作都要屏蔽（见 AppInfo.packaged 注释）。

/// UWP 磁贴图标的取图尺寸。列表里显示 32~48px，取 64 给高 DPI 留余量；
/// 配 SIIGBF_BIGGERSIZEOK 允许 shell 返回更大的原生尺寸（不放大糊图）。
const PACKAGED_ICON_PX: i32 = 64;

/// 枚举 `shell:AppsFolder` 里的 Packaged App。
///
/// ⚠️ 要求调用方已初始化 COM（在 `do_scan` 的 CoInitializeEx 区间内调用）。
/// AppsFolder 里**同时**列着传统 Win32 应用和 UWP，这里只取后者：
/// 前者已由 .lnk 扫描覆盖且信息更全，重复收进来只会制造同名条目。
fn scan_packaged_apps() -> Vec<AppInfo> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::UI::Shell::{
        IEnumShellItems, IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName,
        BHID_EnumItems, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING, SIIGBF_BIGGERSIZEOK,
        SIIGBF_ICONONLY,
    };

    let mut out: Vec<AppInfo> = Vec::new();
    unsafe {
        let wide = str_to_wide("shell:AppsFolder");
        let folder: IShellItem = match SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[apps] AppsFolder 解析失败，跳过 UWP 扫描: {e}");
                return out;
            }
        };
        let items: IEnumShellItems = match folder.BindToHandler(None, &BHID_EnumItems) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("[apps] AppsFolder 枚举器创建失败: {e}");
                return out;
            }
        };

        loop {
            let mut fetched = [None::<IShellItem>; 1];
            let mut got = 0u32;
            if items.Next(&mut fetched, Some(&mut got)).is_err() || got == 0 {
                break;
            }
            let Some(item) = fetched[0].take() else { break };

            // 解析名 = AUMID。取不到就跳过——没有它就没法启动，收进来是个死条目。
            let Some(aumid) = co_string(item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).ok())
            else {
                continue;
            };
            if !is_packaged_aumid(&aumid) {
                continue; // Win32 项，交给 .lnk 扫描
            }
            let Some(name) = co_string(item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()) else {
                continue;
            };

            // 磁贴图标：GetImage 直接给 HBITMAP（没有 HICON 这一层），复用 hbitmap_to_png。
            let icon = item.cast::<IShellItemImageFactory>().ok().and_then(|f| {
                let size = SIZE { cx: PACKAGED_ICON_PX, cy: PACKAGED_ICON_PX };
                let hbm = f.GetImage(size, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK).ok()?;
                let png = hbitmap_to_png(hbm.0 as isize, None);
                DeleteObject(hbm.0 as isize); // GetImage 的 HBITMAP 归调用方所有
                png
            });

            out.push(AppInfo {
                name,
                path: format!("shell:AppsFolder\\{aumid}"),
                icon,
                packaged: true,
            });
        }
    }
    out
}

/// CoTaskMem 分配的宽字符串 → String，顺带释放。GetDisplayName 的返回值必须这样收尾。
fn co_string(p: Option<windows::core::PWSTR>) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    let p = p?;
    if p.is_null() {
        return None;
    }
    let s = unsafe { p.to_string().ok() };
    unsafe { CoTaskMemFree(Some(p.0 as *const std::ffi::c_void)) };
    s.filter(|x| !x.is_empty())
}

/// AUMID 判定：Packaged App 的解析名形如 `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`。
/// AppsFolder 里的 Win32 项解析名是文件路径或 `{GUID}` 形式，靠「有 `!`、且不含路径分隔符/盘符」区分。
fn is_packaged_aumid(s: &str) -> bool {
    s.contains('!') && !s.contains('\\') && !s.contains('/') && !s.contains(':')
}

// ── 图标提取（SHGFI_SYSICONINDEX + ImageList_GetIcon，无 overlay）──

pub fn extract_icon_base64(path: &str) -> Option<String> {
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
                let result = hicon_to_png(clean, None);
                DestroyIcon(clean);
                if result.is_some() { return result; }
            }
        }

        // Fallback：用 Shell 给的 hIcon（.lnk 带 overlay 箭头，聊胜于无）
        if shfi.hIcon == 0 { return None; }
        let result = hicon_to_png(shfi.hIcon, None);
        DestroyIcon(shfi.hIcon);
        result
    }
}

/// 提取大图标（预览面板用）：从 JUMBO 256px 取、缩到 PREVIEW_ICON_MAX(192px) 再返回（续136 省内存）。
/// 失败返回 None，前端回退到既有 32px 图标 / 矢量字形。
/// 与 `extract_icon_base64` **并存而非替换**：列表里几十个 32px 图标够用且省得多，
/// 只有预览这一处需要大图。
pub fn extract_large_icon_base64(path: &str) -> Option<String> {
    let wide = str_to_wide(path);
    unsafe {
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        // 只要下标，不要 SHGFI_ICON（那会额外造一个 32px HICON 还得记着销毁）
        if SHGetFileInfoW(
            wide.as_ptr(), 0, &mut shfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        ) == 0 { return None; }

        let mut himl: isize = 0;
        if SHGetImageList(SHIL_JUMBO, &IID_IIMAGELIST, &mut himl) != 0 || himl == 0 { return None; }

        let hicon = ImageList_GetIcon(himl, shfi.iIcon, ILD_NORMAL);
        if hicon == 0 { return None; }
        let result = hicon_to_png(hicon, Some(PREVIEW_ICON_MAX));
        DestroyIcon(hicon); // 系统列表本身不释放（进程级共享），只销毁取出的副本
        result
    }
}

/// 预览面板取大图标（COM 仅在本次调用线程临时初始化，同 get_file_info）。
#[tauri::command]
pub fn get_large_icon(path: String) -> Option<String> {
    let com_hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };
    let icon = extract_large_icon_base64(&path);
    if com_hr == 0 { unsafe { CoUninitialize(); } }
    icon
}

fn hicon_to_png(hicon: isize, max_dim: Option<u32>) -> Option<String> {
    unsafe {
        let mut ii: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut ii) == 0 { return None; }
        if ii.hbmColor == 0 { DeleteObject(ii.hbmMask); return None; }

        let result = hbitmap_to_png(ii.hbmColor, max_dim);
        DeleteObject(ii.hbmColor);
        DeleteObject(ii.hbmMask);
        result
    }
}

/// 32bpp HBITMAP → base64 PNG data URL。
/// **不接管 hbm 所有权**，调用方负责 DeleteObject。
/// 续125 从 hicon_to_png 中段抽出：UWP 磁贴图标由 IShellItemImageFactory::GetImage 直接给 HBITMAP，
/// 没有 HICON 这一层，两条路复用同一段位图解码。
/// `max_dim=Some(m)`：位图任一边超过 m 时缩到 m 内再编码（续136，仅大图标预览路径用；
/// 小图标/UWP 磁贴传 None 保持原样）。
fn hbitmap_to_png(hbm: isize, max_dim: Option<u32>) -> Option<String> {
    unsafe {
        let hdc = CreateCompatibleDC(0);
        if hdc == 0 { return None; }

        // GetObject 获取尺寸（GetDIBits cLines=0 在此系统不填 biWidth/biHeight）
        let mut bm: BITMAP = std::mem::zeroed();
        let go_ret = GetObjectW(
            hbm,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut BITMAP as *mut std::ffi::c_void,
        );
        let width = bm.bmWidth;
        let height = bm.bmHeight;
        if go_ret == 0 || width <= 0 || height <= 0 {
            DeleteDC(hdc);
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
        let p_ret = GetDIBits(hdc, hbm, 0, height as u32, pixels.as_mut_ptr(), &mut bih, DIB_RGB_COLORS);
        DeleteDC(hdc);
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
        // 续136：大图标路径把过采样的 JUMBO 256px 缩到 max_dim 再编码，省 renderer 解码内存与 base64 体积。
        // Lanczos3 高质量降采样（一次调用/预览，非热路径，画质优先）。from_raw 失败（长度不符，极罕见）
        // → None，前端回退 32px 图标，不 panic。
        if let Some(m) = max_dim {
            let (w, h) = (width as u32, height as u32);
            if w.max(h) > m {
                let src = image::RgbaImage::from_raw(w, h, rgba)?;
                let scale = m as f64 / w.max(h) as f64;
                let nw = ((w as f64 * scale).round() as u32).max(1);
                let nh = ((h as f64 * scale).round() as u32).max(1);
                let dst = image::imageops::resize(&src, nw, nh, image::imageops::FilterType::Lanczos3);
                return encode_png_base64(nw, nh, dst.as_raw());
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
        let mut enc = flate2::write::ZlibEncoder::new(&mut compressed, flate2::Compression::fast());
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
    let mut r = String::with_capacity(data.len().div_ceil(3) * 4);
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

fn stage_thumb_cache_name(path: &str, len: u64, modified: Option<std::time::SystemTime>) -> String {
    let modified_ns = modified
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let hash = crc32(b"THMB", path.as_bytes());
    format!("{hash:08x}_{modified_ns}_{len}.png")
}

// ── 中转区图片缩略图（续99b：解内存/卡顿；续99c：落盘缓存重启秒开）──────────
/// 为中转区的图片文件生成小缩略图（base64 PNG data URL）。
/// 背景：前端若用 asset 协议直接 `<img src=原图>`，WebView 会把每张原图全分辨率解码位图常驻内存
/// （一张 4000×3000 ≈ 48MB），图一多即卡顿 + 内存暴涨。改由此命令在 Rust 侧解码→缩到 ~160px→释放原图，
/// 前端只拿几 KB base64。解码是本次调用内的瞬时开销（返回后 DynamicImage 立即析构），非常驻。
///
/// 续99c 落盘缓存：缓存键 = crc32(路径) + 文件 mtime（源文件被改则键变、自动失效重建）。命中缓存
/// 直接读小 PNG（**零解码原图**）→ 重启后前端逐张 invoke 也只是读几十 KB 小文件，秒开；未命中才解码。
/// 缓存目录未初始化（降级）时退化为纯内存生成、不落盘。失败（文件不存在/非图片/解码错误）返回 Err，
/// 前端回退 emoji 兜底。总量上限由 sweep_stage_thumb_cache 后台管，写路径本身不做清理（同 clip janitor 解耦思路）。
fn get_stage_thumbnail_blocking(path: String) -> Result<String, String> {
    // 源文件的纳秒级 mtime + 长度共同参与缓存身份。旧实现只取整秒，用户在一秒内用另一张图
    // 覆盖同一路径时会命中旧缩略图；加入长度也覆盖“保留时间但尺寸改变”的常见复制工具行为。
    let source_meta = std::fs::metadata(&path).ok();
    let cache_name = stage_thumb_cache_name(
        &path,
        source_meta.as_ref().map_or(0, std::fs::Metadata::len),
        source_meta.as_ref().and_then(|meta| meta.modified().ok()),
    );
    let cache_file = STAGE_THUMB_DIR.get().map(|dir| {
        dir.join(&cache_name)
    });
    // ① 命中磁盘缓存：直接读小 PNG，零解码
    if let Some(cf) = &cache_file {
        if let Ok(bytes) = std::fs::read(cf) {
            return Ok(format!("data:image/png;base64,{}", base64_encode(&bytes)));
        }
    }
    // ② 未命中：解码原图 → 缩略（保持宽高比、仅缩不放）→ PNG
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败: {}", e))?;
    let thumb = img.thumbnail(STAGE_THUMB_MAX_DIM, STAGE_THUMB_MAX_DIM);
    let mut png = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("编码失败: {}", e))?;
    let png_bytes = png.into_inner();
    // ③ 写盘缓存（best-effort：失败仅少一次缓存、不影响本次返回）
    if let Some(cf) = &cache_file {
        let _ = std::fs::write(cf, &png_bytes);
    }
    Ok(format!("data:image/png;base64,{}", base64_encode(&png_bytes)))
}

/// 图片读盘、全分辨率解码、缩放与 PNG 编码都属于阻塞型 CPU/I/O 重活。
/// Tauri 的同步 command 会占住命令调度线程；真机一张高分辨率图片就足以让窗口短时无法响应
/// 热键、关闭和点击。命令入口必须是 async，并把整段冷路径交给 blocking worker。
#[tauri::command]
pub async fn get_stage_thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_stage_thumbnail_blocking(path))
        .await
        .map_err(|e| format!("缩略图任务失败: {e}"))?
}

/// 初始化缩略图落盘缓存：建目录 + 起后台 sweep 线程。setup 时调用一次。
pub(crate) fn init_thumb_cache(data_dir: &std::path::Path) {
    let dir = data_dir.join("stage_thumbs");
    let _ = std::fs::create_dir_all(&dir);
    let _ = STAGE_THUMB_DIR.set(dir);
    // 后台 janitor（仿 clip_images 解耦 sweep）：起手延迟错开 setup，之后周期封顶
    std::thread::spawn(|| {
        let _guard = crate::ThreadExitGuard("stage_thumb_janitor"); // M5-A
        std::thread::sleep(std::time::Duration::from_millis(STAGE_THUMB_SWEEP_INITIAL_MS));
        loop {
            sweep_stage_thumb_cache();
            std::thread::sleep(std::time::Duration::from_millis(STAGE_THUMB_SWEEP_MS));
        }
    });
}

/// 用系统文件管理器打开缩略图缓存目录（stage_thumbs/）。与剪贴板 open_clip_image_dir 对齐。
#[tauri::command]
pub fn open_stage_thumb_dir() -> Result<(), String> {
    let dir = STAGE_THUMB_DIR.get().ok_or_else(|| "缩略图缓存目录未初始化".to_string())?;
    let file = str_to_wide(&dir.to_string_lossy());
    let verb = str_to_wide("open");
    unsafe {
        let ret = ShellExecuteW(0, verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
        if ret as i32 <= 32 { return Err(format!("无法打开目录: {}", ret as i32)); }
    }
    Ok(())
}

/// 删除 stage_thumbs/ 内全部文件（不删目录本身）。与剪贴板 clear_clip_image_cache 对齐。
/// 当前会话前端 stageThumbs 内存缓存仍在（已显示的缩略图不受影响）；重启后按需重新生成并重建磁盘缓存。
#[tauri::command]
pub fn clear_stage_thumb_cache() -> Result<(), String> {
    let Some(dir) = STAGE_THUMB_DIR.get() else { return Ok(()); };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() { let _ = std::fs::remove_file(entry.path()); }
    }
    Ok(())
}

/// 缩略图缓存总量封顶：超 STAGE_THUMB_CACHE_MAX_BYTES 时从最旧（mtime 升序）删到 ≤ 上限。
/// 与 clip 缓存不同：缩略图无 Rust 侧「被引用集」（stage 是前端状态），故不做孤儿清理，纯按容量+时间淘汰
/// （被删的下次呼出会按需重建，非数据丢失）。全程 best-effort，任何 fs 错误跳过、绝不 panic。
fn sweep_stage_thumb_cache() {
    let Some(dir) = STAGE_THUMB_DIR.get() else { return; };
    if !dir.exists() { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let Ok(meta) = entry.metadata() else { continue; };
        let size = meta.len();
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += size;
        files.push((p, size, mtime));
    }
    if total <= STAGE_THUMB_CACHE_MAX_BYTES { return; }
    files.sort_by_key(|(_, _, t)| *t); // 升序：最旧先删
    let mut remaining = total;
    for (p, size, _) in &files {
        if remaining <= STAGE_THUMB_CACHE_MAX_BYTES { break; }
        if std::fs::remove_file(p).is_ok() { remaining = remaining.saturating_sub(*size); }
    }
    eprintln!("[thumb_sweep] 总量封顶：{total} → {remaining} bytes（上限 {STAGE_THUMB_CACHE_MAX_BYTES}）");
}

// ── 启动台资产落盘：图标外置 + 两目录孤儿回收（续146）──────────────────
//
// 背景：`launcher-items` 每条内嵌 base64 图标（≈5.5KB/条），73 条就把 store JSON 撑到 400KB
// ——占整个 store 的 98%。而 plugin-store 的 save() 是**整文件重写**，于是每次拖动中转条目、
// 点固定、改排序都在重写这 400KB，且随收藏数线性变差（200 条上限 → ~1.1MB/次）。
// 修法：图标落成 launcher_icons/ 下的 PNG，JSON 只留文件名；内存态仍带 data URL，渲染层零改动。
//
/// 图标目录：内容寻址（crc32(base64) 命名）→ 同一图标只存一份、重复保存幂等。
static LAUNCHER_ICON_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 图片目录：续143「中转图片项拖进启动台」物化出来的 PNG。**这些是数据本身、不可重建**
/// （截图的唯一副本），删掉即死链——故只做「确证未被引用」的孤儿回收，绝不按容量淘汰。
static LAUNCHER_IMAGE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// store JSON 所在目录（sweep 要从中读「被引用集」）
static LAUNCHER_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
const LAUNCHER_SWEEP_INITIAL_MS: u64 = 12_000;      // 起手延迟错开 setup（晚于 thumb 的 8s）
const LAUNCHER_SWEEP_MS: u64 = 30 * 60 * 1000;      // 之后每 30 分钟一轮
/// **新文件保护期**：Rust 写完图标/图片后，前端要过一小会儿才把文件名写进 store。
/// 这段窗口里文件「看起来没人引用」——保护期内一律不删，否则刚加的收藏图标当场被扫掉。
const LAUNCHER_SWEEP_GRACE_MS: u64 = 30 * 60 * 1000;

/// 中转站图片条目的 base64 内容（`StageItem.content`）落盘目录。**同 launcher_images 一样不可重建**
/// （剪贴板里的截图拖进中转站后，原剪贴板条目可能早已被挤出历史）——只做孤儿回收，绝不容量淘汰。
static STAGE_IMAGE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 把一批 base64（data URL 或裸 base64）落成内容寻址的 PNG，返回各自文件名。
/// 某条失败 → 该位置 None，调用方据此**保留内嵌 base64**（宁可 JSON 大，也不能把图弄丢）。
/// `tag` 参与哈希，只为让不同用途的文件名互不碰撞（各自独立目录，本就不会混）。
fn save_b64_pngs(dir: &std::path::Path, tag: &[u8; 4], data: &[String]) -> Vec<Option<String>> {
    data.iter()
        .map(|data_url| {
            // 入参是 data URL（`data:image/png;base64,xxx`）；容错也接受裸 base64
            let b64 = match data_url.find(',') {
                Some(i) => &data_url[i + 1..],
                None => data_url.as_str(),
            };
            if b64.is_empty() {
                return None;
            }
            let name = format!("{:08x}.png", crc32(tag, b64.as_bytes()));
            let path = dir.join(&name);
            // 内容寻址 → 已存在即同一张图，跳过解码与写盘（幂等，重复 save 近乎零成本）
            if path.exists() {
                return Some(name);
            }
            let bytes = crate::clipboard::base64_decode(b64)?;
            if bytes.is_empty() {
                return None;
            }
            std::fs::write(&path, &bytes).ok()?;
            Some(name)
        })
        .collect()
}

/// 只接受目录内的纯文件名，所有资产读取共用此边界，避免 `../` 跳出应用数据目录。
fn asset_path(dir: &std::path::Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("非法文件名".into());
    }
    Ok(dir.join(file))
}

/// 只读前端当前条目实际引用的 PNG：文件名 → data URL。
/// 旧实现扫描整个目录，孤儿回收线程运行前的历史残留也会进入 IPC 与 JS 堆；选择性读取让
/// 启动峰值和常驻量只与真实条目数相关。
fn load_b64_pngs(dir: &std::path::Path, files: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for name in files {
        let Ok(p) = asset_path(dir, name) else { continue; };
        if let Ok(bytes) = std::fs::read(&p) {
            map.insert(
                name.to_string(),
                format!("data:image/png;base64,{}", base64_encode(&bytes)),
            );
        }
    }
    map
}

/// 启动台图标：批量落盘，返回文件名（失败位 None → 调用方保留内嵌 icon）。
#[tauri::command]
pub fn save_launcher_icons(icons: Vec<String>) -> Vec<Option<String>> {
    match LAUNCHER_ICON_DIR.get() {
        Some(dir) => save_b64_pngs(dir, b"LICO", &icons),
        None => icons.iter().map(|_| None).collect(),
    }
}

/// 启动台图标：只读当前条目实际引用的文件（文件名 → data URL）。
#[tauri::command]
pub fn load_launcher_icons(files: Vec<String>) -> std::collections::HashMap<String, String> {
    LAUNCHER_ICON_DIR.get().map(|d| load_b64_pngs(d, &files)).unwrap_or_default()
}

/// 中转站图片内容：批量落盘，返回文件名（失败位 None → 调用方保留内嵌 content）。
/// 续146b：一条 image 中转条目的 base64 缩略图实测就有 319.9KB，内嵌进 store 会让
/// **每次中转拖动/固定/排序都整文件重写这 300 多 KB**（plugin-store 的 save 是全量重写）。
#[tauri::command]
pub fn save_stage_images(images: Vec<String>) -> Vec<Option<String>> {
    match STAGE_IMAGE_DIR.get() {
        Some(dir) => save_b64_pngs(dir, b"SIMG", &images),
        None => images.iter().map(|_| None).collect(),
    }
}

/// 返回仍存在的中转图片文件名。启动时只做轻量完整性校验，不把图片内容补进 JS state。
#[tauri::command]
pub fn existing_stage_images(files: Vec<String>) -> Vec<String> {
    let Some(dir) = STAGE_IMAGE_DIR.get() else { return Vec::new(); };
    files.into_iter()
        .filter(|file| asset_path(dir, file).is_ok_and(|p| p.is_file()))
        .collect()
}

/// 读取一条中转图片的原始 PNG。拖出路径直接用字节/路径，复制与粘贴才经命令按需转 data URL。
pub(crate) fn read_stage_image_bytes(file: &str) -> Option<Vec<u8>> {
    let dir = STAGE_IMAGE_DIR.get()?;
    let path = asset_path(dir, file).ok()?;
    std::fs::read(path).ok()
}

pub(crate) fn stage_image_path(file: &str) -> Option<PathBuf> {
    let dir = STAGE_IMAGE_DIR.get()?;
    let path = asset_path(dir, file).ok()?;
    path.is_file().then_some(path)
}

#[tauri::command]
pub fn get_stage_image_content(file: String) -> Result<String, String> {
    let bytes = read_stage_image_bytes(&file).ok_or("文件不存在或不可读")?;
    Ok(format!("data:image/png;base64,{}", base64_encode(&bytes)))
}

/// 中转站 image 条目的**小缩略图**（160px，复用 get_stage_thumbnail 的落盘缓存）。
///
/// 续146c：卡片只有 72px，却一直直接把 `content` 那张 **1024px 原图**塞进 `<img>`
/// ——单张解码位图 ≈2.3MB，几张就让拖动掉帧、关闭迟缓。这正是**续99b 给 file 类条目治过的坑**
/// （"WebView 常驻全分辨率解码位图 → 图多即卡顿"），image 类当时治不了：它没有实体文件，
/// 而 `get_stage_thumbnail` 是按路径工作的。续146b 把 content 落成了 stage_images/ 下的 PNG，
/// 这条路才通——于是 image 类终于能复用同一套缩略图机制。
#[tauri::command]
pub async fn get_stage_image_thumb(file: String) -> Result<String, String> {
    let dir = STAGE_IMAGE_DIR.get().ok_or("stage_images 目录未初始化")?;
    let p = asset_path(dir, &file)?;
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    get_stage_thumbnail(p.to_string_lossy().into_owned()).await
}

/// 剪贴板图片条目的**小缩略图**（性能优化步骤1）。
///
/// 剪贴板列表卡片一直直接把 `content`（CLIP_CACHE 里 ≤1024px 的 base64 缩略图）塞进 `<img>`
/// ——单张被 WebView 解码成 ≈4MB GPU 纹理，历史攒满图片时 GPU 进程实测涨到 800MB+。
/// 这正是**续99b（file 类）/ 续146c（image 类中转条目）治过的同一个坑**，剪贴板是漏项。
///
/// 与 stage 不同：剪贴板图源是 base64（大图另有 `orig_path` 实体文件，但小图无实体文件），
/// 故不能走按路径的 `get_stage_thumbnail`。**性能优化步骤2**：改为按 `time` 从 CLIP_CACHE 取 content
/// （前端 image 条目已不再常驻 content），只取 CLIP_CACHE 锁、不碰剪贴板 OS 句柄（不违反 R20）。
/// 复用 `stage_thumbs/` 磁盘缓存（键 = crc32(content)，内容不变则跨会话命中、零解码）与其容量 janitor。
fn get_clip_thumbnail_blocking(time: i64) -> Result<String, String> {
    let content = crate::clipboard::clip_content_by_time(time).ok_or("条目不存在或无内容")?;
    // 接受 data URL（`data:image/png;base64,xxx`）或裸 base64
    let b64 = match content.find(',') {
        Some(i) => &content[i + 1..],
        None => content.as_str(),
    };
    if b64.is_empty() {
        return Err("空内容".into());
    }
    // 缓存键按 content 哈希（content 对某条剪贴板项不可变）+ 缩略尺寸；与 stage 的 path+mtime 键
    // 并存于同一目录，`_clip` 后缀避免与 stage 的 `{hash}_{mtime}.png` 命名撞车。
    // 键含 dim：改 CLIP_THUMB_MAX_DIM 后旧尺寸缓存自动落空、按新尺寸重建。
    let cache_file = STAGE_THUMB_DIR.get().map(|dir| {
        let hash = crc32(b"CTHM", b64.as_bytes());
        dir.join(format!("{:08x}_{}_clip.png", hash, CLIP_THUMB_MAX_DIM))
    });
    // ① 命中磁盘缓存：直接读小 PNG，零解码
    if let Some(cf) = &cache_file {
        if let Ok(bytes) = std::fs::read(cf) {
            return Ok(format!("data:image/png;base64,{}", base64_encode(&bytes)));
        }
    }
    // ② 未命中：解码 base64 → 缩略（保持宽高比、仅缩不放）→ PNG
    let bytes = crate::clipboard::base64_decode(b64).ok_or("base64 解码失败")?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败: {}", e))?;
    let thumb = img.thumbnail(CLIP_THUMB_MAX_DIM, CLIP_THUMB_MAX_DIM);
    let mut png = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("编码失败: {}", e))?;
    let png_bytes = png.into_inner();
    // ③ 写盘缓存（best-effort：失败仅少一次缓存、不影响本次返回）
    if let Some(cf) = &cache_file {
        let _ = std::fs::write(cf, &png_bytes);
    }
    Ok(format!("data:image/png;base64,{}", base64_encode(&png_bytes)))
}

#[tauri::command]
pub async fn get_clip_thumbnail(time: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_clip_thumbnail_blocking(time))
        .await
        .map_err(|e| format!("剪贴板缩略图任务失败: {e}"))?
}

/// 初始化启动台/中转站资产目录 + 起孤儿回收线程。setup 时调用一次。
pub(crate) fn init_launcher_assets(data_dir: &std::path::Path) {
    let icon_dir = data_dir.join("launcher_icons");
    let image_dir = data_dir.join("launcher_images");
    let stage_dir = data_dir.join("stage_images");
    let _ = std::fs::create_dir_all(&icon_dir);
    let _ = std::fs::create_dir_all(&image_dir);
    let _ = std::fs::create_dir_all(&stage_dir);
    let _ = LAUNCHER_ICON_DIR.set(icon_dir);
    let _ = LAUNCHER_IMAGE_DIR.set(image_dir);
    let _ = STAGE_IMAGE_DIR.set(stage_dir);
    let _ = LAUNCHER_DATA_DIR.set(data_dir.to_path_buf());
    std::thread::spawn(|| {
        let _guard = crate::ThreadExitGuard("launcher_janitor"); // M5-A
        std::thread::sleep(std::time::Duration::from_millis(LAUNCHER_SWEEP_INITIAL_MS));
        loop {
            sweep_launcher_assets();
            std::thread::sleep(std::time::Duration::from_millis(LAUNCHER_SWEEP_MS));
        }
    });
}

/// 从 store JSON 收集「被引用集」：图标文件名 + launcher_images 下被引用的图片文件名。
/// 返回 None = **读不出可信的引用集**（文件缺失/解析失败/没有 launcher-items 数组），
/// 调用方必须据此**整轮跳过清理**——这是 clip_images「空集合误删全部」那条教训的同款守卫。
///
/// 图片侧同时扫 `launcher-items` 与 `stage-items` 两个 key：物化出来的 PNG 可能被用户又拖进中转站，
/// 只看启动台会把仍在用的图片当孤儿删掉。
fn collect_launcher_refs() -> Option<AssetRefs> {
    collect_launcher_refs_at(LAUNCHER_DATA_DIR.get()?)
}

/// 三个资产目录各自的「被引用文件名」集合。
type AssetRefs = (
    std::collections::HashSet<String>, // launcher_icons/：launcher-items[].iconFile
    std::collections::HashSet<String>, // launcher_images/：任何指向该目录的 path（小写）
    std::collections::HashSet<String>, // stage_images/：stage-items[].contentFile
);

/// `collect_launcher_refs` 的可测形态（把 OnceLock 依赖抽成入参）。
fn collect_launcher_refs_at(dir: &std::path::Path) -> Option<AssetRefs> {
    let text = std::fs::read_to_string(dir.join("workbench-data.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let launcher = v.get("launcher-items")?.as_array()?;
    let mut icons = std::collections::HashSet::new();
    let mut images = std::collections::HashSet::new();
    let mut stage_imgs = std::collections::HashSet::new();
    let mut note_image = |p: &str| {
        // 只认落在 launcher_images/ 里的路径；其它路径（用户自己的文件）与本回收无关
        let lower = p.replace('/', "\\").to_lowercase();
        if lower.contains("\\launcher_images\\") {
            if let Some(name) = lower.rsplit('\\').next() {
                images.insert(name.to_string());
            }
        }
    };
    for it in launcher {
        if let Some(f) = it.get("iconFile").and_then(|x| x.as_str()) {
            icons.insert(f.to_string());
        }
        if let Some(p) = it.get("path").and_then(|x| x.as_str()) {
            note_image(p);
        }
    }
    // 中转条目：① items[].path 可能引用物化图片；② contentFile 是它自己的图片内容（续146b）
    if let Some(stage) = v.get("stage-items").and_then(|x| x.as_array()) {
        for s in stage {
            if let Some(f) = s.get("contentFile").and_then(|x| x.as_str()) {
                stage_imgs.insert(f.to_string());
            }
            if let Some(items) = s.get("items").and_then(|x| x.as_array()) {
                for i in items {
                    if let Some(p) = i.get("path").and_then(|x| x.as_str()) {
                        note_image(p);
                    }
                }
            }
        }
    }
    Some((icons, images, stage_imgs))
}

/// 资产孤儿回收：删掉 launcher_icons/ · launcher_images/ · stage_images/ 里**确证无人引用**的文件。
/// 三道守卫（少一道都可能删掉用户数据）：
/// ① 引用集读不出来 → 整轮跳过（绝不在「不知道谁在用」时删）；
/// ② 保护期内（mtime 距今 < GRACE）的新文件跳过 → 封住「Rust 已写盘、前端尚未落库」的窗口；
/// ③ 只按文件名精确匹配引用集，不做前缀/模糊判断。
/// 全程 best-effort，任何 fs 错误跳过、绝不 panic。
fn sweep_launcher_assets() {
    let Some((icons, images, stage_imgs)) = collect_launcher_refs() else {
        eprintln!("[launcher_sweep] 引用集读取失败 → 本轮跳过（不做任何删除）");
        return;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for (dir, refs, what) in [
        (LAUNCHER_ICON_DIR.get(), &icons, "icon"),
        (LAUNCHER_IMAGE_DIR.get(), &images, "image"),
        (STAGE_IMAGE_DIR.get(), &stage_imgs, "stage-image"),
    ] {
        let Some(dir) = dir else { continue; };
        let Ok(entries) = std::fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else { continue; };
            // 图片侧引用集是小写（路径大小写不敏感），图标侧是 Rust 自己生成的小写十六进制名
            if refs.contains(&name.to_lowercase()) || refs.contains(name) {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .map(|d| d.as_millis() < LAUNCHER_SWEEP_GRACE_MS as u128)
                .unwrap_or(true); // 拿不到 mtime → 当作「新文件」保守跳过
            if fresh {
                continue;
            }
            if std::fs::remove_file(&p).is_ok() {
                removed += 1;
                eprintln!("[launcher_sweep] 删除孤儿 {what}：{name}");
            }
        }
    }
    if removed > 0 {
        eprintln!("[launcher_sweep] 本轮回收 {removed} 个孤儿文件");
    }
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

// camelCase：前端 FileEntry 接口读 `isDir`（Tauri 不会自动转换 serde 字段名，同 filesearch.rs
// SearchResult 的既有约定）。此前缺这行属潜伏错配——历史调用点只读 .icon 故未暴露，
// 续112 的「浏览文件…」要靠 isDir 区分 file/folder，补齐。
// Default 是给下面那个序列化回归测试用的（续119）。那个测试
// **每加一次字段就编译不过，已经发生两次**（续115、续119）——而 cargo check 不编译
// #[cfg(test)]，当场根本发现不了。改成能用 `..Default::default()` 书写后，
// 以后再加字段测试也不会坏。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub ext: String,
    /// Windows 系统图标，base64 PNG data URL（SHGetFileInfoW 提取，可为 None）
    pub icon: Option<String>,
    /// 修改 / 创建时间（Unix 秒）。取不到则 None——网络盘、部分文件系统不保证提供创建时间，
    /// 故前端必须容忍缺失（预览面板对 None 直接不渲染该行，而不是显示 1970）。
    pub modified: Option<u64>,
    pub created: Option<u64>,
    // ── 续119：为增强预览面板的「消歧」能力而加的 3 项 ────────────────────
    /// 文件夹内的条目数。文件恒为 None。
    /// 动机：选中文件夹时，面板给的信息全是「容器外面」的事（位置/修改），
    /// **对这个文件夹本身什么也没说**。
    pub entries: Option<u32>,
    /// 条目数是否因 DIR_COUNT_CAP 被截断。为 true 时前端显示「N+」。
    pub entries_capped: bool,
    /// 图片的像素尺寸。非图片或读不出时为 None。
    /// 选图时「1920 × 1080」比「340 KB」有用得多。
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// .lnk 解析后的目标完整路径。非快捷方式为 None。
    /// 动机：选中开始菜单里的 .lnk 时，「位置」显示的是开始菜单那个文件夹，
    /// 根本看不出实体在哪。
    pub target: Option<String>,
}

/// 文件夹条目数的计数上限（续119）。几十万条目的文件夹若把 read_dir 跑到底，
/// 预览会卡住，所以要截断。截断后用 entries_capped=true 告知前端。
const DIR_COUNT_CAP: u32 = 10_000;

/// 数文件夹直下的条目数（不递归——想知道的是「这个文件夹里有几个」，
/// 而不是总文件数。递归不仅会在大树上卡住，语义也变了）。
fn count_dir_entries(p: &std::path::Path) -> Option<(u32, bool)> {
    let rd = std::fs::read_dir(p).ok()?; // 无权限等情况返回 None（前端显示「—」）
    let mut n = 0u32;
    for e in rd {
        if e.is_err() {
            continue; // 单条枚举出错就跳过（不因此放弃整体）
        }
        n += 1;
        if n >= DIR_COUNT_CAP {
            return Some((n, true));
        }
    }
    Some((n, false))
}

/// 图片的像素尺寸。**只读文件头**（into_dimensions）——全解码的话，
/// 几千万像素的图会把预览卡住。先按扩展名足切再打开。
fn image_dims(path: &str, ext: &str) -> Option<(u32, u32)> {
    if !matches!(ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "avif") {
        return None;
    }
    // with_guessed_format：即使扩展名与实际格式不符，也按内容判定
    image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_dimensions().ok()
}

/// 解析 .lnk，返回实体的完整路径（续119）。
///
/// ⚠️ 要求调用方已初始化 COM（在 get_file_info 的 CoInitializeEx 区间内调用）。
/// 既有的 `resolve_lnk` 只取名字和图标、**根本没解析链接目标**，是另一回事。
fn resolve_lnk_target(path: &str) -> Option<String> {
    use windows::core::{Interface, PCWSTR}; // Interface 提供 .cast()
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    if !path.to_lowercase().ends_with(".lnk") {
        return None;
    }
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = link.cast().ok()?;
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        pf.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let mut buf = [0u16; 260]; // MAX_PATH。超长的目标放弃（None → 前端不渲染该行）
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..end]);
        if s.is_empty() {
            None // MSI 广告式快捷方式等情况下 GetPath 会返回空
        } else {
            Some(s)
        }
    }
}

/// SystemTime → Unix 秒。早于 epoch（异常时钟 / 某些网络盘）返回 None，不返回负数或 0。
fn unix_secs(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// 批量获取文件/文件夹的 Shell 图标（base64 PNG data URL），供搜索结果异步填充图标用。
/// 返回 [(path, icon | null), ...]，顺序与入参一致；单次 COM init 覆盖整批，避免逐条初始化开销。
#[tauri::command]
pub fn get_file_icons(paths: Vec<String>) -> Vec<(String, Option<String>)> {
    let com_hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };
    let result = paths.iter().map(|p| (p.clone(), extract_icon_base64(p))).collect();
    if com_hr == 0 { unsafe { CoUninitialize(); } }
    result
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
    let is_dir = meta.is_dir();
    // 提取 Windows 系统图标 + 解析 .lnk；两者都要 COM，共用这一次临时初始化（续119 起）
    let com_hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };
    let icon = extract_icon_base64(&path);
    let target = resolve_lnk_target(&path);
    if com_hr == 0 { unsafe { CoUninitialize(); } } // 仅 S_OK 时配对反初始化
    // ↓ 涉及磁盘 I/O，故文件夹 / 图片各自**只在对应情况下**才跑。
    //   本命令是预览面板调用的异步路径，
    //   不在「查询命令（search_files 等）只读内存」那条铁律的约束范围内。
    let (entries, entries_capped) = if is_dir {
        match count_dir_entries(&p) {
            Some((n, capped)) => (Some(n), capped),
            None => (None, false),
        }
    } else {
        (None, false)
    };
    let (width, height) = match if is_dir { None } else { image_dims(&path, &ext) } {
        Some((w, h)) => (Some(w), Some(h)),
        None => (None, None),
    };
    Ok(FileInfo {
        path, name, is_dir, size: meta.len(), ext, icon,
        modified: unix_secs(meta.modified()), created: unix_secs(meta.created()),
        entries, entries_capped, width, height, target,
    })
}

/// 批量存在性检查：返回入参中「已不存在」的路径子集（中转站失踪标记用）。
/// 纯 Path::exists() stat，微秒级；不读内容、不碰任何锁。前端在每次呼出时后台调用。
#[tauri::command]
pub fn check_stage_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| !std::path::Path::new(p).exists())
        .collect()
}

fn str_to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// ── .lnk 快捷方式解析（供启动器拖入） ──────────────────────

#[derive(serde::Serialize)]
pub struct LnkInfo {
    pub name: String,         // 去掉 .lnk 后缀的干净名称
    pub path: String,         // 原始 .lnk 路径（ShellExecuteW 可直接执行）
    pub icon: Option<String>, // base64 图标；提取失败为 null
}

#[tauri::command]
pub fn resolve_lnk(path: String) -> LnkInfo {
    let raw = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    // 大小写不敏感去后缀
    let name = if raw.to_lowercase().ends_with(".lnk") {
        raw[..raw.len() - 4].to_string()
    } else {
        raw
    };
    let icon = extract_icon_base64(&path); // SHGetFileInfoW 自动解析 .lnk 图标
    LnkInfo { name, path, icon }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 预览面板大图标的**载荷与耗时**（`cargo test --lib probe_large_icon_cost -- --ignored --nocapture`）。
    /// 量两件事：① 每次预览一个没看过的项要过多大的 IPC；
    /// ② 前端 `previewCacheRef`（上限 `PREVIEW_CACHE_MAX=300` 条）装满时的常驻内存。
    /// 后者是"预览缓存"这个设计的真实代价，此前从没量过。
    #[test]
    #[ignore]
    fn probe_large_icon_cost() {
        let win = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let paths = [
            format!("{win}\\explorer.exe"),
            format!("{win}\\notepad.exe"),
            format!("{win}\\System32\\cmd.exe"),
            format!("{win}\\System32\\drivers\\etc\\hosts"),
            win.clone(), // 文件夹
        ];
        let mut total_small = 0usize;
        let mut total_large = 0usize;
        let mut n = 0usize;
        for p in &paths {
            let t0 = std::time::Instant::now();
            let large = get_large_icon(p.clone());
            let dt = t0.elapsed();
            let t1 = std::time::Instant::now();
            let small = extract_icon_base64(p);
            let dt_s = t1.elapsed();
            let (ls, ss) = (large.as_ref().map_or(0, |s| s.len()), small.as_ref().map_or(0, |s| s.len()));
            if ls == 0 { println!("{p}: 大图标取不到（跳过）"); continue; }
            total_large += ls;
            total_small += ss;
            n += 1;
            println!(
                "{:<46} 大 {:>7} B / {:>8.2?}   小 {:>6} B / {:>8.2?}",
                p.rsplit('\\').next().unwrap_or(p), ls, dt, ss, dt_s
            );
        }
        assert!(n > 0, "一个大图标都没取到，探针无意义");
        let avg = total_large / n;
        println!(
            "\n均值：大图标 {avg} B（小图标 {} B，约 {:.1}×）\n\
             预览缓存装满 300 条 ≈ {:.1} MB（仅大图标；图片项还会另存一张缩略图）",
            total_small / n,
            avg as f64 / (total_small / n).max(1) as f64,
            avg as f64 * 300.0 / 1024.0 / 1024.0
        );
    }

    /// 续146 孤儿回收的**安全闸**：引用集读不出来时必须返回 None（调用方据此整轮跳过）。
    /// 这条一旦破（比如「读失败就当空集合」），sweep 会把 launcher_icons/ 与 launcher_images/
    /// 里的文件全删光——后者是截图物化出来的**唯一副本**，删掉就是不可逆的数据丢失。
    /// 同款教训见 clip_images 的「首次 sweep 必须在 load_clip_history 之后」。
    #[test]
    fn launcher_refs_bail_out_instead_of_returning_empty_set() {
        let dir = std::env::temp_dir().join(format!(
            "wb_lref_test_{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("workbench-data.json");

        // ① store 文件不存在 → None（首次启动/目录被清）
        assert!(collect_launcher_refs_at(&dir).is_none(), "文件缺失必须 bail，不能当空引用集");
        // ② JSON 损坏 → None
        std::fs::write(&store, "{ not json").unwrap();
        assert!(collect_launcher_refs_at(&dir).is_none(), "解析失败必须 bail");
        // ③ 没有 launcher-items 键 → None（前端还没写过 = 状态未知，不是「没人引用」）
        std::fs::write(&store, r#"{"theme":"dark"}"#).unwrap();
        assert!(collect_launcher_refs_at(&dir).is_none(), "键缺失必须 bail");
        // ④ 空数组是**可信**的空引用集 → Some（用户确实清空了启动台，此时该回收）
        std::fs::write(&store, r#"{"launcher-items":[]}"#).unwrap();
        let (icons, images, stage_imgs) = collect_launcher_refs_at(&dir).expect("空数组是可信状态，应返回 Some");
        assert!(icons.is_empty() && images.is_empty() && stage_imgs.is_empty());

        // ⑤ 正常读取：图标名 + launcher_images 下的图片名；非该目录的路径不得混入
        std::fs::write(&store, r#"{"launcher-items":[
            {"id":1,"iconFile":"a1b2c3d4.png","path":"C:\\Users\\me\\notepad.exe"},
            {"id":2,"path":"C:\\Users\\me\\AppData\\Roaming\\com.workbench.app\\launcher_images\\clip_123.png"}
        ]}"#).unwrap();
        let (icons, images, _) = collect_launcher_refs_at(&dir).unwrap();
        assert!(icons.contains("a1b2c3d4.png"));
        assert_eq!(images.len(), 1, "只有 launcher_images/ 下的路径算引用");
        assert!(images.contains("clip_123.png"));

        // ⑥ 中转条目也要算进引用集：物化图片被拖回中转站后，只看启动台会把它当孤儿删掉；
        //    续146b：中转图片条目自己的 contentFile 同样是**唯一副本**，漏进引用集就是数据丢失
        std::fs::write(&store, r#"{"launcher-items":[],"stage-items":[
            {"id":9,"items":[{"path":"D:\\x\\launcher_images\\clip_777.png"}]},
            {"id":10,"type":"image","contentFile":"deadbeef.png"}
        ]}"#).unwrap();
        let (_, images, stage_imgs) = collect_launcher_refs_at(&dir).unwrap();
        assert!(images.contains("clip_777.png"), "stage-items 引用的物化图片不得被当孤儿");
        assert!(stage_imgs.contains("deadbeef.png"), "stage-items[].contentFile 必须进引用集");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_loading_is_scoped_to_references_and_rejects_traversal() {
        let dir = std::env::temp_dir().join(format!(
            "wb_asset_load_{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("used.png"), b"used").unwrap();
        std::fs::write(dir.join("orphan.png"), b"orphan").unwrap();

        let loaded = load_b64_pngs(&dir, &["used.png".into()]);
        assert_eq!(loaded.len(), 1, "未引用的孤儿资产不得进入返回表");
        assert!(loaded.contains_key("used.png"));
        assert!(!loaded.contains_key("orphan.png"));

        for bad in ["", "../used.png", r"..\used.png", "sub/used.png"] {
            assert!(asset_path(&dir, bad).is_err(), "必须拒绝越界文件名：{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 续119 新增的 3 个字段也必须以 camelCase 输出。
    /// 前端读的是 `entriesCapped`——若留成 snake_case 就会拿到 undefined（静默 falsy），
    /// 于是被截断的巨大文件夹会显示成「10000 个」这个**撒谎的确定值**。
    #[test]
    fn file_info_new_fields_serialize_as_camel_case() {
        let json = serde_json::to_string(&FileInfo {
            entries: Some(12),
            entries_capped: true,
            width: Some(1920),
            height: Some(1080),
            target: Some("C:\\app\\real.exe".into()),
            ..Default::default()
        })
        .expect("FileInfo 应可序列化");
        assert!(json.contains("\"entriesCapped\":true"), "前端读 entriesCapped: {json}");
        assert!(!json.contains("entries_capped"), "不应残留 snake_case: {json}");
        for k in ["\"entries\":12", "\"width\":1920", "\"height\":1080"] {
            assert!(json.contains(k), "缺字段 {k}: {json}");
        }
    }

    /// 文件夹条目数（续119）：只数直下、不递归、截断生效。
    #[test]
    fn count_dir_entries_counts_shallow_and_caps() {
        let base = std::env::temp_dir().join("wb_dircount_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        for i in 0..5 {
            std::fs::write(base.join(format!("f{i}.txt")), b"x").unwrap();
        }
        // 嵌套子目录里的内容不能计入（想知道的是「这个文件夹里有几个」）
        std::fs::write(base.join("sub").join("deep.txt"), b"x").unwrap();
        let (n, capped) = count_dir_entries(&base).expect("应当能读到");
        assert_eq!(n, 6, "直下 = 5 个文件 + 1 个 sub 目录（嵌套的 deep.txt 不算）");
        assert!(!capped, "才 6 条不该被截断");

        // 不存在的路径返回 None（前端退化为显示「—」）
        assert!(count_dir_entries(&base.join("nope")).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 对非 .lnk 输入，resolve_lnk_target 应不碰 COM 直接返回 None（续119）。
    /// 这里若不提前 return，每个文件的预览都会白白创建一次 ShellLink。
    #[test]
    fn resolve_lnk_target_ignores_non_lnk() {
        assert!(resolve_lnk_target("C:\\x\\a.txt").is_none());
        assert!(resolve_lnk_target("C:\\x\\a.exe").is_none());
        // 大小写不敏感（.LNK 也存在）——文件不存在所以解析本身会失败，
        // 但至少不该被扩展名判断挡掉。这里看的是不 panic。
        let _ = resolve_lnk_target("C:\\x\\nonexistent.LNK");
    }

    /// 图片尺寸（续119）：非图片扩展名不打开文件、直接 None。
    /// 不按扩展名足切的话，就会把巨大的 zip 之类丢给解码器。
    #[test]
    fn image_dims_skips_non_images() {
        assert!(image_dims("C:\\x\\a.zip", "zip").is_none());
        assert!(image_dims("C:\\x\\a.txt", "txt").is_none());
        assert!(image_dims("C:\\x\\nonexistent.png", "png").is_none(), "文件不存在应返回 None");
    }

    #[test]
    fn stage_thumb_cache_identity_tracks_subsecond_replacement_and_size() {
        // Windows SystemTime 的表示精度不是 1ns；用同一秒内 1ms 的真实文件时间差。
        let first = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_001);
        let replaced = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_002);
        let a = stage_thumb_cache_name("C:\\x\\same.png", 100, Some(first));
        let b = stage_thumb_cache_name("C:\\x\\same.png", 100, Some(replaced));
        let c = stage_thumb_cache_name("C:\\x\\same.png", 101, Some(first));
        assert_ne!(a, b, "同一秒内覆盖同一路径也必须失效旧缩略图");
        assert_ne!(a, c, "文件长度变化也必须失效旧缩略图");
    }

    /// AUMID 判定（续125）：只认 `PFN!AppId`，AppsFolder 里的 Win32 项一律排除。
    /// 判错的代价是双向的：漏判 = UWP 搜不到（本次要修的问题本身），
    /// 误判 = 把 Win32 项按 `shell:AppsFolder\<路径>` 存起来，启动必失败。
    #[test]
    fn packaged_aumid_detection() {
        assert!(is_packaged_aumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        assert!(is_packaged_aumid("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"));
        // Win32 项：路径 / GUID 形式，都不该被当成 AUMID
        assert!(!is_packaged_aumid("C:\\Program Files\\App\\app.exe"));
        assert!(!is_packaged_aumid("{7b81be6a-ce2b-4676-a29e-eb907a5126c5}\\x"));
        assert!(!is_packaged_aumid("Notepad"));
        assert!(!is_packaged_aumid(""));
    }

    /// 诊断用（默认 #[ignore]，手动执行：
    ///   cargo test --lib probe_packaged_apps -- --ignored --nocapture）
    ///
    /// 真机枚举 shell:AppsFolder，看 UWP 条数 / 图标命中率 / 耗时。
    /// 耗时是这里的关键指标：扫描跑在 start_apps_worker 后台线程里，
    /// 但它是「首次呼出前必须就绪」的预建工作，太慢就得改增量。
    #[test]
    #[ignore]
    fn probe_packaged_apps() {
        let hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };
        let t0 = std::time::Instant::now();
        let list = scan_packaged_apps();
        let dt = t0.elapsed();
        let with_icon = list.iter().filter(|a| a.icon.is_some()).count();
        println!("UWP {} 条 / {} 带图标 / 耗时 {:?}", list.len(), with_icon, dt);
        for a in list.iter().take(15) {
            println!("  {:<40} {}", a.name, a.path);
        }
        assert!(list.iter().all(|a| a.packaged), "本函数只应产出 packaged 条目");
        if hr >= 0 {
            unsafe { CoUninitialize() };
        }
    }

    /// 诊断用（默认 #[ignore]，手动执行：
    ///   cargo test --lib probe_staged_scan -- --ignored --nocapture）
    ///
    /// 验证续128 两段式扫描的实际时序：第一批（.lnk）比完整列表早多少。
    /// 这个差值就是续125 引入 UWP 枚举后、前端白等的那段时间。
    #[test]
    #[ignore]
    fn probe_staged_scan() {
        let t0 = std::time::Instant::now();
        let mut stage1 = (0usize, std::time::Duration::ZERO);
        let all = scan_start_menu_staged(|partial| {
            stage1 = (partial.len(), t0.elapsed());
            // 半成品也必须是排好序的，否则前端先渲染乱序、补完再整体重排
            let names: Vec<String> = partial.iter().map(|a| a.name.to_lowercase()).collect();
            let mut sorted = names.clone();
            sorted.sort();
            assert_eq!(names, sorted, "交给前端的半成品必须已按名字排序");
        });
        let full = t0.elapsed();
        println!("第一批(.lnk): {} 条 / {:?}", stage1.0, stage1.1);
        println!("完整列表:     {} 条 / {:?}", all.len(), full);
        println!("前端提前拿到结果: {:?}", full.saturating_sub(stage1.1));
        assert!(stage1.0 > 0, "第一批不应为空");
        assert!(all.len() >= stage1.0, "完整列表不应少于第一批");
    }

    /// 诊断用（默认 #[ignore]，⚠️ **会真的启动一个应用**（计算器），手动执行：
    ///   cargo test --lib probe_launch_packaged -- --ignored --nocapture）
    ///
    /// 验证整条 UWP 路线的关键假设：`launch_app` 现成的 ShellExecuteW 能否吃
    /// `shell:AppsFolder\<AUMID>`。若不能，就得改走 IApplicationActivationManager。
    #[test]
    #[ignore]
    fn probe_launch_packaged() {
        let hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED) };
        let list = scan_packaged_apps();
        let target = list
            .iter()
            .find(|a| a.path.contains("WindowsCalculator"))
            .or_else(|| list.first())
            .expect("本机应至少有一个 Packaged App");
        println!("启动: {} → {}", target.name, target.path);
        let r = launch_app(target.path.clone());
        println!("结果: {r:?}");
        if hr >= 0 {
            unsafe { CoUninitialize() };
        }
        assert!(r.is_ok(), "ShellExecuteW 无法启动 AUMID，需改用 IApplicationActivationManager");
    }

    /// 诊断用（默认 #[ignore]，手动执行：
    ///   cargo test --lib probe_real_lnk -- --ignored --nocapture）
    ///
    /// 拿实机开始菜单里真实的 .lnk 走一遍 get_file_info 做解析。
    /// COM 创建失败时 resolve_lnk_target 只会静默返回 None，
    /// **所以不过真实数据就无法确认它到底有没有生效**。这里就是做这个确认的。
    /// 顺带用实物看一眼图片尺寸与文件夹条目数。
    #[test]
    #[ignore]
    fn probe_real_lnk() {
        let menu = PathBuf::from(std::env::var("ProgramData").unwrap_or_default())
            .join("Microsoft/Windows/Start Menu/Programs");
        let mut shown = 0;
        if let Ok(rd) = std::fs::read_dir(&menu) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")) != Some(true) {
                    continue;
                }
                let info = match get_file_info(p.to_string_lossy().to_string()) {
                    Ok(i) => i,
                    Err(err) => { println!("  ! {} → {err}", p.display()); continue; }
                };
                println!(
                    "  {:<34} → {}",
                    info.name,
                    info.target.as_deref().unwrap_or("(解析不出 / 广告式快捷方式)")
                );
                shown += 1;
                if shown >= 6 { break; }
            }
        }
        if shown == 0 {
            println!("  开始菜单里没找到 .lnk（无法判定）: {}", menu.display());
        }

        // 顺带用实物看文件夹条目数（本仓库的 src 目录）
        if let Ok(info) = get_file_info("D:\\dev\\workbench-app\\src".into()) {
            println!("  src/ 的条目数: {:?} (capped={})", info.entries, info.entries_capped);
        }
    }

    /// FileInfo 必须以 camelCase 过 IPC——前端 `FileEntry` 接口读的是 `isDir`。
    /// 缺 `#[serde(rename_all)]` 时前端拿到的是 undefined（不是报错，是静默 falsy），
    /// 表现为「拖进来的文件夹被当成文件」：磁贴/卡片显通用文件字形、中转卡片元信息不显示「文件夹」。
    /// 这个错配曾潜伏很久（历史调用点只读 .icon 故没暴露），故用测试钉死。
    #[test]
    fn file_info_serializes_is_dir_as_camel_case() {
        // 用 `..Default::default()` 书写（续119）：这里的目的是看 serde 的 rename，
        // 各字段具体取值无关紧要。全列出来的话每加一个字段都会编译不过，
        // 实际上续115、续119 已经这样坏过两次。
        let json = serde_json::to_string(&FileInfo {
            name: "tmp".into(),
            is_dir: true,
            ..Default::default()
        })
        .expect("FileInfo 应可序列化");
        assert!(json.contains("\"isDir\":true"), "前端读 isDir，实际序列化为: {json}");
        assert!(!json.contains("is_dir"), "不应残留 snake_case 字段: {json}");
    }
}
