import { useState, useEffect, useCallback, useMemo, useRef, Fragment, memo } from "react";
import "./App.css";
import { makeT, type Lang } from "./i18n";
import { IMG_EXTS, fmtSize, ago, agoSec, dirOf, fmtDateTime, fileCategory, catToGroup, type FileCat, type FileGroup } from "./lib/format";
import { groupFiles } from "./lib/enhSections";
import { fuzzyScore, typeKeywords, matchItem } from "./lib/fuzzy";
import { matchName, type PinyinTable, type PinyinVariant } from "./lib/pinyin";
import { tokenFromCode, parseComboStr, matchComboEvent, comboLabel } from "./lib/hotkey";
import { IconCheck, IconCopy, IconTrash, IconOpen, IconPin, IconSearch,
         IconSettings, IconRocket, IconBox, IconClipboard, IconKeyboard, IconInfo, FileGlyph,
         IconWarn, IconClose, IconCamera, IconExplorer, IconDownload, IconMonitor, IconTerminal, IconCalculator, IconPaperclip } from "./icons";

// ── 类型 ──
// packaged=true 即 UWP / Packaged App（续125）：path 是 `shell:AppsFolder\<AUMID>` 而非真实文件路径，
// 只能交给 launch_app（ShellExecuteW 已实测可直接启动 AUMID）。凡按路径办事的操作都要屏蔽。
interface AppInfo { name: string; path: string; icon: string | null; packaged?: boolean; }
interface AppUsage { count: number; last_used: number; } // last_used = Unix 秒
// modified/created 为 Unix 秒，可能缺失（网络盘等不保证提供创建时间）——预览面板对缺失直接不渲染该行
// 续119 新增 entries/entriesCapped/width/height/target（与 Rust apps.rs 的 FileInfo 对应）。
// ⚠️ Rust 侧带 #[serde(rename_all="camelCase")]，这里也必须按 camelCase 读（防续112 那次错配重演）。
interface FileEntry { path: string; name: string; isDir: boolean; size: number; ext: string; icon?: string | null; modified?: number | null; created?: number | null; entries?: number | null; entriesCapped?: boolean; width?: number | null; height?: number | null; target?: string | null; }
interface FileItem { path: string; name: string; ext: string; isImage: boolean; icon?: string | null; }
interface ClipItem { type: "text" | "image" | "file"; content?: string; time: number; items?: FileItem[]; count?: number; orig_path?: string; }
// 文件中转条目：与 ClipItem 同构（type/content/items/count）以复用现成粘贴/复制链路；
// 额外带 id（稳定 key + 去重）和 file 显示辅助字段（name/ext/isDir/size，可选）。
// content：text=正文；image=base64 图片。**image 的 content 是内存态**——落盘前被 dehydrateStage
// 摘掉换成 contentFile（stage_images/ 下的文件名），载入时补回（续146b）。消费方一律只读内存态。
interface StageItem { id: number; type: "text" | "image" | "file"; content?: string; contentFile?: string; items?: FileItem[]; count?: number; name?: string; ext?: string; isDir?: boolean; size?: number; orig_path?: string; pinned?: boolean; }
// copyAndPaste/复制 只读这几个字段，ClipItem 与 StageItem 都满足 → 两个面板共用同一套出口
type Pasteable = { type: "text" | "image" | "file"; content?: string; items?: FileItem[]; orig_path?: string; time?: number; };
type TFn = ReturnType<typeof makeT>;
// 只有含汉字的名字才需要派生拼音（纯英文名走直接匹配即可）。在前端先滤一道，
// 免得把满屏英文文件名送去 Rust 白跑一趟。
const HAS_CJK = /[一-鿿]/;
// 把拼音表裁到 keep 集合内。**返回新对象**（React state 不可原地改）；
// 无需裁剪时返回原引用，避免制造无意义的重渲。
const pruneTable = (tbl: PinyinTable, keep: Set<string>): PinyinTable => {
  const keys = Object.keys(tbl);
  if (keys.length === keep.size && keys.every(k => keep.has(k))) return tbl;
  const out: PinyinTable = {};
  for (const k of keys) if (keep.has(k)) out[k] = tbl[k];
  return out;
};
// 中转 / 剪贴板条目在增强搜索里的「显示名」= 被搜索的那个串。
// 抽成函数是因为它有**两个**消费者且必须一字不差（续131）：增强搜索 Tier1 的匹配、
// 以及拼音派生的取名——两边算出不同的名字，派生表就会查不到、拼音匹配静默失效。
const stageDisplayName = (s: StageItem, t: TFn) => s.name || s.items?.[0]?.name || t("文件");
const clipDisplayName = (c: ClipItem, t: TFn) =>
  c.type === "text" ? (c.content || "").trim().slice(0, 80)
  : c.type === "image" ? t("图片")
  : (c.count !== 1 ? t("{n} 个文件", { n: c.count ?? 0 }) : (c.items?.[0]?.name || t("文件")));
const STAGE_MAX_DEFAULT = 20; // 中转区上限默认值（可在设置→中转站调整，纯前端概念，Rust 侧无对应数组/上限）
const STAGE_MAX_OPTIONS = [20, 50, 100, 200] as const;
// 增强搜索（Ctrl+K）文件结果上限：内置仅扫用户目录够用；Everything 覆盖全盘，给大得多的上限（列表可滚动）
// 分组不足此条数则并入「其他文件」（续114b）。没有这道闸，一个只返回 3 个文件的查询会得到
// 3 个标题配 3 条内容——标题比内容还多，比不分组更难看。这条阈值对实际观感的影响大于分类表本身。
const ENH_MIN_SECTION = 3;
// 预览面板（续115）：按住 ↓ 连续穿过结果时不能每项都发 IPC，故未命中缓存的取用防抖；
// 命中缓存则**立即出**（不等防抖），来回移动时面板不闪。
const PREVIEW_DEBOUNCE_MS = 130;
/// 预览元数据缓存的条数上限（续131d 从 300 改到 60，并从「整表清空」改为 LRU 淘汰）。
///
/// 改小的依据是实测：`get_large_icon` 单张 base64 **均值 43.9 KB**（最大 108 KB，
/// 见 apps.rs 的 `probe_large_icon_cost` 探针），300 条 ≈ **12.6 MB** —— 与整个文件索引
/// （续126 瘦身后 9.8 MB）同量级，对一个常驻后台的工具太重。60 条 ≈ 2.6 MB，
/// 而「会再看一眼」的项本来也就那么几条，命中率损失可忽略。
///
/// 淘汰策略必须**同时**换掉：原注释说「重取代价低，不值得上 LRU」，在预览是"一帧换好"时成立；
/// 续131d 之后重取要走「低清 → 淡入高清」，整表清空 = 所有项一起退回那个观感。
const PREVIEW_CACHE_MAX = 60;
/// 预览大图标共享表的上限（续131e，按 `iconKey` 而非路径计数）。
/// 常见扩展名撑死几十个，会撑大它的只有 exe/lnk（各有各的图标、键是自身路径）。
/// 100 条 ≈ 4.4 MB 封顶，同样走 LRU。
const LARGE_ICON_CACHE_MAX = 100;
// 增强搜索列表的 hover 选中驻留门槛（续118）。指针在某行连续停留超过这个时长才提交选中变更。
// 70ms 的依据：擦过一行通常 <30ms，有意停留远超 70ms，两者区分得干净；而预览面板本就有
// 130ms 元数据防抖，再叠 70ms 仍在既有延迟特征内，手感不会变钝。
const HOVER_DWELL_MS = 70;
const ENH_FILE_LIMIT_BUILTIN = 150;
const ENH_FILE_LIMIT_EVERYTHING = 500;
// 文件查询的防抖，**按引擎分档**（续131）。防抖的目的是压住"每敲一键一次查询"的开销，
// 那个开销两个引擎差着数量级，用同一个值必然有一边配错：
//   内置 = 纯内存读索引，实测 <5ms，加 IPC 往返也就百微秒级 → 150ms 里绝大部分是白等；
//   Everything = 跨进程 IPC + 全盘查询 + 5000 条候选池重排，量级完全不同，150ms 是它的保险。
// 故内置降到 50ms（仍能吃掉连续击键，正常打字相邻间隔 80~200ms），Everything 保持 150ms。
const ENH_DEBOUNCE_BUILTIN_MS = 50;
const ENH_DEBOUNCE_EVERYTHING_MS = 150;
const DRAG_THRESHOLD_PX = 8; // 剪贴板卡片按下后移动超过此距离才激活拖拽，防误触（短按仍走 onClick 粘贴）
const LASSO_THRESHOLD_PX = 6; // 中转区框选：按下后移动超过此距离才激活框选，防误触（纯点击空白不进多选）
const DRAG_OUT_THRESHOLD_PX = 12; // 中转条目拖出：按下后移动超过此距离才触发 OLE DoDragDrop（高于框选/卡片拖拽阈值，防误触）
const STAGE_MOAT_PX = 6; // 中转卡片"边缘缓冲带"：非多选态下、从卡片外沿此宽度内按下拖动→判为框选而非拖出（紧凑布局下框选难起手的补偿，续108）


// 启动器收藏条目：手动策展的常用 app/file/folder「托盘」，独立于 StageItem（左键动作契约不同：启动器=打开/启动，中转=取走粘贴）。
// 持久化到 store key "launcher-items"，不参与自动扫描；扫描链(filteredApps)仅供搜索，不再全量平铺到此面板。
interface LauncherItem {
  id: number;
  kind: "app" | "file" | "folder";
  name: string;
  /** 图标 data URL。**内存态字段**——渲染只读它；落盘前被 dehydrateLauncher 摘掉，换成 iconFile（续146） */
  icon?: string | null;
  /** 图标在 launcher_icons/ 下的文件名。**落盘态字段**——载入时经 load_launcher_icons 换回 icon（续146） */
  iconFile?: string;
  path: string;           // app=launch_app 的 path；file/folder=open_file 的 path
  ext?: string;           // file 显示图标用
}
const LAUNCHER_MAX = 200;
/// 续146 起废弃的 store key（功能已删，但 plugin-store 不会自动回收未知 key，会一直躺在 JSON 里）。
/// ⚠ 别把 `file-list` 加进来——它是只写不读的**老格式迁移兜底**，仍在 store 载入路径上用着。
const DEAD_STORE_KEYS = ["standalone-enh-hotkey", "stage-drag-out-enabled", "stage-drag-auto-hide"] as const;
/// stageThumbs 里给「中转 image 条目缩略图」用的键前缀（值是 stage_images/ 下的文件名，不是路径）。
/// 与真实路径键共用同一张表，是为了复用它已有的 pending 去重与淘汰逻辑（续146c）。
const STAGE_IMG_KEY = "simg:";
const launcherId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);


// ── 应用使用打分：频率为主 × 近期乘数（频率高且近期用过的排前）──
// score = count × 0.5^(距上次使用 / 半衰期)。30 天没用，权重掉一半。要调"近期"敏感度改这个常量。
const USAGE_HALFLIFE_S = 30 * 24 * 3600;
function usageScore(u: AppUsage | undefined, nowS: number): number {
  if (!u || u.count <= 0) return 0;
  return u.count * Math.pow(0.5, (nowS - u.last_used) / USAGE_HALFLIFE_S);
}

async function hideWorkbench() { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("hide_window"); } catch{} }

// ── 缩略图解码并发闸（性能优化步骤3：拖入/攒图流式化削峰）──
// 批量拖入 N 张全屏图时，若给每张裸起一个异步任务同时发起 get_*_thumbnail，Rust 会**并发**
// 解码 N 张原图（每张解码位图 ~25MB @3192×1970），瞬时峰值随 N 线性飙到 GB 级（场景B 拖10图 1000MB+）。
// 这里用固定并发上限的模块级任务队列把它们串流：同一时刻最多 THUMB_CONCURRENCY 张在解码，其余排队。
// 模块级（非组件内）是刻意的——闸要跨 stageThumbs / clipThumbs 两处、跨 effect 多次运行**全局共享**，
// 否则各自开一池、并发上限形同虚设。命中磁盘缓存的解码近乎瞬时，闸只对首次解码的冷路径起削峰作用。
const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbQueue: Array<() => void> = [];
function runThumbTask(task: () => Promise<void>) {
  const run = () => {
    thumbActive++;
    task().finally(() => {
      thumbActive--;
      const next = thumbQueue.shift();
      if (next) next();
    });
  };
  if (thumbActive < THUMB_CONCURRENCY) run(); else thumbQueue.push(run);
}

// ── 文件中转：转换 + 写剪贴板助手 ──
const stageId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000); // 稳定唯一 id（key/去重）
function fileEntryToStage(f: FileEntry): StageItem {
  const isImage = IMG_EXTS.includes(f.ext.toLowerCase());
  return { id: stageId(), type: "file", items: [{ path: f.path, name: f.name, ext: f.ext, isImage, icon: f.icon }], count: 1, name: f.name, ext: f.ext, isDir: f.isDir, size: f.size };
}
function clipToStage(c: ClipItem): StageItem {
  return { id: stageId(), type: c.type, content: c.content, items: c.items, count: c.count, name: c.items?.[0]?.name, orig_path: c.orig_path };
}
// 性能优化步骤2：剪贴板 image 条目的 content 已从前端 state 剥离（30 张 ≤1024px base64 会撑爆 JS 堆）。
// 真正需要原文的动作（复制/粘贴/拖出/入中转）按 time 向 Rust CLIP_CACHE 现取；文本 / 已带 content（如中转条目）者原样返回。
async function hydrateContent(item: { type: string; content?: string; time?: number }): Promise<string | undefined> {
  if (item.content || item.type !== "image" || item.time == null) return item.content;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("get_clip_content", { time: item.time })) ?? undefined;
}
// 只写当前系统剪贴板（不粘贴、不隐藏 overlay），复用现成 copy_* 命令；剪贴板卡片与中转条目共用
async function writeItemToClipboard(item: Pasteable) {
  const { invoke } = await import("@tauri-apps/api/core");
  if (item.type === "text") await invoke("copy_text_to_clipboard", { text: item.content });
  else if (item.type === "file" && item.items) await invoke("copy_files_to_clipboard", { paths: item.items.map(f => f.path) });
  else await invoke("copy_image_to_clipboard", { base64: (await hydrateContent(item)) ?? "", origPath: item.orig_path ?? null });
}

// 时钟：自持 state + 分钟对齐 tick，memo 化后其重渲**不牵动父组件 App**（续147 修 M1）。
// 原实现把 time state 放在 App 里、setInterval(1000) 每秒 setState → 3000 行 App 每秒 reconcile
// 一次（且 overlay 隐藏时仍在后台空转），而显示只到分钟精度、59/60 次结果相同。抽成 memo 叶子后
// 父树完全不受时钟影响；tick 对齐整分边界 → 后台唤醒从 60 次/分降到 1 次/分（贴合低占用目标）。
const Clock = memo(function Clock({ lang }: { lang: Lang }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTime(new Date().toLocaleTimeString(lang === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" }));
      const now = new Date();
      const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
      tid = setTimeout(tick, msToNextMinute); // 只在跨分钟时下一次重渲
    };
    tick(); // 立即出一次，无空白
    return () => clearTimeout(tid);
  }, [lang]);
  return <span className="clock">{time}</span>;
});

