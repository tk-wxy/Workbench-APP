// 轻量字典式 i18n：中文字面量本身即字典 key，缺项时原样 fallback 回中文（不会白屏/报错）。
// 动态文案用 {占位符} 模板：EN_DICT 里配英文模板，调用处 t("已选 {n} 项", {n: count})。
export type Lang = "zh" | "en";

export const EN_DICT: Record<string, string> = {
  "语言": "Language",
  "中文": "Chinese",
  "常规": "General",
  "启动台": "Launcher",
  "中转站": "Stage",
  "剪贴板": "Clipboard",
  "取走粘贴": "Take & paste",
  "搜索": "Search",
  "快捷键": "Shortcuts",
  "关于": "About",

  // ── 顶栏 / 通用 ──
  "设置": "Settings",
  "关闭": "Close",
  "打开": "Open",
  "移除": "Remove",
  "删除": "Delete",
  "复制": "Copy",
  "取走": "Take",
  "添加": "Add",
  "清空": "Clear",
  "已复制": "Copied",
  "无匹配": "No matches",
  "文件": "File",
  "文件夹": "Folder",
  "图片": "Image",
  "文本": "Text",
  "应用": "Apply",
  "中转": "Stage",
  "导航": "Navigate",
  "启动": "Launch",
  "切换": "Toggle",
  "核": "cores",
  "复制到剪贴板": "Copy to clipboard",

  // ── 启动器 ──
  "启动器": "Launcher",
  "添加应用": "Add App",
  "单击启动": "Click to launch",
  "单击打开": "Click to open",
  "拖入或点「添加」收藏应用": "Drag in or click \"Add\" to save an app",
  "打开所在目录": "Open containing folder",
  "从启动器移除": "Remove from Launcher",
  "点击添加到启动器": "Click to add to Launcher",
  "搜索要添加的应用…": "Search apps to add…",
  "无匹配应用": "No matching apps",
  "暂无可添加应用": "No apps available to add",
  "点击添加，可连续添加；": "Click to add — keep adding more;",

  // ── 中转区 ──
  "文件中转区": "Stage",
  "已选 {n}": "{n} selected",
  "取走并粘贴到上个窗口": "Take & paste to previous window",
  "仅文件可批量取走": "Only files can be batch-taken",
  "仅文件可批量复制": "Only files can be batch-copied",
  "完成": "Done",
  "进入多选模式": "Enter multi-select mode",
  "多选": "Multi-select",
  "{n} 个文件": "{n} files",
  "{n}个文件": "{n} files",
  "单击选中 / 取消": "Click to select / deselect",
  "单击取走（写回剪贴板并粘贴），拖出可拖到其他应用": "Click to take (writes to clipboard & pastes); drag out to another app",
  "单击取走（粘贴到上个窗口），拖出可拖到其他应用": "Click to take (pastes to previous window); drag out to another app",
  "单击取走（写回剪贴板并粘贴）": "Click to take (writes to clipboard & pastes)",
  "单击取走（粘贴到上个窗口）": "Click to take (pastes to previous window)",
  "拖入文件 / 文件夹，或在剪贴板卡片点 📌 钉入": "Drag in files/folders, or click 📌 on a clipboard card to pin",
  "快捷入口": "Quick Access",
  "截屏": "Screenshot",
  "文件管理器": "File Explorer",
  "下载": "Downloads",
  "桌面": "Desktop",
  "终端": "Terminal",
  "计算器": "Calculator",
  "取走全部（{n} 项）": "Take all ({n} items)",
  "复制全部（{n} 项）": "Copy all ({n} items)",
  "删除全部（{n} 项）": "Delete all ({n} items)",
  "取消选择": "Deselect",
  "删除该项目": "Delete item",

  // ── 剪贴板历史 ──
  "剪贴板历史": "Clipboard History",
  "单击左键粘贴": "Left-click to paste",
  "单击左键粘贴文件": "Left-click to paste file",
  "单击左键复制": "Left-click to copy",
  "钉到中转区": "Pin to Stage",
  "📌 钉到中转区": "📌 Pin to Stage",
  "删除该条目": "Delete entry",
  "显示时自动读取": "Loaded automatically when shown",

  // ── 增强搜索 ──
  "搜索应用、中转、剪贴板…": "Search apps, stage, clipboard…",
  "搜索应用、中转文件…": "Search apps, staged files…",
  "界面搜索": "Page Search",
  "增强搜索": "Enhanced Search",
  "Everything 未运行，已回退内置搜索": "Everything isn't running; fell back to built-in search",
  "文件索引建立中…": "Building file index…",
  "文件 / 文件夹": "File / Folder",
  "加入中转区": "Add to Stage",
  "加入启动台": "Add to Launcher",
  "输入以搜索": "Type to search",

  // ── 设置：常规 ──
  "背景主题": "Background Theme",
  "深色": "Dark",
  "浅色": "Light",
  "系统": "System",
  "开机自启": "Start with Windows",
  "这里仅保留全局外观与启动行为；启动台、中转站、剪贴板和搜索分别在独立条目中设置。": "This only covers global appearance and startup behavior; Launcher, Stage, Clipboard, and Search each have their own settings section.",

  // ── 设置：启动台 ──
  "收藏条目": "Saved Items",
  "排序方式": "Sort Order",
  "拖拽调整": "Drag to reorder",
  "手动排序": "Manual",
  "启动台只负责打开应用、文件或文件夹；与中转站的取走粘贴动作保持分离。": "Launcher only opens apps, files, or folders — kept separate from Stage's take-and-paste action.",

  // ── 设置：中转站 ──
  "显示布局": "Layout",
  "列表": "List",
  "方格": "Grid",
  "中转条目": "Staged Items",
  "失踪条目": "Missing Items",
  "清理失踪": "Clear Missing",
  "原文件已失踪（可能被删除或移动）": "Original file is missing (deleted or moved)",
  "上限条数": "Capacity",
  "拖出后自动关闭": "Auto-close on drag out",
  "中转站存放手动钉入或拖入的文件、文本、图片条目；左键动作为取走粘贴。「开启」（默认）：拖动条目会立即隐藏界面，便于拖到外部应用（资源管理器等）。「关闭」：拖动时界面保持显示，可拖到启动台或中途取消（松手到空白处 / 按 Esc）；要拖到外部应用时，拖动中按一下呼出热键即可隐藏界面、再松手落地。":
    "Stage holds files, text, and images you've pinned or dragged in; left-click takes and pastes. \"On\" (default): dragging an item hides the window immediately, making it easy to drag into external apps (Explorer, etc). \"Off\": the window stays visible while dragging — you can drop onto Launcher or cancel mid-drag (release over empty space / press Esc); to drag into an external app, tap the hotkey mid-drag to hide the window, then release.",
  "持久化": "Persist Items",
  "「关闭」（默认）：条目确认成功移出/拖出后自动从中转区移除。「开启」：条目移出/拖出后仍保留在中转区，除非手动删除。":
    "\"Off\" (default): items are removed from Stage automatically once a move-out/drag-out is confirmed successful. \"On\": items stay in Stage after being moved/dragged out, until you delete them manually.",
  "底部快捷入口": "Bottom Quick Access",
  "中转区下方的截屏 / 文件管理器 / 下载等快捷按钮。隐藏后这块空间归还给中转区，可容纳更多条目。":
    "The screenshot / File Explorer / Downloads shortcut buttons below Stage. Hiding them returns the space to Stage to fit more items.",

  // ── 设置：剪贴板 ──
  "历史保存条数": "History Size",
  "{n} 条": "{n} items",
  "复制的文本、图片、文件会自动记录，最多保留 {n} 条。": "Copied text, images, and files are recorded automatically, keeping up to {n} items.",
  "图片原图缓存": "Original Image Cache",
  "打开文件夹": "Open Folder",
  "✓ 已清空": "✓ Cleared",
  "清空缓存": "Clear Cache",
  "历史图片原图存放于此，清空后历史图粘贴退回缩略图质量。": "Original images from history are stored here; clearing it reverts history pastes to thumbnail quality.",
  "缩略图缓存": "Thumbnail Cache",
  "中转区图片文件的缩略图缓存，命中后重启秒开。清空后下次显示会按需重新生成，不影响原文件。": "Thumbnail cache for image files in the staging area; cache hits make restarts instant. Clearing it regenerates thumbnails on demand next time and doesn't affect the original files.",

  // ── 设置：搜索 ──
  "呼出默认搜索": "Default Search on Launch",
  "呼出后顶栏输入直接进入增强搜索；{combo}切换为界面搜索。": "Typing in the top bar after launch goes straight to Enhanced Search; {combo} switches to Page Search.",
  "呼出后顶栏搜索过滤界面内容；{combo}进入增强搜索（共用顶栏）。": "Typing in the top bar after launch filters the page; {combo} enters Enhanced Search (shares the top bar).",
  "搜索引擎": "Search Engine",
  "内置": "Built-in",
  "连接状态": "Connection",
  "已连接": "Connected",
  "未连接": "Not connected",
  "✓ 已检测": "✓ Checked",
  "重新检测": "Re-check",
  "未检测到 Everything（需安装 Everything 并保持其后台运行，DLL 已随应用内置）。查询将自动回退到内置引擎。换 DLL / 启动 Everything 后点「重新检测」即可热更新，无需重启。":
    "Everything not detected (install Everything and keep it running in the background — the DLL is already bundled). Queries will fall back to the built-in engine. After swapping the DLL or starting Everything, click \"Re-check\" to hot-reload — no restart needed.",
  "已连接 Everything，查询覆盖全盘、即时。": "Connected to Everything — queries cover the whole drive, instantly.",
  "内置引擎扫描整个用户目录（含下方额外目录），无需任何外部依赖；Everything 覆盖全盘但需另装。": "The built-in engine scans your whole user folder (plus any extra directories below) with no external dependency; Everything covers the entire drive but needs a separate install.",
  "额外扫描目录": "Extra Scan Directories",
  "如 D:\\Work": "e.g. D:\\Work",
  "默认仅扫描用户目录（桌面/下载/文档…）。如需搜其他盘符，在此添加根目录。": "By default, only your user folder is scanned (Desktop/Downloads/Documents…). To search other drives, add a root directory here.",
  "添加目录后约几秒完成后台重建即可搜到；node_modules / .git 等噪音目录自动跳过。": "After adding a directory, the background index rebuilds in a few seconds; noisy folders like node_modules / .git are skipped automatically.",

  // ── 设置：快捷键 ──
  "呼出 / 隐藏": "Show / Hide",
  "如 ctrl+shift+f": "e.g. ctrl+shift+f",
  "如 ctrl+k": "e.g. ctrl+k",
  "按下快捷键…": "Press a shortcut…",
  "录制": "Record",
  "恢复默认": "Reset to Default",
  "点「录制」后直接按下组合键自动填入；也可手动输入。": "Click \"Record\", then press the key combo to auto-fill; you can also type it manually.",
  "格式：ctrl+x · alt+q · ctrl+shift+x · f9": "Format: ctrl+x · alt+q · ctrl+shift+x · f9",
  "· 不支持 Win 键及 Alt+Space / Alt+F4（系统保留）": "· Win key and Alt+Space / Alt+F4 aren't supported (reserved by the system)",
  "· 修饰键 Ctrl / Shift / Alt 可选；纯主键会全局抢占该键，慎设": "· Ctrl / Shift / Alt modifiers are optional; a bare key will globally capture that key — set with care",
  "· 中文输入法下录制前请先切换到英文输入法": "· Switch to an English input method before recording if you're using a Chinese IME",
  "关闭面板": "Close Panel",
  "应用导航": "App Navigation",
  "启动选中应用": "Launch Selected App",
  "长按 = 按住显示松开关闭；短按 = 切换显隐。": "Long-press = hold to show, release to close; short-press = toggle visibility.",

  // ── 设置：关于 ──
  "Windows 全屏「第二桌面」工具": "Windows fullscreen \"second desktop\" tool",
  "应用启动器 · 文件中转 · 剪贴板历史": "App Launcher · File Stage · Clipboard History",

  // ── 热键错误提示（Rust 三条 + 前端本地校验）──
  "不支持 Win 键": "Win key isn't supported",
  "需要且只能有一个主键": "Exactly one main key is required",
  "Alt+Space / Alt+F4 / Alt+Tab 被系统占用": "Alt+Space / Alt+F4 / Alt+Tab are reserved by the system",
  "无效组合": "Invalid combo",
  "与呼出热键冲突": "Conflicts with the toggle hotkey",
  "暂不支持 Win 组合": "Win combos aren't supported yet",
  "不支持的键": "Unsupported key",

  // ── ago() 相对时间 ──
  "刚刚": "Just now",
  "{n}分钟前": "{n}m ago",
  "{n}小时前": "{n}h ago",
};

export function makeT(lang: Lang) {
  return (zh: string, vars?: Record<string, string | number>): string => {
    let s = lang === "en" ? (EN_DICT[zh] ?? zh) : zh;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}