// 高亮命中字符（色用 --accent 兜底，贴合主题系统）
function HighlightText({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<span key={start} style={{ color: "var(--accent)", fontWeight: 600 }}>{text.slice(start, end + 1)}</span>);
    cursor = end + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// 自定义右键菜单（浮层）
type CtxMenuItem = { label: string; action: () => void; disabled?: boolean };
type CtxMenu = { x: number; y: number; items: CtxMenuItem[] } | null;

// 设置条目（左侧导航）；随后续开发逐步扩展，每项独立成区
const SETTINGS_TABS = [
  { id: "general",   Icon: IconSettings,  label: "常规" },
  { id: "launcher",  Icon: IconRocket,    label: "启动台" },
  { id: "stage",     Icon: IconBox,       label: "中转站" },
  { id: "clipboard", Icon: IconClipboard, label: "剪贴板" },
  { id: "search",    Icon: IconSearch,    label: "搜索" },
  { id: "hotkeys",   Icon: IconKeyboard,  label: "快捷键" },
  { id: "about",     Icon: IconInfo,      label: "关于" },
] as const;
type SettingsTab = typeof SETTINGS_TABS[number]["id"];

const SHORTCUTS = [
  { l: "文件管理器", Icon: IconExplorer,   a: "explorer.exe"    },
  { l: "下载",       Icon: IconDownload,   a: "shell:Downloads" },
  { l: "桌面",       Icon: IconMonitor,    a: "shell:Desktop"   },
  { l: "终端",       Icon: IconTerminal,   a: "wt"              },
  { l: "计算器",     Icon: IconCalculator, a: "calc"            },
  { l: "设置",       Icon: IconSettings,   a: "ms-settings:"   },
] as const;

// 应用启动「放大暂留」动画（Mac 启动台式）：点击后图标放大淡出、覆盖层淡出露桌面，暗示刚启动了什么。
// 时长可调；放大幅度在 CSS @keyframes launch-pop 里（克制档 scale 1.4）。
const LAUNCH_ANIM_MS = 200;
// 全局轻提示（toast）驻留时长，须与 App.css 的 @keyframes toast-flash 总时长一致（进 12% / 停 / 出 18%）。
// 「一闪而过」定位：只报「做成了什么」，不承载可交互内容、不要求用户确认、绝不拦截点击。
const TOAST_MS = 1600;
// 「加入启动台/中转区」的结果：重复与超上限此前都是静默失败（early-return / slice 丢弃），
// 调用方分辨不出，直接报「已添加」会说谎。三态回报让提示与实际结果一致。
type AddResult = "added" | "duplicate" | "full";
// 顶层克隆浮层的数据：图标 + 点击瞬间的屏幕坐标（getBoundingClientRect）。
// 用克隆而非就地 transform——避开 .app-grid/.app-panel/.main-area 的 overflow 裁剪。
// 续142b：克隆改 cloneNode(源图标容器)，尺寸/底色由克隆自身携带、精确贴合，不再靠 React 重渲 + 猜百分比（旧 75% → 比磁贴小一圈、点击瞬间"缩一下"）。

// 传给 FileGlyph 的最小参数（剪贴板 / 中转 / 启动动画共用）
type FileGlyphArgs = { cat?: FileCat; ext?: string; isDir?: boolean; isImage?: boolean };

// 剪贴板条目 → FileGlyph 引数（多文件=box、图片=image、其余按扩展名）
function fileGlyphFor(item: ClipItem): FileGlyphArgs {
  const items = item.items ?? [];
  if (items.length > 1) return { cat: "box" };
  const first = items[0];
  if (!first) return { cat: "generic" };
  if (first.isImage) return { isImage: true }; // 剪贴板图片（可能无扩展名）
  const ext = first.ext || first.path.split(".").pop() || "";
  return { ext };
}

// ── 增强搜索结果（Ctrl+K 独立视图层；范围=应用 + 中转区 file 条目）──
type EnhResult =
  | { kind: "app";   app: AppInfo;  ranges: [number, number][] }
  | { kind: "stage"; item: StageItem; name: string; ranges: [number, number][] }
  | { kind: "clip";  item: ClipItem; name: string; ranges: [number, number][] } // 剪贴板历史结果；activate=取走粘贴（copyAndPaste）
  // 文件系统结果（无 ranges，Rust 侧已打分排序）。iconKey = Rust 算好的「图标身份」
  // （目录 / 扩展名 / exe·lnk 用自身路径），续126 起随结果返回；预览大图标按它去重，见 largeIconRef。
  | { kind: "fs";    path: string; name: string; ext: string; isDir: boolean; icon?: string | null; iconKey?: string };

// 结果唯一键：渲染 key + 预览缓存键 + 预览竞态守卫共用一套，避免三处各写一份跑偏
const enhKey = (r: EnhResult) =>
  r.kind === "app" ? "app:" + r.app.path : r.kind === "stage" ? "stage:" + r.item.id
  : r.kind === "clip" ? "clip:" + r.item.time : "fs:" + r.path;
// 结果对应的真实文件路径（取不到=空串，如纯文本/图片剪贴板项）。
// 与渲染里的 rPath 不同：那个只服务「加入启动台/中转」的按钮反馈、故意排除 stage/clip；
// 预览要对 stage/clip 里的文件项也显示位置与时间，所以单独一份。
/// 把 base64 图先解码好再交给渲染（续131d）。
/// 不这么做的话，`<img>` 换 src 的那一帧浏览器可能还没解完码，替换会多出一个中间态。
/// 失败一律当成功返回——预解码只是为了让替换更干净，不该让取不到图标变成取不到面板。
async function preloadImg(src: string | null): Promise<void> {
  if (!src) return;
  try {
    const im = new Image();
    im.src = src;
    if (im.decode) await im.decode();
  } catch { /* 解码失败照常渲染，浏览器会自己处理 */ }
}

const enhPath = (r: EnhResult) =>
  r.kind === "app" ? r.app.path : r.kind === "fs" ? r.path : (r.item.items?.[0]?.path ?? "");

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stage, setStage] = useState<StageItem[]>([]); // 文件中转区：混合条目（文件/文本/图片）
  const [launcher, setLauncher] = useState<LauncherItem[]>([]); // 启动器收藏托盘（手动策展，持久化）
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
  // 拼音派生表（续131）：原名 → 拼音变体。派生在 Rust，这里只缓存结果。
  // 空数组 = 已查过且该名无汉字（与"还没查过"区分开，避免反复重查纯英文名）。
  const [pinyin, setPinyin] = useState<PinyinTable>({});
  const [store, setStore] = useState<any>(null);
  const [clipboard, setClipboard] = useState<ClipItem[]>([]);
  const [theme, setTheme] = useState<"dark"|"light"|"system">("dark");
  const [lang, setLang] = useState<Lang>("zh"); // 界面语言，默认中文，持久化到 store（与 Rust 托盘菜单同步）
  const t = useMemo(() => makeT(lang), [lang]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [copiedTime, setCopiedTime] = useState<number|null>(null); // 最近"只复制"的剪贴板项 time，用于按钮 ✓ 反馈
  const [copiedStageId, setCopiedStageId] = useState<number|null>(null); // 中转条目"复制到剪贴板"的 ✓ 反馈
  const [imgCacheCleared, setImgCacheCleared] = useState(false); // 设置面板「清空缓存」✓ 反馈
  const [thumbCacheCleared, setThumbCacheCleared] = useState(false); // 中转区缩略图缓存「清空」✓ 反馈（续99f）
  const [dismissing, setDismissing] = useState(false); // 覆盖层「快速淡出露桌面」——启动应用与剪贴板粘贴共用同一套消失观感
  const [clipCacheMax, setClipCacheMax] = useState(20); // 剪贴板历史保存条数（与 Rust CLIP_CACHE_MAX_RUNTIME 同步）
  const [stageMax, setStageMax] = useState(STAGE_MAX_DEFAULT); // 中转区上限（纯前端，无需 Rust 同步）
  const [hotkeyCombo, setHotkeyCombo] = useState("ctrl+space"); // 呼出热键（与 Rust HOTKEY_VK_KEYS 同步）
  const [hotkeyInput, setHotkeyInput] = useState("ctrl+space"); // 设置面板输入框编辑态
  const [hotkeyError, setHotkeyError] = useState(""); // 切换失败提示（如被其他应用占用），3s 后自动清
  const [enhHotkey, setEnhHotkey] = useState("ctrl+k"); // 增强搜索呼出键（应用内快捷键，纯前端，不经 Rust）
  const [enhHotkeyInput, setEnhHotkeyInput] = useState("ctrl+k"); // 增强搜索键输入框编辑态
  const [enhHotkeyError, setEnhHotkeyError] = useState(""); // 增强搜索键校验提示，2.5s 自清
  const [recording, setRecording] = useState<null|"main"|"enh">(null); // 录制态：录哪个键（监听物理按键写回对应输入框，不自动应用）
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null); // 自定义右键菜单
  const [autostartEnabled, setAutostartEnabled] = useState(false); // 开机自启
  const ctxMenuRef = useRef<CtxMenu>(null); // Esc 处理用（闭包快照避免加入 keydown deps）
  const clipCacheMaxRef = useRef(20); clipCacheMaxRef.current = clipCacheMax; // 供 clipboard-update 闭包读最新值
  const stageMaxRef = useRef(STAGE_MAX_DEFAULT); stageMaxRef.current = stageMax; // 供 files-dropped 闭包读最新值
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const appsRef = useRef<AppInfo[]>(apps); appsRef.current = apps; // 供 [visible] 兜底扫描闭包读最新 apps（apps-ready 是否已填充）
  const launchingRef = useRef(false); // 防连点/重复触发（setState 异步，用 ref 即时锁）
  // 启动放大暂留期间被点的那个图标：即时隐藏它，让顶层克隆独自弹出，否则原图标随覆盖层慢淡出 → 与克隆同框（"两个图标"）。复位时还原。
  const launchSrcElRef = useRef<HTMLElement|null>(null);
  // 顶层启动克隆节点（cloneNode 生成，挂在 dragLayer）：复位/下次启动前移除，防残留。
  const launchCloneNodeRef = useRef<HTMLElement|null>(null);
  const stageRef = useRef<StageItem[]>(stage); stageRef.current = stage; // 给 []-注册的 files-dropped 监听取最新 stage（避开闭包过期）
  const launcherRef = useRef<LauncherItem[]>(launcher); launcherRef.current = launcher; // 给 []-注册监听用（S3b 拖入落点会用到，先备好）
  const storeRef = useRef<any>(null); storeRef.current = store;
  const [stageSel, setStageSel] = useState<Set<number>>(new Set<number>()); // 中转区多选（选中的 StageItem.id）
  const [stageMultiselect, setStageMultiselect] = useState(false); // 多选模式开关（显式进入，非按住修饰键）
  const [stageLayout, setStageLayout] = useState<"list"|"grid">("list"); // 中转区布局：列表 / 方格
  const [dragoutAutoClose, setDragoutAutoClose] = useState(true); // 中转站拖出后是否自动关闭窗口（与 Rust DRAGOUT_AUTO_CLOSE 同步）
  const dragoutAutoCloseRef = useRef(dragoutAutoClose); dragoutAutoCloseRef.current = dragoutAutoClose; // 供 drag-out-done 监听闭包读最新值
  const [stagePersist, setStagePersist] = useState(false); // 中转站文件持久化：开启后移出/拖出不再自动移除条目，需手动删除（纯前端，无需 Rust 同步）
  const stagePersistRef = useRef(stagePersist); stagePersistRef.current = stagePersist; // 供 drag-out-done 监听闭包读最新值
  const [showShortcuts, setShowShortcuts] = useState(true); // 中转区下方「快捷入口」行是否显示（纯前端 store 持久化）；关闭时空间归还给中转区 drop-area（flex:1 自动铺满）
  // 续99b：中转区图片文件缩略图缓存（path → data URL）。由 Rust get_stage_thumbnail 生成小图，避免前端直接加载原图全分辨率致内存暴涨/卡顿。仅会话内内存缓存，不落盘。
  const [stageThumbs, setStageThumbs] = useState<Record<string,string>>({});
  const stageThumbPendingRef = useRef<Set<string>>(new Set()); // 已发起/已失败的 path（失败不重试，卡片回退 emoji）
  // 剪贴板图片缩略图（性能优化步骤1）：键=条目 time，值=~320px 小缩略图 data URL。
  // 列表原先直接渲染 ≤1024px 的 content → 每张 ≈4MB GPU 纹理。改为渲染小缩略图后纹理面积降到 ≈1/10。
  const [clipThumbs, setClipThumbs] = useState<Record<number,string>>({});
  const clipThumbPendingRef = useRef<Set<number>>(new Set()); // 已发起的 time（去重，失败回退整图见下方 catch）
  // 续100：中转区 file 条目「原文件失踪」路径集。每次呼出时后台批量 exists() 扫一遍（check_stage_paths）。
  // 不用实时文件监听（分散父目录 watcher 代价高/网络盘不支持），只在呼出这个「该看的时刻」懒扫。
  // 处理按「拖出移除」同一豁免规则（见 scanStageMissing）：`!persist && !pinned` 直接移除；固定/持久化则留存并进本集合，供 ⚠️ 标记。
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set()); // 复用既有 stageRef（行 216）读最新 stage
  const [batchCopied, setBatchCopied] = useState(false); // 批量复制 ✓ 反馈
  const stageSelRef = useRef<Set<number>>(new Set<number>()); stageSelRef.current = stageSel; // 供 Esc keydown 闭包读最新（仿 ctxMenuRef 模式）
  const stageMultiselectRef = useRef(false); stageMultiselectRef.current = stageMultiselect; // 同上
  const stageAnchorRef = useRef<number|null>(null); // shift 区间选择锚点 index
  // 剪贴板卡片长按拖拽到中转区（纯前端，Pointer Events，移动超阈值才激活）。
  // 唯一用途 = 拖进中转区，落到别处一律无操作——别给它加第二个落点语义。
  // 续109 性能铁律：坐标只进 ref + 直写 ghost DOM style，**绝不进 React state**。
  //   （原实现每次 pointermove 都 setDragState → 重渲整个 App（三栏 + 全部卡片）→ 掉帧不跟手。
  //     与 launcher-drag-ghost / stage-drag-ghost 同款「零 React 渲染」跟手方案对齐。）
  // state 只留 item：激活时挂载 ghost 渲染一次、收尾时卸载一次，全程仅 2 次渲染。
  const [clipDragItem, setClipDragItem] = useState<ClipItem | null>(null);
  const clipDragRef = useRef<
    { item: ClipItem; originX: number; originY: number; x: number; y: number; active: boolean; dropRect: DOMRect | null } | null
  >(null);
  const clipGhostRef = useRef<HTMLDivElement | null>(null); // ghost 节点，move 时直写 style.left/top
  const dropAreaRef = useRef<HTMLDivElement | null>(null); // 中转区 .drop-area，命中检测用
  const launcherDropRef = useRef<HTMLDivElement | null>(null); // 启动器 .app-grid，OLE 拖入落点判断用
  const dragLayerRef = useRef<HTMLDivElement | null>(null); // 顶层拖拽预览层，承载 DOM clone ghost
  const suppressClickRef = useRef(false); // 激活拖拽后抑制随之而来的 onClick（防拖拽落点误触发粘贴）
  // 中转区鼠标框选多选（续70，纯前端）：在 .drop-area 空白处按下拖拽，扫过的条目实时选中
  type LassoState = { active: boolean; origin: { x: number; y: number }; current: { x: number; y: number } };
  const [lassoState, setLassoState] = useState<LassoState>({ active: false, origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } });
  const lassoStateRef = useRef(lassoState); lassoStateRef.current = lassoState; // 供 move/up 闭包读最新值（仿 stageSelRef 渲染时同步）
  const lassoArmedRef = useRef(false); // down 通过排除判定才布防；move/up 据此区分「框选拖拽」与「条目上拖拽」
  // 续143：框选激活时快照一次卡片 rect（框选期间卡片不移动，进入多选态只是 header 内换按钮、不改卡片布局），
  // move 只对缓存矩形求交，避免逐帧 querySelectorAll+getBoundingClientRect 的强制同步布局（仿 reorder 的 rects 快照）。
  const lassoRectsRef = useRef<{ id: number; left: number; top: number; right: number; bottom: number }[]>([]);
  // 中转条目拖出（续71）：按下记录起点，move 超阈值 → emit drag-out-begin（Rust 接管 OLE DoDragDrop）
  // mode：idle=未决出/pending；reorder=区内重排中（续87）；native=已交给 Rust OLE，JS 侧不再处理
  const dragOutRef = useRef<{ pressing: boolean; itemId: number | null; origin: { x: number; y: number }; draggedIds: number[]; mode: "idle" | "reorder" | "native" | "lasso" }>({ pressing: false, itemId: null, origin: { x: 0, y: 0 }, draggedIds: [], mode: "idle" });
  // 续97：本次 OLE 拖出的落点其实落回自身 overlay（内部拖，非真正投放到外部）→ files-dropped 置位、drag-out-done 据此不删条目。
  const droppedOnSelfRef = useRef(false);
  // 续110：本次原生拖出的来源——中转站(stage) 还是剪贴板(clip)。drag-out-done handler 据此分流：
  //   clip 来源"拖出后剪贴板不变"，不走任何删条目/copyAndPaste 逻辑（中转站的 draggedIds 与其无关）。
  const dragOutSourceRef = useRef<"stage" | "clip">("stage");
  const suppressStageClickRef = useRef(false); // 拖出触发后抑制随之而来的 onClick（防误触取走粘贴）
  // 中转区内重排（续87，仿启动台 FLIP 方案）：单项拖动全程走此逻辑，ghost 跟手 + FLIP 排序。
  // 续143：界面开着时**永不自动升级为原生拖出**（已删旧的「光标离开 .drop-area 边界即升级」逻辑）——
  // 去外部的唯一触发是拖动中按热键手动隐藏界面（stage-drag-hotkey → beginNativeDragOut，见 start_drag_out 链路）。
  const stageReorderRef = useRef<{
    active: boolean; tiles: HTMLElement[]; rects: { left: number; top: number; width: number; height: number }[];
    ghostEl: HTMLElement | null; srcEl: HTMLElement | null; srcIdx: number; insertIdx: number;
    grabOffsetX: number; grabOffsetY: number;
  }>({ active: false, tiles: [], rects: [], ghostEl: null, srcEl: null, srcIdx: -1, insertIdx: -1, grabOffsetX: 0, grabOffsetY: 0 });
  // 启动台排序拖拽（续74重写）：全 DOM 直操作 + window 全局监听，绕过 React 渲染保证跟手
  // ghost 也走 DOM clone，不经 React state/ref，确保拖拽预览一定可见。
  const launcherDragActiveRef = useRef(false); // 是否已超阈值激活
  const launcherDragInsertRef = useRef(-1); // 当前插入位置，-1=未激活
  const launcherLandingRef = useRef(false); // 松手回落动画进行中：守卫此窗口内不被新拖拽采集脏几何
  const suppressLaunchClickRef = useRef(false); // 激活排序拖拽后抑制随之而来的 onClick
  // 外部文件拖入窗口时的悬停高亮（HTML5 dragenter/dragleave，与 OLE IDropTarget 正交）
  const [fileDragOver, setFileDragOver] = useState(false);
  // 增强搜索（Ctrl+K 独立全屏视图层；同一 overlay 内的视图层，不开新窗、不碰 show/hide/焦点/粘贴高危区）
  const [enhOpen, setEnhOpen] = useState(false);
  const [enhPinned, setEnhPinned] = useState(false); // true=打字触发（顶栏为输入框，不覆盖顶栏）；false=Ctrl+K触发（全覆盖+独立搜索框）
  const [enhQuery, setEnhQuery] = useState("");
  const [enhSelIdx, setEnhSelIdx] = useState(0);
  const [launcherSelIdx, setLauncherSelIdx] = useState(-1); // 启动器网格键盘选中项（-1=未选中，焦点在搜索框）
  const [enhAdded, setEnhAdded] = useState<{path:string;target:"stage"|"launcher"}|null>(null); // 操作按钮 ✓ 反馈
  const enhInputRef = useRef<HTMLInputElement>(null);
  const enhResultsRef = useRef<HTMLDivElement>(null); // 结果列表容器：选中高亮命令式加 class 时的查询根（续127）
  const enhOpenRef = useRef(false); enhOpenRef.current = enhOpen; // 供 Esc keydown 闭包读最新
  const enhPinnedRef = useRef(false); enhPinnedRef.current = enhPinned; // 供 onChange 闭包读最新 pinned 状态
  const pageSearchForcedRef = useRef(false); // enhanced 模式下用户主动按 Ctrl+K 切到界面搜索，本次呼出有效
  // 文件系统搜索结果（S4b）：增强搜索 Tier 2，来自 Rust 后台索引 search_files；150ms 防抖查询；icon 随结果同步返回
  const [fsResults, setFsResults] = useState<{ path: string; name: string; ext: string; isDir: boolean; icon?: string | null; iconKey?: string }[]>([]);
  const [indexReady, setIndexReady] = useState(false); // 文件索引是否就绪（未就绪时显示「建立中…」，不阻塞 Tier 1）
  // 搜索引擎（续57）：内置自建索引 / 可选 Everything；持久化 store，运行时由 Rust set_search_engine 应用
  const [searchEngine, setSearchEngine] = useState<"builtin"|"everything">("builtin");
  const [searchDirs, setSearchDirs] = useState<string[]>([]); // 内置引擎额外扫描根目录（如 D:\）
  const [dirPicking, setDirPicking] = useState(false); // 文件夹选择框是否已弹出（防重复弹）
  const [launcherPicking, setLauncherPicking] = useState(false); // 启动台「浏览…」选择框是否已弹出（同上，防重入叠弹）
  // ── 全局轻提示（续113）──
  // 定位：补「无锚点操作」的反馈空白——右键菜单项、模态里点完就关的按钮，动作一完成界面上什么都没变，
  // 用户不知道成没成。**不替换已有的 7 处按钮原地 ✓ 反馈**（copiedTime/enhAdded/imgCacheCleared…）：
  // 那些反馈与按钮同位、指向明确，比飘到屏幕另一头的 toast 更好，换成 toast 是倒退。
  // id 用自增计数器：同一句提示连点两次也能重放动画（靠 key 重挂 DOM 节点重启 CSS animation）。
  const [toast, setToast] = useState<{id:number;msg:string}|null>(null);
  const toastTimerRef = useRef<number|null>(null);
  const toastIdRef = useRef(0);
  const [everythingAvailable, setEverythingAvailable] = useState(false); // Everything 是否可用（DLL 加载且服务运行）
  const [evtRedetected, setEvtRedetected] = useState(false); // 「重新检测」✓ 反馈
  // 呼出默认搜索模式：page=顶栏界面搜索（默认），enhanced=直接进增强搜索层
  const [searchDefaultMode, setSearchDefaultMode] = useState<"page"|"enhanced">("page");
  const searchDefaultModeRef = useRef<"page"|"enhanced">("page");
  searchDefaultModeRef.current = searchDefaultMode;
  // 启动器「添加应用」picker 模态（复用 settings-modal 样式）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerOpenRef = useRef(false); pickerOpenRef.current = pickerOpen; // 供 Esc keydown 闭包读最新
  const pickerInputRef = useRef<HTMLInputElement>(null);

  // 同步 ctxMenu ref（供 keydown 闭包读取，无需加入 deps）
  useEffect(() => { ctxMenuRef.current = ctxMenu; }, [ctxMenu]);
  // 点外任意处关闭右键菜单（mousedown 先于 click，不影响 click 回调）
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  // ── 主题：把 theme 解析为 data-theme（"system" 跟随 OS prefers-color-scheme 并实时响应切换）──
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { const resolved = theme==="system" ? (mq.matches?"dark":"light") : theme; document.documentElement.setAttribute("data-theme", resolved); };
    apply();
    if (theme==="system") { mq.addEventListener("change", apply); return ()=>mq.removeEventListener("change", apply); }
  }, [theme]);

  // ── Store ──
  useEffect(() => { (async()=>{ try { const {load}=await import("@tauri-apps/plugin-store"); const s=await load("workbench-data.json",{autoSave:true,defaults:{}}); setStore(s); const raw=await s.get<Record<string,number|AppUsage>>("app-frequency")??{}; const nowS=Math.floor(Date.now()/1000); const usage:Record<string,AppUsage>={}; for(const[k,v]of Object.entries(raw)){ usage[k]= typeof v==="number" ? {count:v,last_used:nowS} : v; } setAppUsage(usage); const savedTheme=await s.get<string>("theme"); if(savedTheme==="dark"||savedTheme==="light"||savedTheme==="system") setTheme(savedTheme); const savedLang=await s.get<string>("language"); const initLang:Lang=(savedLang==="en"?"en":"zh"); setLang(initLang); try{const{invoke}=await import("@tauri-apps/api/core");await invoke("set_tray_language",{lang:initLang});}catch{} const savedMax=await s.get<number>("clip-cache-max"); if(typeof savedMax==="number"&&savedMax>=10&&savedMax<=100){ setClipCacheMax(savedMax); clipCacheMaxRef.current=savedMax; try{const{invoke}=await import("@tauri-apps/api/core");await invoke("set_clip_cache_max",{n:savedMax});}catch{} } const savedStageMax=await s.get<number>("stage-max"); let stageMaxLoaded:number=STAGE_MAX_DEFAULT; if(typeof savedStageMax==="number"&&(STAGE_MAX_OPTIONS as readonly number[]).includes(savedStageMax)){ stageMaxLoaded=savedStageMax; setStageMax(savedStageMax); stageMaxRef.current=savedStageMax; } const savedHotkey=await s.get<string>("hotkey-combo"); if(typeof savedHotkey==="string"&&savedHotkey.trim()){const hk=savedHotkey.trim();setHotkeyCombo(hk);setHotkeyInput(hk);} /* 不 invoke set_hotkey——Rust setup 已按 store 同步落地，避免重复注册 */ const savedEnh=await s.get<string>("enh-hotkey"); if(typeof savedEnh==="string"&&savedEnh.trim()&&parseComboStr(savedEnh.trim())){const eh=savedEnh.trim();setEnhHotkey(eh);setEnhHotkeyInput(eh);} /* 增强搜索键纯前端，无需 invoke */ const savedEngine=await s.get<string>("search-engine"); const savedDirs=await s.get<string[]>("search-dirs")??[]; const eng:("builtin"|"everything")=savedEngine==="everything"?"everything":"builtin"; setSearchEngine(eng); setSearchDirs(savedDirs); try{const{invoke}=await import("@tauri-apps/api/core"); if(savedDirs.length){await invoke("set_search_dirs",{dirs:savedDirs});} /* 空目录无需 invoke：默认已扫用户目录，避免启动期冗余重建 */ await invoke("set_search_engine",{engine:eng});}catch{} const savedStage=await s.get<StageItem[]>("stage-items"); if(savedStage&&savedStage.length){ let loaded=savedStage.slice(0,stageMaxLoaded); /* 续146b 补水：contentFile → data URL（老条目仍内嵌 content，原样可用，由迁移 effect 搬走） */ if(loaded.some(it=>it.contentFile)){ try{ const{invoke}=await import("@tauri-apps/api/core"); const imgMap=await invoke<Record<string,string>>("load_stage_images"); /* 文件还在→补回 content；已不在→连 contentFile 一起摘掉（同 iconFile 那条退化路径） */ loaded=loaded.map(it=>{ if(!it.contentFile) return it; const hit=imgMap[it.contentFile]; if(hit) return {...it,content:hit}; const {contentFile:_gone,...rest}=it; return rest; }); }catch{/* 整体取不到（瞬时失败）→ 保留 contentFile，下次启动再试 */} } loaded.forEach(it=>{ if(it.contentFile) stageContentFileRef.current.set(it.id,it.contentFile); }); setStage(loaded); scanStageMissing(loaded); /* 续100：启动即扫一遍失踪（重启后原文件可能已被删） */ } else { const fps=await s.get<string[]>("file-list")??[]; if(fps.length){ const {invoke}=await import("@tauri-apps/api/core"); const items:StageItem[]=[]; for(const fp of fps.slice(0,stageMaxLoaded)){ try { items.push(fileEntryToStage(await invoke<FileEntry>("get_file_info",{path:fp}))); } catch{} } setStage(items); scanStageMissing(items); } } const savedLauncher=await s.get<LauncherItem[]>("launcher-items"); if(savedLauncher&&savedLauncher.length){ let items=savedLauncher.slice(0,LAUNCHER_MAX); /* 续146 补水：iconFile → data URL（老条目仍内嵌 icon，原样可用，由下方迁移 effect 搬走） */ if(items.some(it=>it.iconFile)){ try{ const{invoke}=await import("@tauri-apps/api/core"); const iconMap=await invoke<Record<string,string>>("load_launcher_icons"); /* 文件还在→补回 icon；文件已不在（手动删/异常清理）→ 连 iconFile 一起摘掉：否则该条目「有 iconFile 却永远补不出 icon」，图标回填每次启动白跑一轮、且因 dehydrate 认旧 iconFile 而永远存不下来 */ items=items.map(it=>{ if(!it.iconFile) return it; const hit=iconMap[it.iconFile]; if(hit) return {...it,icon:hit}; const {iconFile:_gone,...rest}=it; return rest; }); }catch{/* 整体取不到（瞬时失败）→ 保留 iconFile，下次启动再试 */} } items.forEach(it=>{ if(it.iconFile) launcherIconFileRef.current.set(it.id,it.iconFile); }); setLauncher(items); } const savedStageLayout=await s.get<string>("stage-layout"); if(savedStageLayout==="list"||savedStageLayout==="grid")setStageLayout(savedStageLayout); const savedDragoutAutoClose=await s.get<boolean>("dragout-auto-close"); if(typeof savedDragoutAutoClose==="boolean"){ setDragoutAutoClose(savedDragoutAutoClose); try{const{invoke}=await import("@tauri-apps/api/core");await invoke("set_dragout_auto_close",{enabled:savedDragoutAutoClose});}catch{} } const savedStagePersist=await s.get<boolean>("stage-persist"); if(typeof savedStagePersist==="boolean"){ setStagePersist(savedStagePersist); } const savedShowShortcuts=await s.get<boolean>("show-shortcuts"); if(typeof savedShowShortcuts==="boolean"){ setShowShortcuts(savedShowShortcuts); } const savedSearchMode=await s.get<string>("search-default-mode"); if(savedSearchMode==="enhanced"||savedSearchMode==="page")setSearchDefaultMode(savedSearchMode as "enhanced"|"page"); /* 续146：清掉已删功能残留的死 key（plugin-store 不回收未知 key，会一直躺在 JSON 里） */ let pruned=false; for(const k of DEAD_STORE_KEYS){ try{ if(await s.delete(k)) pruned=true; }catch{} } if(pruned){ try{ await s.save(); }catch{} } } catch{} })(); }, []);

  // ── 开机自启：启动时读取当前状态 ──
  useEffect(() => { (async()=>{ try { const {invoke}=await import("@tauri-apps/api/core"); const enabled=await invoke<boolean>("plugin:autostart|is_enabled"); setAutostartEnabled(enabled); } catch{} })(); }, []);

  // 续146b：id → stage_images/ 文件名（同 launcherIconFileRef，只为省掉重复 invoke，不参与渲染）
  const stageContentFileRef = useRef<Map<number,string>>(new Map());
  // 续146b 脱水：image 条目的 base64 `content` 落成 stage_images/ 下的 PNG，持久化形态只留 contentFile。
  // 实测单条 image 内嵌就 319.9KB，而 plugin-store 是**整文件重写** → 每次中转拖动/固定/排序都在重写它。
  // **只动 image**：text 的 content 就是正文（几 KB，落文件反而更糟）、file 靠 items[].path 本就无内嵌。
  // 消费方（copyAndPaste / 拖出 / 渲染 / 去重）读的都是**内存态**，故与启动台图标同理：渲染与消费链零改动。
  const dehydrateStage = useCallback(async (list:StageItem[]):Promise<StageItem[]> => {
    const known = stageContentFileRef.current;
    const pending = list.map((it,i)=>({it,i})).filter(({it})=> it.type==="image" && it.content && !it.contentFile && !known.has(it.id));
    if (pending.length) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const files = await invoke<(string|null)[]>("save_stage_images", { images: pending.map(({it})=>it.content!) });
        pending.forEach(({it},k)=>{ const f=files[k]; if(f) known.set(it.id,f); });
      } catch {}
    }
    return list.map(it => {
      if (it.type !== "image") return it;
      const contentFile = it.contentFile ?? known.get(it.id);
      if (!contentFile) return it;                 // 落盘失败 → 原样带 content 落盘（宁可大，不可丢图）
      const { content:_omit, ...rest } = it;
      return { ...rest, contentFile };
    });
  }, []);
  // 续146b：中转条目落盘的**唯一出口**。所有写 `stage-items` 的地方都必须走它——
  // 直接 `store.set("stage-items", list)` 会把内存态里内嵌的 base64 content 原样写回 JSON、抵消脱水
  // （5 处监听器为避开闭包过期而用 storeRef 直写，正是这种情况，已全部改道到此）。
  // 用 storeRef 而非 store state + 依赖恒稳的 dehydrateStage → 自身标识稳定，[]-deps 监听器可安全捕获。
  const persistStage = useCallback(async (list:StageItem[]) => {
    const s = storeRef.current; if(!s) return;
    try { await s.set("stage-items", await dehydrateStage(list)); await s.save(); } catch {}
  }, [dehydrateStage]);
  const saveStage = useCallback(async (list:StageItem[]) => {
    setStage(list);                                 // 先上屏（内存态保留 content）
    await persistStage(list);
  }, [persistStage]);
  // 中转条目「固定/保留」开关（续99）：点亮后拖出成功也不自动移除（豁免非持久化模式的移除）。落盘进 stage-items，重启保留。
  const toggleStagePin = useCallback((id:number) => { saveStage(stageRef.current.map(x=>x.id===id?{...x,pinned:!x.pinned}:x)); }, [saveStage]);
  // 续146：id → launcher_icons/ 文件名。存在 ref 而非 state——它只服务于「下次落盘不必重复 invoke」，
  // 不影响任何渲染；放进 state 会引来「落盘回填与用户新操作互相覆盖」的竞态。
  const launcherIconFileRef = useRef<Map<number,string>>(new Map());
  // 续146 脱水：把内嵌的 base64 图标落成 launcher_icons/ 下的 PNG，返回**只含文件名**的持久化形态。
  // 原先每条内嵌 ≈5.5KB base64、73 条把 store 撑到 400KB（占 98%），而 plugin-store 是整文件重写
  // → 每次中转/启动台改动都重写这 400KB。脱水后 store ≈12KB。
  // 失败降级：某条落盘失败就保留它的内嵌 icon（宁可 JSON 大，也绝不把图标弄丢）。
  const dehydrateLauncher = useCallback(async (list:LauncherItem[]):Promise<LauncherItem[]> => {
    const known = launcherIconFileRef.current;
    const pending = list.map((it,i)=>({it,i})).filter(({it})=> it.icon && !it.iconFile && !known.has(it.id));
    if (pending.length) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const files = await invoke<(string|null)[]>("save_launcher_icons", { icons: pending.map(({it})=>it.icon!) });
        pending.forEach(({it},k)=>{ const f=files[k]; if(f) known.set(it.id,f); });
      } catch {}
    }
    return list.map(it => {
      const iconFile = it.iconFile ?? known.get(it.id);
      if (!iconFile) return it;                    // 落盘失败/本就无图标 → 原样带 icon 落盘
      const { icon:_omit, ...rest } = it;          // 有文件名了才摘 icon
      return { ...rest, iconFile };
    });
  }, []);
  // 启动台落盘的**唯一出口**（同 persistStage 的理由：绕过它直写会把内嵌 base64 图标写回 JSON）。
  const persistLauncher = useCallback(async (list:LauncherItem[]) => {
    const s = storeRef.current; if(!s) return;
    try { await s.set("launcher-items", await dehydrateLauncher(list)); await s.save(); } catch {}
  }, [dehydrateLauncher]);
  const saveLauncher = useCallback(async (list:LauncherItem[]) => {
    setLauncher(list);                              // 先上屏（内存态保留 icon，渲染层零改动）
    await persistLauncher(list);
  }, [persistLauncher]);
  // 启动台文件/文件夹图标回填：历史存的旧条目 icon 为 null（走 Solar 兜底），这里补取系统默认图标（与桌面一致）。
  // tried 集合防止对提取失败（返回 null）的路径反复 invoke；每个缺图路径只尝试一次。
  const launcherIconTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const need = launcher
      .filter(it => (it.kind==="file"||it.kind==="folder") && !it.icon && !launcherIconTriedRef.current.has(it.path))
      .map(it => it.path);
    if (!need.length) return;
    need.forEach(p => launcherIconTriedRef.current.add(p));
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const res = await invoke<[string, string|null][]>("get_file_icons", { paths: need });
        if (cancelled) return;
        const map = new Map(res);
        const cur = launcherRef.current;
        // 仅当确有取到图标时才写回并持久化，避免无意义的 store 写入
        if (cur.some(it => !it.icon && map.get(it.path))) {
          saveLauncher(cur.map(it => (!it.icon && map.get(it.path)) ? { ...it, icon: map.get(it.path)! } : it));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [launcher, saveLauncher]);

  // 续146 一次性迁移：老条目的图标还内嵌在 store JSON 里（400KB），搬进 launcher_icons/。
  // 不塞进上面的 store 载入 effect——那里 saveLauncher 尚未初始化（同 copyAndPasteRef 那次 TDZ 教训）。
  // 只跑一次：迁移本身会触发 saveLauncher → launcher 变化 → 本 effect 重入，靠 ref 闸住。
  const launcherMigratedRef = useRef(false);
  useEffect(() => {
    if (launcherMigratedRef.current || !store || !launcher.length) return;
    if (!launcher.some(it => it.icon && !it.iconFile && !launcherIconFileRef.current.has(it.id))) return;
    launcherMigratedRef.current = true;
    saveLauncher(launcher);
  }, [launcher, store, saveLauncher]);

  // 续146b 同款一次性迁移：中转站 image 条目的内嵌 content 搬进 stage_images/。
  const stageMigratedRef = useRef(false);
  useEffect(() => {
    if (stageMigratedRef.current || !store || !stage.length) return;
    if (!stage.some(it => it.type==="image" && it.content && !it.contentFile && !stageContentFileRef.current.has(it.id))) return;
    stageMigratedRef.current = true;
    saveStage(stage);
  }, [stage, store, saveStage]);
  const changeStageLayout = useCallback(async (v:"list"|"grid") => { setStageLayout(v); if(store){ await store.set("stage-layout",v); await store.save(); } }, [store]);
  const changeDragoutAutoClose = useCallback(async (v:boolean) => { setDragoutAutoClose(v); if(store){ await store.set("dragout-auto-close",v); await store.save(); } try{ const{invoke}=await import("@tauri-apps/api/core"); await invoke("set_dragout_auto_close",{enabled:v}); }catch{} }, [store]);
  const changeStagePersist = useCallback(async (v:boolean) => { setStagePersist(v); if(store){ await store.set("stage-persist",v); await store.save(); } }, [store]);
  const changeShowShortcuts = useCallback(async (v:boolean) => { setShowShortcuts(v); if(store){ await store.set("show-shortcuts",v); await store.save(); } }, [store]);
  const changeStageMax = useCallback(async (n:number) => { setStageMax(n); if(store){ await store.set("stage-max",n); await store.save(); } if(stage.length>n){ await saveStage(stage.slice(0,n)); } }, [store,stage,saveStage]);
  const changeSearchDefaultMode = useCallback(async (v:"page"|"enhanced") => { setSearchDefaultMode(v); if(store){ await store.set("search-default-mode",v); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const cur=appUsage[p]; const u={...appUsage,[p]:{count:(cur?.count??0)+1,last_used:Math.floor(Date.now()/1000)}}; setAppUsage(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appUsage,store]);

  // ── 核心：事件监听（只注册一次，依赖[]）。可见性唯一真相在 Rust，前端只同步 ──
  useEffect(() => {
    let cleanup: (() => void)[] = [];
    let fileDragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un1 = await listen("hotkey-show", () => { setVisible(true); scanStageMissing(); }); // 续100：呼出即后台扫一遍中转区失踪文件（<1ms，不阻塞渲染）
        const un2 = await listen("hotkey-hide", () => { endClipDrag(); if (stageReorderRef.current.active) { cancelStageReorder(); setStageReorderActiveNative(false); } dragOutRef.current.pressing = false; dragOutRef.current.mode = "idle"; setVisible(false); if(launchCloneNodeRef.current){launchCloneNodeRef.current.remove();launchCloneNodeRef.current=null;} setDismissing(false); launchingRef.current = false; if(launchSrcElRef.current){launchSrcElRef.current.style.opacity="";launchSrcElRef.current=null;} setStageSel(new Set<number>()); setStageMultiselect(false); stageAnchorRef.current = null; setLassoState({active:false,origin:{x:0,y:0},current:{x:0,y:0}}); lassoArmedRef.current=false; dropAreaRef.current?.classList.remove("lasso-active"); setEnhOpen(false); setEnhPinned(false); setEnhQuery(""); setEnhSelIdx(0); setFsResults([]); setPickerOpen(false); setPickerQuery(""); setSearch(""); pageSearchForcedRef.current=false; setCtxMenu(null); if(toastTimerRef.current!==null){clearTimeout(toastTimerRef.current);toastTimerRef.current=null;} setToast(null); }); // 复位（续88：任何窗口隐藏都兜底清一次区内重排残留状态，防 ghost 卡死；含右键菜单，防隐藏后残留；含 toast，防隐藏时挂着的提示在下次呼出时残留半截动画）
        const un3 = await listen("clipboard-update", async () => {
          // 性能优化步骤2：image 条目 content 已不入前端 state，无法再按 content 做乐观去重。
          // 改为回拉 Rust 权威历史（get_clipboard_history 已剥图片 content、且 Rust 侧已按 ahash 去重 R24）。
          // 事件仅在真实外部复制时触发（自写回流被 R21 抑制），此处一次 IPC 开销可忽略。
          const { invoke } = await import("@tauri-apps/api/core");
          const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
          setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
        });
        // 原生拖入（S3b）：落点在启动器区→入启动器，否则→入中转（兜底）；落地区域闪烁确认。
        // pt 是 Windows 屏幕物理像素，÷ devicePixelRatio 转 CSS px 后与 getBoundingClientRect 比对。
        const un4 = await listen("files-dropped", async (event: any) => {
          const payload = event.payload as { paths: string[]; x: number; y: number };
          const paths = payload.paths ?? [];
          if (!paths.length) return;
          // 「保持界面」模式下，我们自己的中转拖出落回窗口内也会经 IDropTarget→files-dropped（draggedIds 尚未清）。
          // 与外部文件拖入区分：区内拖出且落点在启动台 → 走下方启动台添加（等同拖入收藏）；落回中转区 →
          // 区内重排属后续阶段，暂跳过（避免把自身当外部文件重复添加）。
          const internalDrag = dragOutRef.current.draggedIds.length > 0;
          const cssX = payload.x / window.devicePixelRatio;
          const cssY = payload.y / window.devicePixelRatio;
          const launcherRect = launcherDropRef.current?.getBoundingClientRect();
          const inLauncher = !!launcherRect && cssX >= launcherRect.left && cssX <= launcherRect.right && cssY >= launcherRect.top && cssY <= launcherRect.bottom;
          // 续97：内部拖出落回自身 overlay（非启动台）——即"拖了一下又落回本窗口"，属未真正投放到外部。
          // 标记之，供随后到达的 drag-out-done 跳过删除（OS 仍会回传 copy，否则会误判成功投放而删条目）。
          if (internalDrag && !inLauncher) { droppedOnSelfRef.current = true; setFileDragOver(false); return; }
          const { invoke } = await import("@tauri-apps/api/core");
          if (inLauncher) {
            // 落点在启动器：.lnk → resolve_lnk → kind:"app"；其余 → get_file_info → file/folder
            let next = [...launcherRef.current];
            for (const p of paths) {
              try {
                if (next.length >= LAUNCHER_MAX) break;
                if (next.some(x => x.path === p)) continue; // 原始路径去重
                let newItem: LauncherItem;
                if (p.toLowerCase().endsWith(".lnk")) {
                  const lnk = await invoke<{ name: string; path: string; icon: string | null }>("resolve_lnk", { path: p });
                  newItem = { id: launcherId(), kind: "app", name: lnk.name, icon: lnk.icon, path: lnk.path };
                } else {
                  const f = await invoke<FileEntry>("get_file_info", { path: p });
                  newItem = { id: launcherId(), kind: f.isDir ? "folder" : "file", name: f.name, path: f.path, ext: f.ext, icon: f.icon ?? null };
                }
                next = [...next, newItem];
              } catch {}
            }
            next = next.slice(0, LAUNCHER_MAX);
            setLauncher(next);
            await persistLauncher(next); // 续146b：改道唯一出口（脱水后落盘）
            launcherDropRef.current?.classList.add("drop-flash");
            setTimeout(() => launcherDropRef.current?.classList.remove("drop-flash"), 200);
          } else {
            // 落点在中转区或区域外（兜底）：转 StageItem 入中转（原有行为）
            const built: StageItem[] = [];
            for (const p of paths) { try { built.push(fileEntryToStage(await invoke<FileEntry>("get_file_info", { path: p }))); } catch {} }
            if (!built.length) return;
            let next = [...stageRef.current];
            for (const it of built) {
              if (next.length >= stageMaxRef.current) break;
              if (next.some(s => s.type === "file" && s.items?.[0]?.path === it.items?.[0]?.path)) continue;
              next.push(it);
            }
            next = next.slice(0, stageMaxRef.current);
            setStage(next);
            await persistStage(next); // 续146b：改道唯一出口（脱水后落盘）
            // 续99d：中转区不再播落地闪烁（drop-flash）——卡片冒出即确认，且与缩略图生成窗口重合像闪 bug（染色确认根因）。启动台仍保留（走 .app-grid.drop-flash）。
          }
          setFileDragOver(false);
          // 拖入后回焦点，让 Esc 可用
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setFocus(); } catch {}
        });
        // 文件索引就绪（S4b）：后台线程每次建/重建完成 emit 条目数，>0 视为就绪
        const un5 = await listen("file-index-ready", (e: any) => setIndexReady((e.payload ?? 0) > 0));
        // 应用扫描就绪（S4c）：后台预扫线程扫完一次性推送 apps，呼出前填充、消除首次卡顿
        const un6 = await listen("apps-ready", (e: any) => { const list = (e.payload ?? []) as AppInfo[]; if (list.length) setApps(list); });
        // 外部文件拖入悬停高亮（S5a）：Rust DragEnter/DragLeave emit，前端 100ms 防抖过滤 HWND 间快速 leave-enter
        const un7 = await listen("file-drag-enter", () => {
          if (fileDragLeaveTimer) { clearTimeout(fileDragLeaveTimer); fileDragLeaveTimer = null; }
          setFileDragOver(true);
        });
        const un8 = await listen("file-drag-leave", () => {
          fileDragLeaveTimer = setTimeout(() => setFileDragOver(false), 100);
        });
        // 拖出完成（续71，续86 修正）：effect==="move"|"copy" 均视为投放成功 → 从中转区移除被拖出的条目
        // （draggedIds 在拖出触发时已快照）；取消(Esc)/none → 保留。
        // 续86 修正根因：文件跨盘拖出、图片/文本拖到绝大多数非 Explorer 目标，OS 回传的都是 copy 而非
        // move（move 只在同盘 Explorer 间搬移等少数场景出现）——旧版「仅 move 才移除」导致 copy 效果的
        // text/image/file 条目拖出成功后仍滞留中转区（不符合"移出即消失"的中转直觉）。改为凡投放成功
        // （非取消/none）即视为已移出。overlay 已被 Rust 隐藏，此处只改状态 + 落盘，用户重按热键再呼出。
        // 持久化开关（stagePersistRef，续86 同批新增）——开启时跳过下方两处移除，条目仅可手动删除；
        // 移除仍严格挂在 Rust 回传的「非 none」（已确认成功投放）之后，只是多加一道门。
        const un9 = await listen<string>("drag-out-done", async (event) => {
          const dr = dragOutRef.current;
          // 续110：剪贴板来源的原生拖出——"拖出后剪贴板不变"。中转站的 draggedIds/持久化/copyAndPaste
          // 逻辑与其无关，全部跳过；复位来源 + 兜底清 clip 让路标志（Rust do_drag_on_main 通常已清，幂等）后返回。
          if (dragOutSourceRef.current === "clip") {
            dragOutSourceRef.current = "stage";
            droppedOnSelfRef.current = false;
            setClipDragActiveNative(false);
            console.log("[clip-drag] drag-out-done effect=", event.payload, "→ 剪贴板不变，不删任何条目");
            return;
          }
          console.log("[stage-drag] drag-out-done effect=", event.payload, "draggedIds=", dr.draggedIds, "onSelf=", droppedOnSelfRef.current); // 续88/续97 诊断
          // 续97：本次 OLE 落点落回自身 overlay（files-dropped 已置位 droppedOnSelfRef）——非真正外部投放。
          // OS 仍回传 copy（overlay 自身 IDropTarget 接受），但不应删条目/清选区。命中则保留一切、直接返回。
          // 这正是"多选拖动后什么也没做（区内小幅拖动+立刻松手，落回本窗口）却误删选中项"的根因（单项因先走区内重排、
          // 落回区内只是重排不起 OLE，故无此症）。真正拖到外部落地时不经此分支（落点非本窗口→无 files-dropped 自标记）。
          if (droppedOnSelfRef.current) {
            droppedOnSelfRef.current = false;
            dr.draggedIds = [];
            console.log("[stage-drag] 落回自身 overlay → 视为未投放，保留条目与选区");
            return;
          }
          const dropped = event.payload === "move" || event.payload === "copy"; // 真正投放成功；取消/none 一律不算
          // 续72：单个 text 条目拖出且 effect==="copy" 时，回退 copyAndPaste（写剪贴板 + 焦点交还 + Ctrl+V），等同点击取走。
          // 判定依据（别改成「无论 effect 一律回退」，会双粘）：会原生插入文本的目标（Word/写字板）返回 move →
          // 走下方分支、native 已插入，此处不回退；返回 copy 的恰是 Chromium 输入框——它不原生插入（痼疾），
          // 但拖拽过程已在输入框落了 caret，故回退 Ctrl+V 正好补上。即 copy⟺不原生插入，二者同源，故无双粘。
          // 残留理论风险：非 Chromium 原生 app 若对文本返回 copy 且原生插入 → 双粘；实测 Word/写字板返回 move，未触发。
          // Gemini 等 contenteditable dragover 不落 caret → 回退 Ctrl+V 也落空，属硬边界，无干净解（见会话分析）。
          const draggedItems = dr.draggedIds.length
            ? dr.draggedIds.map(id => stageRef.current.find(s => s.id === id)).filter((s): s is StageItem => !!s)
            : [];
          // 「保持界面」模式（keepOpen）：拖出不关窗，故跳过会隐藏窗口的 copyAndPaste 回退。
          const keepOpen = !dragoutAutoCloseRef.current;
          if (!keepOpen && dropped && event.payload !== "move" && draggedItems.length === 1 && draggedItems[0].type === "text") {
            const item = draggedItems[0];
            copyAndPaste(item); // 复用现有粘贴出口（含焦点交还 + Ctrl+V）
            if (!stagePersistRef.current && !item.pinned) { // 续99：固定条目豁免自动移除
              const next = stageRef.current.filter(s => s.id !== item.id); // 取走语义：从中转区移除
              setStage(next);
              await persistStage(next); // 续146b：改道唯一出口（脱水后落盘）
            }
            setStageSel(new Set<number>());
            setStageMultiselect(false);
            dr.draggedIds = [];
            return;
          }
          if (dropped && dr.draggedIds.length) {
            if (!stagePersistRef.current) {
              // 续99：全局非持久化时，仍豁免被固定（pinned）的条目——只移除拖出成功且未固定的
              const ids = new Set(dr.draggedIds.filter(id => !stageRef.current.find(s => s.id === id)?.pinned));
              if (ids.size) {
                const next = stageRef.current.filter(s => !ids.has(s.id));
                setStage(next);
                await persistStage(next); // 续146b：改道唯一出口（脱水后落盘）
              }
            }
            setStageSel(new Set<number>());
            setStageMultiselect(false);
          }
          dr.draggedIds = [];
        });
        // 续88：区内重排期间用户按热键 → Rust monitor emit 此事件（而非直接 hide）。把纯 JS 重排**升级为原生拖出**：
        // 先起手 DoDragDrop（此刻窗口仍可见，SetCapture 成功），再由 Rust force_hide 隐藏 overlay，用户即可拖到
        // 外部目标投放。若直接让 monitor hide，DoDragDrop 起手前窗口已隐藏→拖拽不启动→松手无文件落地（四轮反馈根因）。
        const un10 = await listen("stage-drag-hotkey", () => {
          const dr = dragOutRef.current;
          if (dr.mode !== "reorder" || !stageReorderRef.current.active || dr.itemId === null) return;
          const itemId = dr.itemId;
          console.log("[stage-drag] hotkey during reorder → 升级为原生拖出 + 隐藏", itemId); // 续88 诊断
          cancelStageReorder();               // 仅清 JS 重排现场；STAGE_REORDER_ACTIVE 留给 Rust 交接
          dr.mode = "native";
          beginNativeDragOut([itemId], true); // force_hide：起手 DoDragDrop（窗口仍可见）后由 dragout 自身隐藏
        });
        // 续110：剪贴板项纯 JS 拖动中按热键 → Rust monitor emit 此事件（而非直接 hide）。仿 un10：把纯 JS ghost
        // 升级为原生拖出（beginClipDragOut：force_hide=true，窗口仍可见时先起手 DoDragDrop，再由 Rust 隐藏 overlay）。
        const un11 = await listen("clip-drag-hotkey", () => {
          const ds = clipDragRef.current;
          if (!ds?.active) return; // 未激活（理论上 monitor 不会在此发）——保险起见忽略
          console.log("[clip-drag] hotkey during drag → 升级为原生拖出 + 隐藏", ds.item.type); // 续110 诊断
          beginClipDragOut(ds.item);
        });
        cleanup = [un1, un2, un3, un4, un5, un6, un7, un8, un9, un10, un11];
      } catch (e) { console.error("listen error:", e); }
    })();
    return () => { cleanup.forEach(fn => fn()); if (fileDragLeaveTimer) clearTimeout(fileDragLeaveTimer); };
  }, []);

  // ── 窗口显示时从后台缓存加载剪贴板历史（毫秒级）──
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
        if (history.length) {
          setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
        }
      } catch {}
    })();
    // 应用列表：现由后台预扫线程（start_apps_worker）提前填充并 emit("apps-ready")，呼出时通常已就绪。
    // 此处仅作兜底：首次 visible 时若 apps 仍空（apps-ready 还没到/被错过），才 invoke scan_start_menu
    // 兜底（命中 APP_CACHE、近乎瞬时）；否则跳过、不重复扫描。
    if (!loadedRef.current) {
      loadedRef.current = true;
      if (appsRef.current.length === 0) {
        (async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const list = await invoke<AppInfo[]>("scan_start_menu");
            // 不在此处定死顺序：排序交给 sortedApps（响应 appUsage 变化，刚用过的 app 下次浮上来）
            if (list.length) setApps(list);
          } catch {}
        })();
      }
    }
    setTimeout(() => searchRef.current?.focus(), 100);
  }, [visible]);

  // ── 按使用打分排序（频率为主×近期乘数：常用且近期用过的浮前；同分按名字兜底）──
  const sortedApps = useMemo(() => { const nowS=Math.floor(Date.now()/1000); return [...apps].sort((a,b) =>
    usageScore(appUsage[b.path],nowS) - usageScore(appUsage[a.path],nowS) || a.name.localeCompare(b.name)
  ); }, [apps, appUsage]);

  // ── 搜索过滤（模糊打分 + 相关度排序）。统一输出 {app, ranges}，空查询时 ranges 为空 ──
  const filteredApps = useMemo<{ app: AppInfo; ranges: [number, number][] }[]>(() => {
    const query = search.trim();
    if (!query) return sortedApps.slice(0, 200).map(app => ({ app, ranges: [] }));
    const nowS = Math.floor(Date.now()/1000);
    return sortedApps
      .map(app => {
        const nameR = fuzzyScore(query, app.name);
        const basename = app.path.split(/[\\/]/).pop() ?? "";
        const pathScore = fuzzyScore(query, basename).score * 0.6; // path basename 降权
        const useName = nameR.score >= pathScore;
        return { app, score: useName ? nameR.score : pathScore, ranges: useName ? nameR.ranges : [] };
      })
      .filter(it => it.score > 0) // 子序列不成立的淘汰
      .sort((a, b) =>
        b.score - a.score                                                              // 相关度降序
        || usageScore(appUsage[b.app.path],nowS) - usageScore(appUsage[a.app.path],nowS) // 同分按使用打分
        || a.app.name.localeCompare(b.app.name))                                       // 再按字母
      .slice(0, 200)
      .map(({ app, ranges }) => ({ app, ranges }));
  }, [search, sortedApps, appUsage]);

  // ── 拼音派生表的维护（续131）────────────────────────────────────────────────
  //
  // 不变量：**表的键集 == 已请求集 == 当前三个列表里所有含汉字的名字**。
  // 每次列表变化都按这个集合裁剪，所以表不会随会话变长而无限膨胀
  // （剪贴板文本条目会持续换新，不裁剪的话一场长会话能攒出几千条）。
  // 两者必须**一起**裁剪：只裁表不裁已请求集，条目被移除又加回来时会
  // "认为已请求过"而不再请求，拼音就静默失效了。
  //
  // 派生**不进逐键路径**：只在 apps/stage/clipboard 变化时跑一次，匹配读的是缓存。
  //
  // ⚠️ **裁剪只在同步段做，异步回来只合并、不裁剪**，且**不要给这个 effect 加 cancelled 守卫**。
  // 首版两样都反了，埋了一个启动期必现的静默 bug：请求发出前名字就已记进"已请求集"，
  // 而 effect 的 cleanup 在任何一次列表变化时都会把在途结果判死（apps/stage/clipboard
  // 启动时本就前后脚到齐，必然踩中）→ 结果被丢弃，可"已请求集"里还留着这批名字
  // → 后续轮次认为请求过而不再请求 → **这批名字永久没有拼音，且零日志零报错**。
  // 现在：结果无条件合并（name→变体 是幂等的，合早合晚都对），过期的键由下一轮同步裁剪清掉。
  const pinyinReqRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const all = new Set<string>();
    const add = (n: string) => { if (n && HAS_CJK.test(n)) all.add(n); };
    for (const a of apps) add(a.name);
    for (const s of stage) if (s.type === "file") add(stageDisplayName(s, t));
    for (const c of clipboard) add(clipDisplayName(c, t));
    // 裁剪表与已请求集（即使本轮无新名字也要做——条目只减不增时同样要收缩）。
    // 两者必须**一起**裁：只裁表不裁已请求集，条目被移除又加回来时会"认为已请求过"
    // 而不再请求，拼音就静默失效了。
    pinyinReqRef.current = new Set([...all].filter(n => pinyinReqRef.current.has(n)));
    setPinyin(prev => pruneTable(prev, all));
    const want = [...all].filter(n => !pinyinReqRef.current.has(n));
    if (!want.length) return;
    for (const n of want) pinyinReqRef.current.add(n);
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const res = await invoke<PinyinVariant[][]>("to_pinyin_batch", { names: want });
        setPinyin(prev => { const next = { ...prev }; want.forEach((n, i) => { next[n] = res[i] ?? []; }); return next; });
      } catch (e) {
        // 失败就把这批从已请求集摘掉，下次列表变化时自然重试（拼音失效只是搜不到，不该永久卡住）。
        // **必须留日志**：这条分支"正常不该发生"，而它一旦发生就是拼音静默失效——
        // 续129b/129c 两次栽在静默分支上，不再重蹈。
        console.warn("[pinyin] 派生失败，本批退回直接匹配：", e);
        for (const n of want) pinyinReqRef.current.delete(n);
      }
    })();
  }, [apps, stage, clipboard, t]);

  // ── 增强搜索 Tier 1（应用 + 中转区 file 条目；空查询=常用应用兜底，可直接 Enter）──
  // 有查询时上限 10（D5）；空查询兜底仍给 30 常用应用（此时无文件结果，总数 ≤30 不超）。
  const enhTier1 = useMemo<EnhResult[]>(() => {
    const q = enhQuery.trim();
    const nowS = Math.floor(Date.now() / 1000);
    if (!q) return sortedApps.slice(0, 30).map(app => ({ kind: "app" as const, app, ranges: [] as [number, number][] }));
    // matchName = 直接模糊匹配 + 拼音匹配取优（续131）。三类条目共用它，口径一致。
    const appHits = apps.map(app => { const r = matchName(q, app.name, pinyin); return { kind: "app" as const, app, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    const stageHits = stage.filter(s => s.type === "file").map(s => { const nm = stageDisplayName(s, t); const r = matchName(q, nm, pinyin); return { kind: "stage" as const, item: s, name: nm, score: r.score, ranges: r.ranges }; }).filter(x => x.score > 0);
    // 剪贴板历史条目（续101）：名称=文本内容/文件名/图片标签；名称模糊未命中时用类型词（"图片""txt"）兜底给基础分。
    const ql = q.toLowerCase();
    const clipHits = clipboard.map(c => {
      const nm = clipDisplayName(c, t);
      const r = matchName(q, nm, pinyin);
      let score = r.score, ranges = r.ranges;
      if (score === 0 && typeKeywords({ type: c.type, ext: c.items?.[0]?.ext, isImage: c.items?.[0]?.isImage }).some(k => k.toLowerCase().includes(ql))) { score = 5; ranges = []; }
      return { kind: "clip" as const, item: c, name: nm, score, ranges };
    }).filter(x => x.score > 0);
    return [...appHits, ...stageHits, ...clipHits]
      .sort((a, b) => b.score - a.score || (a.kind === "app" && b.kind === "app" ? usageScore(appUsage[b.app.path], nowS) - usageScore(appUsage[a.app.path], nowS) : 0))
      .slice(0, 10)
      .map(({ score, ...rest }) => rest as EnhResult);
  }, [enhQuery, apps, stage, clipboard, sortedApps, appUsage, t, pinyin]);

  // ── 文件查询：防抖后 invoke（每次 search_files 是 Rust 命令往返，避免逐键 invoke）──
  // 防抖时长按引擎分档，见 ENH_DEBOUNCE_* 常量注释（续131）
  //
  // ⚠️ **必须有竞态守卫**（续131c）：`clearTimeout` 只能取消还没发出的查询，一旦 invoke 在途就拦不住了，
  // 而后发的查询完全可能先返回（词越短候选越多、越慢）——旧结果就会盖掉新结果，
  // 症状是「搜 ste 却列出一堆只配 s 的结果」。防抖从 150ms 降到 50ms 后两次请求叠在一起的概率大增，
  // 这个一直存在的漏洞才被实测撞出来。守卫用自增 token：只有最后一次发出的查询有权写结果。
  const fsReqRef = useRef(0);
  useEffect(() => {
    // 续136：关闭增强搜索时清掉 fsResults（原先只清 enhQuery、不清结果 →
    // 上一次搜索最多 500 条结果 + 图标 base64 引用一直滞留 JS 堆到下次搜索）。
    // 占一个 token 让在途查询作废（否则关闭瞬间在途的旧查询会把结果写回已清空的列表）。
    if (!enhOpen) { fsReqRef.current++; setFsResults([]); return; }
    const q = enhQuery.trim();
    // 清空也要占一个 token，否则在途的旧查询会把结果写回已清空的列表
    if (!q) { fsReqRef.current++; setFsResults([]); return; }
    // Everything 覆盖全盘、结果量大，给更高 limit；内置仅用户目录，50 足够
    const ev = searchEngine==="everything";
    const lim = ev ? ENH_FILE_LIMIT_EVERYTHING : ENH_FILE_LIMIT_BUILTIN;
    const t = setTimeout(async () => {
      const token = ++fsReqRef.current;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // 续126 ③：Rust 侧不再给每条结果内联 base64 图标，而是返回「结果（只带 iconKey）+ 去重后的图标表」。
        // 实测查询 "windows" 的 IPC 载荷 660KB → 79KB（-88%）——同一张扩展名图标此前被重复送了 500 遍。
        // 这里**收到后立刻回填成原来的形状**：下游 4 个消费点（EnhResult 构造 / 预览面板 / 加入启动台 / 列表渲染）
        // 一行都不用改。回填不产生拷贝——JS 字符串不可变，同扩展名的各行共享同一个引用。
        const r = await invoke<{ results: { path: string; name: string; ext: string; isDir: boolean; iconKey: string }[]; icons: Record<string, string> }>("search_files", { query: q, limit: lim });
        if (token !== fsReqRef.current) return; // 已有更新的查询发出，本次结果作废
        setFsResults(r.results.map(x => ({ ...x, icon: r.icons[x.iconKey] ?? null })));
      } catch { if (token === fsReqRef.current) setFsResults([]); }
    }, ev ? ENH_DEBOUNCE_EVERYTHING_MS : ENH_DEBOUNCE_BUILTIN_MS);
    return () => clearTimeout(t);
  }, [enhQuery, enhOpen, searchEngine]);

  // 增强搜索/设置打开或引擎切换时主动查一次状态（含 Everything 可用性；事件 file-index-ready 之外的兜底）
  useEffect(() => {
    if (!enhOpen && !settingsOpen) return;
    (async () => { try { const { invoke } = await import("@tauri-apps/api/core"); const s = await invoke<{ ready: boolean; count: number; everythingAvailable: boolean }>("get_index_status"); setIndexReady(s.ready); setEverythingAvailable(!!s.everythingAvailable); } catch {} })();
  }, [enhOpen, settingsOpen, searchEngine]);

  // ── 增强搜索 hover 选中的门控（续118）────────────────────────────────────────
  //
  // 裸 `onMouseEnter={()=>setEnhSelIdx(i)}` 有两个失效，症状都是「信息栏莫名其妙跳、
  // 跟着点错东西」，但根因不同，故两道门各治一个：
  //
  // ① **位移门**（治「键盘导航被静止的鼠标劫持」）：下面那个 scrollIntoView 会在 ↑↓ 时滚动列表，
  //    于是**鼠标没动、它底下的行却换了**，浏览器照样派发 mouseenter → 选中被拽回鼠标位置，
  //    可能再次触发滚动。故要求「指针坐标相对上一次真实 mousemove 确有变化」才放行。
  //    真实移动时 mouseenter 先于该位置的 mousemove 派发，故此时 enter 的坐标必然 ≠ 已记录值；
  //    滚动导致的 enter 坐标则与已记录值完全相同 —— 靠这个差异区分，无需监听 scroll。
  //
  // ② **驻留门**（治「去预览面板路上蹭到邻行」）：预览面板在列表**左外侧**，去点它的按钮必须
  //    横向穿越，轨迹稍斜就会扫过上下邻行，每扫一行都换一次预览 → 走到面板时对象已经变了
  //    （经典的菜单对角线问题）。故 hover 不立即提交，先等 HOVER_DWELL_MS；中途离开即取消。
  //
  // 为什么不拆 enhSelIdx 成「键盘光标」和「hover 预览」两个状态：它同时是 Enter 的目标，
  // 而 enhResults[0] / Enter 行为的稳定性是续114b 明确维护的不变量，拆开风险远大于收益。
  const hoverPosRef = useRef({ x: -1, y: -1 });   // 最近一次**真实** mousemove 的视口坐标
  const hoverTimerRef = useRef<number | null>(null);
  const cancelHoverSelect = useCallback(() => {
    if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
  }, []);
  // 键盘导航时清掉待定的 hover 提交，否则 70ms 窗口内的按键会被随后落地的 hover 覆盖回去
  const selectByKeyboard = useCallback((next: number | ((i: number) => number)) => {
    cancelHoverSelect();
    setEnhSelIdx(next as never);
  }, [cancelHoverSelect]);
  const onEnhRowEnter = useCallback((idx: number, e: React.MouseEvent) => {
    const p = hoverPosRef.current;
    if (e.clientX === p.x && e.clientY === p.y) return; // ① 指针没动 = 滚动造成的，不是用户意图
    cancelHoverSelect();
    hoverTimerRef.current = window.setTimeout(() => {   // ② 驻留够久才算数
      hoverTimerRef.current = null;
      setEnhSelIdx(idx);
    }, HOVER_DWELL_MS);
  }, [cancelHoverSelect]);
  // 关闭增强搜索时清掉待定提交（否则关掉后定时器落地会改已失效的下标）。
  // 结果集变化时的清理放在 enhResults 声明之后（见那里）——此处引用不到它。
  useEffect(() => { if (!enhOpen) cancelHoverSelect(); }, [enhOpen, cancelHoverSelect]);

  // 选中高亮 + 滚入视野。**高亮是命令式加 class，不进 React**（续127）。
  //
  // 为什么：行是 `enhResults.map` 全量渲染的，若 className 里带 `i===enhSelIdx`，
  // 每按一次 ↑↓ 就要让 React reconcile 全部 500 行——而真正变化的只有 2 行。
  // 用户实测「↑↓ 翻结果时卡顿」即源于此。改成这里直接摘/挂 class 后：
  // 行数组由 useMemo 缓存（依赖里**不含 enhSelIdx**），一次按键的开销从 O(500) 降到 O(1)。
  // 这与续109 拖拽 ghost「坐标只进 ref + 直写 DOM」是同一套写法。
  //
  // ⚠️ 依赖里必须有 enhResults：换查询时 enhSelIdx 常常仍是 0（值没变、effect 不会重跑），
  // 那样新列表就一行都不会高亮。
  // 依赖里要有 enhResults，而此处引用不到它（声明在下方），故 effect 本体放在其声明之后。

  // 启动器键盘选中：滚入视野；关闭覆盖层 / 搜索过滤态变化时复位到「未选中」（焦点回搜索框）
  useEffect(() => {
    if (launcherSelIdx >= 0) document.querySelector(".app-tile.selected")?.scrollIntoView({ block: "nearest" });
  }, [launcherSelIdx]);
  useEffect(() => { setLauncherSelIdx(-1); }, [visible, search]);

  // ── 增强搜索结果分段（续114b）──
  // 结构：先建 sections，再由它**派生**扁平数组与段边界；渲染/导航都读派生值，段的增删不用改它们。
  //
  // 段序 = 「段内最靠前条目的排名」（数组下标最小者优先）——含最佳匹配的段排最前，
  // 故 `enhResults[0]` 与分段前完全一致，**Enter 的行为不变**。用排名而非分数是因为：
  // Tier1 打分后在 enhTier1 末尾就把 score 剥掉了，Tier2 来自 Rust 压根没有分数字段，
  // 两个数组本身已是排好序的，用下标等价且无需把分数透出来。
  //
  // Tier1 整块恒在 Tier2 之上，**不跨层按名次混排**：Tier1 用 JS fuzzyScore、Tier2 用 Rust
  // token_score，两套标尺的数值不可比，混排出来的名次没有意义。
  const enhSections = useMemo<{ key: string; label: string; items: EnhResult[] }[]>(() => {
    const out: { key: string; label: string; items: EnhResult[] }[] = [];

    // Tier1：应用 / 中转 / 剪贴板 各自成段（此前三者混在一起，只靠徽标区分）
    const T1_LABEL: Record<string, string> = { app: t("应用程序"), stage: t("中转站"), clip: t("剪贴板") };
    const t1Items = new Map<string, EnhResult[]>(); // Map 保持插入序 = 首次出现的名次序
    for (const r of enhTier1) {
      if (!t1Items.has(r.kind)) t1Items.set(r.kind, []);
      t1Items.get(r.kind)!.push(r);
    }
    for (const [k, items] of t1Items) out.push({ key: `t1-${k}`, label: T1_LABEL[k] ?? k, items });

    // Tier2：文件按大类分段
    const G_LABEL: Record<FileGroup, string> = {
      folder: t("文件夹"), image: t("图片"), archive: t("压缩包"), doc: t("文档"),
      code: t("代码"), media: t("媒体"), exe: t("可执行文件"), other: t("其他文件"),
    };
    // 分组 + runt 合并 + 名次排序在 lib/enhSections.ts（纯函数，有回归测试；
    // 「不可依赖 Map 插入序」这个坑的说明也在那里）
    for (const { group, items } of groupFiles(fsResults.slice(0, ENH_FILE_LIMIT_EVERYTHING), ENH_MIN_SECTION)) {
      out.push({
        key: `fs-${group}`, label: G_LABEL[group],
        items: items.map(f => ({ kind: "fs" as const, path: f.path, name: f.name, ext: f.ext, isDir: f.isDir, icon: f.icon, iconKey: f.iconKey })),
      });
    }

    return out;
  }, [enhTier1, fsResults, t]);

  // 扁平结果：↑↓/Enter/激活全部照旧读它，分段对这些路径完全透明
  const enhResults = useMemo<EnhResult[]>(() => enhSections.flatMap(s => s.items), [enhSections]);
  // 结果集变化时清掉待定的 hover 提交（续118）：边打字边把鼠标停在某行时，结果会在
  // 驻留窗口内被换掉，此时旧下标已指向另一个条目——让定时器落地就是选中了不相干的东西。
  useEffect(() => cancelHoverSelect, [enhResults, cancelHoverSelect]);
  // 选中高亮 + 滚入视野的本体在 enhRows 定义之后——它必须依赖 enhRows（见那里的说明）。
  // 每段首项的下标：Ctrl+↑↓ 跨段跳转的边界表（取代续114 硬编码的 enhTier1.length）
  const enhSectionStarts = useMemo<number[]>(() => {
    const starts: number[] = []; let acc = 0;
    for (const s of enhSections) { starts.push(acc); acc += s.items.length; }
    return starts;
  }, [enhSections]);
  // 下标 → 段标题，供渲染在该行之前插入表头
  const enhHeadAt = useMemo<Map<number, string>>(() => {
    const m = new Map<number, string>();
    enhSections.forEach((s, i) => m.set(enhSectionStarts[i], `${s.label} (${s.items.length})`));
    return m;
  }, [enhSections, enhSectionStarts]);

  // ── 预览面板异步元数据（续115）：大图标 + 时间戳/大小，仅文件系统类结果需要 ──
  // 同步能算的部分（名称/类型/徽标/已有小图标）在 enhPreview 里直接出，**不等这里**，
  // 所以快速 ↑↓ 时面板不会空白闪烁，只是详细行稍后补上。
  const [previewMeta, setPreviewMeta] = useState<{ key: string; info: FileEntry | null; icon: string | null; thumb: string | null } | null>(null);
  const previewCacheRef = useRef(new Map<string, { info: FileEntry | null; icon: string | null; thumb: string | null }>());
  const previewKeyRef = useRef("");
  /// 预览大图标按「图标身份」共享（续131e）：`iconKey` 是 Rust 算的——目录一个键、
  /// 普通文件按扩展名、exe/lnk 用自身路径（各有各的图标，本就不该共享）。
  ///
  /// 为什么不按路径存：50 个 .txt 就是 50 次 `get_large_icon`（每次 14~64ms 的 Shell COM）
  /// 外加 50 份各自独立的 43.9 KB 字符串——同一张图标反复取、反复占内存。
  /// 续126 已经给**列表**图标做过同样的去重，预览这一路当时没跟上。
  ///
  /// 键直接用 Rust 回传的 `iconKey`，**不在前端另写一套身份规则**——两套规则迟早跑偏。
  /// 命中时不仅省掉 IPC，还能在第一帧就画出高清图（连那次淡入都不会发生）。
  const largeIconRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (!enhOpen) {
      setPreviewMeta(null);
      // 续137：关闭增强搜索时释放预览大图标/缩略图缓存（续136 ②′ 落地）。
      // 这两张表攒的是本流程里最大的**已解码图片**——192px 大图标（均 ~44KB/张，largeIconRef LRU 100）
      // 与图片文件缩略图（previewCacheRef LRU 60）；用得越久攒得越满，且**关掉后仍占着 JS 堆
      // 并撑着 Chromium 的解码位图缓存**，正是「用增强搜索后内存一直下不来」的那部分。
      // 关闭时清空，内存回到基线；重开只对**当前选中项**按需重取（异步 + PREVIEW_DEBOUNCE_MS 防抖，
      // 不碰列表、不产生 UI 卡顿——等价于每次全新打开的既有行为）。列表图标另走 fsResults，每次查询本就重取，不受影响。
      previewCacheRef.current.clear();
      largeIconRef.current.clear();
      return;
    }
    const r = enhResults[enhSelIdx] ?? enhResults[0];
    const key = r ? enhKey(r) : "";
    const path = r ? enhPath(r) : "";
    previewKeyRef.current = key;              // 竞态守卫基准：响应回来时若已不等，说明选中变了
    if (!r || !path) { setPreviewMeta(null); return; } // 纯文本/图片剪贴板项无路径，无需取
    const hit = previewCacheRef.current.get(key);
    if (hit) {
      // LRU 触碰：删了再塞回去 = 移到 Map 末尾（Map 保插入序）。
      // **只在 effect 里做，不在渲染期做**——渲染期那次读取（见 enhPreview）必须保持纯净，
      // 改动 ref 会让同一次渲染变得有副作用。effect 每次选中变化都会跑，触碰不会漏。
      previewCacheRef.current.delete(key);
      previewCacheRef.current.set(key, hit);
      setPreviewMeta({ key, ...hit });
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // 图片文件另取真缩略图（复用续99c 的落盘缓存，重复访问零解码原图）；非图片跳过这次 IPC
        const isImg = IMG_EXTS.includes((path.split(".").pop() ?? "").toLowerCase());
        // 大图标先查「图标身份」共享表（续131e）：同扩展名的第二个文件起直接复用，
        // 既省掉 14~64ms 的 Shell COM，又让 50 个 .txt 共用同一个字符串实例
        // （JS 字符串按引用共享，去重后内存是真降下来的，不是只少了几次调用）。
        const ikey = r.kind === "fs" ? (r.iconKey ?? "") : "";
        const shared = ikey ? largeIconRef.current.get(ikey) : undefined;
        // 三个命令并行；任一失败不影响其余（大图标失败会回退到小图标/矢量字形）
        const [info, icon, thumb] = await Promise.all([
          invoke<FileEntry>("get_file_info", { path }).catch(() => null),
          shared !== undefined ? Promise.resolve(shared)
                               : invoke<string | null>("get_large_icon", { path }).catch(() => null),
          isImg ? invoke<string>("get_stage_thumbnail", { path }).catch(() => null) : Promise.resolve(null),
        ]);
        if (ikey && shared === undefined) {
          largeIconRef.current.set(ikey, icon ?? null); // 含 null：取不到也记下来，别每次都去白试
          while (largeIconRef.current.size > LARGE_ICON_CACHE_MAX) {
            const oldest = largeIconRef.current.keys().next().value;
            if (oldest === undefined) break;
            largeIconRef.current.delete(oldest);
          }
        }
        const entry = { info, icon: icon ?? null, thumb: thumb ?? null };
        previewCacheRef.current.set(key, entry);
        // LRU 淘汰：Map 的迭代序 = 插入序，队首就是最久没被触碰的那条，逐条删到不超上限。
        // **不能再用整表清空**（续131d）：清空一次会让所有项都退回"低清淡入一次高清"，
        // 正是刚修掉的那个体验问题周期性重演。
        while (previewCacheRef.current.size > PREVIEW_CACHE_MAX) {
          const oldest = previewCacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          previewCacheRef.current.delete(oldest);
        }
        // 先解码再上屏（续131d）：高清图标一挂上去就能立刻画出来，替换只占一帧。
        // 放在写缓存**之后**——缓存的是数据，解码只服务这次渲染，失败也不该让缓存落空。
        await Promise.all([preloadImg(entry.icon), preloadImg(entry.thumb)]);
        if (previewKeyRef.current === key) setPreviewMeta({ key, ...entry }); // 迟到的响应直接丢弃
      } catch {}
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enhOpen, enhSelIdx, enhResults]);

  // ── 预览面板视图模型（续115）──
  // 同步部分（标题/徽标/字形/已有小图标）恒可算；异步部分（大图标/缩略图/时间/大小）到了才补，
  // 故快速导航时面板结构稳定、只有细节行渐显，不会整块闪。
  const enhPreview = useMemo(() => {
    const r = enhResults[enhSelIdx] ?? enhResults[0];
    if (!r) return null;
    const key = enhKey(r);
    // 只认当前选中项的元数据，防串味。
    // ⚠️ **命中缓存时必须在这里直接读缓存，不能等 state**（续131d 修正）：
    // effect 在**渲染之后**才跑，所以"选中变了"那一帧 `previewMeta` 还是上一项的、判定为 null
    // → 面板先渲染一帧低清图，effect 随后 setPreviewMeta 才换高清。
    // 结果就是**哪怕刚看过这一项，也照样从低清淡入一次高清**（用户原话：比抖动还难受）。
    // previewCacheRef 是纯数据缓存、读它幂等，渲染期读取安全；state 仍保留——
    // 它负责在异步取回后触发重渲，两者职责不同。
    const meta = previewMeta?.key === key ? previewMeta : (previewCacheRef.current.get(key) ?? null);
    const info = meta?.info ?? null;
    // rtl：只给「位置」行——用 direction:rtl 让超长路径省略头部、保住尾部（文件名侧）。
    // 绝不能全表铺开：时间/大小含中性字符，RTL 排版会把它们的标点顺序弄错。
    // 续116 的信息设计：这个面板的职责是**消歧（这是我要的那个吗）**，不是属性对话框。
    // 判断材料分三层——① 位置 = 最大的消歧依据（同名文件散在不同目录，是搜索场景里
    // 压倒性最常见的歧义源），升为独立区块；② stats = 一眼扫的 1~2 个事实；
    // ③ rows = 其余次要信息。删掉的两项：「类型」（徽标 + 图标已经说了两遍）与
    // 「创建时间」（Windows 上复制会重置创建时间、常晚于 modified ——
    // 既不参与消歧又容易误导）。
    const rows: { label: string; value: string; rtl?: boolean; pending?: boolean; title?: string }[] = [];
    const stats: { label: string; value: string; title?: string; pending?: boolean }[] = [];
    let loc: string | null = null;
    const push = (label: string, value?: string | null, rtl?: boolean, title?: string) => { if (value) rows.push({ label, value, rtl, title }); };
    const fileFacts = (path: string, isDir?: boolean, extHint?: string) => {
      loc = dirOf(path);
      // ↓ stats 的**槽位数只由同步已知的信息决定**（不按值的有无出没）。值要等 get_file_info。
      // 若用「有值才渲染」，元数据到达的瞬间面板就会长高、肉眼可见地抖动
      // （续115 实测并反馈过的症状）。加载中→「…」／取到但字段缺失→「—」，两者高度一致。
      // pending 看的是「元数据是否已返回」(meta) 而非「值是否非空」(info)：取失败时
      // info=null 但 meta 已到，此时该显示「—」（否则失败与加载中无法区分）。
      // ⚠️ 续119 把分支增加到 3 个，但**分支条件是 isDir 与扩展名，都是同步已知**，
      //    所以这个不变量仍然成立（切记不要拿 meta 的内容做分支）。
      const pending = !meta;
      const ext = (extHint || "").toLowerCase().replace(/^\./, "");
      const isImg = !isDir && IMG_EXTS.includes(ext);
      const modStat = {
        // 以相对表述为主：这里是扫「是不是最近碰过的」，而不是精确看「什么时候」。
        // 绝对值放 title 里 hover 查看（续116。此前两行绝对时间是一堵数字墙）。
        label: t("修改"),
        value: pending ? "…" : (info?.modified ? agoSec(info.modified, t) : "—"),
        title: info?.modified ? fmtDateTime(info.modified) : undefined,
        pending,
      };
      const sizeStat = { label: t("大小"), value: pending ? "…" : (info ? fmtSize(info.size) : "—"), pending };
      if (isDir) {
        // 续119：选中文件夹时面板给的全是「容器外面」的信息。把条目数提到主角级。
        // entriesCapped 时显示「10000+」——把截断值当确定值输出就是撒谎。
        stats.push({
          label: t("项目数"),
          value: pending ? "…"
            : (info?.entries != null ? `${info.entries}${info.entriesCapped ? "+" : ""}` : "—"),
          pending,
        });
        stats.push(modStat);
      } else if (isImg) {
        // 图片更在意「1920 × 1080」而非「340 KB」。槽位固定 2 个，故把 修改 降级到下面的 rows。
        stats.push({
          label: t("尺寸"),
          value: pending ? "…" : (info?.width && info?.height ? `${info.width} × ${info.height}` : "—"),
          pending,
        });
        stats.push(sizeStat);
        rows.push({ label: modStat.label, value: modStat.value, title: modStat.title, pending });
      } else {
        stats.push(sizeStat);
        stats.push(modStat);
      }
      lnkRow(path);
    };
    // .lnk 的解析目标（续119）。**行的有无必须由 path 的扩展名（同步已知）决定**——
    // 若写成「target 返回了才加行」，meta 到达时面板就会长高抖动（见上面的不变量）。
    // 解析不出来（MSI 广告式快捷方式等）时显示「—」。
    const lnkRow = (path: string) => {
      if (!path.toLowerCase().endsWith(".lnk")) return;
      rows.push({
        label: t("目标"),
        value: !meta ? "…" : (info?.target || "—"),
        rtl: true, // 长路径省略头部、保留尾部（可执行文件名那一侧）
        pending: !meta,
        title: info?.target || undefined,
      });
    };

    // photo=true 表示 big 应「铺满」（照片缩略图）；false 表示应「居中留白」（图标）。
    // 混为一谈会把应用图标按 cover 裁掉边缘。
    //
    // ⚠️ **photo 必须由同步已知的信息（扩展名 / 条目类型）决定，不能看 meta 的内容**（续127）。
    // 这就是续115/119 给文字行立的那条不变量，当初漏了图标这一处：
    // 原先写的是 `photo = !!meta?.thumb`，于是图片文件在 meta 到达前是图标态（72×72 contain）、
    // 130ms 后缩略图到达翻成照片态（88×88 cover）——**几何尺寸在选中后跳一次**，
    // 来回移动选中项就是持续抖动（用户报「信息卡片抖动太厉害」）。
    // 现在几何从第一帧就定死，meta 到达只换 src（低清→高清），不再改盒子。
    // 注：图标本身是正方形，正方形源在正方形框里 cover 不裁掉任何东西，
    // 故「是图片但缩略图生成失败、回退到图标」时也只是少了内边距，不会变形。
    const photoExt = (ext?: string | null, isDir?: boolean) =>
      !isDir && IMG_EXTS.includes((ext ?? "").toLowerCase());
    let title = "", badge = "", big: string | null = null, low: string | null = null, glyph: FileGlyphArgs | null = null, text: string | null = null, photo = false;
    // cat = 徽标配色用的分类键。中转 / 剪贴板条目可能没有真实扩展名（如纯文本），
    // 故不走扩展名而直接定 FileCat，再用 catToGroup 折到色组（复用 format.ts 的映射）。
    let cat: FileCat = "generic";
    if (r.kind === "app") {
      title = r.app.name; badge = t("应用程序"); glyph = { cat: "exe" }; cat = "exe";
      big = meta?.icon ?? r.app.icon ?? null; low = r.app.icon ?? null;
      // 应用只给位置：大小是可执行文件的体积、意义不大，修改时间基本等于安装日期。
      // 两者对「这是我要的那个吗」都不起作用，故不显示（续116）。
      loc = dirOf(r.app.path);
      lnkRow(r.app.path); // 续119：开始菜单的 .lnk，「位置」只会显示菜单所在文件夹，看不出实体在哪
    } else if (r.kind === "fs") {
      title = r.name; badge = r.isDir ? t("文件夹") : t("文件");
      cat = r.isDir ? "folder" : fileCategory(r.ext ?? "");
      glyph = r.isDir ? { isDir: true } : { ext: r.ext };
      // 共享表命中时**第一帧就是高清**——同扩展名的第二个文件起，连那次淡入都不会发生（续131e）。
      // 与上面读 previewCacheRef 同理：渲染期只读、不改，保持纯净。
      const sharedIcon = r.iconKey ? (largeIconRef.current.get(r.iconKey) ?? null) : null;
      big = meta?.thumb ?? meta?.icon ?? sharedIcon ?? r.icon ?? null; low = r.icon ?? null; photo = photoExt(r.ext, r.isDir);
      fileFacts(r.path, r.isDir, r.ext);
    } else if (r.kind === "stage") {
      const it = r.item, p = it.items?.[0]?.path;
      // 徽标并列「出处 · 种别」（续116）：种别的信息量不足以独占一行，
      // 但在中转 / 剪贴板里光有出处又看不出是什么条目。折进一个徽标，省下一行。
      if (it.type === "text") { title = (it.content || "").trim().slice(0, 60) || t("文本"); badge = `${t("中转站")} · ${t("文本")}`; cat = "text"; glyph = { cat: "doc" }; text = it.content ?? null; stats.push({ label: t("字数"), value: String((it.content || "").length) }); }
      else if (it.type === "image") { title = t("图片"); badge = `${t("中转站")} · ${t("图片")}`; cat = "image"; glyph = { isImage: true }; big = (p && stageThumbs[p]) || meta?.thumb || it.content || null; low = (p && stageThumbs[p]) || it.content || null; photo = true; }
      else { title = r.name; badge = t("中转站"); cat = it.isDir ? "folder" : fileCategory(it.ext ?? ""); glyph = it.isDir ? { isDir: true } : { ext: it.ext ?? "" }; big = (p && stageThumbs[p]) || meta?.thumb || meta?.icon || null; low = (p && stageThumbs[p]) || null; photo = photoExt(it.ext, it.isDir); if (p) fileFacts(p, it.isDir, it.ext); }
      if (it.pinned) push(t("状态"), t("已固定"));
    } else { // clip
      const it = r.item, p = it.items?.[0]?.path;
      if (it.type === "text") { title = (it.content || "").trim().slice(0, 60) || t("文本"); badge = `${t("剪贴板")} · ${t("文本")}`; cat = "text"; glyph = { cat: "doc" }; text = it.content ?? null; stats.push({ label: t("字数"), value: String((it.content || "").length) }); }
      else if (it.type === "image") { title = t("图片"); badge = `${t("剪贴板")} · ${t("图片")}`; cat = "image"; glyph = { isImage: true }; big = clipThumbs[it.time] ?? null; photo = true; } /* 步骤2：clip 图 content 已剥离，预览用缩略图 */
      else { title = r.name; badge = t("剪贴板"); cat = fileCategory(it.items?.[0]?.ext ?? ""); glyph = { ext: it.items?.[0]?.ext ?? "" }; big = meta?.thumb ?? meta?.icon ?? null; photo = photoExt(it.items?.[0]?.ext); if (p) fileFacts(p, false, it.items?.[0]?.ext); if ((it.count ?? 1) > 1) push(t("数量"), t("{n} 个文件", { n: it.count ?? 0 })); }
      // 剪贴板条目唯一有用的元信息。相对表述 + 绝对值 hover 查看（ClipItem.time 是毫秒 → 直接用 ago）
      push(t("复制时间"), ago(it.time, t), false, fmtDateTime(Math.floor(it.time / 1000)));
    }
    // 渲染用的两层（续131d）：low 恒是**同步已知**的那张，第一帧就在场——这样高清到达时
    // 它才有「从可见淡出」的前值可插值；若与高清同帧挂载，它带着 is-hidden 出生，过渡根本不会发生。
    // hi 只在**确实比 low 更好**时才有值（两者相同则为 null，免得同一张图白叠两层）。
    const hi = big && big !== low ? big : null;
    return { r, key, title, badge, cat, group: catToGroup(cat), low, hi, photo, glyph, text, loc, stats, rows, path: enhPath(r) };
  }, [enhResults, enhSelIdx, previewMeta, stageThumbs, clipThumbs, t]);

  // ── 启动器「添加应用」picker 结果：排除已加入的 app，空查询=常用前 50，有查询=fuzzyScore 排序 ──
  const pickerResults = useMemo<{ app: AppInfo; ranges: [number, number][] }[]>(() => {
    const q = pickerQuery.trim();
    const base = sortedApps.filter(a => !launcher.some(x => x.kind === "app" && x.path === a.path)); // 排除已加入
    if (!q) return base.slice(0, 50).map(app => ({ app, ranges: [] as [number, number][] }));
    return base.map(app => { const r = fuzzyScore(q, app.name); return { app, score: r.score, ranges: r.ranges }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 50).map(({ app, ranges }) => ({ app, ranges }));
  }, [pickerQuery, sortedApps, launcher]);

  // ── 顶栏普通搜索：三区联动过滤（与 Ctrl+K 增强搜索的 enhQuery 完全独立）──
  // 中转区：名称/内容优先 + 类型词叠加；空查询=全量
  const filteredStage = useMemo(() => {
    const q = search.trim();
    if (!q) return stage;
    return stage.filter(s => {
      const name = s.type === "text" ? (s.content || "") : s.type === "image" ? "图片" : (s.name || s.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: s.type, ext: s.ext ?? s.items?.[0]?.ext, isImage: s.items?.[0]?.isImage }));
    });
  }, [stage, search]);
  // 续99b：为中转区图片文件懒生成缩略图（Rust 侧解码缩图，前端只缓存小 base64）。pending ref 去重：每个 path 只发起一次，失败不重试（回退 emoji）。
  useEffect(() => {
    const stagePaths = stage
      .filter(s => s.type === "file" && s.items?.[0]?.isImage && s.items?.[0]?.path)
      .map(s => s.items![0].path);
    // 启动台的图片文件也生成缩略图（与中转区共用同一缓存 stageThumbs）
    const launcherPaths = launcher
      .filter(it => it.kind === "file" && !!it.ext && IMG_EXTS.includes(it.ext.toLowerCase()))
      .map(it => it.path);
    // 续146c：image 类条目（内容在 stage_images/）也走缩略图——卡片 72px 却渲染 1024px 原图
    // （≈2.3MB 解码位图/张）是拖动掉帧/关闭迟缓的主因。键用 `simg:` 前缀与真实路径区分，
    // 但**照样并入 paths**，好让下面那套 pending 去重与淘汰逻辑原样适用（无需第二套簿记）。
    const stageImgKeys = stage
      .filter(s => s.type === "image" && s.contentFile)
      .map(s => STAGE_IMG_KEY + s.contentFile!);
    const paths = [...stagePaths, ...launcherPaths, ...stageImgKeys];
    for (const p of paths) {
      if (stageThumbPendingRef.current.has(p)) continue;
      stageThumbPendingRef.current.add(p);
      runThumbTask(async () => { // 步骤3：经并发闸串流，避免批量拖入并发解码飙峰
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const url = p.startsWith(STAGE_IMG_KEY)
            ? await invoke<string>("get_stage_image_thumb", { file: p.slice(STAGE_IMG_KEY.length) })
            : await invoke<string>("get_stage_thumbnail", { path: p });
          setStageThumbs(prev => ({ ...prev, [p]: url }));
        } catch { /* 失败：保留 pending 标记不再重试，显示图标兜底 */ }
      });
    }
    // 淘汰（H5）：条目删除/清空后，其 base64 缩略图与 pending 标记不再需要——否则整会话只增不减。
    // 存活集 = 当前仍在中转/启动台的图片 path；两者恰是上面算出的 paths。用函数式更新只删非存活键，
    // 无陈旧键时返回原引用不触发重渲。pending 一并清，路径日后再出现时可重新取图。
    const live = new Set(paths);
    for (const k of stageThumbPendingRef.current) if (!live.has(k)) stageThumbPendingRef.current.delete(k);
    setStageThumbs(prev => {
      const stale = Object.keys(prev).filter(k => !live.has(k));
      if (!stale.length) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [stage, launcher]);
  // 性能优化步骤1：为剪贴板图片条目懒生成小缩略图（Rust 侧解码缩图，前端只缓存小 base64）。
  // 与中转区 stageThumbs 同构：pending ref 去重（每个 time 只发起一次），失败则回退渲染整图（见下方 catch）。
  // 淘汰逻辑同 stageThumbs：条目被挤出历史/清空后清掉其缩略图，否则整会话只增不减。
  useEffect(() => {
    const imgClips = clipboard.filter(c => c.type === "image");
    for (const c of imgClips) {
      if (clipThumbPendingRef.current.has(c.time)) continue;
      clipThumbPendingRef.current.add(c.time);
      runThumbTask(async () => { // 步骤3：与 stageThumbs 共用同一并发闸，全局串流削峰
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          // 步骤2：content 已不在前端，按 time 让 Rust 从 CLIP_CACHE 取原文再缩图
          const url = await invoke<string>("get_clip_thumbnail", { time: c.time });
          setClipThumbs(prev => ({ ...prev, [c.time]: url }));
        } catch { /* 失败：保留占位框，不再重试（content 已不在前端，无法回退整图） */ }
      });
    }
    const live = new Set(imgClips.map(c => c.time));
    for (const k of clipThumbPendingRef.current) if (!live.has(k)) clipThumbPendingRef.current.delete(k);
    setClipThumbs(prev => {
      const stale = Object.keys(prev).map(Number).filter(k => !live.has(k));
      if (!stale.length) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [clipboard]);
  // 续100：中转区失踪扫描。收集所有 file 条目路径 → Rust 批量 exists() → 记下失踪集合。
  // 复用既有 stageRef（行 216，已随渲染更新）供 hotkey-show 闭包读最新 stage；scanStageMissing 无依赖、稳定。
  const scanStageMissing = useCallback(async (list?: StageItem[]) => {
    const src = list ?? stageRef.current;
    const paths = Array.from(new Set(
      src.flatMap(s => s.type === "file" ? (s.items?.map(i => i.path).filter(Boolean) ?? []) : [])
    )) as string[];
    if (!paths.length) { setMissingPaths(new Set()); return; }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const missing = await invoke<string[]>("check_stage_paths", { paths });
      const missSet = new Set(missing);
      if (!missSet.size) { setMissingPaths(new Set()); return; }
      // 续100：源文件失踪按「拖出移除」同一条豁免规则处理——`!persist && !pinned` 直接移除，固定/持久化则保留 + ⚠️ 标记。
      const persist = stagePersistRef.current;
      const removeIds = new Set<number>();       // 默认模式：自动移除
      const keepMissing = new Set<string>();      // 固定/持久化：留存路径（供 missingIds 标记）
      for (const it of src) {
        if (it.type !== "file" || !it.items?.length) continue;
        if (!it.items.every(f => missSet.has(f.path))) continue; // 批量条目部分尚在 → 不算失踪
        if (!persist && !it.pinned) removeIds.add(it.id);
        else it.items.forEach(f => keepMissing.add(f.path));
      }
      if (removeIds.size) {
        // 函数式更新读最新 stage；storeRef 落盘（复用 files-dropped 同款 idiom，避免 saveStage 的闭包过期）。
        setStage(prev => {
          const next = prev.filter(s => !removeIds.has(s.id));
          void persistStage(next); // 续146b：改道唯一出口（脱水后落盘）
          return next;
        });
      }
      setMissingPaths(keepMissing);
    } catch { /* 检查失败不改变现状，下次呼出再扫 */ }
  }, []);
  // 条目粒度：file 条目的全部文件都失踪才判该条目失踪（批量条目部分尚在则不误标）。
  const missingIds = useMemo(() => {
    const s = new Set<number>();
    if (!missingPaths.size) return s;
    for (const it of stage) {
      if (it.type !== "file" || !it.items?.length) continue;
      if (it.items.every(f => missingPaths.has(f.path))) s.add(it.id);
    }
    return s;
  }, [stage, missingPaths]);
  const missingIdsRef = useRef<Set<number>>(new Set()); missingIdsRef.current = missingIds; // 给 []-注册的拖出/点击 handler 读最新失踪集
  const cleanupMissingStage = useCallback(() => {
    if (!missingIds.size) return;
    saveStage(stageRef.current.filter(s => !missingIds.has(s.id)));
    setMissingPaths(new Set());
  }, [missingIds, saveStage]);
  // 剪贴板历史：同上
  const filteredClip = useMemo(() => {
    const q = search.trim();
    if (!q) return clipboard;
    return clipboard.filter(c => {
      const name = c.type === "text" ? (c.content || "") : c.type === "image" ? "图片" : (c.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: c.type, ext: c.items?.[0]?.ext, isImage: c.items?.[0]?.isImage }));
    });
  }, [clipboard, search]);
  // 启动器过滤：有 search 时按名称模糊过滤，无 search 直接返回原列表（持久化/拖入/picker 行为不受影响）
  const filteredLauncher = useMemo(() => {
    const q = search.trim();
    if (!q) return launcher;
    return launcher.filter(it => matchItem(q, it.name, []));
  }, [launcher, search]);

  // ── 操作函数 ──
  // 启动放大暂留：深拷贝源图标容器（.app-tile-icon / .enh-result-icon）到顶层 dragLayer，按源 rect 定位，
  // 自播 scale+淡出（.launch-clone）。克隆自带精确尺寸与底色 → 任何上下文像素级贴合、无缩放跳变。
  // 调用前源图标应仍可见（克隆保真），调用后再隐藏源。复位/下次启动前由 launchCloneNodeRef 移除。
  const spawnLaunchClone = useCallback((iconEl: HTMLElement, r: DOMRect) => {
    launchCloneNodeRef.current?.remove(); // 防上一枚残留（正常已由 hotkey-hide 清）
    const clone = iconEl.cloneNode(true) as HTMLElement;
    clone.style.margin = "0"; clone.style.opacity = ""; // 保证克隆可见（源随后才置 opacity:0）
    const wrap = document.createElement("div");
    wrap.className = "launch-clone";
    wrap.style.top = `${r.top}px`; wrap.style.left = `${r.left}px`;
    wrap.style.width = `${r.width}px`; wrap.style.height = `${r.height}px`;
    wrap.appendChild(clone);
    (dragLayerRef.current ?? document.body).appendChild(wrap);
    launchCloneNodeRef.current = wrap;
  }, []);
  const launchApp = useCallback((app:AppInfo, iconEl?:HTMLElement|null) => {
    if (launchingRef.current) return; // 防连点：动画进行中忽略后续触发
    recordUse(app.path);
    // 立即发起启动，不等动画——app 照常秒开，只把覆盖层的「消失」动画化
    import("@tauri-apps/api/core").then(({invoke})=>invoke("launch_app",{path:app.path})).catch(()=>{});
    // 无障碍 / 拿不到图标坐标：跳过动画，沿用即时隐藏（与改造前一致）
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !iconEl) { hideWorkbench(); return; }
    // 放大暂留：克隆图标到顶层浮层做 scale+淡出，覆盖层整体淡出露桌面，LAUNCH_ANIM_MS 后再 Rust hide
    launchingRef.current = true;
    const r = iconEl.getBoundingClientRect();
    spawnLaunchClone(iconEl, r); // 克隆（源仍可见时）
    iconEl.style.opacity = "0"; launchSrcElRef.current = iconEl; // 源图标即时隐藏，克隆顶替（防"两个图标"）
    setDismissing(true); // 覆盖层淡出（与剪贴板粘贴共用）
    setTimeout(() => hideWorkbench(), LAUNCH_ANIM_MS);
  }, [recordUse, spawnLaunchClone]);
  // 增强搜索激活：app 复用 launchApp（含放大动画+淡出+hide，不在此 setEnhOpen，让整层随 overlay dismiss 一起淡出，hotkey-hide 复位）；
  // stage file 走 hide + open_file（fire-and-forget）。两条都不碰粘贴/焦点交还/CLIPBOARD_LOCK。
  const copyAndPasteRef = useRef<((item: Pasteable) => void) | null>(null); // copyAndPaste 定义在后，activateEnh 经此 ref 调用
  const activateEnh = useCallback((r: EnhResult, iconEl?: HTMLElement | null) => {
    if (r.kind === "app") { launchApp(r.app, iconEl ?? null); }
    else if (r.kind === "fs") { hideWorkbench(); import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_file", { path: r.path })).catch(() => {}); }
    else if (r.kind === "clip") { copyAndPasteRef.current?.(r.item); } // 剪贴板结果：取走粘贴（copyAndPaste 定义在后，走 ref 避免 TDZ）
    else { hideWorkbench(); import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_file", { path: r.item.items![0].path })).catch(() => {}); }
  }, [launchApp]);
  // 注：原生拖入（drag-in）已废弃——全屏 transparent+alwaysOnTop+focus:false 覆盖层收不到任何 OLE 拖放事件（阶段2 实测：零事件+红色禁止），且全屏会盖住拖拽源。改走剪贴板 📌 钉入。详见 DECISIONS §14。

  // ── 启动器（收藏托盘）操作 ──
  // 左键打开/启动条目：app→launchApp（含放大动画+hide）；file/folder→open_file。由区决定动作，不走粘贴/焦点交还/CLIPBOARD_LOCK。
  const openLauncherItem = useCallback((it:LauncherItem, iconEl?:HTMLElement|null) => {
    // 排序拖拽激活后抑制 onClick（pointer 事件顺序：up → click，ref 比 state 更即时）
    if (suppressLaunchClickRef.current) { suppressLaunchClickRef.current = false; return; }
    if (it.kind === "app") {
      launchApp({ name: it.name, path: it.path, icon: it.icon ?? null }, iconEl ?? null);
      return;
    }
    // file/folder：同 app 的放大暂留动画——立即发起 open_file，再播克隆动画后 hide
    if (launchingRef.current) return;
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:it.path})).catch(()=>{});
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !iconEl) { hideWorkbench(); return; }
    launchingRef.current = true;
    const r = iconEl.getBoundingClientRect();
    spawnLaunchClone(iconEl, r); // 克隆（源仍可见时）——磁贴图标含真实系统图标/缩略图/FileGlyph，cloneNode 一律精确保真
    iconEl.style.opacity = "0"; launchSrcElRef.current = iconEl; // 源图标即时隐藏，克隆顶替（防"两个图标"）
    setDismissing(true);
    setTimeout(() => hideWorkbench(), LAUNCH_ANIM_MS);
  }, [launchApp, spawnLaunchClone]);

  // ── 启动台排序拖拽（续75 打磨：Launchpad 式让路 + ghost 首帧修复 + 松手回落 + 淡入抬起）──
  // 核心原则：ghost 位置 / 让路 transform 全走 DOM 直操作，零 React 渲染，彻底保证跟手。
  // 让路用 FLIP：激活时采集各格「固定原始槽位坐标」，之后插入判断 + 让路位移都基于这份快照
  //（绝不用实时 rect——格子 transform 移动后 getBoundingClientRect 会含位移、污染插入判断）。
  // React state 仅用于：① 触发 ghost 内容渲染（激活时一次 setLauncherDragSource，含首帧坐标）②清除 ghost。
  const handleLauncherPointerDown = useCallback((e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    if (search.trim()) return; // 过滤态禁排序（filteredLauncher 是子集）
    if (launcherLandingRef.current) return; // 上一次松手回落动画未结束，忽略新起手（防脏几何）
    const srcIdx = launcherRef.current.findIndex(x => x.id === id);
    if (srcIdx === -1) return;
    e.preventDefault(); // 阻止默认（防文字选中、防系统拖拽光标）
    const originX = e.clientX, originY = e.clientY;
    const srcEl = e.currentTarget as HTMLElement;
    const srcStartRect = srcEl.getBoundingClientRect();
    const grabOffsetX = originX - srcStartRect.left;
    const grabOffsetY = originY - srcStartRect.top;
    launcherDragActiveRef.current = false;
    launcherDragInsertRef.current = srcIdx;
    suppressLaunchClickRef.current = false;

    // FLIP 快照：激活时采集，之后固定不变（同一次 pointerdown 闭包内 onMove/onUp 共享）
    let tiles: HTMLElement[] = [];
    let rects: { left: number; top: number; width: number; height: number }[] = [];
    let ghostEl: HTMLElement | null = null;

    // 按固定槽位快照判断鼠标落在哪个插入点（0..n，插入到第 idx 个之前）
    const calcInsert = (cx: number, cy: number): number => {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (cy < r.top) return i; // 鼠标在本行上方 → 插入本行第一项前
        if (cy <= r.top + r.height) {
          if (cx < r.left + r.width / 2) return i; // 左半区 → 插入此格前
          // 右半区 → 继续找下一格
        }
      }
      return rects.length;
    };

    // 让路：源被抓走后，非源格子平移填补，为落点 target 槽腾出空位（transform 纯视觉、不改 grid）
    const applyShift = (insertIdx: number) => {
      const target = insertIdx > srcIdx ? insertIdx - 1 : insertIdx; // 源在「去源序列」里的落点槽
      for (let i = 0; i < tiles.length; i++) {
        if (i === srcIdx) continue; // 源由 ghost 代替、不参与让路
        const k = i < srcIdx ? i : i - 1;        // 该格在去源序列里的顺序
        const newSlot = k < target ? k : k + 1;   // 跳过 target 槽 → 让出空位
        const dx = rects[newSlot].left - rects[i].left;
        const dy = rects[newSlot].top - rects[i].top;
        tiles[i].style.transform = dx || dy ? `translate(${dx}px,${dy}px)` : "";
      }
    };

    const onMove = (me: PointerEvent) => {
      if (!launcherDragActiveRef.current) {
        if (Math.hypot(me.clientX - originX, me.clientY - originY) < 8) return;
        // 超阈值激活：先采集固定槽位快照（此刻所有格都在原位、未 transform）
        tiles = Array.from(document.querySelectorAll<HTMLElement>(".app-grid .app-tile"));
        rects = tiles.map(t => { const r = t.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
        tiles.forEach(t => t.classList.add("launcher-shift")); // 建立让路过渡
        launcherDragActiveRef.current = true;
        suppressLaunchClickRef.current = true;
        ghostEl = srcEl.cloneNode(true) as HTMLElement;
        ghostEl.classList.remove("selected", "launcher-dragging-src", "launcher-shift"); // 续143：摘掉继承的 launcher-shift（transition:transform 200ms → 逐帧 transform 位移被动画化 → 滞后不跟手）
        ghostEl.classList.add("launcher-drag-ghost");
        ghostEl.querySelectorAll("img").forEach(img => { img.draggable = false; });
        const ghostHost = dragLayerRef.current ?? document.body;
        const inDragLayer = ghostHost === dragLayerRef.current;
        // 续143：位移走 transform:translate3d 而非 left/top（后者逐帧 layout → 掉帧）；scale 并入同一 transform。同剪贴板 ghost。
        Object.assign(ghostEl.style, {
          position: inDragLayer ? "absolute" : "fixed",
          left: "0",
          top: "0",
          transition: "none", // 续143：拖动期间瞬时跟手（落定时 onUp 再设 180ms）
          transform: `translate3d(${me.clientX - grabOffsetX}px,${me.clientY - grabOffsetY}px,0) scale(1.05)`,
          width: `${srcStartRect.width}px`,
          height: `${srcStartRect.height}px`,
          zIndex: inDragLayer ? "" : "100003",
          display: "flex",
          opacity: "0.72",
          visibility: "visible",
          pointerEvents: "none",
        });
        ghostHost.appendChild(ghostEl);
        srcEl.classList.add("launcher-dragging-src");
        document.getElementById("overlay")?.classList.add("launcher-reordering");
      }
      // ghost 跟手：保持鼠标在原卡片内的相对位置，直接写 transform，零 React 渲染、零 layout（续143）
      if (ghostEl) {
        ghostEl.style.transform = `translate3d(${me.clientX - grabOffsetX}px,${me.clientY - grabOffsetY}px,0) scale(1.05)`;
      }
      const ins = calcInsert(me.clientX, me.clientY);
      if (ins !== launcherDragInsertRef.current) {
        launcherDragInsertRef.current = ins;
        applyShift(ins);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      if (!launcherDragActiveRef.current) { // 短按 → 未激活，onClick 正常启动
        srcEl.classList.remove("launcher-dragging-src");
        return;
      }
      launcherDragActiveRef.current = false;
      const finalInsert = launcherDragInsertRef.current;
      const target = finalInsert > srcIdx ? finalInsert - 1 : finalInsert;

      // 松手回落：ghost 平滑飞回落点空槽（rects[target]），落定后再统一 commit
      const landing = rects[target] ?? rects[srcIdx];
      launcherLandingRef.current = true;
      if (ghostEl && landing) {
        ghostEl.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1)"; // 续143：落定动画同走 transform
        ghostEl.style.transform = `translate3d(${landing.left}px,${landing.top}px,0) scale(1.05)`;
      }

      // 180ms 回落结束后统一 commit：清 transform/class → 清 ghost → 重排持久化
      window.setTimeout(() => {
        tiles.forEach(t => { t.style.transform = ""; t.classList.remove("launcher-shift"); });
        srcEl.classList.remove("launcher-dragging-src");
        document.getElementById("overlay")?.classList.remove("launcher-reordering");
        ghostEl?.remove();
        ghostEl = null;
        launcherLandingRef.current = false;
        const list = [...launcherRef.current];
        const [moved] = list.splice(srcIdx, 1);
        const tgt = Math.max(0, Math.min(target, list.length));
        list.splice(tgt, 0, moved);
        const unchanged = list.every((x, i) => x.id === launcherRef.current[i]?.id);
        if (!unchanged) saveLauncher(list); // 位置不变则跳过 I/O
      }, 180);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [search, saveLauncher]);

  // 发一条轻提示；重复调用直接顶掉上一条（不排队——排队会让连续操作的提示滞后于操作本身）。
  const showToast = useCallback((msg:string) => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast({ id: ++toastIdRef.current, msg });
    toastTimerRef.current = window.setTimeout(() => { setToast(null); toastTimerRef.current = null; }, TOAST_MS);
  }, []);

  // 把 AddResult 翻成一句提示。集中在此，避免每个调用点各写一遍三分支（也保证措辞一致）。
  const toastAddResult = useCallback((res:AddResult, target:"launcher"|"stage", name:string) => {
    const where = target==="launcher" ? t("启动台") : t("中转站"); // 用面板正名（i18n 既有 key）
    if (res==="duplicate") showToast(t("已在{where}中：{name}", {where, name}));
    else if (res==="full")  showToast(t("{where}已满（{n}）", {where, n:target==="launcher"?LAUNCHER_MAX:stageMax}));
    else                    showToast(t("已添加到{where}：{name}", {where, name}));
  }, [showToast, t, stageMax]);

  // 从 app picker 加入应用（按 path 去重）
  const addAppToLauncher = useCallback((app:AppInfo):AddResult => {
    if (launcher.some(x=>x.kind==="app" && x.path===app.path)) return "duplicate";
    if (launcher.length >= LAUNCHER_MAX) return "full";
    saveLauncher([...launcher, { id:launcherId(), kind:"app" as const, name:app.name, icon:app.icon, path:app.path }].slice(0,LAUNCHER_MAX));
    return "added";
  }, [launcher, saveLauncher]);
  // 增强搜索 fs 结果加入中转区（按 path 去重，置顶）。
  // 返回 AddResult 供调用方发**诚实**的提示——重复是静默 early-return、超上限是静默 slice 丢弃，
  // 调用方无从分辨，不回报状态就会出现「明明没加进去却提示已添加」的假成功。
  const addFsToStage = useCallback(async (r:{path:string;name:string;ext:string;isDir:boolean}):Promise<AddResult> => {
    if (stage.some(s => s.items?.[0]?.path === r.path)) return "duplicate";
    const isImage = IMG_EXTS.includes((r.ext||"").toLowerCase());
    let icon: string | null = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<FileEntry>("get_file_info", { path: r.path });
      icon = info.icon ?? null;
    } catch {}
    const item: StageItem = { id:stageId(), type:"file", items:[{path:r.path,name:r.name,ext:r.ext,isImage,icon}], count:1, name:r.name, ext:r.ext, isDir:r.isDir };
    saveStage([item, ...stage].slice(0, stageMax));
    return "added"; // 中转区是「置顶 + 截尾」，新项恒在，不会像启动台那样被上限挡在门外
  }, [stage, saveStage, stageMax]);
  // 增强搜索 fs 结果加入启动台（按 path 去重）；图标用系统默认图标（与桌面/资源管理器一致）：
  // 优先复用结果自带 icon（搜索索引已附），缺失则回退 get_file_info 取一次。
  const addFsToLauncher = useCallback(async (r:{path:string;name:string;ext?:string;isDir:boolean;icon?:string|null}):Promise<AddResult> => {
    if (launcher.some(x => x.path === r.path)) return "duplicate";
    if (launcher.length >= LAUNCHER_MAX) return "full"; // 追加式 + slice 截尾 → 满了新项会被静默丢弃
    let icon: string | null = r.icon ?? null;
    if (!icon) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<FileEntry>("get_file_info", { path: r.path });
        icon = info.icon ?? null;
      } catch {}
    }
    saveLauncher([...launcher, {id:launcherId(), kind:r.isDir?"folder" as const:"file" as const, name:r.name, icon, path:r.path, ext:r.ext}].slice(0,LAUNCHER_MAX));
    return "added";
  }, [launcher, saveLauncher]);
  // 启动台「浏览文件…/浏览文件夹…」：经系统选择框收藏任意路径（续112）。
  // 补的是覆盖盲区——此前非拖入的唯一入口是增强搜索命中，索引外的路径（网络盘 / 被 skip 名单剪掉的
  // 目录 / 刚新建的目录）根本搜不到，只能去资源管理器拖，而 overlay 全屏覆盖时这一步很别扭。
  // 与 pickSearchDir 同理：Rust 的 pick_file/pick_folder 在对话框存续期间置 DIALOG_ACTIVE，
  // light-dismiss 与热键都让路，故此处**不需要也不应该** hideWorkbench()。
  const pickLauncherPath = useCallback(async (kind:"file"|"folder") => {
    if (launcherPicking) return;
    setLauncherPicking(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const p = await invoke<string|null>(kind==="folder" ? "pick_folder" : "pick_file");
      if (!p) return; // 用户取消 → Rust 返回 null，静默收场（取消不是失败，不必提示）
      // 名称/扩展名/是否目录/图标一律由 Rust 取，避免前端切路径字符串（UNC、尾斜杠、无扩展名等边角）
      const info = await invoke<FileEntry>("get_file_info", { path: p });
      // 去重/上限规则只留在 addFsToLauncher 一处，此处不再预判，避免两套规则漂移
      toastAddResult(await addFsToLauncher({ path:p, name:info.name, ext:info.ext, isDir:info.isDir, icon:info.icon ?? null }), "launcher", info.name);
    } catch (e) {
      console.error("[pick_launcher_path]", e);
      showToast(t("添加失败"));
    } finally {
      setLauncherPicking(false);
    }
  }, [launcherPicking, addFsToLauncher, toastAddResult, showToast, t]);
  // 从启动器移除（右键）
  const removeLauncherItem = useCallback((id:number) => { saveLauncher(launcher.filter(x=>x.id!==id)); }, [launcher, saveLauncher]);

  const removeStage = useCallback((id:number) => { saveStage(stage.filter(s=>s.id!==id)); }, [stage,saveStage]);
  // 剪贴板项「钉到中转」：同类型同内容已在则不重复；新项置顶；单文件异步补全 Windows 图标
  const addToStage = useCallback(async (c:ClipItem) => {
    c = { ...c, content: await hydrateContent(c) }; // 步骤2：图片 content 现取，供下方 exists 比对 + clipToStage 落库
    const exists = stage.some(s => s.type===c.type && (c.type==="file" ? s.items?.[0]?.path===c.items?.[0]?.path : s.content===c.content));
    // 续146c：原先重复项**静默 return**，用户看到的就是「拖过去没反应」，无从分辨是重复还是坏了。
    if (exists) {
      const nm = c.type==="text" ? (c.content||"").trim().slice(0,20) : c.type==="image" ? t("图片") : (c.items?.[0]?.name || t("文件"));
      showToast(t("已在{where}中：{name}", { where: t("中转站"), name: nm })); // 复用既有词条，不新增 key
      return;
    }
    let item = clipToStage(c);
    if (c.type==="file" && (c.count??0)<=1 && c.items?.[0]?.path && item.items?.[0]) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<FileEntry>("get_file_info", { path: c.items[0].path });
        if (info.icon) item = { ...item, items: [{ ...item.items![0], icon: info.icon }] };
      } catch {}
    }
    saveStage([item, ...stage].slice(0,stageMax));
  }, [stage,saveStage,stageMax,showToast,t]);
  // 清拖拽现场（**不投放**）：卸载 ghost + 复位光标/高亮。
  // 凡非「正常松手」的收尾都必须走这里——热键关页 / Esc / pointercancel / 丢 capture。
  // 续109 bug 根因：hotkey-hide 复位了重排/框选/多选等全部现场，唯独漏了剪贴板拖拽 →
  //   拖着不松手按热键关页，pointerup 再也到不了卡片 → ghost 永久悬浮到下次呼出。
  // 续109b bug（**由续109 修复衍生**）：热键关页时本函数清掉了 clipDragRef，再呼出松手时
  //   handleClipPointerUp 已读不到拖拽态（active=false 提前 return、不设 suppress）→ 浏览器
  //   随后在卡片上合成的 click 落到 onClick 的 copyAndPaste（写回剪贴板+焦点交还+Ctrl+V）
  //   → 剪贴板项被"点击粘贴"进外部焦点窗口、界面消失。**根治**：凡在「已激活拖拽」中被清场
  //   （含热键关页/丢 capture/cancel/正常松手），一律在此置 suppressClickRef，吞掉随后的 click。
  //   （suppressClickRef 会被下次 pointerdown 复位 → 不会误伤后续正常点击粘贴，自愈。）
  // 幂等：ref 已空 / state 已 null 时 React 自动 bail out，可安全重复调用。
  // 续110 clearNativeFlag：默认 true=非升级收尾（落点 A/B/丢 capture/cancel/热键关页），一并清 Rust
  //   CLIP_DRAG_ACTIVE 让路标志；升级为原生拖出时（beginClipDragOut）传 false——标志留给 Rust 无缝交接
  //   （do_drag_on_main 先置 DRAG_IN_PROGRESS 再清它），中间不留空窗被 monitor/light-dismiss 钻空提前 hide。
  const setClipDragActiveNative = useCallback((active: boolean) => {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_clip_drag_active", { active })).catch(() => {});
  }, []);
  const endClipDrag = useCallback((clearNativeFlag = true) => {
    if (clipDragRef.current?.active) suppressClickRef.current = true;
    clipDragRef.current = null;
    document.getElementById("overlay")?.classList.remove("dragging");
    dropAreaRef.current?.closest(".center-panel")?.classList.remove("drag-over"); // 续144：高亮挂整栏面板
    setClipDragItem(null);
    if (clearNativeFlag) setClipDragActiveNative(false);
  }, [setClipDragActiveNative]);
  // 拖拽：按下记录起点（不立刻激活，等移动超阈值），但跳过 .clip-actions 内的按钮区，且仅左键
  const handleClipPointerDown = useCallback((e: React.PointerEvent, c: ClipItem) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".clip-actions")) return; // 复制/删除/📌 按钮区不参与拖拽
    suppressClickRef.current = false; // 每次新交互复位，避免上次拖拽残留误抑制本次点击
    clipDragRef.current = { item: c, originX: e.clientX, originY: e.clientY, x: e.clientX, y: e.clientY, active: false, dropRect: null };
    e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针，移动出卡片也持续收到 move/up
  }, []);
  // 拖拽：移动超阈值激活；激活后跟手并按命中与否高亮中转区
  const handleClipPointerMove = useCallback((e: React.PointerEvent) => {
    const ds = clipDragRef.current;
    if (!ds) return;
    ds.x = e.clientX; ds.y = e.clientY; // ghost ref 回调按此就位，无 (0,0) 闪帧
    if (!ds.active) {
      if (Math.hypot(e.clientX - ds.originX, e.clientY - ds.originY) < DRAG_THRESHOLD_PX) return;
      ds.active = true;
      // 落点矩形在拖拽全程不变（.center-panel 固定 800px、满栏高，不随内容/滚动移动）→ 激活时快照一次，
      // 避免每次 move 都 getBoundingClientRect 与 classList 写形成「写后读」强制同步布局。
      // 续144：从 .drop-area 改为**整栏 .center-panel**——与蓝框高亮范围一致（含标题行/快捷入口行），
      // 否则「整栏亮蓝、只有中间能放」会让落在标题行/快捷入口行的松手静默失败。
      ds.dropRect = (dropAreaRef.current?.closest(".center-panel") as HTMLElement | null)?.getBoundingClientRect() ?? null;
      document.getElementById("overlay")?.classList.add("dragging"); // 防泛蓝 + grabbing 光标
      setClipDragItem(ds.item); // 全程唯一一次「挂载 ghost」渲染
      // 续110：告知 Rust 剪贴板纯 JS 拖动已激活 → light-dismiss 让路、热键 monitor 改 emit clip-drag-hotkey。
      setClipDragActiveNative(true);
      return;
    }
    const g = clipGhostRef.current; // 跟手：直写 DOM transform，零 React 渲染 + 零布局重绘
    if (g) g.style.transform = `translate3d(${e.clientX + 12}px,${e.clientY + 12}px,0)`;
    const r = ds.dropRect;
    const over = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    dropAreaRef.current?.closest(".center-panel")?.classList.toggle("drag-over", over); // 续144：高亮挂整栏面板
  }, [setClipDragActiveNative]);
  // 拖拽结束：仅在激活且落点命中中转区时入中转（不粘贴）；未激活则放手让 onClick 正常粘贴。
  // 落点只认中转区——落在启动台/剪贴板/空白一律无操作（拖拽的唯一功能就是进中转区）。
  const handleClipPointerUp = useCallback((e: React.PointerEvent) => {
    const ds = clipDragRef.current;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    const active = !!ds?.active, item = ds?.item, r = ds?.dropRect;
    endClipDrag(); // 先清场（active 时 endClipDrag 已置 suppressClickRef 吞掉随后 onClick），投放与否都不留残留
    if (!active) return; // 短按 / 未越阈值：不拦截，交给原有 onClick 粘贴（未 suppress）
    if (item && r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) addToStage(item);
  }, [addToStage, endClipDrag]);
  // pointercancel（系统/浏览器撤销手势）：坐标已不可信 → 只清场、**绝不按落点投放**。
  // 原实现把 cancel 直接接到 pointerUp 上，会拿着可疑坐标去判中转区命中而误投放。
  // suppress 由 endClipDrag 统一处理（active 时置位，防 cancel 后补发 click 误粘贴）。
  const handleClipPointerCancel = useCallback(() => {
    endClipDrag();
  }, [endClipDrag]);
  // 续110：剪贴板项纯 JS 拖动中按热键 → 升级为原生 OLE 拖出（拖到外部桌面/文件夹/输入框/文本框）。
  // 完全仿续88 stage-drag-hotkey 升级路径：force_hide=true 让 Rust 在窗口仍可见时先起手 DoDragDrop
  // （SetCapture 成功）、再由 dragout 自身隐藏 overlay。清 JS ghost 但 endClipDrag(false)**保留
  // CLIP_DRAG_ACTIVE 标志**——留给 Rust do_drag_on_main 无缝交接（先置 DRAG_IN_PROGRESS 再清它）。
  // 数据映射同 beginNativeDragOut：items → 路径数组；来源置 "clip" 供 drag-out-done 不删任何条目。
  const beginClipDragOut = useCallback((c: ClipItem) => {
    dragOutSourceRef.current = "clip";
    droppedOnSelfRef.current = false;
    // ⚠️ 此路径必须**完全同步**：start_drag_out 的 DoDragDrop 主线程模态 + CLIP_DRAG_ACTIVE 无缝交接（R13）
    // 对 invoke 与 endClipDrag 的先后时序极敏感——插入任何 await 都会卡死呼出（已实测 100% 复现）。
    // 步骤2：图片 content 已不在前端 state，故**不在这里现取**（那要 await），改为把 time 带给 Rust，
    // 由 dragout.rs 按 time 从 CLIP_CACHE 自查 content（DragOutItem.resolve_content）。
    const dragItem = { type: c.type, content: c.content ?? null, items: c.items?.map(f => f.path) ?? null, orig_path: c.orig_path ?? null, time: c.time };
    console.log("[clip-drag] → native drag-out", c.type); // 续110 诊断
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("start_drag_out", { items: [dragItem], forceHide: true })).catch(() => {});
    endClipDrag(false); // 清 ghost；CLIP_DRAG_ACTIVE 不清，交给 Rust 无缝交接
  }, [endClipDrag]);
  // ── 中转区框选多选（续70）──
  // 实时计算选区矩形与各条目 DOM 的相交，命中者写入 stageSel；与显式多选共用同一套状态。
  // 续143：框选激活时调用一次——快照当前所有卡片的 id + rect（按当前 stageLayout 选对应选择器）。
  const snapshotLassoRects = useCallback(() => {
    const arr: { id: number; left: number; top: number; right: number; bottom: number }[] = [];
    dropAreaRef.current?.querySelectorAll<HTMLElement>(stageLayout==="grid"?".stage-card":".stage-item").forEach(el => {
      const id = Number(el.dataset.stageId);
      if (Number.isNaN(id)) return;
      const rc = el.getBoundingClientRect();
      arr.push({ id, left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom });
    });
    lassoRectsRef.current = arr;
  }, [stageLayout]);
  const computeLassoSelection = useCallback((origin:{x:number;y:number}, current:{x:number;y:number}) => {
    const l = Math.min(origin.x, current.x), r = Math.max(origin.x, current.x);
    const t = Math.min(origin.y, current.y), b = Math.max(origin.y, current.y);
    const sel = new Set<number>();
    // 续143：只对激活时的快照矩形求交，move 期间零 DOM 查询、零布局读取
    for (const rc of lassoRectsRef.current) {
      if (rc.left <= r && rc.right >= l && rc.top <= b && rc.bottom >= t) sel.add(rc.id); // 矩形相交
    }
    // 续143：选区未变则返回同一引用 → 跳过 React 重渲（框选 move 大量帧里选区其实不常变）
    setStageSel(prev => (prev.size === sel.size && [...sel].every(id => prev.has(id))) ? prev : sel);
  }, []);
  const handleLassoPointerDown = useCallback((e: React.PointerEvent) => {
    lassoArmedRef.current = false;
    if (e.button !== 0) return; // 仅左键
    if (clipDragRef.current?.active) return; // 剪贴板卡片拖拽进行中不框选（复用现有 clipDrag 检查）
    // 命中条目 / 操作按钮 / 工具栏则交给原有点击逻辑，不框选
    if ((e.target as Element).closest(".stage-item,.stage-card,.stage-multi-toolbar,.stage-batch-bar,button")) return;
    lassoArmedRef.current = true;
    setLassoState({ active: false, origin: { x: e.clientX, y: e.clientY }, current: { x: e.clientX, y: e.clientY } });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // 不立即激活——等 move 超阈值
  }, []);
  const handleLassoPointerMove = useCallback((e: React.PointerEvent) => {
    if (!lassoArmedRef.current) return; // 未布防（如在条目上按下拖拽）
    if (e.buttons === 0) return; // 未按下
    const ls = lassoStateRef.current;
    const cur = { x: e.clientX, y: e.clientY };
    if (!ls.active) {
      if (Math.hypot(cur.x - ls.origin.x, cur.y - ls.origin.y) <= LASSO_THRESHOLD_PX) return; // 未超阈值不激活
      dropAreaRef.current?.classList.add("lasso-active"); // user-select:none + crosshair
      setLassoState({ ...ls, active: true, current: cur });
      setStageMultiselect(true);
      snapshotLassoRects(); // 续143：激活时快照卡片 rect，之后 move 只对缓存求交
      computeLassoSelection(ls.origin, cur);
      return;
    }
    setLassoState({ ...ls, current: cur }); // 触发重渲染刷新选区矩形
    computeLassoSelection(ls.origin, cur);
  }, [computeLassoSelection, snapshotLassoRects]);
  const handleLassoPointerUp = useCallback((e: React.PointerEvent) => {
    if (!lassoArmedRef.current) return;
    lassoArmedRef.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    const ls = lassoStateRef.current;
    if (!ls.active) {
      // 未激活=纯点击空白（未拖出框选）：若当前有选择则取消（点空白处取消选择）。
      // armed 已保证点的是空白区——条目/按钮在 down 阶段被排除、不会 armed，故不影响条目自身的 toggle/取走。
      if (stageSelRef.current.size || stageMultiselectRef.current) {
        setStageSel(new Set<number>());
        setStageMultiselect(false);
        stageAnchorRef.current = null;
      }
      return;
    }
    dropAreaRef.current?.classList.remove("lasso-active");
    setLassoState(s => ({ ...s, active: false }));
    // 框中条目 → 保持多选；框中空白（选区为空）→ 退出多选
    if (stageSelRef.current.size === 0) setStageMultiselect(false);
  }, []);
  // ── 中转条目拖出（续71）+ 区内重排（续88）──
  // 条目上按下→拖动超阈值→区内重排（FLIP，仿启动台），单项拖动全程只排序、界面开着时永不自动升级为原生拖出
  // （续143 删除旧的「光标离开 .drop-area 边界即升级」逻辑）。去外部靠拖动中按热键手动隐藏界面→ stage-drag-hotkey
  // 升级为原生 OLE 拖出（Rust 侧 STA 线程跑 DoDragDrop，hide overlay 后接管鼠标），在目标处松手投放。
  // 与框选互斥：down 在条目上时 .drop-area 的 lasso 不布防（closest 排除）；与左键取走互斥：未超阈值=普通点击。
  // 区内重排仅限单项拖动（多选拖多项 / 搜索过滤态 索引对不上）：两种情形直接走原生拖出，行为与重排功能加入前一致。
  // 续88 bug 修复：重排阶段窗口全程可见、尚未进入 Rust 的 DRAG_IN_PROGRESS——必须另行告知 Rust 侧
  // light-dismiss/热键 monitor 在此期间也让路，否则前台瞬时切换会被判定为"点了外部应用"提前 hide()，
  // 打断整个手势（ghost 卡死 + 从未真正调用 start_drag_out，"拖到外部目标"根本没发生）。
  const setStageReorderActiveNative = useCallback((active: boolean) => {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_stage_reorder_active", { active })).catch(() => {});
  }, []);
  // forceHide=true：由"区内重排中按热键"升级而来——Rust 侧无视 keepOpen 设置强制隐藏 overlay（用户已明确要隐藏
  // 去外部投放）。边界越出触发的常规升级传 false，沿用中转站「拖出后自动关闭」设置。
  const beginNativeDragOut = useCallback((ids: number[], forceHide = false) => {
    const dr = dragOutRef.current;
    console.log("[stage-drag] → native drag-out", ids, "forceHide=", forceHide); // 续88 诊断
    dr.mode = "native";
    dr.draggedIds = ids;
    dragOutSourceRef.current = "stage"; // 续110：中转站来源，drag-out-done 走原有删条目/持久化逻辑
    droppedOnSelfRef.current = false; // 续97：每次拖出重置「落回自身」标记，等 files-dropped 内部落点再置位
    const dragItems = stageRef.current.filter(s => ids.includes(s.id)).map(s => ({
      type: s.type,
      content: s.content ?? null,
      items: s.items?.map(f => f.path) ?? null,
      orig_path: s.orig_path ?? null,
    }));
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("start_drag_out", { items: dragItems, forceHide })).catch(() => {});
  }, []);
  // FLIP 快照 + ghost 建立：与启动台 handleLauncherPointerDown 的 onMove 激活段同构，选择器按当前 stageLayout 决定。
  const startStageReorder = useCallback((id: number, srcEl: HTMLElement, clientX: number, clientY: number) => {
    const container = dropAreaRef.current;
    const srcIdx = stageRef.current.findIndex(s => s.id === id);
    if (!container || srcIdx === -1) return;
    const selector = stageLayout === "grid" ? ".stage-card" : ".stage-item";
    const tiles = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const rects = tiles.map(t => { const r = t.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const srcStartRect = srcEl.getBoundingClientRect();
    const grabOffsetX = clientX - srcStartRect.left, grabOffsetY = clientY - srcStartRect.top;
    tiles.forEach(t => t.classList.add("stage-shift"));
    const ghostEl = srcEl.cloneNode(true) as HTMLElement;
    ghostEl.classList.remove("selected", "stage-shift"); // 续143：摘掉克隆时继承来的 stage-shift（它带 transition:transform 200ms，会让逐帧 transform 位移被动画化 → 滞后不跟手）
    ghostEl.classList.add("stage-drag-ghost");
    ghostEl.querySelectorAll("img").forEach(img => { (img as HTMLImageElement).draggable = false; });
    const ghostHost = dragLayerRef.current ?? document.body;
    const inDragLayer = ghostHost === dragLayerRef.current;
    // 续143：位移走 transform:translate3d 而非 left/top（left/top 逐帧触发 layout → 掉帧；transform 只走合成器）。
    // 固定 left/top=0，位置全交给 translate3d；scale 并入同一 transform（合成器一次处理）。同剪贴板 ghost（续109）。
    Object.assign(ghostEl.style, {
      position: inDragLayer ? "absolute" : "fixed",
      left: "0",
      top: "0",
      transition: "none", // 续143：拖动期间瞬时跟手（落定时 commitStageReorder 再设 180ms）
      transform: `translate3d(${clientX - grabOffsetX}px,${clientY - grabOffsetY}px,0) scale(1.04)`,
      width: `${srcStartRect.width}px`,
      height: `${srcStartRect.height}px`,
      zIndex: inDragLayer ? "" : "100003",
      opacity: "0.85",
      visibility: "visible",
      pointerEvents: "none",
    });
    ghostHost.appendChild(ghostEl);
    srcEl.classList.add("stage-dragging-src");
    document.getElementById("overlay")?.classList.add("stage-reordering");
    stageReorderRef.current = { active: true, tiles, rects, ghostEl, srcEl, srcIdx, insertIdx: srcIdx, grabOffsetX, grabOffsetY };
    console.log("[stage-drag] reorder start id=", id, "srcIdx=", srcIdx); // 续88 诊断
    setStageReorderActiveNative(true); // 告知 Rust：light-dismiss 本阶段让路（热键 monitor 续88 起不再让路）
  }, [stageLayout, setStageReorderActiveNative]);
  const updateStageReorder = useCallback((clientX: number, clientY: number) => {
    const st = stageReorderRef.current;
    if (!st.active || !st.ghostEl) return;
    st.ghostEl.style.transform = `translate3d(${clientX - st.grabOffsetX}px,${clientY - st.grabOffsetY}px,0) scale(1.04)`; // 续143：合成器位移，零 layout
    // 按固定槽位快照判断插入点：同启动台 calcInsert（cy 落在某行 → 按 cx 半区决定插入本格前/继续找下一格）
    let ins = st.rects.length;
    for (let i = 0; i < st.rects.length; i++) {
      const r = st.rects[i];
      if (clientY < r.top) { ins = i; break; }
      if (clientY <= r.top + r.height && clientX < r.left + r.width / 2) { ins = i; break; }
    }
    if (ins !== st.insertIdx) {
      st.insertIdx = ins;
      const target = ins > st.srcIdx ? ins - 1 : ins;
      for (let i = 0; i < st.tiles.length; i++) {
        if (i === st.srcIdx) continue;
        const k = i < st.srcIdx ? i : i - 1;
        const newSlot = k < target ? k : k + 1;
        const dx = st.rects[newSlot].left - st.rects[i].left;
        const dy = st.rects[newSlot].top - st.rects[i].top;
        st.tiles[i].style.transform = dx || dy ? `translate(${dx}px,${dy}px)` : "";
      }
    }
  }, []);
  // 升级为原生拖出前的清场：无落定动画（马上交给 Rust 接管鼠标），立即复原让路 transform + 清 ghost。
  // ⚠️ 本函数只做 JS 侧清场（ghost / 让路 transform / class），**不**清 Rust 的 STAGE_REORDER_ACTIVE 让路标志。
  // 清标志的时机分两类，别在这里一刀切：
  //   ① 升级为原生拖出（边界越出 / 热键触发）→ 标志必须**保持为真**直到 Rust do_drag_on_main 置位 DRAG_IN_PROGRESS
  //      后再由 Rust 清（两标志无缝交接、中间无空窗，防 monitor/light-dismiss 在交接瞬间钻空 hide 窗口 →
  //      DoDragDrop 起手 SetCapture 失败 → 松手无文件落地，续88 四轮反馈根因）；
  //   ② 非升级的终止（重排落定 commit / 意外丢 pointer capture）→ 由各自调用点显式 setStageReorderActiveNative(false)。
  const cancelStageReorder = useCallback(() => {
    const st = stageReorderRef.current;
    if (!st.active) return;
    console.log("[stage-drag] reorder cancel (仅 JS 清场，标志留待 Rust/调用点处理)"); // 续88 诊断
    st.tiles.forEach(t => { t.style.transform = ""; t.classList.remove("stage-shift"); });
    st.srcEl?.classList.remove("stage-dragging-src");
    document.getElementById("overlay")?.classList.remove("stage-reordering");
    st.ghostEl?.remove();
    stageReorderRef.current = { ...st, active: false, ghostEl: null, tiles: [], rects: [] };
  }, []);
  // 松手提交：ghost 飞回落点空槽，180ms 落定后统一 commit（同启动台 onUp 收尾节奏）。
  const commitStageReorder = useCallback(() => {
    const st = stageReorderRef.current;
    if (!st.active) return;
    const { srcIdx, tiles, ghostEl, srcEl } = st;
    const target = st.insertIdx > srcIdx ? st.insertIdx - 1 : st.insertIdx;
    const landing = st.rects[target] ?? st.rects[srcIdx];
    if (ghostEl && landing) {
      ghostEl.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1)"; // 续143：落定动画同走 transform
      ghostEl.style.transform = `translate3d(${landing.left}px,${landing.top}px,0) scale(1.04)`;
    }
    stageReorderRef.current = { ...st, active: false };
    setStageReorderActiveNative(false); // 重排结束（落定动画只是视觉收尾，与 Rust 让路无关，可立即清）
    window.setTimeout(() => {
      tiles.forEach(t => { t.style.transform = ""; t.classList.remove("stage-shift"); });
      srcEl?.classList.remove("stage-dragging-src");
      document.getElementById("overlay")?.classList.remove("stage-reordering");
      ghostEl?.remove();
      const list = [...stageRef.current];
      const [moved] = list.splice(srcIdx, 1);
      const tgt = Math.max(0, Math.min(target, list.length));
      list.splice(tgt, 0, moved);
      const unchanged = list.every((x, i) => x.id === stageRef.current[i]?.id);
      if (!unchanged) saveStage(list); // 位置不变则跳过 I/O
    }, 180);
  }, [saveStage, setStageReorderActiveNative]);
  // 续143：单项重排松手落点在启动台 → 加入启动台（恢复旧「拖中转项目到启动台」功能——旧靠越界升级为原生 OLE
  // 落到启动台再由 files-dropped 处理，续143 删了越界升级故改在此 JS 落点侧处理）。仅文件/文件夹项（有 path）可入；
  // 忠实旧 OLE 行为的 move 语义：加入成功（added/duplicate）后，非持久 + 非固定则从中转移除。清 reorder 现场不回弹。
  const dropStageItemToLauncher = useCallback(async (item: StageItem) => {
    let path: string | undefined, name: string, ext: string | undefined, isDir = false, icon: string | null = null;
    if (item.type === "file" && item.items?.[0]?.path) {
      path = item.items[0].path; name = item.name ?? item.items[0].name; ext = item.ext; isDir = !!item.isDir; icon = item.items[0].icon ?? null;
    } else if (item.type === "image") {
      // 图片项无实体路径：物化成持久 PNG 文件再加入（恢复旧「拖截图到启动台」；旧靠 OLE 产 temp 文件、会被清理→死链，今写持久 launcher_images/）
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        path = await invoke<string>("save_image_as_launcher_file", { base64: item.content ?? null, origPath: item.orig_path ?? null });
      } catch { showToast(t("图片加入启动台失败")); return; }
      name = t("截图"); ext = "png";
    } else { return; } // 文本等无实体，不该走到这
    if (!path) return;
    const res = await addFsToLauncher({ path, name, ext, isDir, icon });
    toastAddResult(res, "launcher", name);
    launcherDropRef.current?.classList.add("drop-flash");
    setTimeout(() => launcherDropRef.current?.classList.remove("drop-flash"), 200);
    if ((res === "added" || res === "duplicate") && !stagePersistRef.current && !item.pinned) { // move 语义：非持久/非固定则从中转移除
      const next = stageRef.current.filter(s => s.id !== item.id);
      setStage(next);
      await persistStage(next); // 续146b：改道唯一出口（脱水后落盘）
    }
  }, [addFsToLauncher, toastAddResult, showToast, t]);
  const handleStagePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // 悬浮操作按钮区不触发拖出
    suppressStageClickRef.current = false; // 每次新交互复位
    const id = Number((e.currentTarget as HTMLElement).dataset.stageId);
    if (Number.isNaN(id)) return;
    // 多选状态下按下选中项 → 拖全部选中（ids 在 move 时按 stageSel 决定）；未超阈值松手仍走 onClick 点选
    dragOutRef.current = { pressing: true, itemId: id, origin: { x: e.clientX, y: e.clientY }, draggedIds: [], mode: "idle" };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  }, []);
  const handleStagePointerMove = useCallback((e: React.PointerEvent) => {
    const dr = dragOutRef.current;
    const itemId = dr.itemId;
    // 注意：进入 reorder/native 后 dr.pressing 会置 false（表示"一次性阈值判定"已完成），
    // 但重排/原生拖出仍需继续吃后续 move 事件——门槛判据只能用 itemId + mode，不能查 pressing。
    if (itemId === null || dr.mode === "native") return; // native：已交给 Rust，JS 侧不再处理
    if (dr.mode === "idle") {
      if (!dr.pressing) return;
      // ── 本手势"框选 or 拖出/重排"意图判定（续108）──
      // 多选态：拖未选中卡=框选（拖已选中卡仍=拖出全部选中）；非多选态：从卡片外沿 STAGE_MOAT_PX 内起手=框选（紧凑布局补偿）。
      // 框选走较小的 LASSO 阈值（更跟手），拖出/重排仍走较大的 DRAG_OUT 阈值（防误触）。
      let lassoIntent: boolean;
      if (stageMultiselectRef.current) {
        lassoIntent = !stageSelRef.current.has(itemId);
      } else {
        const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
        lassoIntent = (dr.origin.x - rc.left < STAGE_MOAT_PX) || (rc.right - dr.origin.x < STAGE_MOAT_PX)
                   || (dr.origin.y - rc.top < STAGE_MOAT_PX) || (rc.bottom - dr.origin.y < STAGE_MOAT_PX);
      }
      const threshold = lassoIntent ? LASSO_THRESHOLD_PX : DRAG_OUT_THRESHOLD_PX;
      if (Math.hypot(e.clientX - dr.origin.x, e.clientY - dr.origin.y) < threshold) return;
      dr.pressing = false; // 一次性阈值判定，避免重复进入下面的分支决策
      suppressStageClickRef.current = true; // 抑制紧随的 onClick 取走粘贴/切换选中
      if (lassoIntent) { // 从卡片起手的框选：复用空白框选同一套 lasso 状态（指针已被卡片捕获，直接由卡片 move/up 驱动，无需捕获交接）
        dr.mode = "lasso";
        setLassoState({ active: true, origin: dr.origin, current: { x: e.clientX, y: e.clientY } });
        dropAreaRef.current?.classList.add("lasso-active");
        setStageMultiselect(true);
        snapshotLassoRects(); // 续143：激活时快照卡片 rect，之后 move 只对缓存求交
        computeLassoSelection(dr.origin, { x: e.clientX, y: e.clientY });
        return;
      }
      // 多选且按下项在选区内 → 拖全部选中项；否则 → 拖当前单项（与原有 ids 判定一致）
      const sel = stageSelRef.current;
      let ids = (sel.size > 0 && sel.has(itemId)) ? Array.from(sel) : [itemId];
      // 续100：失踪项排除出拖出集——死路径进 OLE 会崩溃目标(cmd 等)+本进程。全为失踪则复位手势、不起拖动。
      ids = ids.filter(id => !missingIdsRef.current.has(id));
      if (ids.length === 0) { dr.mode = "idle"; dr.itemId = null; return; }
      if (ids.length > 1 || search.trim() || ids[0] !== itemId) { // 多项 / 搜索过滤态 / 按下项被失踪过滤掉（重排要按下元素、故剩余单项非按下项时走原生）：直接原生拖出
        dr.mode = "native";
        beginNativeDragOut(ids);
        return;
      }
      dr.mode = "reorder";
      startStageReorder(itemId, e.currentTarget as HTMLElement, e.clientX, e.clientY);
      return;
    }
    if (dr.mode === "lasso") { // 卡片起手的框选：持续刷新选区矩形 + 命中计算（镜像 handleLassoPointerMove 的激活态）
      setLassoState(s => ({ ...s, current: { x: e.clientX, y: e.clientY } }));
      computeLassoSelection(dr.origin, { x: e.clientX, y: e.clientY });
      return;
    }
    if (dr.mode === "reorder") {
      // 续143：单项重排在界面开着时**永不自动升级为原生拖出**——光标可拖到中转区外（启动台/剪贴板/快捷入口等
      // overlay 任意处），ghost 全程跟手、只做排序，拖回区内无缝续排。去外部的唯一触发是「拖动中按热键手动关界面
      // → stage-drag-hotkey 升级为原生拖出 → 在目标处松手」（见上方 un10 监听器）。已删旧的「越界即升级」逻辑
      // （原按 .drop-area 边界 + STAGE_REORDER_ESCAPE_PX 判定）：不小心蹭出边界再拖回会被误判成拖去外部而中止重排。
      updateStageReorder(e.clientX, e.clientY);
    }
  }, [search, beginNativeDragOut, startStageReorder, updateStageReorder, cancelStageReorder, computeLassoSelection, snapshotLassoRects]);
  const handleStagePointerUp = useCallback((e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    if (dragOutRef.current.mode === "reorder") {
      // 续143：松手落点在启动台 → 加入启动台（而非提交排序回弹）。仅文件/文件夹项可入；非文件项或落在别处则正常提交排序。
      // 命中用**整个启动台面板 .app-panel** 的矩形（.app-grid 在条目少时很小，落在面板空白处会判不中 → 回弹）。
      const panel = (launcherDropRef.current?.closest(".app-panel") as HTMLElement | null) ?? launcherDropRef.current;
      const lr = panel?.getBoundingClientRect();
      const inLauncher = !!lr && e.clientX >= lr.left && e.clientX <= lr.right && e.clientY >= lr.top && e.clientY <= lr.bottom;
      const item = dragOutRef.current.itemId != null ? stageRef.current.find(s => s.id === dragOutRef.current.itemId) : undefined;
      const canLaunch = !!item && ((item.type === "file" && !!item.items?.[0]?.path) || item.type === "image"); // 文件/文件夹有实体路径；图片可物化成 PNG；文本无可启动实体
      if (inLauncher && canLaunch) {
        cancelStageReorder(); setStageReorderActiveNative(false); // 清 reorder 现场（无回弹，源卡回原位）；非升级终止需自清 Rust 让路标志
        void dropStageItemToLauncher(item!);
      } else if (inLauncher && item) { // 落在启动台但是文本项：启动台只收可打开/启动的东西，文本无实体，明确提示、不回弹
        cancelStageReorder(); setStageReorderActiveNative(false);
        showToast(t("文本项无法加入启动台"));
      } else {
        commitStageReorder();
      }
    }
    else if (dragOutRef.current.mode === "lasso") { // 卡片起手的框选收尾（镜像 handleLassoPointerUp 激活态）：清 class；框中为空则退出多选
      dropAreaRef.current?.classList.remove("lasso-active");
      setLassoState(s => ({ ...s, active: false }));
      if (stageSelRef.current.size === 0) setStageMultiselect(false);
    }
    dragOutRef.current.pressing = false; // 未超阈值=普通点击，交给 onClick（取走/选中）
    dragOutRef.current.mode = "idle";
  }, [commitStageReorder, cancelStageReorder, setStageReorderActiveNative, dropStageItemToLauncher, showToast, t]);
  // 安全网（续88）：capture 被外部原因（而非我们自己的 pointerup/releasePointerCapture）中途撤销时兜底清场。
  // 典型触发场景：重排阶段窗口本应由 light-dismiss/热键 monitor 让路（见 dragout.rs stage_reorder_active），
  // 但如果因未预见的原因窗口仍被意外隐藏，浏览器会静默丢弃 capture 而不发 pointerup——不兜底就会永久
  // 卡住 ghost/让路 transform（下次呼出时"卡片悬浮"）。无论根因是否已堵上，这层兜底都应保留。
  const handleStageLostPointerCapture = useCallback(() => {
    console.log("[stage-drag] lost pointer capture", { mode: dragOutRef.current.mode, reorderActive: stageReorderRef.current.active }); // 续88 诊断
    if (stageReorderRef.current.active) cancelStageReorder();
    if (dragOutRef.current.mode === "lasso") { dropAreaRef.current?.classList.remove("lasso-active"); setLassoState(s => ({ ...s, active: false })); } // 续108：capture 被外部撤销时清框选现场
    dragOutRef.current.pressing = false;
    dragOutRef.current.mode = "idle";
    setStageReorderActiveNative(false);
  }, [cancelStageReorder, setStageReorderActiveNative]);
  const openStageFile = useCallback((s:StageItem) => {
    if (s.type!=="file"||!s.items?.[0]) return;
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:s.items![0].path})).catch(()=>{});
  }, []);
  // 从 Rust 权威缓存（CLIP_CACHE）回拉历史覆盖前端 state（续147）。删除/清空乐观改前端后若落地失败，
  // 用它把前端拽回权威真相，避免「前端删了、磁盘没删 → 重启复活」的静默分叉。
  const refreshClipboard = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
    setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
  }, []);
  const deleteClipItem = useCallback(async (time:number) => {
    setClipboard(prev => prev.filter(c => c.time !== time)); // 乐观：先从界面移除
    try {
      const {invoke}=await import("@tauri-apps/api/core");
      await invoke("delete_clipboard_item",{time}); // 命令现返回 Result：落盘失败会 reject → 落入 catch
    } catch {
      // 删除未落地（IPC 失败 / 锁毒化 / 落盘失败）→ 前端已移除会与 Rust 权威缓存分叉、重启复活。
      // 从权威缓存回同步（该条目会重新出现）+ 提示，绝不留静默分叉。
      try { await refreshClipboard(); } catch {}
      showToast(t("删除失败"));
    }
  }, [refreshClipboard, t]);
  const changeTheme = useCallback(async (t:"dark"|"light"|"system") => {
    setTheme(t);
    if(store){ await store.set("theme",t); await store.save(); }
  }, [store]);
  const changeLang = useCallback(async (v:Lang) => {
    setLang(v);
    if(store){ await store.set("language",v); await store.save(); }
    try{ const{invoke}=await import("@tauri-apps/api/core"); await invoke("set_tray_language",{lang:v}); }catch{}
  }, [store]);
  const changeAutostart = useCallback(async (enable: boolean) => {
    try { const {invoke}=await import("@tauri-apps/api/core"); await invoke(enable?"plugin:autostart|enable":"plugin:autostart|disable"); setAutostartEnabled(enable); } catch{}
  }, []);
  // 切换呼出热键：先 invoke set_hotkey（Rust 原子注册新组合，失败 throw）成功后再更新 state + 持久化。
  // Rust 失败（如被占用）则保留旧组合工作，UI 红字提示 3s 后自清。
  const changeHotkey = useCallback(async (next: string) => {
    const normalized = next.trim().toLowerCase();
    if (normalized === hotkeyCombo) return;
    try {
      const {invoke}=await import("@tauri-apps/api/core");
      await invoke("set_hotkey", { combo: normalized });
      setHotkeyCombo(normalized);
      setHotkeyInput(normalized);
      setHotkeyError("");
      if (store) { await store.set("hotkey-combo", normalized); await store.save(); }
    } catch (e:any) {
      setHotkeyError(String(e));
      setTimeout(() => setHotkeyError(""), 3000);
    }
  }, [hotkeyCombo, store]);
  // 切换增强搜索键（纯前端，不经 Rust）：前端校验合法 + 不与呼出热键冲突 → 更新 state + 持久化。
  const changeEnhHotkey = useCallback(async (next: string) => {
    const normalized = next.trim().toLowerCase();
    if (normalized === enhHotkey) return;
    const fail = (msg:string)=>{ setEnhHotkeyError(msg); setTimeout(()=>setEnhHotkeyError(""), 2500); };
    if (!parseComboStr(normalized)) { fail("无效组合"); return; }
    if (normalized === hotkeyCombo) { fail("与呼出热键冲突"); return; }
    setEnhHotkey(normalized);
    setEnhHotkeyInput(normalized);
    setEnhHotkeyError("");
    if (store) { await store.set("enh-hotkey", normalized); await store.save(); }
  }, [enhHotkey, hotkeyCombo, store]);
  // 录制式快捷键：录制态下捕获阶段监听 keydown（抢在全局 onKey 冒泡 handler 之前），转成 token 串写回
  // 对应输入框（不自动应用，用户再点「应用」走 changeHotkey/changeEnhHotkey）。token 映射对齐 Rust key_token 54 条。
  useEffect(() => {
    if (!recording) return;
    const setInput = recording === "main" ? setHotkeyInput : setEnhHotkeyInput; // 写回哪个输入框
    const setErr = recording === "main" ? setHotkeyError : setEnhHotkeyError;
    const flash = (msg: string) => { setErr(msg); setTimeout(() => setErr(""), 2500); };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecording(null); return; } // Esc 取消录制（不关窗——已被 stopPropagation 拦下）
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.shiftKey) mods.push("shift");
      if (e.altKey) mods.push("alt"); // Alt 续46 spike 实测可用（RegisterHotKey 消费组合，不触发菜单栏）
      const isMod = /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code);
      if (isMod) { setInput(mods.length ? mods.join("+") + "+…" : "…"); return; } // 仅修饰键：实时预览等待主键
      if (e.metaKey) { flash("暂不支持 Win 组合"); return; } // 仅拒 Win（OS 吞键）；Alt+Space/Alt+F4 由校验兜底拒
      const main = tokenFromCode(e.code); // 修饰键可选（含纯主键）；Win 仍拒
      if (!main) { flash("不支持的键"); return; }
      setInput([...mods, main].join("+")); // 定型，写回文本框
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true); // capture 阶段：抢在全局 onKey（冒泡）之前
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  const clearClipboard = useCallback(async () => {
    setClipboard([]); // 乐观：先清界面
    try {
      const {invoke}=await import("@tauri-apps/api/core");
      await invoke("clear_clipboard_history"); // 命令现返回 Result：落盘失败会 reject → 落入 catch
    } catch {
      // 清空未落地 → 前端已空会与权威缓存分叉、重启复活。回同步（条目重现）+ 提示（续147）。
      try { await refreshClipboard(); } catch {}
      showToast(t("清空失败"));
    }
  }, [refreshClipboard, t]);
  const clearStage = useCallback(async () => { await saveStage([]); }, [saveStage]);
  const clearLauncher = useCallback(async () => { await saveLauncher([]); }, [saveLauncher]);
  // ── 搜索引擎切换 + 额外目录配置（续57）：持久化 store + 运行时 invoke 应用 ──
  const changeSearchEngine = useCallback(async (eng: "builtin"|"everything") => {
    setSearchEngine(eng);
    if (store) { await store.set("search-engine", eng); await store.save(); }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_search_engine", { engine: eng });
      // 切到 Everything 顺带热检测一次（reload 丢弃旧句柄 → 重载 → 返回是否可用）
      if (eng === "everything") { const avail = await invoke<boolean>("reload_everything"); setEverythingAvailable(!!avail); }
    } catch {}
  }, [store]);
  // Everything 热更新：丢弃旧 DLL 句柄重载 + 重新检测（运行期换 DLL / 启动 Everything 后无需重启）
  const redetectEverything = useCallback(async () => {
    try { const { invoke } = await import("@tauri-apps/api/core"); const avail = await invoke<boolean>("reload_everything"); setEverythingAvailable(!!avail); setEvtRedetected(true); setTimeout(()=>setEvtRedetected(false), 1500); } catch {}
  }, []);
  const applySearchDirs = useCallback(async (dirs: string[]) => {
    setSearchDirs(dirs);
    if (store) { await store.set("search-dirs", dirs); await store.save(); }
    try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_search_dirs", { dirs }); } catch {}
  }, [store]);
  // 弹系统文件夹选择框加目录（续111，取代手输——打错路径会被 Rust 侧 exists() 静默跳过，用户无从察觉）。
  // Rust 的 pick_folder 在对话框存续期间置 DIALOG_ACTIVE，light-dismiss / 热键让路，故此处**不需要**
  // 也**不应该** hideWorkbench()：界面全程保持，对话框以主窗口为 owner 浮在其上。
  // dirPicking 防重复弹（Show 是模态阻塞的，重入会叠出第二个对话框）。
  const pickSearchDir = useCallback(async () => {
    if (dirPicking) return;
    setDirPicking(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const d = await invoke<string|null>("pick_folder");
      if (d && !searchDirs.includes(d)) await applySearchDirs([...searchDirs, d]);
    } catch (e) {
      console.error("[pick_folder]", e);
    } finally {
      setDirPicking(false);
    }
  }, [dirPicking, searchDirs, applySearchDirs]);
  const removeSearchDir = useCallback(async (d: string) => {
    await applySearchDirs(searchDirs.filter(x => x !== d));
  }, [searchDirs, applySearchDirs]);
  const changeClipCacheMax = useCallback(async (n: number) => {
    setClipCacheMax(n);
    if (store) { await store.set("clip-cache-max", n); await store.save(); }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_clip_cache_max", { n });
      // Rust 已截断缓存，重新拉取最新历史同步前端 state
      const history = await invoke<{type:string;content?:string;time:number;items?:FileItem[];count?:number;orig_path?:string}[]>("get_clipboard_history");
      setClipboard(history.map(e => ({ type: e.type as "text"|"image"|"file", content: e.content, time: e.time, items: e.items, count: e.count, orig_path: e.orig_path })));
    } catch {}
  }, [store]);
  const copyAndPaste = useCallback((item:Pasteable) => { // 剪贴板历史 + 中转条目共用：取走（写回剪贴板+焦点交还+Ctrl+V）
    if (launchingRef.current) return; // 与启动共用锁：动画进行中忽略
    // 实际粘贴：hide+交还焦点+Ctrl+V 全在 Rust 命令内（流程不变），此处仅负责调用
    const doPaste = async () => {
      const {invoke}=await import("@tauri-apps/api/core");
      if (item.type === "text") { try { await invoke("paste_clipboard",{text:item.content}); } catch{ await hideWorkbench(); } }
      else if (item.type === "file" && item.items) { try { await invoke("set_clipboard_files",{paths:item.items.map(f=>f.path)}); } catch{ await hideWorkbench(); } }
      else { try { await invoke("set_clipboard_image",{base64:(await hydrateContent(item)) ?? "",origPath:item.orig_path??null}); } catch{ await hideWorkbench(); } } // 步骤2：图片 content 现取
    };
    // 无障碍：跳过淡出，沿用即时粘贴
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { doPaste(); return; }
    // 与启动一致：先播 LAUNCH_ANIM_MS 覆盖层淡出露桌面，再调粘贴命令（命令自身会 hide+粘贴）
    launchingRef.current = true;
    setDismissing(true);
    setTimeout(async () => {
      if (!launchingRef.current) return; // 淡出期间被 Esc/热键复位（用户反悔）→ 放弃粘贴
      try { await doPaste(); }
      finally { setDismissing(false); launchingRef.current = false; } // 粘贴命令不发 hotkey-hide，手动复位（窗口此时已隐藏，复位不可见）
    }, LAUNCH_ANIM_MS);
  }, []);
  copyAndPasteRef.current = copyAndPaste; // 供 activateEnh（定义在前）对剪贴板结果取走粘贴，避开 TDZ
  // 只复制到当前剪贴板（不粘贴、不隐藏 overlay）：内容进系统剪贴板供用户自行 Ctrl+V，且不回流历史面板
  const copyToClipboard = useCallback(async (item:ClipItem) => {
    setCopiedTime(item.time); // 续146c：同 copyStageToClipboard，✓ 先亮再干活（图片项的写入耗时可观）
    setTimeout(()=>setCopiedTime(t=>t===item.time?null:t), 1000); // 1s 后还原 ✓（仅当未被更新的复制覆盖）
    try { await writeItemToClipboard(item); }
    catch { setCopiedTime(t=>t===item.time?null:t); }
  }, []);
  // 中转条目「复制到剪贴板」：同上，独立 ✓ 反馈（按 id）
  // 续146c：✓ **先亮再干活**。原先 await 完写剪贴板才置 ✓——图片项要把 ~300KB base64 送过 IPC、
  // Rust 再解码写剪贴板，于是「点了没反应」（文本项因为快才显得正常）。✓ 反馈的语义是「你这一下点到了」，
  // 不是「剪贴板已写完」，故乐观置位；真失败时立刻撤掉 ✓，不会骗人。
  const copyStageToClipboard = useCallback(async (s:StageItem) => {
    setCopiedStageId(s.id);
    setTimeout(()=>setCopiedStageId(x=>x===s.id?null:x), 1000);
    try { await writeItemToClipboard(s); }
    catch { setCopiedStageId(x=>x===s.id?null:x); }
  }, []);

  // 中转区单击 handler
  // Ctrl/Meta+click：隐式进入多选模式 + 切换单项
  // Shift+click：隐式进入多选模式；首次=设锚点（选这一项为起始）；再次=扩展区间到此
  // plain（多选模式）：切换单项 + 更新锚点
  // plain（非多选模式）：取走粘贴（原行为）
  const handleStageClick = useCallback((e: React.MouseEvent, s: StageItem, idx: number) => {
    if (suppressStageClickRef.current) { suppressStageClickRef.current = false; return; } // 拖出触发后抑制本次点击
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!stageMultiselect) setStageMultiselect(true);
      setStageSel(prev => { const next = new Set(prev); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; });
      stageAnchorRef.current = idx;
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      if (!stageMultiselect) setStageMultiselect(true);
      const a = stageAnchorRef.current;
      if (a == null) {
        stageAnchorRef.current = idx; // 首次：设此项为区间起始锚点
        setStageSel(new Set([s.id]));
      } else {
        const lo = Math.min(a, idx), hi = Math.max(a, idx);
        // idx/anchor 均为「当前显示列表」(filteredStage) 的索引，故区间切片也走 filteredStage——
        // 否则 search 过滤态下用全量 stage 索引切片会选错（遗漏锚点起始项）。无 search 时 filteredStage===stage，行为不变。
        setStageSel(new Set(filteredStage.slice(lo, hi + 1).map(x => x.id)));
      }
      return;
    }
    if (!stageMultiselect) { if (missingIdsRef.current.has(s.id)) return; copyAndPaste(s); return; } // 续100：失踪项不可取走（死路径粘贴无意义/可能崩目标）
    setStageSel(prev => { const next = new Set(prev); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; });
    stageAnchorRef.current = idx;
  }, [stageMultiselect, filteredStage, copyAndPaste]);

  // 通用：在鼠标位置弹出自定义右键菜单（边界检测防出屏）
  const openCtxMenu = useCallback((e: React.MouseEvent, items: CtxMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 176, MENU_H = items.length * 36 + 8;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setCtxMenu({ x, y, items });
  }, []);

  // 中转区条目右键菜单：多选模式且有选中项→批量操作；否则→单项操作
  const openStageCtxMenu = useCallback((e: React.MouseEvent, s: StageItem) => {
    if (stageMultiselect && stageSel.size > 0) {
      const sel = stage.filter(x => stageSel.has(x.id));
      const allFiles = sel.length > 0 && sel.every(x => x.type === "file");
      const combined = (): Pasteable => ({ type: "file", items: sel.flatMap(x => x.items ?? []) });
      openCtxMenu(e, [
        { label: t("取走全部（{n} 项）", {n: sel.length}), disabled: !allFiles,
          action: () => { copyAndPaste(combined()); setStageSel(new Set()); setStageMultiselect(false); } },
        { label: t("复制全部（{n} 项）", {n: sel.length}), disabled: !allFiles,
          action: async () => { await writeItemToClipboard(combined()); setBatchCopied(true); setTimeout(() => setBatchCopied(false), 1000); } },
        { label: t("删除全部（{n} 项）", {n: sel.length}),
          action: () => { saveStage(stage.filter(x => !stageSel.has(x.id))); setStageSel(new Set()); } },
        { label: t("取消选择"), action: () => setStageSel(new Set()) },
      ]);
      return;
    }
    const items: CtxMenuItem[] = [];
    if (s.type === "file" && s.items?.[0]?.path) {
      items.push({
        label: t("打开所在目录"),
        action: async () => {
          hideWorkbench(); // 先隐藏全屏毛玻璃覆盖层，避免 explorer 在其下冷起时 backdrop-filter 抢 GPU 卡顿
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("reveal_in_explorer", { path: s.items![0].path });
        },
      });
    }
    items.push({ label: t("复制到剪贴板"), action: () => copyStageToClipboard(s) });
    items.push({ label: t("删除该项目"),   action: () => removeStage(s.id) });
    openCtxMenu(e, items);
  }, [stageMultiselect, stageSel, stage, openCtxMenu, copyAndPaste, saveStage, copyStageToClipboard, removeStage, t]);

  // 剪贴板历史卡片右键菜单（file 额外加「打开所在目录」；通用：复制/钉入中转/删除）
  const openClipCtxMenu = useCallback((e: React.MouseEvent, c: ClipItem) => {
    // 拖拽中不弹菜单：右键的 pointerdown 因 button!==0 提前返回、不打断拖拽，但 contextmenu 照样触发 →
    // 菜单浮出而 ghost 仍在跟手、松手照旧投放，纯属添乱。拖拽期间右键一律吞掉。
    if (clipDragRef.current?.active) { e.preventDefault(); return; }
    const items: CtxMenuItem[] = [];
    if (c.type === "file" && c.items?.[0]?.path) {
      items.push({
        label: t("打开所在目录"),
        action: async () => {
          hideWorkbench(); // 同上：先隐藏覆盖层再唤起 explorer
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("reveal_in_explorer", { path: c.items![0].path });
        },
      });
    }
    items.push({ label: t("复制到剪贴板"), action: () => copyToClipboard(c) });
    items.push({ label: t("钉到中转区"),  action: () => addToStage(c) });
    items.push({ label: t("删除该条目"),    action: () => deleteClipItem(c.time) });
    openCtxMenu(e, items);
  }, [openCtxMenu, copyToClipboard, addToStage, deleteClipItem, t]);

  // 启动器条目右键菜单（file/folder 额外加「打开所在目录」；通用：从启动器移除）
  const openLauncherCtxMenu = useCallback((e: React.MouseEvent, it: LauncherItem) => {
    // 「打开」置顶：左键本就能打开，但右键菜单里补一条更符合直觉（与增强搜索结果菜单一致）。
    // 无图标元素调用 → openLauncherItem 走 !iconEl 分支直接打开并隐藏，不播放大动画。
    const items: CtxMenuItem[] = [{ label: t("打开"), action: () => openLauncherItem(it) }];
    if (it.kind !== "app") items.push({ label: t("打开所在目录"), action: async () => { hideWorkbench(); const { invoke } = await import("@tauri-apps/api/core"); await invoke("reveal_in_explorer", { path: it.path }); } });
    items.push({ label: t("从启动器移除"), action: () => removeLauncherItem(it.id) });
    openCtxMenu(e, items);
  }, [openCtxMenu, removeLauncherItem, openLauncherItem, t]);

  // 增强搜索结果右键菜单：打开 / 复制到剪贴板 / 打开所在目录 / 加入启动台 / 加入中转区（按 kind 取可用子集）
  // stage 结果只有 file 类型（enhTier1 已按 type==="file" 过滤），故其 items[0].path 恒有效
  const revealPath = useCallback(async (path: string) => { hideWorkbench(); const { invoke } = await import("@tauri-apps/api/core"); await invoke("reveal_in_explorer", { path }); }, []);
  const openEnhCtxMenu = useCallback((e: React.MouseEvent, r: EnhResult) => {
    const items: CtxMenuItem[] = [{ label: r.kind === "clip" ? t("取走粘贴") : t("打开"), action: () => activateEnh(r) }];
    // 右键菜单项此前**全部静默**：菜单一收，界面无任何变化（不像那些按钮有原地 ✓ 可看）。
    // 故凡「不离开本界面」的动作都补 toast；「打开/打开所在目录」不补——它们会隐藏 overlay
    // 切到外部窗口，提示既看不到也没意义。
    if (r.kind === "fs") {
      items.push({ label: t("复制到剪贴板"), action: async () => { await writeItemToClipboard({ type: "file", items: [{ path: r.path, name: r.name, ext: r.ext, isImage: IMG_EXTS.includes((r.ext || "").toLowerCase()) }] }); showToast(t("已复制到剪贴板")); } });
      items.push({ label: t("打开所在目录"), action: () => revealPath(r.path) });
      items.push({ label: t("加入启动台"), action: async () => toastAddResult(await addFsToLauncher(r), "launcher", r.name) });
      items.push({ label: t("加入中转区"), action: async () => toastAddResult(await addFsToStage(r), "stage", r.name) });
    } else if (r.kind === "app") {
      // UWP 没有真实文件路径（path 是 shell:AppsFolder\AUMID），复制/定位这两项对它无意义——
      // 不是置灰而是整条不出现，菜单里留个必然失败的项比没有更糟。「加入启动台」照常可用。
      if (!r.app.packaged) {
        items.push({ label: t("复制到剪贴板"), action: async () => { await writeItemToClipboard({ type: "file", items: [{ path: r.app.path, name: r.app.name, ext: "", isImage: false }] }); showToast(t("已复制到剪贴板")); } });
        items.push({ label: t("打开所在目录"), action: () => revealPath(r.app.path) });
      }
      items.push({ label: t("加入启动台"), action: () => toastAddResult(addAppToLauncher(r.app), "launcher", r.app.name) });
    } else if (r.kind === "stage") { // stage（恒 file 类型）
      const path = r.item.items?.[0]?.path;
      items.push({ label: t("复制到剪贴板"), action: async () => { await copyStageToClipboard(r.item); showToast(t("已复制到剪贴板")); } });
      if (path) {
        items.push({ label: t("打开所在目录"), action: () => revealPath(path) });
        items.push({ label: t("加入启动台"), action: async () => toastAddResult(await addFsToLauncher({ path, name: r.name, ext: r.item.ext, isDir: !!r.item.isDir }), "launcher", r.name) });
      }
    } // clip：仅默认「取走粘贴」，无附加项（已在剪贴板中，复制冗余）
    openCtxMenu(e, items);
    // ↑ 该函数体结束于下方 deps；enhRows 紧随其后定义（它要用 openEnhCtxMenu）
  }, [openCtxMenu, activateEnh, addFsToLauncher, addFsToStage, addAppToLauncher, copyStageToClipboard, revealPath, toastAddResult, showToast, t]);

  // ── 增强搜索结果行（续127：从 JSX 内联的 map 提出来缓存）──
  //
  // **依赖里绝不能出现 enhSelIdx**——那正是本次优化的全部要点：↑↓ 只改选中项时，
  // 这份元素数组保持同一批引用，React 直接 bail out，500 行一行都不 reconcile。
  // 选中高亮由上面那个 effect 命令式加 class（行上有 data-idx 供其定位）。
  //
  // 其余依赖（enhAdded / 各 handler）变化时整批重建是可以接受的：那都是用户主动操作
  // 且低频，而 ↑↓ 是按住方向键时每秒几十次的高频路径。
  const enhRows = useMemo(() => enhResults.map((r,i)=>{
            // ⚠️ key 必须带上行号（续131c）。`enhKey` 对文件结果是 `"fs:"+path`，
            // 只要结果里出现两条同路径（续131c 之前索引嵌套根就会造出来），
            // 同一列表里就有重复 key → React reconciliation 错乱：旧行残留在顶部、
            // 段表头跟着错位（表头就包在这个 Fragment 里）。索引侧已去重，这里是兜底——
            // Everything 引擎的结果不归我们控制，不能假设它一定没有重复。
            // 结果列表每次查询整体重建、不是 prepend 列表，故带下标不会踩续96 那个「index key 错位复用」的坑。
            const key = enhKey(r) + "#" + i;
            const icon = r.kind==="app" ? (r.app.icon? <img src={r.app.icon} alt=""/> : <span>{r.app.name[0]}</span>)
                       : r.kind==="stage" ? <FileGlyph size={22} isDir={r.item.isDir} isImage={r.item.items?.[0]?.isImage} ext={r.item.ext??r.item.items?.[0]?.ext??""}/>
                       : r.kind==="clip" ? (r.item.type==="text"?<FileGlyph cat="doc" size={22}/>:r.item.type==="image"?<FileGlyph isImage size={22}/>:<FileGlyph size={22} {...fileGlyphFor(r.item)}/>)
                       : r.kind==="fs" && r.icon ? <img src={r.icon} alt=""/>
                                                 : <FileGlyph size={22} isDir={r.kind==="fs" && r.isDir} ext={r.kind==="fs"?r.ext:""}/>;
            const label = r.kind==="app" ? r.app.name : r.name;
            const ranges = r.kind==="fs" ? [] : r.ranges; // 文件结果无高亮区间（Rust 侧子串匹配，未回传位置）
            const badge = r.kind==="app" ? (lang==="en"?"App":"应用") : r.kind==="stage" ? t("中转") : r.kind==="clip" ? t("剪贴板") : (r.isDir?t("文件夹"):t("文件"));
            const rPath = r.kind==="app" ? r.app.path : r.kind==="fs" ? r.path : ""; // 操作按钮反馈用统一路径键
            // 段表头：本行是某段首项时插在其前（续114b 起由 enhHeadAt 驱动，段的增删无需改此处）
            const head = enhHeadAt.get(i);
            const divider = head ? <div key={`enh-head-${i}`} className="enh-divider">{head}</div> : null;
            return (
              <Fragment key={key}>
                {divider}
                <div className="enh-result" data-idx={i}
                  onMouseEnter={e=>onEnhRowEnter(i,e)}
                  onMouseLeave={cancelHoverSelect}
                  onContextMenu={e=>openEnhCtxMenu(e,r)}
                  onClick={e=>activateEnh(r, e.currentTarget.querySelector<HTMLElement>(".enh-result-icon"))}>
                  <div className="enh-result-icon">{icon}</div>
                  <div className="enh-result-meta">
                    <span className="enh-result-label"><HighlightText text={label} ranges={ranges}/></span>
                    {r.kind==="fs" && <span className="enh-result-dir">{dirOf(r.path)}</span>}
                  </div>
                  <span className="enh-result-badge">{badge}</span>
                  {(r.kind==="fs" || r.kind==="app") && (
                    <div className="enh-result-actions">
                      {r.kind==="fs" && <button className={`enh-action-btn${enhAdded?.path===rPath&&enhAdded?.target==="stage"?" enh-action-added":""}`} onClick={async e=>{e.stopPropagation();const res=await addFsToStage(r);if(res==="added"){setEnhAdded({path:rPath,target:"stage"});setTimeout(()=>setEnhAdded(null),1000);}else toastAddResult(res,"stage",r.name);}} title={t("加入中转区")}>{enhAdded?.path===rPath&&enhAdded?.target==="stage"?<IconCheck size={13}/>:t("中转")}</button>}
                      <button className={`enh-action-btn${enhAdded?.path===rPath&&enhAdded?.target==="launcher"?" enh-action-added":""}`} onClick={async e=>{e.stopPropagation();const res=r.kind==="app"?addAppToLauncher(r.app):await addFsToLauncher(r);const nm=r.kind==="app"?r.app.name:r.name;if(res==="added"){setEnhAdded({path:rPath,target:"launcher"});setTimeout(()=>setEnhAdded(null),1000);}else toastAddResult(res,"launcher",nm);}} title={t("加入启动台")}>{enhAdded?.path===rPath&&enhAdded?.target==="launcher"?<IconCheck size={13}/>:t("启动台")}</button>
                    </div>
                  )}
                </div>
              </Fragment>
            );
          }), [enhResults, enhHeadAt, enhAdded, lang, t, onEnhRowEnter, cancelHoverSelect, openEnhCtxMenu, activateEnh, addFsToStage, addFsToLauncher, addAppToLauncher, toastAddResult]);

  // 选中高亮 + 滚入视野。**高亮命令式加 class，不进 React**（续127，说明见 onEnhRowEnter 附近）。
  //
  // ⚠️ 依赖必须是 **enhRows 本身**，不能只写 enhResults：
  // enhRows 重建时（如点了「中转/启动台」按钮使 enhAdded 变化）React 会按 `className="enh-result"`
  // 重渲这些行，**把命令式加上的 .selected 抹掉**；此时 enhSelIdx/enhResults 都没变，
  // effect 若不重跑，高亮就凭空消失、直到下次按 ↑↓ 才回来。
  // enhRows 的引用恰好在「行被重建」时才变，正是需要的那个信号。
  useEffect(() => {
    if (!enhOpen) return;
    const box = enhResultsRef.current;
    if (!box) return;
    box.querySelector(".enh-result.selected")?.classList.remove("selected");
    const cur = box.querySelector<HTMLElement>(`.enh-result[data-idx="${enhSelIdx}"]`);
    cur?.classList.add("selected");
    cur?.scrollIntoView({ block: "nearest" });
  }, [enhSelIdx, enhOpen, enhRows]);

  // shell:/ms-settings:/wt 等系统路径走 cmd /c start，能找到 WindowsApps 里的 wt.exe
  const openShortcut = useCallback((target:string) => {
    hideWorkbench();
    import("@tauri-apps/api/core").then(({invoke})=>invoke("open_file",{path:target})).catch(()=>{});
  }, []);

  // 截屏：Rust 侧负责 hide + emit + 150ms 等待 + Win+Shift+S，前端无需额外 hideWorkbench。
  const handleScreenshot = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trigger_screenshot");
    } catch {}
  }, []);


  // ── 键盘 ──
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      // 右键菜单是纯鼠标浮层（无键盘交互）：任何键盘/热键操作都顺带关掉它，避免切页/关页后残留悬浮。
      // Escape 交由下方分层逻辑处理（第一次 Esc 只关菜单、不关页），故此处排除。
      if(ctxMenuRef.current && e.key!=="Escape") setCtxMenu(null);
      if(e.key==="Escape"){e.preventDefault();if(clipDragRef.current?.active){endClipDrag();return;}if(lassoStateRef.current.active){setLassoState(s=>({...s,active:false}));dropAreaRef.current?.classList.remove("lasso-active");lassoArmedRef.current=false;return;}if(ctxMenuRef.current){setCtxMenu(null);return;}if(enhOpenRef.current){setEnhOpen(false);setEnhPinned(false);setEnhQuery("");setSearch("");if(searchDefaultModeRef.current==="enhanced")pageSearchForcedRef.current=true;searchRef.current?.focus();return;}if(pickerOpenRef.current){setPickerOpen(false);setPickerQuery("");return;}if(stageSelRef.current.size||stageMultiselectRef.current){setStageSel(new Set<number>());setStageMultiselect(false);stageAnchorRef.current=null;return;}if(launcherSelIdx>=0){setLauncherSelIdx(-1);searchRef.current?.focus();return;}if(settingsOpen){setSettingsOpen(false);return;}setVisible(false);hideWorkbench();return;}
      if(matchComboEvent(e, enhHotkey)){e.preventDefault();if(enhOpen){setEnhOpen(false);setEnhPinned(false);setEnhQuery("");setSearch("");if(searchDefaultModeRef.current==="enhanced")pageSearchForcedRef.current=true;searchRef.current?.focus();}else{pageSearchForcedRef.current=false;setEnhQuery(search);setEnhSelIdx(0);setEnhOpen(true);setEnhPinned(true);searchRef.current?.focus();}return;}
      // 中和默认 Tab 焦点遍历（防焦点逃逸到模态背后的按钮 / 旧死 filteredApps 导航）。Tab 作为热键已被上面 matchComboEvent 先处理。
      if(e.key==="Tab"){e.preventDefault();return;}
      if(settingsOpen||pickerOpen)return; // 设置 / picker 打开时屏蔽应用导航/启动按键
      if(enhOpen){ // 增强搜索接管导航，屏蔽下面 launcher 键（字母键不拦截，正常输入到 enhInput）
        // Ctrl+↑↓：跨段跳转（续114 起，续114b 改为读通用段边界表 enhSectionStarts）。
        // **必须排在下面裸 ↑↓ 分支之前**，否则被逐条移动先吃掉。
        // 不用 Tab：它在上面被无条件 preventDefault 吞掉（防焦点逃逸到模态背后的按钮），
        // 且那行在本分支之前——为一个跳转去动全局键盘路由的顺序不划算。
        // 不用裸 ←→：增强搜索有输入框，←→ 是编辑查询词的常用键，抢了会难受。
        if(e.ctrlKey && (e.key==="ArrowDown"||e.key==="ArrowUp")){
          e.preventDefault();
          const st = enhSectionStarts;
          if(e.key==="ArrowDown"){
            const nxt = st.find(s => s > enhSelIdx);      // 下一段段首；已在末段则不动
            if(nxt !== undefined) selectByKeyboard(nxt);
          }else{
            // 先回本段段首，已在段首才跳上一段（编辑器里「上一段」的通行语义，一个键给出两种粒度）
            const curStart = [...st].reverse().find(s => s <= enhSelIdx) ?? 0;
            if(enhSelIdx > curStart) selectByKeyboard(curStart);
            else { const prv = [...st].reverse().find(s => s < curStart); if(prv !== undefined) selectByKeyboard(prv); }
          }
          return;
        }
        // ↓ selectByKeyboard = setEnhSelIdx + 清掉待定的 hover 提交（续118）。
        //   直接用 setEnhSelIdx 会让 70ms 窗口内落地的 hover 把刚按的键覆盖回去。
        if(e.key==="ArrowDown"){e.preventDefault();selectByKeyboard((i:number)=>Math.min(i+1,enhResults.length-1));}
        else if(e.key==="ArrowUp"){e.preventDefault();selectByKeyboard((i:number)=>Math.max(i-1,0));}
        else if(e.key==="Enter"){e.preventDefault();const r=enhResults[enhSelIdx]??enhResults[0];if(r)activateEnh(r, document.querySelector<HTMLElement>(".enh-result.selected .enh-result-icon"));}
        return;
      }
      // ── 启动器网格键盘导航（Start 菜单风）──
      // 未选中(idx<0)：焦点在搜索框，仅 ↓ 进入网格；←→↑ 留给输入框做文本编辑。
      // 已选中(idx>=0)：←→↑↓ 二维移动（列数按 DOM offsetTop 动态算），行首←/首行↑ 退回搜索框；Enter 打开。
      const nL=filteredLauncher.length;
      if(nL){
        const grid=launcherDropRef.current;
        const cols=(()=>{ if(!grid)return 1; const tiles=grid.querySelectorAll<HTMLElement>(".app-tile"); if(tiles.length<2)return tiles.length||1; const top0=tiles[0].offsetTop; let c=0; for(const el of Array.from(tiles)){ if(el.offsetTop===top0)c++; else break;} return c||1; })();
        if(launcherSelIdx<0){
          if(e.key==="ArrowDown"){e.preventDefault();setLauncherSelIdx(0);return;}
        }else{
          if(e.key==="ArrowRight"){e.preventDefault();setLauncherSelIdx(i=>Math.min(i+1,nL-1));return;}
          if(e.key==="ArrowLeft"){e.preventDefault();if(launcherSelIdx===0){setLauncherSelIdx(-1);searchRef.current?.focus();}else setLauncherSelIdx(i=>Math.max(i-1,0));return;}
          if(e.key==="ArrowDown"){e.preventDefault();setLauncherSelIdx(i=>Math.min(i+cols,nL-1));return;}
          if(e.key==="ArrowUp"){e.preventDefault();if(launcherSelIdx<cols){setLauncherSelIdx(-1);searchRef.current?.focus();}else setLauncherSelIdx(i=>Math.max(i-cols,0));return;}
          if(e.key==="Enter"){e.preventDefault();const it=filteredLauncher[launcherSelIdx];if(it)openLauncherItem(it, document.querySelector<HTMLElement>(".app-tile.selected .app-tile-icon"));return;}
        }
      }
      // Enter：未进入网格且顶栏搜索非空时，启动扫描链排名第一的应用（保留旧兜底行为）
      if(e.key==="Enter"&&search.trim()&&filteredApps.length){e.preventDefault();const a=filteredApps[0];if(a)launchApp(a.app, null);}
    };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  }, [visible, search, filteredApps, launchApp, settingsOpen, pickerOpen, enhOpen, enhResults, enhSectionStarts, enhSelIdx, activateEnh, enhHotkey, filteredLauncher, launcherSelIdx, openLauncherItem]);

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}${fileDragOver ? " file-drag-active" : ""}`} onContextMenu={e=>e.preventDefault()}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
        <div className="top-center">
          <div className="global-search">
            <IconSearch size={16}/>
            <input ref={searchRef} className="search-field" placeholder={t("搜索应用、中转、剪贴板…")} value={search}
              onChange={e=>{
                const v=e.target.value;
                if((searchDefaultModeRef.current==="enhanced"&&!pageSearchForcedRef.current)||enhPinnedRef.current){
                  // enhanced 模式自动打开 / 或 enh 已以 pinned 方式打开（page 模式手动呼出时）：顶栏输入同步到 enhQuery
                  setSearch(v);setEnhQuery(v);setEnhSelIdx(0);
                  if(v&&!enhOpenRef.current){setEnhOpen(true);setEnhPinned(true);}
                }else{setSearch(v);}
              }} spellCheck={false} />
          </div>
        </div>
        <div className="top-right">
          <Clock lang={lang}/>
          <button className="settings-btn" onClick={()=>setSettingsOpen(true)} title={t("设置")} aria-label={t("设置")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>
      <main className="main-area">
        <section className="app-panel">
          <div className="stage-section-header">
            <span className="section-label">{t("启动器")}</span>
            <button className="stage-batch-btn" onClick={()=>{setPickerQuery("");setPickerOpen(true);}} title={t("添加到启动台")}>{t("添加")}</button>
          </div>
          <div className="app-grid" ref={launcherDropRef}>
            {/* 启动器=手动策展的收藏托盘。条目左键打开/启动，右键移除；拖拽排序由 window-level pointer 监听驱动 */}
            {filteredLauncher.map((it,i)=>(
              <div key={it.id}
                className={`app-tile${i===launcherSelIdx?" selected":""}`}
                draggable={false}
                onClick={e=>openLauncherItem(it, e.currentTarget.querySelector<HTMLElement>(".app-tile-icon"))}
                onContextMenu={e=>openLauncherCtxMenu(e,it)}
                onPointerDown={e=>handleLauncherPointerDown(e, it.id)}
                title={it.kind==="app"?t("单击启动"):t("单击打开")}>
                <div className="app-tile-icon">
                  {it.kind==="file" && it.ext && IMG_EXTS.includes(it.ext.toLowerCase()) && stageThumbs[it.path]
                     ? <img className="app-tile-thumb" src={stageThumbs[it.path]} alt="" draggable={false}/>
                   : it.icon ? <img src={it.icon} alt="" draggable={false}/>
                   : it.kind==="folder" ? <FileGlyph isDir size={42}/>
                   : it.kind==="file" ? <FileGlyph ext={it.ext??""} size={42}/>
                   : <span>{it.name[0]}</span>}
                </div>
                <div className="app-tile-label-wrap"><span className="app-tile-label">{it.name}</span></div>
              </div>
            ))}
            {/* 末尾插入指示线：insertIdx === launcher.length 时显示在最后一个元素之后 */}
            {!filteredLauncher.length && (
              <p className="empty-hint" style={{gridColumn:"1/-1"}}>
                {launcher.length ? t("无匹配") : t("拖入或点「添加」收藏应用")}
              </p>
            )}
          </div>
        </section>
        <section className="center-panel">
          <div className="stage-section-header">
            <span className="section-label">{t("文件中转区")}</span>
            {stageMultiselect ? (
              <div className="stage-multi-toolbar">
                {stageSel.size > 0 && <span className="stage-sel-count">{t("已选 {n}", {n: stageSel.size})}</span>}
                <button className="stage-batch-btn" disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")?t("取走并粘贴到上个窗口"):t("仅文件可批量取走")}
                  onClick={()=>{const sel=stage.filter(x=>stageSel.has(x.id));copyAndPaste({type:"file",items:sel.flatMap(x=>x.items??[])});setStageSel(new Set());setStageMultiselect(false);}}>{t("取走")}</button>
                <button className={`stage-batch-btn${batchCopied?" copied":""}`} disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file")?t("复制到剪贴板"):t("仅文件可批量复制")}
                  onClick={async()=>{const sel=stage.filter(x=>stageSel.has(x.id));await writeItemToClipboard({type:"file",items:sel.flatMap(x=>x.items??[])});setBatchCopied(true);setTimeout(()=>setBatchCopied(false),1000);}}>{t("复制")}</button>
                <button className="stage-batch-btn" disabled={stageSel.size===0}
                  onClick={()=>{saveStage(stage.filter(x=>!stageSel.has(x.id)));setStageSel(new Set());}}>{t("删除")}</button>
                <button className="stage-batch-btn stage-batch-cancel"
                  onClick={()=>{setStageSel(new Set());setStageMultiselect(false);stageAnchorRef.current=null;}}>{t("完成")}</button>
              </div>
            ) : (
              <button className="stage-batch-btn" disabled={!stage.length}
                onClick={()=>setStageMultiselect(true)} title={t("进入多选模式")}>{t("多选")}</button>
            )}
          </div>
          <div className="drop-area" ref={dropAreaRef}
            onPointerDown={handleLassoPointerDown} onPointerMove={handleLassoPointerMove}
            onPointerUp={handleLassoPointerUp} onPointerCancel={handleLassoPointerUp}>
            {lassoState.active && (() => {
              const rect = dropAreaRef.current?.getBoundingClientRect();
              if (!rect) return null;
              return <div className="stage-lasso" style={{
                left:   Math.min(lassoState.origin.x, lassoState.current.x) - rect.left + dropAreaRef.current!.scrollLeft,
                top:    Math.min(lassoState.origin.y, lassoState.current.y) - rect.top + dropAreaRef.current!.scrollTop,
                width:  Math.abs(lassoState.current.x - lassoState.origin.x),
                height: Math.abs(lassoState.current.y - lassoState.origin.y),
              }}/>;
            })()}
            {filteredStage.length ? (stageLayout==="grid"
              ? <div className={`stage-grid${stageMultiselect?" stage-multiselect":""}`}>{filteredStage.map((s,idx)=>{
                  const rawExt = (s.ext||s.items?.[0]?.ext||"").replace(/^\./,"");
                  const isAnyDir = !!s.isDir;
                  const isMissing = missingIds.has(s.id); // 续100：原文件失踪，灰化 + ⚠️
                  const cardName = s.type==="image" ? t("图片")
                    : s.type==="text" ? (s.content?.slice(0,12)||t("文本"))
                    : (s.count!==1 ? t("{n} 个文件", {n: s.count ?? 0}) : (s.name||s.items?.[0]?.name||t("文件")));
                  const cardMeta = s.type==="image" ? t("图片")
                    : s.type==="text" ? t("文本")
                    : (isAnyDir ? t("文件夹") : (rawExt ? `.${rawExt}` : t("文件")));
                  // 右上点点（续99）：全局持久化开启时整体隐藏（冗余）；否则点击切换「固定」——已固定显 📌 常驻，未固定显类型色点。
                  // stopPropagation 双拦：pointerdown 不触发拖动、click 不触发取走。
                  const dotEl = stagePersist ? null : (
                    <button type="button" className={`stage-card-dot${s.pinned?" pinned":` type-${s.type}`}`}
                      onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();toggleStagePin(s.id);}}
                      title={s.pinned?t("已固定：取走 / 拖出后保留（点击取消）"):t("点击固定：取走 / 拖出后仍保留在中转区")}>
                      {s.pinned ? <span className="dot-pin"><IconPin/></span> : <span className="dot-type"/>}
                    </button>
                  );
                  return (
                  <div key={s.id} data-stage-id={s.id} className={`stage-card${stageSel.has(s.id)?" selected":""}${isMissing?" stage-missing":""}`} draggable={false} onDragStart={e=>e.preventDefault()} onClick={e=>handleStageClick(e,s,idx)} onContextMenu={e=>openStageCtxMenu(e,s)} onPointerDown={handleStagePointerDown} onPointerMove={handleStagePointerMove} onPointerUp={handleStagePointerUp} onPointerCancel={handleStagePointerUp} onLostPointerCapture={handleStageLostPointerCapture} title={isMissing?t("原文件已失踪（可能被删除或移动）"):(stageMultiselect?t("单击选中 / 取消"):(s.type==="file"?t("单击取走（写回剪贴板并粘贴），拖出可拖到其他应用"):t("单击取走（粘贴到上个窗口），拖出可拖到其他应用")))}>
                    {isMissing && <span className="stage-missing-badge" title={t("原文件已失踪（可能被删除或移动）")}><IconWarn size={15}/></span>}
                    {/* ── 缩略图区（thumb 固定 110×90，内容直接置于其中）── */}
                    {s.type==="image" && (
                      <div className="stage-card-thumb">
                        {dotEl}
                        {/* 续146c：优先用 160px 缩略图；原图（content，1024px）只在取走/复制/拖出时用，
                            绝不再直接塞进 <img>——72px 的卡片渲染 1024px 图 = 每张 ≈2.3MB 解码位图（续99b 同款坑）。
                            缩略图未就绪/生成失败时才回退原图，保证不出现空白卡。 */}
                        {(s.contentFile && stageThumbs[STAGE_IMG_KEY + s.contentFile])
                          ? <img className="cover" draggable={false} src={stageThumbs[STAGE_IMG_KEY + s.contentFile]} alt=""/>
                          : s.content
                          ? <img className="cover" draggable={false} src={s.content.startsWith("data:")?s.content:`data:image/png;base64,${s.content}`} alt=""/>
                          : <FileGlyph isImage size={34}/>}
                      </div>
                    )}
                    {s.type==="text" && (
                      <div className="stage-card-thumb">
                        {dotEl}
                        <div className="stage-card-text-preview">{s.content||""}</div>
                      </div>
                    )}
                    {s.type==="file" && (
                      <div className="stage-card-thumb">
                        {dotEl}
                        <div className="stage-card-icon-wrap">
                          {s.items?.[0]?.icon
                            ? <img src={s.items[0].icon} alt="" draggable={false} style={{width:34,height:34,objectFit:"contain"}}/>
                            : <FileGlyph size={30} isDir={isAnyDir} isImage={s.items?.[0]?.isImage} ext={s.ext??s.items?.[0]?.ext??""}/>}
                        </div>
                        {/* 续99b：图片文件显示 Rust 生成的小缩略图（避免原图全分辨率常驻内存）；未就绪/失败则无此层，露出下方 emoji 兜底 */}
                        {s.items?.[0]?.isImage && s.items?.[0]?.path && stageThumbs[s.items[0].path] && (
                          <img className="cover" draggable={false} src={stageThumbs[s.items[0].path]} alt=""/>
                        )}
                      </div>
                    )}
                    {/* ── 标签区 ── */}
                    <div className="stage-card-label">
                      <span className="stage-card-name">{cardName}</span>
                      <span className="stage-card-meta">{cardMeta}</span>
                    </div>
                    {/* ── 悬浮操作栏：左键本体已=取走粘贴，故悬浮栏统一留「复制到剪贴板 + 删除」两键（所有类型一致）── */}
                    <div className="stage-card-actions">
                      {!isMissing && <button className="stage-card-act-btn" onClick={e=>{e.stopPropagation();copyStageToClipboard(s);}} title={copiedStageId===s.id?t("已复制"):t("复制到剪贴板")}>
                        {copiedStageId===s.id ? <IconCheck/> : <IconCopy/>}
                      </button>}{/* 续100：失踪项复制死文件无意义，仅留删除 */}
                      <button className="stage-card-act-btn" onClick={e=>{e.stopPropagation();removeStage(s.id);}} title={t("删除")}><IconTrash/></button>
                    </div>
                  </div>
                );})}</div>
              : <div className={`stage-list${stageMultiselect?" stage-multiselect":""}`}>{filteredStage.map((s,idx)=>{
                  const label = s.type==="text"?(s.content?.slice(0,60)||t("文本")):s.type==="image"?t("图片"):(s.count!==1?t("{n} 个文件", {n: s.count ?? 0}):(s.name||s.items?.[0]?.name||t("文件")));
                  const isMissing = missingIds.has(s.id); // 续100
                  return (
                  <div key={s.id} data-stage-id={s.id} className={`stage-item${stageSel.has(s.id)?" selected":""}${isMissing?" stage-missing":""}`} draggable={false} onDragStart={e=>e.preventDefault()} onClick={e=>handleStageClick(e,s,idx)} onContextMenu={e=>openStageCtxMenu(e,s)} onPointerDown={handleStagePointerDown} onPointerMove={handleStagePointerMove} onPointerUp={handleStagePointerUp} onPointerCancel={handleStagePointerUp} onLostPointerCapture={handleStageLostPointerCapture} title={isMissing?t("原文件已失踪（可能被删除或移动）"):(stageMultiselect?t("单击选中 / 取消"):(s.type==="file"?t("单击取走（写回剪贴板并粘贴）"):t("单击取走（粘贴到上个窗口）")))}>
                    {s.type==="image"
                      ?<img className="stage-thumb" draggable={false} src={(s.contentFile && stageThumbs[STAGE_IMG_KEY + s.contentFile]) || s.content} alt=""/> /* 续146c：同方格视图，优先 160px 缩略图 */
                      :s.type==="file" && s.items?.[0]?.isImage && s.items?.[0]?.path && stageThumbs[s.items[0].path]
                        ?<img className="stage-thumb" draggable={false} src={stageThumbs[s.items[0].path]} alt=""/> /* 续99e：列表视图图片文件缩略图，与方格视图一致（复用同一 stageThumbs 缓存）*/
                        :s.type==="file" && s.items?.[0]?.icon
                          ?<img className="stage-thumb" draggable={false} src={s.items[0].icon} alt=""/>
                          :<span className="stage-emoji">{s.type==="text"?<FileGlyph cat="doc" size={20}/>:<FileGlyph size={20} isDir={s.isDir} isImage={s.items?.[0]?.isImage} ext={s.ext??s.items?.[0]?.ext??""}/>}</span>}
                    {isMissing && <span className="stage-missing-badge" title={t("原文件已失踪（可能被删除或移动）")}><IconWarn size={15}/></span>}
                    <span className="stage-title">{label}</span>
                    {s.type==="file"&&s.count===1&&s.size?<span className="stage-meta">{fmtSize(s.size)}</span>:null}
                    {/* 续99e：列表视图「固定」开关，与方格视图 dot 同语义——未固定 hover 才现、已固定常驻 accent；全局持久化开启时隐藏 */}
                    {!stagePersist && (
                      <button className={`stage-pin-btn${s.pinned?" pinned":""}`} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();toggleStagePin(s.id);}} title={s.pinned?t("已固定：取走 / 拖出后保留（点击取消）"):t("点击固定：取走 / 拖出后仍保留在中转区")}><IconPin/></button>
                    )}
                    <div className="stage-actions">
                      {!isMissing && <button className={`clip-copy-btn${copiedStageId===s.id?" copied":""}`} onClick={e=>{e.stopPropagation();copyStageToClipboard(s);}} title={copiedStageId===s.id?t("已复制"):t("复制到剪贴板")}>
                        {copiedStageId===s.id ? <IconCheck/> : <IconCopy/>}
                      </button>}{/* 续100：失踪项复制/打开死文件无意义，仅留删除 */}
                      {!isMissing && s.type==="file"&&<button className="stage-open-btn" onClick={e=>{e.stopPropagation();openStageFile(s);}} title={t("打开")}><IconOpen/></button>}
                      <button className="clip-del-btn" onClick={e=>{e.stopPropagation();removeStage(s.id);}} title={t("移除")}><IconTrash/></button>
                    </div>
                  </div>);
                })}</div>
            ) : <p className="empty-hint">{search.trim()?t("无匹配"):t("拖入文件 / 文件夹，或在剪贴板卡片点固定按钮钉入")}</p>}
          </div>
          {/* 快捷入口：可在设置→中转站关闭；关闭后本行不渲染，上方 .drop-area(flex:1) 自动铺满归还的空间 */}
          {showShortcuts && (<>
          <div className="section-label" style={{marginTop:16}}>{t("快捷入口")}</div>
          <div className="shortcut-row">
            <button className="shortcut-chip" onClick={handleScreenshot}><span><IconCamera/></span><span>{t("截屏")}</span></button>
            {SHORTCUTS.map(s=>(
              <button key={s.l} className="shortcut-chip" onClick={()=>openShortcut(s.a)}><span><s.Icon/></span><span>{t(s.l)}</span></button>
            ))}
          </div>
          </>)}
        </section>
        <section className="clip-panel">
          <div className="stage-section-header">
            <span className="section-label">{t("剪贴板历史")}</span>
          </div>
          <div className="clip-list">
            {filteredClip.length? filteredClip.map((c)=>(
              <div key={c.time} className="clip-block"
                onClick={()=>{ if(suppressClickRef.current){suppressClickRef.current=false;return;} copyAndPaste(c); }}
                onPointerDown={e=>handleClipPointerDown(e,c)} onPointerMove={handleClipPointerMove} onPointerUp={handleClipPointerUp}
                onPointerCancel={handleClipPointerCancel} onLostPointerCapture={()=>endClipDrag()}
                onContextMenu={e=>openClipCtxMenu(e,c)} title={c.type==="text"?t("单击左键粘贴"):c.type==="file"?t("单击左键粘贴文件"):t("单击左键复制")}>
                <div className="clip-actions">
                  <button className="clip-pin-btn" onClick={e=>{e.stopPropagation();addToStage(c);}} title={t("钉到中转区")}><IconPin/></button>
                  <button className={`clip-copy-btn${copiedTime===c.time?" copied":""}`} onClick={e=>{e.stopPropagation();copyToClipboard(c);}} title={copiedTime===c.time?t("已复制"):t("复制到剪贴板")}>
                    {copiedTime===c.time ? <IconCheck/> : <IconCopy/>}
                  </button>
                  <button className="clip-del-btn" onClick={e=>{e.stopPropagation();deleteClipItem(c.time);}} title={t("删除")}><IconTrash/></button>
                </div>
                {c.type==="image"? (clipThumbs[c.time]
                    ? <img className="clip-image" src={clipThumbs[c.time]} alt="" draggable={false}/>
                    : <div className="clip-image clip-image-ph" aria-hidden/>)
                : c.type==="file"? <div className="file-clip-preview">
                    <span className="clip-file-icon"><FileGlyph size={20} {...fileGlyphFor(c)}/></span>
                    <span className="file-clip-info">{c.count===1? c.items?.[0]?.name : t("{n}个文件", {n: c.count ?? 0})}</span>
                  </div>
                : <span className="clip-preview">{c.content?.slice(0,100)}{(c.content?.length??0)>100?"…":""}</span>}
                <span className="clip-time">{c.type==="image"?<IconCamera size={12} className="clip-time-ic"/>:c.type==="file"?<IconPaperclip size={12} className="clip-time-ic"/>:null}{ago(c.time, t)}</span>
              </div>
            )): <p className="empty-hint">{search.trim()?t("无匹配"):t("显示时自动读取")}</p>}
          </div>
        </section>
      </main>
      {/* ── 增强搜索层（始终挂载，靠 class 切换显隐，沿用 overlay-visible/hidden 模式避免卸载闪烁）── */}
      <div className={`enh-layer${enhOpen?" enh-open":""}${enhPinned?" enh-pinned":""}`}>
        <div className="enh-search-box">
          <IconSearch size={18}/>
          <input ref={enhInputRef} className="enh-search-input" placeholder={t("搜索应用、中转、剪贴板…")}
            value={enhQuery} onChange={e=>{setEnhQuery(e.target.value);setEnhSelIdx(0);}} spellCheck={false}/>
          {/* Ctrl+↑↓ 提示只在**两段都非空**时出现：单段结果下跳转无处可去，提示它反而是噪音 */}
          <span className="enh-hint">{enhSections.length>1 && <><kbd>Ctrl+↑↓</kbd> {t("换区")} · </>}{searchDefaultMode==="enhanced"&&<><kbd>{comboLabel(enhHotkey)}</kbd> {t("界面搜索")} · </>}<kbd>Esc</kbd> {t("关闭")}</span>
        </div>
        {/* 索引未就绪提示：不阻塞 Tier 1（应用/中转）结果显示 */}
        {enhQuery.trim() && searchEngine==="everything" && !everythingAvailable ? <div className="enh-index-hint">{t("Everything 未运行，已回退内置搜索")}</div> : (!indexReady && enhQuery.trim() ? <div className="enh-index-hint">{t("文件索引建立中…")}</div> : null)}
        {/* 结果区：列表恒居中；预览由 CSS 绝对定位挂在本容器左外侧，不参与布局流 */}
        <div className="enh-body">
        {/* onMouseMove 只记坐标（写 ref、零渲染），供行的 mouseenter 判定「指针是否真的动过」——
            见上方 onEnhRowEnter 的位移门说明。挂容器而非每行，避免 N 个监听器。 */}
        <div className="enh-results" ref={enhResultsRef}
          onMouseMove={e=>{ hoverPosRef.current = { x: e.clientX, y: e.clientY }; }}>
          {enhResults.length ? enhRows : <p className="empty-hint">{enhQuery.trim()?t("无匹配"):t("输入以搜索")}</p>}
        </div>
        {/* ── 预览面板（续115）：当前选中项的详情 + 快捷操作 ── */}
        {enhPreview && (
          <aside className="enh-preview">
            <div className="enh-pv-head">
              <div className={`enh-pv-icon${enhPreview.photo?" enh-pv-icon-img":""}`}>
                {/* 低清→高清的替换做成「下层淡出」而非直接对调（续131d）。
                    根因：Windows 多分辨率图标的 32px 与 256px **是两套不同的美术资源**
                    （内部留白/比例不一样），瞬间对调时外框虽没动，画面里的图形却像挪了一下——
                    用户报「图标在不清楚到清楚的瞬间抖一下」。几何早在续127 就钉死了，
                    这一下不是布局跳变，是内容跳变，只能在视觉层化解。
                    高清图**不做淡入**（保持命中缓存时的即时感，按住 ↑↓ 连翻不会觉得黏），
                    只让压在下面的低清图淡出，把两套美术的差异抹平。 */}
                {enhPreview.low &&
                  <img className={`enh-pv-ic-low${enhPreview.hi ? " is-hidden" : ""}`}
                       src={enhPreview.low} alt="" draggable={false}/>}
                {enhPreview.hi && <img src={enhPreview.hi} alt="" draggable={false}/>}
                {!enhPreview.low && !enhPreview.hi && <FileGlyph size={56} {...(enhPreview.glyph ?? {})}/>}
              </div>
              <div className="enh-pv-title" title={enhPreview.title}>{enhPreview.title}</div>
              {/* 用 data-group 取色（续116）：颜色是分类而非装饰——
                  与搜索结果分段用同一份映射，故「徽标颜色 == 所属段落」恒定一致 */}
              <div className="enh-pv-badge" data-group={enhPreview.group}>{enhPreview.badge}</div>
            </div>
            {/* 位置＝这个面板的主角（续116）。同名文件认错是搜索里最常见的歧义，
                而解开它的几乎总是路径。所以从 dt/dd 的一行升格为独立区块。 */}
            {enhPreview.loc && (
              <div className="enh-pv-loc" title={enhPreview.loc}>
                <IconExplorer size={13} className="enh-pv-loc-ic"/>
                <span className="enh-pv-loc-t">{enhPreview.loc}</span>
              </div>
            )}
            {/* 文本类条目：给一段真正的内容预览，比任何元信息都有用 */}
            {enhPreview.text && <div className="enh-pv-text">{enhPreview.text.slice(0, 600)}</div>}
            {enhPreview.stats.length > 0 && (
              <div className="enh-pv-stats">
                {enhPreview.stats.map((s,i)=>(
                  <div className="enh-pv-stat" key={i} title={s.title}>
                    <div className={`enh-pv-stat-v${s.pending?" enh-pv-pending":""}`}>{s.value}</div>
                    <div className="enh-pv-stat-l">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
            {enhPreview.rows.length > 0 && (
              <dl className="enh-pv-rows">
                {enhPreview.rows.map((row,i)=>(
                  <Fragment key={i}>
                    <dt>{row.label}</dt>
                    <dd className={`${row.rtl?"enh-pv-rtl":""}${row.pending?" enh-pv-pending":""}`.trim()||undefined} title={row.title ?? row.value}>{row.value}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            <div className="enh-pv-actions">
              <button className="enh-pv-btn enh-pv-btn-primary" onClick={()=>activateEnh(enhPreview.r)}>
                {enhPreview.r.kind==="clip" ? t("取走粘贴") : t("打开")}
              </button>
              {enhPreview.path && <button className="enh-pv-btn" onClick={()=>revealPath(enhPreview.path)}>{t("打开所在目录")}</button>}
              {enhPreview.path && enhPreview.r.kind!=="clip" && (
                <button className="enh-pv-btn" onClick={async()=>{
                  const r=enhPreview.r;
                  const res = r.kind==="app" ? addAppToLauncher(r.app)
                    : await addFsToLauncher(r.kind==="fs" ? r : { path:enhPreview.path, name:r.kind==="stage"?r.name:enhPreview.title, ext:r.kind==="stage"?r.item.ext:undefined, isDir:r.kind==="stage"?!!r.item.isDir:false });
                  toastAddResult(res,"launcher",enhPreview.title);
                }}>{t("加入启动台")}</button>
              )}
              {enhPreview.r.kind==="fs" && (
                <button className="enh-pv-btn" onClick={async()=>toastAddResult(await addFsToStage(enhPreview.r as Extract<EnhResult,{kind:"fs"}>),"stage",enhPreview.title)}>{t("加入中转区")}</button>
              )}
            </div>
          </aside>
        )}
        </div>
      </div>
      {/* ── 启动器「添加应用」picker（复用 settings-modal 样式 + enh-result 列表项）── */}
      {pickerOpen && (
        <div className="settings-mask" onClick={()=>{setPickerOpen(false);setPickerQuery("");}}>
          <div className="settings-modal picker-modal" onClick={e=>e.stopPropagation()}>
            <div className="settings-head">
              <span className="settings-title">{t("添加到启动台")}</span>
              <button className="settings-close" onClick={()=>{setPickerOpen(false);setPickerQuery("");}} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
            </div>
            <div className="picker-search">
              <IconSearch size={16}/>
              <input ref={pickerInputRef} className="picker-search-input" autoFocus placeholder={t("搜索要添加的应用…")} value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)} spellCheck={false}/>
            </div>
            {/* 列表只含扫描到的「应用」；任意文件/文件夹走系统选择框（索引外路径搜索命中不了） */}
            <div className="picker-browse">
              <span className="picker-browse-label">{t("或收藏任意文件 / 文件夹：")}</span>
              <button className="settings-action" onClick={()=>pickLauncherPath("file")} disabled={launcherPicking}>{t("浏览文件…")}</button>
              <button className="settings-action" onClick={()=>pickLauncherPath("folder")} disabled={launcherPicking}>{t("浏览文件夹…")}</button>
            </div>
            <div className="picker-list">
              {pickerResults.length ? pickerResults.map(({app,ranges})=>(
                <div key={app.path} className="enh-result" onClick={()=>addAppToLauncher(app)} title={t("点击添加到启动器")}>
                  <div className="enh-result-icon">{app.icon? <img src={app.icon} alt=""/> : <span>{app.name[0]}</span>}</div>
                  <span className="enh-result-label"><HighlightText text={app.name} ranges={ranges}/></span>
                </div>
              )) : <p className="empty-hint">{pickerQuery.trim()?t("无匹配应用"):t("暂无可添加应用")}</p>}
            </div>
            <div className="picker-foot">{t("点击添加，可连续添加；")}<kbd>Esc</kbd> {t("关闭")}</div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="settings-mask" onClick={()=>setSettingsOpen(false)}>
          <div className="settings-modal" onClick={e=>e.stopPropagation()}>
            <div className="settings-head">
              <span className="settings-title">{t("设置")}</span>
              <button className="settings-close" onClick={()=>setSettingsOpen(false)} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
            </div>
            <div className="settings-layout">
              <nav className="settings-nav">
                {SETTINGS_TABS.map(tab=>(
                  <button key={tab.id} className={`settings-nav-item${settingsTab===tab.id?" settings-nav-active":""}`} onClick={()=>setSettingsTab(tab.id)}>
                    <span className="settings-nav-icon"><tab.Icon size={16}/></span>{t(tab.label)}
                  </button>
                ))}
              </nav>
              <div className="settings-panel">
                {settingsTab==="general" && (<>
                  <div className="settings-panel-title">{t("常规")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("背景主题")}</span>
                    <div className="seg">
                      {([["dark","深色"],["light","浅色"],["system","系统"]] as const).map(([v,l])=>(
                        <button key={v} className={`seg-btn${theme===v?" seg-active":""}`} onClick={()=>changeTheme(v)}>{t(l)}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("语言")}</span>
                    <div className="seg">
                      {([["zh","中文"],["en","English"]] as const).map(([v,l])=>(
                        <button key={v} className={`seg-btn${lang===v?" seg-active":""}`} onClick={()=>changeLang(v)}>{t(l)}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("开机自启")}</span>
                    <div className="seg">
                      <button className={`seg-btn${autostartEnabled?" seg-active":""}`} onClick={()=>changeAutostart(true)}>{lang==="en"?"On":"开启"}</button>
                      <button className={`seg-btn${!autostartEnabled?" seg-active":""}`} onClick={()=>changeAutostart(false)}>{lang==="en"?"Off":"关闭"}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("这里仅保留全局外观与启动行为；启动台、中转站、剪贴板和搜索分别在独立条目中设置。")}</p>
                </>)}
                {settingsTab==="launcher" && (<>
                  <div className="settings-panel-title">{t("启动台")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("收藏条目")}<span className="settings-row-sub">{launcher.length} / {LAUNCHER_MAX}</span></span>
                    <div className="settings-inline-actions">
                      <button className="settings-action" onClick={()=>{setPickerQuery("");setPickerOpen(true);}}>{t("添加到启动台")}</button>
                      <button className="settings-action danger" onClick={clearLauncher} disabled={!launcher.length}>{t("清空")}</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("排序方式")}<span className="settings-row-sub">{t("拖拽调整")}</span></span>
                    <span className="settings-row-value">{t("手动排序")}</span>
                  </div>
                  <p className="settings-hint">{t("启动台只负责打开应用、文件或文件夹；与中转站的取走粘贴动作保持分离。")}</p>
                </>)}
                {settingsTab==="stage" && (<>
                  <div className="settings-panel-title">{t("中转站")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("显示布局")}</span>
                    <div className="seg">
                      <button className={`seg-btn${stageLayout==="list"?" seg-active":""}`} onClick={()=>changeStageLayout("list")}>{t("列表")}</button>
                      <button className={`seg-btn${stageLayout==="grid"?" seg-active":""}`} onClick={()=>changeStageLayout("grid")}>{t("方格")}</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("中转条目")}<span className="settings-row-sub">{stage.length} / {stageMax}</span></span>
                    <button className="settings-action danger" onClick={clearStage} disabled={!stage.length}>{t("清空")}</button>
                  </div>
                  {missingIds.size>0 && (
                    <div className="settings-row">
                      <span className="settings-row-label">{t("失踪条目")}<span className="settings-row-sub">{t("{n} 条", {n: missingIds.size})}</span></span>
                      <button className="settings-action danger" onClick={cleanupMissingStage}>{t("清理失踪")}</button>
                    </div>
                  )}
                  <div className="settings-row">
                    <span className="settings-row-label">{t("上限条数")}</span>
                    <div className="seg">
                      {STAGE_MAX_OPTIONS.map(n=>(
                        <button key={n} className={`seg-btn${stageMax===n?" seg-active":""}`} onClick={()=>changeStageMax(n)}>{n}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("拖出后自动关闭")}</span>
                    <div className="seg">
                      <button className={`seg-btn${dragoutAutoClose?" seg-active":""}`} onClick={()=>changeDragoutAutoClose(true)}>{lang==="en"?"On":"开启"}</button>
                      <button className={`seg-btn${!dragoutAutoClose?" seg-active":""}`} onClick={()=>changeDragoutAutoClose(false)}>{lang==="en"?"Off":"关闭"}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("中转站存放手动钉入或拖入的文件、文本、图片条目；左键动作为取走粘贴。「开启」（默认）：拖动条目会立即隐藏界面，便于拖到外部应用（资源管理器等）。「关闭」：拖动时界面保持显示，可拖到启动台或中途取消（松手到空白处 / 按 Esc）；要拖到外部应用时，拖动中按一下呼出热键即可隐藏界面、再松手落地。")}</p>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("持久化")}</span>
                    <div className="seg">
                      <button className={`seg-btn${stagePersist?" seg-active":""}`} onClick={()=>changeStagePersist(true)}>{lang==="en"?"On":"开启"}</button>
                      <button className={`seg-btn${!stagePersist?" seg-active":""}`} onClick={()=>changeStagePersist(false)}>{lang==="en"?"Off":"关闭"}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("「关闭」（默认）：条目确认成功移出/拖出后自动从中转区移除。「开启」：条目移出/拖出后仍保留在中转区，除非手动删除。")}</p>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("底部快捷入口")}</span>
                    <div className="seg">
                      <button className={`seg-btn${showShortcuts?" seg-active":""}`} onClick={()=>changeShowShortcuts(true)}>{lang==="en"?"Show":"显示"}</button>
                      <button className={`seg-btn${!showShortcuts?" seg-active":""}`} onClick={()=>changeShowShortcuts(false)}>{lang==="en"?"Hide":"隐藏"}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("中转区下方的截屏 / 文件管理器 / 下载等快捷按钮。隐藏后这块空间归还给中转区，可容纳更多条目。")}</p>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("缩略图缓存")}</span>
                    <div style={{display:"flex",gap:4}}>
                      <button className="settings-action" onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("open_stage_thumb_dir");}catch{}}}>{t("打开文件夹")}</button>
                      <button className={`settings-action danger${thumbCacheCleared?" copied":""}`} onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("clear_stage_thumb_cache");setThumbCacheCleared(true);setTimeout(()=>setThumbCacheCleared(false),1500);}catch{}}}>{thumbCacheCleared?<><IconCheck size={12}/> {t("已清空")}</>:t("清空缓存")}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("中转区图片文件的缩略图缓存，命中后重启秒开。清空后下次显示会按需重新生成，不影响原文件。")}</p>
                </>)}
                {settingsTab==="clipboard" && (<>
                  <div className="settings-panel-title">{t("剪贴板")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("历史保存条数")}</span>
                    <div className="seg">
                      {([10, 20, 50, 100] as const).map(n=>(
                        <button key={n} className={`seg-btn${clipCacheMax===n?" seg-active":""}`} onClick={()=>changeClipCacheMax(n)}>{n}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("剪贴板历史")}<span className="settings-row-sub">{t("{n} 条", {n: clipboard.length})}</span></span>
                    <button className="settings-action danger" onClick={clearClipboard} disabled={!clipboard.length}>{t("清空")}</button>
                  </div>
                  <p className="settings-hint">{t("复制的文本、图片、文件会自动记录，最多保留 {n} 条。", {n: clipCacheMax})}</p>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("图片原图缓存")}</span>
                    <div style={{display:"flex",gap:4}}>
                      <button className="settings-action" onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("open_clip_image_dir");}catch{}}}>{t("打开文件夹")}</button>
                      <button className={`settings-action danger${imgCacheCleared?" copied":""}`} onClick={async()=>{try{const{invoke}=await import("@tauri-apps/api/core");await invoke("clear_clip_image_cache");setImgCacheCleared(true);setTimeout(()=>setImgCacheCleared(false),1500);}catch{}}}>{ imgCacheCleared?<><IconCheck size={12}/> {t("已清空")}</>:t("清空缓存")}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{t("历史图片原图存放于此，清空后历史图粘贴退回缩略图质量。")}</p>
                </>)}
                {settingsTab==="search" && (<>
                  <div className="settings-panel-title">{t("搜索")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("呼出默认搜索")}</span>
                    <div className="seg">
                      <button className={`seg-btn${searchDefaultMode==="page"?" seg-active":""}`} onClick={()=>changeSearchDefaultMode("page")}>{t("界面搜索")}</button>
                      <button className={`seg-btn${searchDefaultMode==="enhanced"?" seg-active":""}`} onClick={()=>changeSearchDefaultMode("enhanced")}>{t("增强搜索")}</button>
                    </div>
                  </div>
                  <p className="settings-hint">{searchDefaultMode==="enhanced"?t("呼出后顶栏输入直接进入增强搜索；{combo}切换为界面搜索。",{combo:comboLabel(enhHotkey)}):t("呼出后顶栏搜索过滤界面内容；{combo}进入增强搜索（共用顶栏）。",{combo:comboLabel(enhHotkey)})}</p>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("搜索引擎")}</span>
                    <div className="seg">
                      <button className={`seg-btn${searchEngine==="builtin"?" seg-active":""}`} onClick={()=>changeSearchEngine("builtin")}>{t("内置")}</button>
                      <button className={`seg-btn${searchEngine==="everything"?" seg-active":""}`} onClick={()=>changeSearchEngine("everything")}>Everything</button>
                    </div>
                  </div>
                  {searchEngine==="everything" && (
                    <div className="settings-row">
                      <span className="settings-row-label">{t("连接状态")}<span className="settings-row-sub">{everythingAvailable?t("已连接"):t("未连接")}</span></span>
                      <button className={`settings-action${evtRedetected?" copied":""}`} onClick={redetectEverything}>{evtRedetected?<><IconCheck size={12}/> {t("已检测")}</>:t("重新检测")}</button>
                    </div>
                  )}
                  {searchEngine==="everything" && !everythingAvailable && <p className="settings-hint settings-hint-error">{t("未检测到 Everything（需安装 Everything 并保持其后台运行，DLL 已随应用内置）。查询将自动回退到内置引擎。换 DLL / 启动 Everything 后点「重新检测」即可热更新，无需重启。")}</p>}
                  {searchEngine==="everything" && everythingAvailable && <p className="settings-hint">{t("已连接 Everything，查询覆盖全盘、即时。")}</p>}
                  <p className="settings-hint">{t("内置引擎扫描整个用户目录（含下方额外目录），无需任何外部依赖；Everything 覆盖全盘但需另装。")}</p>
                  {searchEngine==="builtin" && (<>
                    <div className="settings-row">
                      <span className="settings-row-label">{t("额外扫描目录")}</span>
                      <button className="settings-action" onClick={pickSearchDir} disabled={dirPicking}>{t("浏览…")}</button>
                    </div>
                    {searchDirs.length>0 ? <div className="search-dir-list">{searchDirs.map(d=>(
                      <div key={d} className="search-dir-item"><span className="search-dir-path" title={d}>{d}</span><button className="search-dir-remove" onClick={()=>removeSearchDir(d)} title={t("移除")}><IconClose size={14}/></button></div>
                    ))}</div> : <p className="settings-hint">{t("默认仅扫描用户目录（桌面/下载/文档…）。如需搜其他盘符，在此添加根目录。")}</p>}
                    <p className="settings-hint">{t("添加目录后约几秒完成后台重建即可搜到；node_modules / .git 等噪音目录自动跳过。")}</p>
                  </>)}
                </>)}
                {settingsTab==="hotkeys" && (<>
                  <div className="settings-panel-title">{t("快捷键")}</div>
                  <div className="settings-row">
                    <span className="settings-row-label">{t("呼出 / 隐藏")}</span>
                    <div style={{display:"flex",gap:6}}>
                      <input
                        className="hotkey-input"
                        value={hotkeyInput}
                        onChange={e=>setHotkeyInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();changeHotkey(hotkeyInput);}}}
                        placeholder={t("如 ctrl+shift+f")}
                        spellCheck={false}
                        readOnly={recording==="main"}
                      />
                      <button className={"settings-action"+(recording==="main"?" recording":"")} onClick={()=>{setHotkeyError("");setRecording(r=>r==="main"?null:"main");}}>{recording==="main"?t("按下快捷键…"):t("录制")}</button>
                      <button className="settings-action" onClick={()=>changeHotkey(hotkeyInput)}>{t("应用")}</button>
                    </div>
                  </div>
                  {hotkeyError && <p className="settings-hint settings-hint-error">{t(hotkeyError)}</p>}
                  {hotkeyCombo!=="ctrl+space" && <button className="settings-action" onClick={()=>changeHotkey("ctrl+space")}>{t("恢复默认")}</button>}
                  <div className="settings-row">
                    <span className="settings-row-label">{t("增强搜索")}</span>
                    <div style={{display:"flex",gap:6}}>
                      <input
                        className="hotkey-input"
                        value={enhHotkeyInput}
                        onChange={e=>setEnhHotkeyInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();changeEnhHotkey(enhHotkeyInput);}}}
                        placeholder={t("如 ctrl+k")}
                        spellCheck={false}
                        readOnly={recording==="enh"}
                      />
                      <button className={"settings-action"+(recording==="enh"?" recording":"")} onClick={()=>{setEnhHotkeyError("");setRecording(r=>r==="enh"?null:"enh");}}>{recording==="enh"?t("按下快捷键…"):t("录制")}</button>
                      <button className="settings-action" onClick={()=>changeEnhHotkey(enhHotkeyInput)}>{t("应用")}</button>
                    </div>
                  </div>
                  {enhHotkeyError && <p className="settings-hint settings-hint-error">{t(enhHotkeyError)}</p>}
                  {enhHotkey!=="ctrl+k" && <button className="settings-action" onClick={()=>changeEnhHotkey("ctrl+k")}>{t("恢复默认")}</button>}
                  <p className="settings-hint">{t("点「录制」后直接按下组合键自动填入；也可手动输入。")}</p>
                  <p className="settings-hint" style={{marginTop: '4px'}}>{t("格式：ctrl+x · alt+q · ctrl+shift+x · f9")}</p>
                  <p className="settings-hint" style={{marginTop: '4px'}}>{t("· 不支持 Win 键及 Alt+Space / Alt+F4（系统保留）")}<br/>{t("· 修饰键 Ctrl / Shift / Alt 可选；纯主键会全局抢占该键，慎设")}<br/>{t("· 中文输入法下录制前请先切换到英文输入法")}</p>
                  <div className="settings-row"><span className="settings-row-label">{t("关闭面板")}</span><kbd>Esc</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">{t("应用导航")}</span><kbd>↑↓</kbd></div>
                  <div className="settings-row"><span className="settings-row-label">{t("启动选中应用")}</span><kbd>Enter</kbd></div>
                  <p className="settings-hint">{t("长按 = 按住显示松开关闭；短按 = 切换显隐。")}</p>
                </>)}
                {settingsTab==="about" && (<>
                  <div className="settings-panel-title">{t("关于")}</div>
                  <div className="settings-about">
                    <div>Workbench <b>v{__APP_VERSION__}</b></div>
                    <div>{t("Windows 全屏「第二桌面」工具")}</div>
                    <div>{t("应用启动器 · 文件中转 · 剪贴板历史")}</div>
                  </div>
                </>)}
              </div>
            </div>
          </div>
        </div>
      )}
      <footer className="bottom-bar">
        <div className="bot-left"><span className="sys-dot"/><span>CPU {navigator.hardwareConcurrency??"?"} {t("核")}</span></div>
        <div className="bot-center"><kbd>{comboLabel(hotkeyCombo)}</kbd> {t("切换")} · <kbd>{comboLabel(enhHotkey)}</kbd> {enhOpen?t("界面搜索"):t("增强搜索")} · <kbd>Esc</kbd> {t("关闭")} · <kbd>↑↓</kbd> {t("导航")} · <kbd>Enter</kbd> {t("启动")}</div>
        <div className="bot-right"><span>Workbench v{__APP_VERSION__}</span></div>
      </footer>
    </div>
    {/* 全局轻提示：同样是 #overlay 的兄弟节点——#overlay 的 backdrop-filter 会成为 fixed 的包含块，
        放进去会相对它定位而非视口。key={toast.id} 让同一句提示连发也能重挂节点、重启 CSS 动画。
        pointer-events:none（见 CSS）：提示绝不能挡住下面的卡片点击。 */}
    {toast && <div key={toast.id} className="toast" style={{animationDuration:`${TOAST_MS}ms`}} role="status" aria-live="polite">{toast.msg}</div>}
    {/* 启动放大暂留克隆改为命令式 cloneNode（见 spawnLaunchClone），挂进下方 dragLayer，不再走 React 渲染 */}
    {/* 顶层拖拽预览层：承载 DOM clone ghost + 启动克隆，集中管理层级，避免散挂 body 后再靠单个节点抢 z-index */}
    <div className="drag-layer" ref={dragLayerRef}/>
    {/* 自定义右键菜单浮层：fixed 定位，渲染在最顶层；mousedown stopPropagation 防被全局 close 监听立即关掉 */}
    {ctxMenu && (
      <div className="ctx-menu" style={{left:ctxMenu.x, top:ctxMenu.y}} onMouseDown={e=>e.stopPropagation()}>
        {ctxMenu.items.map((item,i)=>(
          <button key={i} className="ctx-menu-item" disabled={item.disabled}
            onClick={()=>{item.action();setCtxMenu(null);}}>
            {item.label}
          </button>
        ))}
      </div>
    )}
    {/* 拖拽跟手克隆：与 #overlay 同为兄弟节点（#overlay 的 backdrop-filter 会成为 fixed 的包含块，放里面定位会错），pointerEvents:none 不挡命中检测。
        位移不进 React style（避免每次 move 重渲，续109）——由 ref 回调按 clipDragRef 当前坐标就位、move 时直写 transform。
        ref 回调在 commit 阶段跑（paint 前），且 App 因他因重渲时会重跑并按最新坐标复位 → 天然自愈、无 (0,0) 闪帧。 */}
    {clipDragItem && (
      <div className="clip-drag-ghost"
        ref={el=>{ clipGhostRef.current=el; const d=clipDragRef.current; if(el&&d) el.style.transform=`translate3d(${d.x+12}px,${d.y+12}px,0)`; }}
        style={{position:"fixed",pointerEvents:"none",zIndex:100002}}>
        {clipDragItem.type==="image"
          ? <img src={clipThumbs[clipDragItem.time]} className="clip-ghost-img" alt="" draggable={false}/> /* 步骤2：拖拽 ghost 用缩略图（content 已剥离）*/
          : clipDragItem.type==="file"
          ? <span className="clip-ghost-file"><FileGlyph size={14} {...fileGlyphFor(clipDragItem)}/><span className="clip-ghost-name">{clipDragItem.items?.[0]?.name ?? t("文件")}</span></span>
          : <span>{String(clipDragItem.content ?? "").slice(0,40)}</span>}
      </div>
    )}
   </>
  );
}
