import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue, Fragment } from "react";
import "./App.css";
import { makeT, type Lang } from "./i18n";
import { IMG_EXTS, dirOf, fileGroup, fileGlyphFor, type FileGroup } from "./lib/format";
import { groupFiles, groupRanked } from "./lib/enhSections";
import { fuzzyScore, typeKeywords, matchItem } from "./lib/fuzzy";
import { matchName, type PinyinTable, type PinyinVariant } from "./lib/pinyin";
import { tokenFromCode, parseComboStr, matchComboEvent, comboLabel } from "./lib/hotkey";
import LauncherPanel from "./components/LauncherPanel";
import ClipboardPanel, { type ClipboardPanelActions, type ClipboardPanelDragHandlers } from "./components/ClipboardPanel";
import { StageGridCard, StageListRow, type StageItemActions, type StageItemPointerHandlers } from "./components/StageItems";
import EnhancedSearchLayer, { type EnhancedSearchActions, type EnhancedSearchPreview } from "./components/EnhancedSearchLayer";
import { Clock, WorkbenchFooter, WorkbenchSearchHeader } from "./components/WorkbenchChrome";
import HighlightText from "./components/HighlightText";
import SettingsDialog, { type SettingsTab } from "./components/SettingsDialog";
import { LauncherManagerDialog, LauncherPickerDialog, StageRecoveryDialog } from "./components/WorkbenchDialogs";
import { enhancedResultKey as enhKey } from "./domain/enhancedSearch";
import { buildLauncherLayoutExport, createLauncherId, LAUNCHER_MAX, previewLauncherImport } from "./domain/launcherLayout";
import { STAGE_MAX_OPTIONS } from "./domain/stageSettings";
import { useWorkbenchPersistence } from "./hooks/useWorkbenchPersistence";
import { stageImageThumbKey, useThumbnailCaches } from "./hooks/useThumbnailCaches";
import { useEnhancedSearchQuery } from "./hooks/useEnhancedSearchQuery";
import { useEnhancedSearchPreview } from "./hooks/useEnhancedSearchPreview";
import { useEnhancedSearchSelection } from "./hooks/useEnhancedSearchSelection";
import { cacheApi } from "./platform/cacheApi";
import { clipboardApi } from "./platform/clipboardApi";
import { subscribeNativeEvents } from "./platform/nativeEvents";
import { openWorkbenchStore, runStartupStep, startupNative, type WorkbenchStore } from "./platform/workbenchStartup";
import { createPassiveEventHandlers, normalizeClipboardHistory, type ClipboardOriginalDegradedPayload } from "./shell/passiveEventHandlers";
import {
  resolveEscapeTarget,
  resolveHeaderSearchTarget,
  resolveHideResetPlan,
  resolveSearchModeToggle,
} from "./shell/uiPolicies";
import type {
  AppInfo,
  AppUsage,
  ClipItem,
  EnhResult,
  FileEntry,
  FileItem,
  LauncherImportPreview,
  LauncherItem,
  Pasteable,
  StageItem,
} from "./types";
import { IconCheck, IconSettings, FileGlyph,
         IconCamera, IconExplorer, IconDownload, IconMonitor, IconTerminal, IconCalculator, IconDrop } from "./icons";

// ── 类型 ──
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
// 失效扫描只是提示补全，绝不能占用工作台呼出的关键路径。
// 每批很小；预算到即停，下一次呼出再续扫。
const STAGE_MISSING_SCAN_DELAY_MS = 250;
const STAGE_MISSING_SCAN_BUDGET_MS = 750;
const STAGE_MISSING_SCAN_BATCH_SIZE = 24;
const STAGE_MISSING_SCAN_YIELD_MS = 32;
// 增强搜索（Ctrl+K）文件结果上限：内置仅扫用户目录够用；Everything 覆盖全盘，给大得多的上限（列表可滚动）
// 分组不足此条数则并入「其他文件」（续114b）。没有这道闸，一个只返回 3 个文件的查询会得到
// 3 个标题配 3 条内容——标题比内容还多，比不分组更难看。这条阈值对实际观感的影响大于分类表本身。
const ENH_MIN_SECTION = 3;
const ENH_FILE_LIMIT_BUILTIN = 150;
const ENH_FILE_LIMIT_EVERYTHING = 500;
// 文件查询的防抖，**按引擎分档**（续131）。防抖的目的是压住"每敲一键一次查询"的开销，
// 那个开销两个引擎差着数量级，用同一个值必然有一边配错：
//   内置 = 纯内存读索引，V2 真机 4.47 万项总体 p95≈29ms → 150ms 里绝大部分仍是白等；
//   Everything = 跨进程 IPC + 全盘查询 + 5000 条候选池重排，量级完全不同，150ms 是它的保险。
// 故内置降到 50ms（仍能吃掉连续击键，正常打字相邻间隔 80~200ms），Everything 保持 150ms。
const ENH_DEBOUNCE_BUILTIN_MS = 50;
const ENH_DEBOUNCE_EVERYTHING_MS = 150;
const DRAG_THRESHOLD_PX = 8; // 剪贴板卡片按下后移动超过此距离才激活拖拽，防误触（短按仍走 onClick 粘贴）
const LASSO_THRESHOLD_PX = 6; // 中转区框选：按下后移动超过此距离才激活框选，防误触（纯点击空白不进多选）
const DRAG_OUT_THRESHOLD_PX = 12; // 中转条目拖出：按下后移动超过此距离才触发 OLE DoDragDrop（高于框选/卡片拖拽阈值，防误触）
const STAGE_MOAT_PX = 6; // 中转卡片"边缘缓冲带"：非多选态下、从卡片外沿此宽度内按下拖动→判为框选而非拖出（紧凑布局下框选难起手的补偿，续108）


/// 搜索现场（页面搜索/增强搜索）保留时长：隐藏时若仍带着搜索现场则不立即复位，保留此时长供用户
/// 多次呼出继续浏览；每次隐藏重新起算，呼出即取消计时；超时在隐藏中静默复位，下次呼出全新。
const SEARCH_KEEP_MS = 10_000;
/// 续146 起废弃的 store key（功能已删，但 plugin-store 不会自动回收未知 key，会一直躺在 JSON 里）。
/// ⚠ 别把 `file-list` 加进来——它是只写不读的**老格式迁移兜底**，仍在 store 载入路径上用着。
const DEAD_STORE_KEYS = ["standalone-enh-hotkey", "stage-drag-out-enabled", "stage-drag-auto-hide"] as const;
// ── 应用使用打分：频率为主 × 近期乘数（频率高且近期用过的排前）──
// score = count × 0.5^(距上次使用 / 半衰期)。30 天没用，权重掉一半。要调"近期"敏感度改这个常量。
const USAGE_HALFLIFE_S = 30 * 24 * 3600;
function usageScore(u: AppUsage | undefined, nowS: number): number {
  if (!u || u.count <= 0) return 0;
  return u.count * Math.pow(0.5, (nowS - u.last_used) / USAGE_HALFLIFE_S);
}
// 与 Rust 文件使用学习同档：动态搜索投影只同步 0..400 的同层 tie-break，不参与跨匹配层翻转。
function searchUsageBoost(u: AppUsage | undefined, nowS: number): number {
  const score = usageScore(u, nowS);
  return score < 0.25 ? 0 : score < 1 ? 100 : score < 2 ? 200 : score < 4 ? 300 : 400;
}

async function hideWorkbench() { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("hide_window"); } catch{} }

// ── 文件中转：转换 + 写剪贴板助手 ──
const stageId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000); // 稳定唯一 id（key/去重）
function fileEntryToStage(f: FileEntry): StageItem {
  const isImage = IMG_EXTS.includes(f.ext.toLowerCase());
  return { id: stageId(), type: "file", items: [{ path: f.path, name: f.name, ext: f.ext, isImage, icon: f.icon }], count: 1, name: f.name, ext: f.ext, isDir: f.isDir, size: f.size };
}
function clipToStage(c: ClipItem): StageItem {
  return { id: stageId(), type: c.type, content: c.content, items: c.items, count: c.count, name: c.items?.[0]?.name, orig_path: c.orig_path };
}
// 图片大内容不常驻前端 state：剪贴板按 time 从 CLIP_CACHE 现取，中转图片按 contentFile 从
// stage_images/ 现取。拖出路径另由 Rust 同步自查，绝不在前端 await（R13）。
async function hydrateContent(item: { type: string; content?: string; contentFile?: string; time?: number }): Promise<string | undefined> {
  if (item.content || item.type !== "image") return item.content;
  const { invoke } = await import("@tauri-apps/api/core");
  if (item.time != null) return (await invoke<string | null>("get_clip_content", { time: item.time })) ?? undefined;
  if (item.contentFile) return await invoke<string>("get_stage_image_content", { file: item.contentFile });
  return undefined;
}
// 只写当前系统剪贴板（不粘贴、不隐藏 overlay），复用现成 copy_* 命令；剪贴板卡片与中转条目共用
async function writeItemToClipboard(item: Pasteable) {
  const { invoke } = await import("@tauri-apps/api/core");
  if (item.type === "text") await invoke("copy_text_to_clipboard", { text: item.content });
  else if (item.type === "file" && item.items) await invoke("copy_files_to_clipboard", { paths: item.items.map(f => f.path) });
  else await invoke("copy_image_to_clipboard", { base64: (await hydrateContent(item)) ?? "", origPath: item.orig_path ?? null, time: item.time ?? null });
}

// 自定义右键菜单（浮层）
type CtxMenuItem = { label: string; action: () => void; disabled?: boolean };
type CtxMenu = { x: number; y: number; items: CtxMenuItem[] } | null;

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

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const searchValueRef = useRef(""); searchValueRef.current = search; // 供 hotkey-hide 闭包读最新值（判定有无搜索现场）
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stage, setStage] = useState<StageItem[]>([]); // 文件中转区：混合条目（文件/文本/图片）
  const [launcher, setLauncher] = useState<LauncherItem[]>([]); // 启动器收藏托盘（手动策展，持久化）
  // 启动台不预扫：只记录用户点击过的条目的最近一次存在性结果，且不落盘，避免下次显示陈旧状态。
  const [missingLauncherIds, setMissingLauncherIds] = useState<Set<number>>(new Set());
  const launcherMissingScanTokenRef = useRef(new Map<number, number>()); // 同项连点时，只采用最后一次检查结果
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
  // 拼音派生表（续131）：原名 → 拼音变体。派生在 Rust，这里只缓存结果。
  // 空数组 = 已查过且该名无汉字（与"还没查过"区分开，避免反复重查纯英文名）。
  const [pinyin, setPinyin] = useState<PinyinTable>({});
  const [store, setStore] = useState<WorkbenchStore | null>(null);
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
  const {
    persistStage,
    persistLauncher,
    rememberStageReferences,
    rememberLauncherReferences,
    hasStageContentFile,
    getStageContentFile,
    rememberStageContentFile,
    hasLauncherIconFile,
  } = useWorkbenchPersistence({ storeRef, setStage });
  const [stageSel, setStageSel] = useState<Set<number>>(new Set<number>()); // 中转区多选（选中的 StageItem.id）
  const [stageMultiselect, setStageMultiselect] = useState(false); // 多选模式开关（显式进入，非按住修饰键）
  const [stageLayout, setStageLayout] = useState<"list"|"grid">("list"); // 中转区布局：列表 / 方格
  const [dragoutAutoClose, setDragoutAutoClose] = useState(true); // 中转站拖出后是否自动关闭窗口（与 Rust DRAGOUT_AUTO_CLOSE 同步）
  const dragoutAutoCloseRef = useRef(dragoutAutoClose); dragoutAutoCloseRef.current = dragoutAutoClose; // 供 drag-out-done 监听闭包读最新值
  const [stagePersist, setStagePersist] = useState(false); // 中转站文件持久化：开启后移出/拖出不再自动移除条目，需手动删除（纯前端，无需 Rust 同步）
  const stagePersistRef = useRef(stagePersist); stagePersistRef.current = stagePersist; // 供 drag-out-done 监听闭包读最新值
  const [showShortcuts, setShowShortcuts] = useState(true); // 中转区下方「快捷入口」行是否显示（纯前端 store 持久化）；关闭时空间归还给中转区 drop-area（flex:1 自动铺满）
  const { stageThumbs, clipThumbs } = useThumbnailCaches({ stage, launcher, clipboard });
  // 中转区 file 条目「原文件失踪」路径集。每次呼出时后台批量 exists() 扫一遍（check_stage_paths）。
  // 不用实时文件监听（分散父目录 watcher 代价高/网络盘不支持），只在呼出这个「该看的时刻」懒扫。
  // 失效引用必须保留给用户处理：重新定位、复制原路径或删除整项，绝不静默删掉。
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set()); // 复用既有 stageRef（行 216）读最新 stage
  const missingPathsRef = useRef<Set<string>>(new Set()); missingPathsRef.current = missingPaths;
  const stageMissingScanGenerationRef = useRef(0); // 新一轮或 hide 后，旧结果一律作废
  const stageMissingScanTimerRef = useRef<number | null>(null);
  const [stageRecoveryOpen, setStageRecoveryOpen] = useState(false);
  const stageRecoveryOpenRef = useRef(false); stageRecoveryOpenRef.current = stageRecoveryOpen;
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
  // 中转区内重排（续87，仿启动台 FLIP 方案）：仅「拖出后自动关闭」关闭时，单项拖动走此逻辑，ghost 跟手 + FLIP 排序。
  // 自动关闭开启时，超过阈值直接进入原生拖出并隐藏；关闭时仍不使用曾被否决的越界/时间升级，
  // 如需去外部则在重排中按热键，经 stage-drag-hotkey → beginNativeDragOut 交接。
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
  const [launcherSelIdx, setLauncherSelIdx] = useState(-1); // 启动器网格键盘选中项（-1=未选中，焦点在搜索框）
  const [enhAdded, setEnhAdded] = useState<{path:string;target:"stage"|"launcher"}|null>(null); // 操作按钮 ✓ 反馈
  const enhInputRef = useRef<HTMLInputElement>(null);
  const enhResultsRef = useRef<HTMLDivElement>(null); // 结果列表容器：选中高亮命令式加 class 时的查询根（续127）
  const enhOpenRef = useRef(false); enhOpenRef.current = enhOpen; // 供 Esc keydown 闭包读最新
  const enhPinnedRef = useRef(false); enhPinnedRef.current = enhPinned; // 供 onChange 闭包读最新 pinned 状态
  const pageSearchForcedRef = useRef(false); // enhanced 模式下用户主动按 Ctrl+K 切到界面搜索，本次呼出有效
  // 搜索引擎（续57）：内置自建索引 / 可选 Everything；持久化 store，运行时由 Rust set_search_engine 应用
  const [searchEngine, setSearchEngine] = useState<"builtin"|"everything">("builtin");
  const [searchItemsRevision, setSearchItemsRevision] = useState(0);
  // 双引擎查询、分档防抖和迟到响应守卫由查询控制器统一持有；App 只消费两种结果投影。
  const { fileResults: fsResults, builtinHits, clearResults: clearEnhancedSearchResults } = useEnhancedSearchQuery({
    open: enhOpen,
    query: enhQuery,
    engine: searchEngine,
    itemsRevision: searchItemsRevision,
    builtinLimit: ENH_FILE_LIMIT_BUILTIN,
    everythingLimit: ENH_FILE_LIMIT_EVERYTHING,
    builtinDebounceMs: ENH_DEBOUNCE_BUILTIN_MS,
    everythingDebounceMs: ENH_DEBOUNCE_EVERYTHING_MS,
  });
  // 以时间作 epoch，WebView 在同一 Rust 进程内重载时 revision 也不会从 0 倒退。
  const searchItemsSyncRef = useRef(Date.now());
  const [indexReady, setIndexReady] = useState(false); // 文件索引是否就绪（未就绪时显示「建立中…」，不阻塞 Tier 1）
  const [searchDirs, setSearchDirs] = useState<string[]>([]); // 内置引擎额外扫描根目录（如 D:\）
  const [dirPicking, setDirPicking] = useState(false); // 文件夹选择框是否已弹出（防重复弹）
  const [launcherPicking, setLauncherPicking] = useState(false); // 启动台「浏览…」选择框是否已弹出（同上，防重入叠弹）
  // 启动台批量管理：不复用主网格的点击/拖拽语义，集中在独立模态中做多选删除与布局迁移。
  const [launcherManageOpen, setLauncherManageOpen] = useState(false);
  const [launcherManageSelected, setLauncherManageSelected] = useState<Set<number>>(new Set());
  const [launcherImportPreview, setLauncherImportPreview] = useState<LauncherImportPreview | null>(null);
  const [launcherLayoutBusy, setLauncherLayoutBusy] = useState(false);
  const launcherManageOpenRef = useRef(false); launcherManageOpenRef.current = launcherManageOpen;
  // ── 全局轻提示（续113）──
  // 定位：补「无锚点操作」的反馈空白——右键菜单项、模态里点完就关的按钮，动作一完成界面上什么都没变，
  // 用户不知道成没成。**不替换已有的 7 处按钮原地 ✓ 反馈**（copiedTime/enhAdded/imgCacheCleared…）：
  // 那些反馈与按钮同位、指向明确，比飘到屏幕另一头的 toast 更好，换成 toast 是倒退。
  // id 用自增计数器：同一句提示连点两次也能重放动画（靠 key 重挂 DOM 节点重启 CSS animation）。
  const [toast, setToast] = useState<{id:number;msg:string}|null>(null);
  const toastTimerRef = useRef<number|null>(null);
  const toastIdRef = useRef(0);
  // deps[] 核心监听无法捕获后面声明的 showToast；用恒稳 ref 复用同一 toast 状态机。
  const showToastRef = useRef((msg:string) => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast({ id: ++toastIdRef.current, msg });
    toastTimerRef.current = window.setTimeout(() => { setToast(null); toastTimerRef.current = null; }, TOAST_MS);
  });
  const langRef = useRef<Lang>(lang); langRef.current = lang;
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
  useEffect(() => {
    (async () => {
      try {
        const s = await openWorkbenchStore();
        setStore(s);

        await runStartupStep("加载应用使用记录", async () => {
          const raw = await s.get<Record<string, number | AppUsage>>("app-frequency") ?? {};
          const nowS = Math.floor(Date.now() / 1000);
          const usage: Record<string, AppUsage> = {};
          for (const [k, v] of Object.entries(raw)) {
            usage[k] = typeof v === "number" ? { count: v, last_used: nowS } : v;
          }
          setAppUsage(usage);
        });

        await runStartupStep("加载主题", async () => {
          const savedTheme = await s.get<string>("theme");
          if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "system") setTheme(savedTheme);
        });

        await runStartupStep("加载语言", async () => {
          const savedLang = await s.get<string>("language");
          const initLang: Lang = savedLang === "en" ? "en" : "zh";
          setLang(initLang);
          await runStartupStep("同步托盘语言", async () => {
            await startupNative.setTrayLanguage(initLang);
          });
        });

        await runStartupStep("加载剪贴板上限", async () => {
          const savedMax = await s.get<number>("clip-cache-max");
          if (typeof savedMax !== "number" || savedMax < 10 || savedMax > 100) return;
          setClipCacheMax(savedMax);
          clipCacheMaxRef.current = savedMax;
          await runStartupStep("同步剪贴板上限", async () => {
            await startupNative.setClipCacheMax(savedMax);
          });
        });

        let stageMaxLoaded: number = STAGE_MAX_DEFAULT;
        await runStartupStep("加载中转站上限", async () => {
          const savedStageMax = await s.get<number>("stage-max");
          if (typeof savedStageMax !== "number" || !(STAGE_MAX_OPTIONS as readonly number[]).includes(savedStageMax)) return;
          stageMaxLoaded = savedStageMax;
          setStageMax(savedStageMax);
          stageMaxRef.current = savedStageMax;
        });

        await runStartupStep("加载主热键", async () => {
          const savedHotkey = await s.get<string>("hotkey-combo");
          if (typeof savedHotkey === "string" && savedHotkey.trim()) {
            const hk = savedHotkey.trim();
            setHotkeyCombo(hk);
            setHotkeyInput(hk);
          }
          // 不 invoke set_hotkey——Rust setup 已按 store 同步落地，避免重复注册。
        });

        await runStartupStep("加载增强搜索热键", async () => {
          const savedEnh = await s.get<string>("enh-hotkey");
          if (typeof savedEnh === "string" && savedEnh.trim() && parseComboStr(savedEnh.trim())) {
            const eh = savedEnh.trim();
            setEnhHotkey(eh);
            setEnhHotkeyInput(eh);
          }
          // 增强搜索键纯前端，无需 invoke。
        });

        let searchEngineLoaded: "builtin" | "everything" = "builtin";
        let searchDirsLoaded: string[] = [];
        const searchSettingsLoaded = await runStartupStep("加载搜索设置", async () => {
          const savedEngine = await s.get<string>("search-engine");
          searchDirsLoaded = await s.get<string[]>("search-dirs") ?? [];
          searchEngineLoaded = savedEngine === "everything" ? "everything" : "builtin";
          setSearchEngine(searchEngineLoaded);
          setSearchDirs(searchDirsLoaded);
        });
        if (searchSettingsLoaded && searchDirsLoaded.length) {
          await runStartupStep("应用搜索目录", async () => {
            await startupNative.setSearchDirs(searchDirsLoaded);
          });
        }
        if (searchSettingsLoaded) {
          await runStartupStep("应用搜索引擎", async () => {
            await startupNative.setSearchEngine(searchEngineLoaded);
          });
        }

        await runStartupStep("加载中转站", async () => {
          const savedStage = await s.get<StageItem[]>("stage-items");
          if (savedStage && savedStage.length) {
            let loaded = savedStage.slice(0, stageMaxLoaded);
            // image content 不再启动补水：只校验 contentFile 仍存在，动作时按需读取。
            if (loaded.some(it => it.contentFile)) {
              await runStartupStep("校验中转图片引用", async () => {
                const files = [...new Set(loaded.flatMap(it => it.contentFile ? [it.contentFile] : []))];
                const existing = new Set(await startupNative.existingStageImages(files));
                loaded = loaded.map(it => {
                  if (!it.contentFile || existing.has(it.contentFile)) return it;
                  const { contentFile: _gone, ...rest } = it;
                  return rest;
                });
              });
            }
            rememberStageReferences(loaded);
            setStage(loaded);
            scanStageMissing(loaded); // 续100：启动即扫一遍失踪（重启后原文件可能已被删）
            return;
          }

          const fps = await s.get<string[]>("file-list") ?? [];
          if (!fps.length) return;
          const items: StageItem[] = [];
          for (const fp of fps.slice(0, stageMaxLoaded)) {
            try {
              items.push(fileEntryToStage(await startupNative.getFileInfo(fp)));
            } catch (error) {
              console.warn(`[startup] 恢复旧中转条目失败：${fp}`, error);
            }
          }
          setStage(items);
          scanStageMissing(items);
        });

        await runStartupStep("加载启动台", async () => {
          const savedLauncher = await s.get<LauncherItem[]>("launcher-items");
          if (!savedLauncher?.length) return;
          let items = savedLauncher.slice(0, LAUNCHER_MAX);
          // 只读取当前条目实际引用的 iconFile，孤儿文件不进 IPC/JS 堆。
          if (items.some(it => it.iconFile)) {
            await runStartupStep("加载启动台图标", async () => {
              const files = [...new Set(items.flatMap(it => it.iconFile ? [it.iconFile] : []))];
              const iconMap = await startupNative.loadLauncherIcons(files);
              items = items.map(it => {
                if (!it.iconFile) return it;
                const hit = iconMap[it.iconFile];
                if (hit) return { ...it, icon: hit };
                const { iconFile: _gone, ...rest } = it;
                return rest;
              });
            });
          }
          rememberLauncherReferences(items);
          setLauncher(items);
        });

        await runStartupStep("加载中转站布局", async () => {
          const savedStageLayout = await s.get<string>("stage-layout");
          if (savedStageLayout === "list" || savedStageLayout === "grid") setStageLayout(savedStageLayout);
        });

        await runStartupStep("加载拖出后关闭设置", async () => {
          const savedDragoutAutoClose = await s.get<boolean>("dragout-auto-close");
          if (typeof savedDragoutAutoClose !== "boolean") return;
          setDragoutAutoClose(savedDragoutAutoClose);
          await runStartupStep("同步拖出后关闭设置", async () => {
            await startupNative.setDragoutAutoClose(savedDragoutAutoClose);
          });
        });

        await runStartupStep("加载中转站持久化设置", async () => {
          const savedStagePersist = await s.get<boolean>("stage-persist");
          if (typeof savedStagePersist === "boolean") setStagePersist(savedStagePersist);
        });
        await runStartupStep("加载快捷入口设置", async () => {
          const savedShowShortcuts = await s.get<boolean>("show-shortcuts");
          if (typeof savedShowShortcuts === "boolean") setShowShortcuts(savedShowShortcuts);
        });
        await runStartupStep("加载默认搜索模式", async () => {
          const savedSearchMode = await s.get<string>("search-default-mode");
          if (savedSearchMode === "enhanced" || savedSearchMode === "page") setSearchDefaultMode(savedSearchMode);
        });

        // plugin-store 不回收未知 key；单个删除失败不阻塞其余 key 和后续启动流程。
        await runStartupStep("清理旧设置键", async () => {
          let pruned = false;
          for (const k of DEAD_STORE_KEYS) {
            try {
              if (await s.delete(k)) pruned = true;
            } catch (error) {
              console.warn(`[startup] 清理旧设置键失败：${k}`, error);
            }
          }
          if (pruned) await s.save();
        });
      } catch (error) {
        // store 本身不可用时没有可继续读取的配置域；保留内存默认值启动。
        console.error("[startup] 加载 workbench-data.json 失败，使用默认设置：", error);
      }
    })();
  }, []);

  // ── 开机自启：启动时读取当前状态 ──
  useEffect(() => { (async()=>{ try { setAutostartEnabled(await startupNative.isAutostartEnabled()); } catch(error){ console.warn("[startup] 读取开机自启状态失败：", error); } })(); }, []);

  const saveStage = useCallback(async (list:StageItem[]) => {
    setStage(list);                                 // 先上屏；落盘成功后 persistStage 自动脱去 image content
    await persistStage(list);
  }, [persistStage]);
  // 中转条目「固定/保留」开关（续99）：点亮后拖出成功也不自动移除（豁免非持久化模式的移除）。落盘进 stage-items，重启保留。
  const toggleStagePin = useCallback((id:number) => { saveStage(stageRef.current.map(x=>x.id===id?{...x,pinned:!x.pinned}:x)); }, [saveStage]);
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
    if (!launcher.some(it => it.icon && !it.iconFile && !hasLauncherIconFile(it.id))) return;
    launcherMigratedRef.current = true;
    saveLauncher(launcher);
  }, [launcher, store, saveLauncher, hasLauncherIconFile]);

  // 续146b 同款一次性迁移：中转站 image 条目的内嵌 content 搬进 stage_images/。
  const stageMigratedRef = useRef(false);
  useEffect(() => {
    if (stageMigratedRef.current || !store || !stage.length) return;
    if (!stage.some(it => it.type==="image" && it.content && !it.contentFile && !hasStageContentFile(it.id))) return;
    stageMigratedRef.current = true;
    saveStage(stage);
  }, [stage, store, saveStage, hasStageContentFile]);
  const changeStageLayout = useCallback(async (v:"list"|"grid") => { setStageLayout(v); if(store){ await store.set("stage-layout",v); await store.save(); } }, [store]);
  const changeDragoutAutoClose = useCallback(async (v:boolean) => {
    const previous = dragoutAutoClose;
    setDragoutAutoClose(v);
    try {
      // 运行时行为必须先同步：store.save() 是整文件写，若排在 invoke 前，UI 已显示新档位时
      // 立即起手的拖拽仍会读到 Rust 旧值（实测日志进入了“保持界面模式”）。
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_dragout_auto_close", { enabled: v });
      if (store) { await store.set("dragout-auto-close", v); await store.save(); }
    } catch {
      setDragoutAutoClose(previous);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_dragout_auto_close", { enabled: previous });
      } catch {}
    }
  }, [dragoutAutoClose, store]);
  const changeStagePersist = useCallback(async (v:boolean) => { setStagePersist(v); if(store){ await store.set("stage-persist",v); await store.save(); } }, [store]);
  const changeShowShortcuts = useCallback(async (v:boolean) => { setShowShortcuts(v); if(store){ await store.set("show-shortcuts",v); await store.save(); } }, [store]);
  const changeStageMax = useCallback(async (n:number) => { setStageMax(n); if(store){ await store.set("stage-max",n); await store.save(); } if(stage.length>n){ await saveStage(stage.slice(0,n)); } }, [store,stage,saveStage]);
  const changeSearchDefaultMode = useCallback(async (v:"page"|"enhanced") => { setSearchDefaultMode(v); if(store){ await store.set("search-default-mode",v); await store.save(); } }, [store]);
  const recordUse = useCallback(async (p:string) => { const cur=appUsage[p]; const u={...appUsage,[p]:{count:(cur?.count??0)+1,last_used:Math.floor(Date.now()/1000)}}; setAppUsage(u); if(store){ await store.set("app-frequency",u); await store.save(); } }, [appUsage,store]);

  // ── 核心：事件监听（只注册一次，依赖[]）。可见性唯一真相在 Rust，前端只同步 ──
  useEffect(() => {
    let fileDragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
    let searchKeepTimer: ReturnType<typeof setTimeout> | null = null; // 搜索现场延迟复位计时器（hide 武装 / show 取消）
    let uiKeepTimer: ReturnType<typeof setTimeout> | null = null;
    // 搜索现场复位：页面搜索 + 增强搜索全部状态，hotkey-hide 的「立即/延迟」两路复用
    const resetSearchState = () => { setEnhOpen(false); setEnhPinned(false); setEnhQuery(""); setEnhSelIdx(0); clearEnhancedSearchResults(); setSearch(""); pageSearchForcedRef.current = false; };
    // 可恢复工作现场与危险瞬态分开：多选/管理弹层保留 10 秒；拖拽、框选、菜单仍在 hide 当场清。
    const resetRetainedUiState = () => {
      setStageSel(new Set<number>());
      setStageMultiselect(false);
      stageAnchorRef.current = null;
      setPickerOpen(false);
      setPickerQuery("");
      setLauncherManageOpen(false);
      setLauncherImportPreview(null);
      setStageRecoveryOpen(false);
    };
    const passiveEventHandlers = createPassiveEventHandlers({
      loadClipboardHistory: clipboardApi.getHistory,
      replaceClipboard: history => setClipboard(history),
      updateClipboard: update => setClipboard(update),
      setIndexReady,
      setApps,
      notifyOriginalFallback: () => {
        showToastRef.current(makeT(langRef.current)("原图不可用，本次已使用缩略图"));
      },
    });
    // 监听作用域统一承担动态加载、逐项隔离和 StrictMode 的异步注册清理竞态（R47）。
    const eventScope = subscribeNativeEvents(async register => {
        await register("hotkey-show", () => {
          if (searchKeepTimer !== null) { clearTimeout(searchKeepTimer); searchKeepTimer = null; }
          if (uiKeepTimer !== null) { clearTimeout(uiKeepTimer); uiKeepTimer = null; }
          setVisible(true);
          scheduleStageMissingScan();
        }); // 失效检查延后到首屏可操作后，绝不阻塞呼出。
        await register("hotkey-hide", () => {
          cancelStageMissingScan();
          endClipDrag();
          if (stageReorderRef.current.active) {
            cancelStageReorder();
            setStageReorderActiveNative(false);
          }
          dragOutRef.current.pressing = false;
          dragOutRef.current.mode = "idle";
          setVisible(false);
          if (launchCloneNodeRef.current) {
            launchCloneNodeRef.current.remove();
            launchCloneNodeRef.current = null;
          }
          setDismissing(false);
          launchingRef.current = false;
          if (launchSrcElRef.current) {
            launchSrcElRef.current.style.opacity = "";
            launchSrcElRef.current = null;
          }
          setLassoState({ active: false, origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } });
          lassoArmedRef.current = false;
          dropAreaRef.current?.classList.remove("lasso-active");
          setCtxMenu(null);
          if (toastTimerRef.current !== null) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
          }
          setToast(null);

          // 搜索现场例外：带着搜索现场隐藏时不立即复位，保留 SEARCH_KEEP_MS 供多次呼出继续浏览。
          const resetPlan = resolveHideResetPlan({
            pageSearchActive: !!searchValueRef.current,
            enhancedSearchOpen: enhOpenRef.current,
          });
          if (searchKeepTimer !== null) {
            clearTimeout(searchKeepTimer);
            searchKeepTimer = null;
          }
          if (resetPlan.search === "delayed") {
            searchKeepTimer = setTimeout(() => {
              searchKeepTimer = null;
              resetSearchState();
            }, SEARCH_KEEP_MS);
          } else {
            resetSearchState();
          }

          if (uiKeepTimer !== null) clearTimeout(uiKeepTimer);
          if (resetPlan.retainedUi === "delayed") {
            uiKeepTimer = setTimeout(() => {
              uiKeepTimer = null;
              resetRetainedUiState();
            }, SEARCH_KEEP_MS);
          } else {
            resetRetainedUiState();
          }
        }); // 复位（续88：任何窗口隐藏都兜底清一次区内重排残留状态，防 ghost 卡死；菜单/toast 同样立即清）
        // 性能优化步骤2：image 条目 content 已不入前端 state，无法再按 content 做乐观去重。
        // 改为回拉 Rust 权威历史（get_clipboard_history 已剥图片 content、且 Rust 侧已按 ahash 去重 R24）。
        // 事件仅在真实外部复制时触发（自写回流被 R21 抑制），此处一次 IPC 开销可忽略。
        await register("clipboard-update", passiveEventHandlers.onClipboardUpdate);
        // 原生拖入（S3b）：落点在启动器区→入启动器，否则→入中转（兜底）；落地区域闪烁确认。
        // pt 是 Windows 屏幕物理像素，÷ devicePixelRatio 转 CSS px 后与 getBoundingClientRect 比对。
        await register("files-dropped", async (event: any) => {
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
                  newItem = { id: createLauncherId(), kind: "app", name: lnk.name, icon: lnk.icon, path: lnk.path };
                } else {
                  const f = await invoke<FileEntry>("get_file_info", { path: p });
                  newItem = { id: createLauncherId(), kind: f.isDir ? "folder" : "file", name: f.name, path: f.path, ext: f.ext, icon: f.icon ?? null };
                }
                next = [...next, newItem];
              } catch (error) {
                console.warn(`[events] files-dropped 加入启动台失败：${p}`, error);
              }
            }
            next = next.slice(0, LAUNCHER_MAX);
            setLauncher(next);
            await persistLauncher(next); // 续146b：改道唯一出口（脱水后落盘）
            launcherDropRef.current?.classList.add("drop-flash");
            setTimeout(() => launcherDropRef.current?.classList.remove("drop-flash"), 200);
          } else {
            // 落点在中转区或区域外（兜底）：转 StageItem 入中转（原有行为）
            const built: StageItem[] = [];
            for (const p of paths) {
              try {
                built.push(fileEntryToStage(await invoke<FileEntry>("get_file_info", { path: p })));
              } catch (error) {
                console.warn(`[events] files-dropped 加入中转站失败：${p}`, error);
              }
            }
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
        await register<number>("file-index-ready", event => passiveEventHandlers.onFileIndexReady(event.payload));
        // 应用扫描就绪（S4c）：后台预扫线程扫完一次性推送 apps，呼出前填充、消除首次卡顿
        await register<AppInfo[]>("apps-ready", event => passiveEventHandlers.onAppsReady(event.payload));
        // 外部文件拖入悬停高亮（S5a）：Rust DragEnter/DragLeave emit，前端 100ms 防抖过滤 HWND 间快速 leave-enter
        await register("file-drag-enter", () => {
          if (fileDragLeaveTimer) { clearTimeout(fileDragLeaveTimer); fileDragLeaveTimer = null; }
          setFileDragOver(true);
        });
        await register("file-drag-leave", () => {
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
        await register<string>("drag-out-done", async (event) => {
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
        await register("stage-drag-hotkey", () => {
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
        await register("clip-drag-hotkey", () => {
          const ds = clipDragRef.current;
          if (!ds?.active) return; // 未激活（理论上 monitor 不会在此发）——保险起见忽略
          console.log("[clip-drag] hotkey during drag → 升级为原生拖出 + 隐藏", ds.item.type); // 续110 诊断
          beginClipDragOut(ds.item);
        });
        // D2：Rust 在粘贴/复制/拖出消费时首次发现原图不可用，持久标记后同步当前卡片。
        // badge 是主提示；toast 只在界面仍可见的首次消费降级时补一句，避免粘贴已隐藏后留下幽灵提示。
        await register<ClipboardOriginalDegradedPayload>("clipboard-original-degraded", event => passiveEventHandlers.onClipboardOriginalDegraded(event.payload));
    });
    return () => { eventScope.dispose(); if (fileDragLeaveTimer) clearTimeout(fileDragLeaveTimer); if (searchKeepTimer) clearTimeout(searchKeepTimer); if (uiKeepTimer) clearTimeout(uiKeepTimer); };
  }, []);

  // ── 窗口显示时从后台缓存加载剪贴板历史（毫秒级）──
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const history = await clipboardApi.getHistory();
        if (history.length) {
          setClipboard(normalizeClipboardHistory(history));
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

  // ── 内置统一搜索的动态投影同步 ──────────────────────────────────────────────
  // 只在源列表/使用记录变化时发送轻量 name/key/path；逐键查询不重复传整批对象，更不传图标或正文。
  // revision 由 Rust 一并校验，防异步 invoke 乱序时旧列表反盖新列表。
  useEffect(() => {
    const revision = ++searchItemsSyncRef.current;
    const nowS = Math.floor(Date.now() / 1000);
    const items = [
      ...apps.map(app => ({
        kind: "app", key: app.path, name: app.name, path: app.path,
        ext: "", isDir: false, boost: searchUsageBoost(appUsage[app.path], nowS),
        keywords: ["应用", "app", "application"],
      })),
      ...stage.filter(item => item.type === "file").map(item => ({
        kind: "stage", key: String(item.id), name: stageDisplayName(item, t),
        path: item.items?.[0]?.path ?? "", ext: item.ext ?? item.items?.[0]?.ext ?? "",
        isDir: !!item.isDir, boost: item.pinned ? 100 : 0,
        keywords: item.isDir
          ? ["文件夹", "folder", "dir"]
          : typeKeywords({ type: "file", ext: item.ext ?? item.items?.[0]?.ext, isImage: item.items?.[0]?.isImage }),
      })),
      ...clipboard.map(item => ({
        kind: "clip", key: String(item.time), name: clipDisplayName(item, t),
        path: item.items?.[0]?.path ?? "", ext: item.items?.[0]?.ext ?? "",
        isDir: false, boost: 0,
        keywords: typeKeywords({ type: item.type, ext: item.items?.[0]?.ext, isImage: item.items?.[0]?.isImage }),
      })),
    ];
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const applied = await invoke<number>("set_search_items", { revision, items });
        if (revision === searchItemsSyncRef.current) setSearchItemsRevision(applied);
      } catch (e) {
        console.warn("[search] 动态搜索投影同步失败：", e);
      }
    })();
  }, [apps, stage, clipboard, appUsage, t]);

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

  const builtinEnhResults = useMemo<EnhResult[]>(() => {
    if (searchEngine !== "builtin" || !enhQuery.trim()) return [];
    const appByKey = new Map(apps.map(app => [app.path, app]));
    const stageByKey = new Map(stage.map(item => [String(item.id), item]));
    const clipByKey = new Map(clipboard.map(item => [String(item.time), item]));
    const out: EnhResult[] = [];
    for (const hit of builtinHits) {
      if (hit.kind === "fs") {
        out.push({ kind: "fs", path: hit.path, name: hit.name, ext: hit.ext, isDir: hit.isDir, icon: hit.icon, iconKey: hit.iconKey });
        continue;
      }
      if (hit.kind === "app") {
        const app = appByKey.get(hit.key); if (!app) continue;
        out.push({ kind: "app", app, ranges: matchName(enhQuery, app.name, pinyin).ranges });
      } else if (hit.kind === "stage") {
        const item = stageByKey.get(hit.key); if (!item) continue;
        const name = stageDisplayName(item, t);
        out.push({ kind: "stage", item, name, ranges: matchName(enhQuery, name, pinyin).ranges });
      } else {
        const item = clipByKey.get(hit.key); if (!item) continue;
        const name = clipDisplayName(item, t);
        out.push({ kind: "clip", item, name, ranges: matchName(enhQuery, name, pinyin).ranges });
      }
    }
    return out;
  }, [searchEngine, enhQuery, builtinHits, apps, stage, clipboard, pinyin, t]);

  // 增强搜索/设置打开或引擎切换时主动查一次状态（含 Everything 可用性；事件 file-index-ready 之外的兜底）
  useEffect(() => {
    if (!enhOpen && !settingsOpen) return;
    (async () => { try { const { invoke } = await import("@tauri-apps/api/core"); const s = await invoke<{ ready: boolean; count: number; everythingAvailable: boolean }>("get_index_status"); setIndexReady(s.ready); setEverythingAvailable(!!s.everythingAvailable); } catch {} })();
  }, [enhOpen, settingsOpen, searchEngine]);

  // 启动器键盘选中：滚入视野；关闭覆盖层 / 搜索过滤态变化时复位到「未选中」（焦点回搜索框）
  useEffect(() => {
    if (launcherSelIdx >= 0) document.querySelector(".app-tile.selected")?.scrollIntoView({ block: "nearest" });
  }, [launcherSelIdx]);
  useEffect(() => { setLauncherSelIdx(-1); }, [visible, search]);

  // ── 增强搜索结果分段（续114b）──
  // 结构：先建 sections，再由它**派生**扁平数组与段边界；渲染/导航都读派生值，段的增删不用改它们。
  //
  // 内置模式的非空查询已经由 Rust 跨来源统一排序。按类别恢复段落时，段序取该类首次出现的
  // 全局名次、段内保持原顺序，确保最佳匹配仍在第 1 项，同时让 Ctrl+↑↓ 有真实段首可跳。
  // Everything 仍沿用旧的 Tier1 + 文件分段，因为其候选语法和相关性来自外部引擎。
  const enhSections = useMemo<{ key: string; label: string; items: EnhResult[] }[]>(() => {
    if (searchEngine === "builtin" && enhQuery.trim()) {
      const labels: Record<string, string> = {
        "t1-app": t("应用程序"), "t1-stage": t("中转站"), "t1-clip": t("剪贴板"),
        "fs-folder": t("文件夹"), "fs-image": t("图片"), "fs-archive": t("压缩包"),
        "fs-doc": t("文档"), "fs-code": t("代码"), "fs-media": t("媒体"),
        "fs-exe": t("可执行文件"), "fs-other": t("其他文件"),
      };
      return groupRanked(builtinEnhResults, r => r.kind === "fs" ? `fs-${fileGroup(r.ext, r.isDir)}` : `t1-${r.kind}`)
        .map(({ group, items }) => ({ key: `builtin-${group}`, label: labels[group] ?? t("最佳匹配"), items }));
    }
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
  }, [searchEngine, enhQuery, builtinEnhResults, enhTier1, fsResults, t]);

  // 扁平结果：↑↓/Enter/激活全部照旧读它，分段对这些路径完全透明
  const enhResults = useMemo<EnhResult[]>(() => enhSections.flatMap(s => s.items), [enhSections]);
  const {
    selectedIndex: enhSelIdx,
    setSelectedIndex: setEnhSelIdx,
    selectByKeyboard,
    onRowEnter: onEnhRowEnter,
    cancelPendingHover: cancelHoverSelect,
    trackPointer: trackEnhResultsPointer,
  } = useEnhancedSearchSelection(enhOpen, enhResults);
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

  // Async metadata, image caches and the synchronous preview view model share one feature controller.
  const enhPreview = useEnhancedSearchPreview({
    open: enhOpen,
    results: enhResults,
    selectedIndex: enhSelIdx,
    stageThumbnails: stageThumbs,
    clipboardThumbnails: clipThumbs,
    t,
  });
  // ── 启动器「添加应用」picker 结果：排除已加入的 app，空查询=常用前 50，有查询=fuzzyScore 排序 ──
  const pickerResults = useMemo<{ app: AppInfo; ranges: [number, number][] }[]>(() => {
    const q = pickerQuery.trim();
    const base = sortedApps.filter(a => !launcher.some(x => x.kind === "app" && x.path === a.path)); // 排除已加入
    if (!q) return base.slice(0, 50).map(app => ({ app, ranges: [] as [number, number][] }));
    return base.map(app => { const r = fuzzyScore(q, app.name); return { app, score: r.score, ranges: r.ranges }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 50).map(({ app, ranges }) => ({ app, ranges }));
  }, [pickerQuery, sortedApps, launcher]);

  // ── 顶栏普通搜索：三区联动过滤（与 Ctrl+K 增强搜索的 enhQuery 完全独立）──
  // 性能优化步骤4a：三区过滤用 `deferredSearch`（React 18 useDeferredValue），输入框仍绑即时 `search`
  // → 敲键先让输入框回显下一字符（高优先级），启动台/中转/剪贴板三列表的重过滤+重渲被延后且**可打断**，
  // 消除「每键同步重建整棵列表」的输入掉帧。控制逻辑（键盘导航/enh 同步）仍读即时 `search`，deferred
  // 只喂视觉列表；两者相差至多一两帧内收敛，打字停下即一致，不影响回车/方向键选中。
  const deferredSearch = useDeferredValue(search);
  // 中转区：名称/内容优先 + 类型词叠加；空查询=全量
  const filteredStage = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return stage;
    return stage.filter(s => {
      const name = s.type === "text" ? (s.content || "") : s.type === "image" ? "图片" : (s.name || s.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: s.type, ext: s.ext ?? s.items?.[0]?.ext, isImage: s.items?.[0]?.isImage }));
    });
  }, [stage, deferredSearch]);
  // 中转区失踪扫描是低优先级任务：呼出后才延迟启动；按小批次检查并让出执行机会。
  // 预算耗尽时不清空未检查路径的旧状态，避免“尚未检查”被误标；下一次呼出再继续。
  const scanStageMissing = useCallback(async (generationOrInitial: number | StageItem[]) => {
    const initialList = Array.isArray(generationOrInitial) ? generationOrInitial : null;
    const generation = initialList ? stageMissingScanGenerationRef.current : generationOrInitial;
    // 初始载入也不抢首屏：延后后沿用同一批次/预算策略；若期间已呼出新一轮则直接作废。
    if (initialList) await new Promise<void>(resolve => window.setTimeout(resolve, STAGE_MISSING_SCAN_DELAY_MS));
    if (generation !== stageMissingScanGenerationRef.current) return;
    const paths = Array.from(new Set(
      (initialList ?? stageRef.current).flatMap(s => s.type === "file" ? (s.items?.map(i => i.path).filter(Boolean) ?? []) : [])
    )) as string[];
    if (!paths.length) {
      if (generation === stageMissingScanGenerationRef.current) setMissingPaths(new Set());
      return;
    }
    const checked = new Set<string>();
    const missing = new Set<string>();
    const deadline = performance.now() + STAGE_MISSING_SCAN_BUDGET_MS;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      for (let offset = 0; offset < paths.length && performance.now() < deadline; offset += STAGE_MISSING_SCAN_BATCH_SIZE) {
        if (generation !== stageMissingScanGenerationRef.current) return;
        const batch = paths.slice(offset, offset + STAGE_MISSING_SCAN_BATCH_SIZE);
        const gone = await invoke<string[]>("check_stage_paths", { paths: batch });
        if (generation !== stageMissingScanGenerationRef.current) return;
        batch.forEach(path => checked.add(path));
        gone.forEach(path => missing.add(path));
        if (performance.now() < deadline && offset + STAGE_MISSING_SCAN_BATCH_SIZE < paths.length) {
          await new Promise<void>(resolve => window.setTimeout(resolve, STAGE_MISSING_SCAN_YIELD_MS));
        }
      }
      if (generation !== stageMissingScanGenerationRef.current) return;
      // 只覆写本轮已经确认过的路径；预算外路径保持上次确认状态。
      setMissingPaths(prev => {
        const next = new Set(prev);
        checked.forEach(path => next.delete(path));
        missing.forEach(path => next.add(path));
        return next;
      });
    } catch { /* 当前批检查失败：保持上次状态，下次呼出重试 */ }
  }, []);
  const cancelStageMissingScan = useCallback(() => {
    stageMissingScanGenerationRef.current += 1;
    if (stageMissingScanTimerRef.current !== null) {
      window.clearTimeout(stageMissingScanTimerRef.current);
      stageMissingScanTimerRef.current = null;
    }
  }, []);
  const scheduleStageMissingScan = useCallback(() => {
    cancelStageMissingScan();
    const generation = stageMissingScanGenerationRef.current;
    stageMissingScanTimerRef.current = window.setTimeout(() => {
      stageMissingScanTimerRef.current = null;
      void scanStageMissing(generation);
    }, STAGE_MISSING_SCAN_DELAY_MS);
  }, [cancelStageMissingScan, scanStageMissing]);
  useEffect(() => () => cancelStageMissingScan(), [cancelStageMissingScan]);
  // 多文件条目的语义尚未定型；只要其中任一路径失效，先整体视为不可消费，避免擅自定义“部分取走”。
  const missingIds = useMemo(() => {
    const s = new Set<number>();
    for (const it of stage) {
      if (it.type !== "file" || !it.items?.length) continue;
      if (it.items.some(f => missingPaths.has(f.path))) s.add(it.id);
    }
    return s;
  }, [stage, missingPaths]);
  const missingStageItems = useMemo(() => stage.filter(s => missingIds.has(s.id)), [stage, missingIds]);
  const missingIdsRef = useRef<Set<number>>(new Set()); missingIdsRef.current = missingIds; // 给 []-注册的拖出/点击 handler 读最新失踪集
  const cleanupMissingStage = useCallback(() => {
    if (!missingPaths.size) return;
    saveStage(stageRef.current.filter(it => !missingIdsRef.current.has(it.id)));
    setMissingPaths(new Set());
  }, [missingPaths, saveStage]);
  // 剪贴板历史：同上
  const filteredClip = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return clipboard;
    return clipboard.filter(c => {
      const name = c.type === "text" ? (c.content || "") : c.type === "image" ? "图片" : (c.items?.[0]?.name || "文件");
      return matchItem(q, name, typeKeywords({ type: c.type, ext: c.items?.[0]?.ext, isImage: c.items?.[0]?.isImage }));
    });
  }, [clipboard, deferredSearch]);
  // 启动器过滤：有 search 时按名称模糊过滤，无 search 直接返回原列表（持久化/拖入/picker 行为不受影响）
  const filteredLauncher = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return launcher;
    return launcher.filter(it => matchItem(q, it.name, []));
  }, [launcher, deferredSearch]);

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
    // 点击照常打开；后台只检查这一个真实路径并更新标记。UWP shell 路径不是文件系统路径，跳过。
    if (!it.path.startsWith("shell:AppsFolder\\")) {
      const token = (launcherMissingScanTokenRef.current.get(it.id) ?? 0) + 1;
      launcherMissingScanTokenRef.current.set(it.id, token);
      import("@tauri-apps/api/core").then(({ invoke }) => invoke<string[]>("check_stage_paths", { paths: [it.path] }))
        .then(missing => {
          if (launcherMissingScanTokenRef.current.get(it.id) !== token) return;
          setMissingLauncherIds(prev => {
            const next = new Set(prev);
            if (missing.includes(it.path)) next.add(it.id); else next.delete(it.id);
            return next;
          });
        })
        .catch(() => {}); // 检查失败不影响打开，也不改旧标记。
    }
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
  const showToast = useCallback((msg:string) => showToastRef.current(msg), []);

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
    saveLauncher([...launcher, { id:createLauncherId(), kind:"app" as const, name:app.name, icon:app.icon, path:app.path }].slice(0,LAUNCHER_MAX));
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
    saveLauncher([...launcher, {id:createLauncherId(), kind:r.isDir?"folder" as const:"file" as const, name:r.name, icon, path:r.path, ext:r.ext}].slice(0,LAUNCHER_MAX));
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

  // ── 启动台批量管理：选择、删除、导入 / 导出 ──
  // 管理态独立于主网格，避免把「单击打开 / 拖拽排序」的既有肌肉记忆改成多选。
  const openLauncherManager = useCallback(() => {
    setLauncherManageSelected(new Set());
    setLauncherImportPreview(null);
    // 管理弹窗是独立页面层，不应在其后保留设置模态；关闭管理后直接回主界面。
    setSettingsOpen(false);
    setLauncherManageOpen(true);
  }, []);
  const openLauncherPicker = useCallback(() => {
    setPickerQuery("");
    setPickerOpen(true);
  }, []);
  const toggleLauncherManageItem = useCallback((id: number) => {
    setLauncherManageSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleLauncherManageAll = useCallback(() => {
    setLauncherManageSelected(prev => prev.size === launcher.length ? new Set() : new Set(launcher.map(it => it.id)));
  }, [launcher]);
  const deleteSelectedLauncherItems = useCallback(async () => {
    if (!launcherManageSelected.size) return;
    const selected = launcherManageSelected;
    await saveLauncher(launcher.filter(it => !selected.has(it.id)));
    setLauncherManageSelected(new Set());
  }, [launcher, launcherManageSelected, saveLauncher]);
  const exportLauncherLayout = useCallback(async () => {
    if (!launcher.length || launcherLayoutBusy) return;
    setLauncherLayoutBusy(true);
    try {
      // 复用已验证的原生文件夹对话框；用户明确选定目录后才向外写出导出文件。
      const { invoke } = await import("@tauri-apps/api/core");
      const dir = await invoke<string | null>("pick_folder");
      if (!dir) return;
      const doc = buildLauncherLayoutExport(launcher);
      const path = await invoke<string>("write_launcher_layout_export", { dir, content: JSON.stringify(doc, null, 2) });
      showToast(t("已导出到：{path}", { path }));
    } catch {
      showToast(t("导出失败"));
    } finally {
      setLauncherLayoutBusy(false);
    }
  }, [launcher, launcherLayoutBusy, showToast, t]);
  const chooseLauncherLayoutImport = useCallback(async () => {
    if (launcherLayoutBusy) return;
    setLauncherLayoutBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>("pick_file");
      if (!path) return;
      const text = await invoke<string>("read_launcher_layout_import", { path });
      setLauncherImportPreview(previewLauncherImport(text, launcher));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      showToast(t(msg));
    } finally {
      setLauncherLayoutBusy(false);
    }
  }, [launcher, launcherLayoutBusy, showToast, t]);
  const confirmLauncherLayoutImport = useCallback(async () => {
    if (!launcherImportPreview?.items.length) return;
    await saveLauncher([...launcher, ...launcherImportPreview.items]);
    setLauncherManageSelected(new Set());
    setLauncherImportPreview(null);
    showToast(t("已导入 {n} 项", { n: launcherImportPreview.items.length }));
  }, [launcher, launcherImportPreview, saveLauncher, showToast, t]);
  // 从启动器移除（右键）
  const removeLauncherItem = useCallback((id:number) => { saveLauncher(launcher.filter(x=>x.id!==id)); }, [launcher, saveLauncher]);

  const removeStage = useCallback((id:number) => { saveStage(stage.filter(s=>s.id!==id)); }, [stage,saveStage]);
  // ── 中转站失效条目的恢复操作 ──
  const openStageRecovery = useCallback(() => {
    setSettingsOpen(false);
    setStageRecoveryOpen(true);
  }, []);
  // 单文件条目可直接替换引用。多文件条目的语义尚未定型，先保留原状等待用户决定。
  const relinkStageItem = useCallback(async (item: StageItem) => {
    if (item.type !== "file" || item.items?.length !== 1 || !item.items[0] || !missingPathsRef.current.has(item.items[0].path)) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>(item.isDir ? "pick_folder" : "pick_file");
      if (!path) return;
      const info = await invoke<FileEntry>("get_file_info", { path });
      const replacement: FileItem = { path: info.path, name: info.name, ext: info.ext, isImage: IMG_EXTS.includes(info.ext.toLowerCase()), icon: info.icon ?? null };
      const next = stageRef.current.map(s => s.id === item.id
        ? { ...s, items: [replacement], count: 1, name: info.name, ext: info.ext, isDir: info.isDir, size: info.size }
        : s);
      await saveStage(next);
      setMissingPaths(prev => { const copy = new Set(prev); copy.delete(item.items![0].path); return copy; });
      showToast(t("已重新定位：{name}", { name: info.name }));
    } catch {
      showToast(t("重新定位失败"));
    }
  }, [saveStage, showToast, t]);
  const copyMissingStagePath = useCallback(async (path: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("copy_text_to_clipboard", { text: path });
      showToast(t("已复制原路径"));
    } catch { showToast(t("复制失败")); }
  }, [showToast, t]);
  // 剪贴板项「加入中转站」：同类型同内容已在则不重复；新项置顶；单文件异步补全 Windows 图标
  const addToStage = useCallback(async (c:ClipItem) => {
    c = { ...c, content: await hydrateContent(c) }; // 剪贴板图片按 time 现取，仅在本次动作局部变量中短驻
    let contentFile: string | undefined;
    if (c.type==="image" && c.content) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        contentFile = (await invoke<(string|null)[]>("save_stage_images", { images:[c.content] }))[0] ?? undefined;
      } catch {}
    }
    let exists = stage.some(s => s.type===c.type && (c.type==="file"
      ? s.items?.[0]?.path===c.items?.[0]?.path
      : c.type==="image"
        ? s.content===c.content || (!!contentFile && (s.contentFile===contentFile || getStageContentFile(s.id)===contentFile))
        : s.content===c.content));
    // 极端降级：stage_images 写入失败时没有内容寻址文件名可比，才逐条按需读取既有图片。
    if (!exists && c.type==="image" && !contentFile) {
      for (const s of stage) {
        if (s.type==="image" && await hydrateContent(s) === c.content) { exists = true; break; }
      }
    }
    // 续146c：原先重复项**静默 return**，用户看到的就是「拖过去没反应」，无从分辨是重复还是坏了。
    if (exists) {
      const nm = c.type==="text" ? (c.content||"").trim().slice(0,20) : c.type==="image" ? t("图片") : (c.items?.[0]?.name || t("文件"));
      showToast(t("已在{where}中：{name}", { where: t("中转站"), name: nm })); // 复用既有词条，不新增 key
      return;
    }
    let item = clipToStage(c);
    if (contentFile) {
      const { content:_omit, ...rest } = item;
      item = { ...rest, contentFile };
      rememberStageContentFile(item.id, contentFile);
    }
    if (c.type==="file" && (c.count??0)<=1 && c.items?.[0]?.path && item.items?.[0]) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<FileEntry>("get_file_info", { path: c.items[0].path });
        if (info.icon) item = { ...item, items: [{ ...item.items![0], icon: info.icon }] };
      } catch {}
    }
    saveStage([item, ...stage].slice(0,stageMax));
  }, [stage,saveStage,stageMax,showToast,t,getStageContentFile,rememberStageContentFile]);
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
  // 条目上按下→拖动超阈值：自动关闭开启时直接进入原生 OLE 拖出并隐藏；关闭时单项进入区内重排
  // （FLIP，仿启动台），需要外部投放再按热键，经 stage-drag-hotkey 升级为原生 OLE 拖出。
  // 两种原生路径都由 Rust 侧主线程跑 DoDragDrop、建立 capture 后再按模式隐藏 overlay。
  // 与框选互斥：down 在条目上时 .drop-area 的 lasso 不布防（closest 排除）；与左键取走互斥：未超阈值=普通点击。
  // 区内重排仅限单项拖动（多选拖多项 / 搜索过滤态 索引对不上）：两种情形直接走原生拖出，行为与重排功能加入前一致。
  // 续88 bug 修复：重排阶段窗口全程可见、尚未进入 Rust 的 DRAG_IN_PROGRESS——必须另行告知 Rust 侧
  // light-dismiss/热键 monitor 在此期间也让路，否则前台瞬时切换会被判定为"点了外部应用"提前 hide()，
  // 打断整个手势（ghost 卡死 + 从未真正调用 start_drag_out，"拖到外部目标"根本没发生）。
  const setStageReorderActiveNative = useCallback((active: boolean) => {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_stage_reorder_active", { active })).catch(() => {});
  }, []);
  // forceHide=true：由"区内重排中按热键"升级而来——Rust 侧无视 keepOpen 设置强制隐藏 overlay（用户已明确要隐藏
  // 去外部投放）。自动关闭开启时的直接原生拖出传 false，由 Rust 读取当前设置决定起手隐藏。
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
      content_file: s.contentFile ?? null,
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
        path = await invoke<string>("save_image_as_launcher_file", { base64: item.content ?? null, origPath: item.orig_path ?? null, contentFile:item.contentFile ?? null });
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
      if (dragoutAutoClose || ids.length > 1 || search.trim() || ids[0] !== itemId) { // 自动关闭开启时，任一有效拖动都直接进入原生拖出并由 Rust 隐藏；关闭时单项仍可区内重排。多项 / 搜索过滤态 / 按下项被失踪过滤掉也直接原生拖出。
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
      // 只有自动关闭关闭时才会进入此分支。单项重排不会因光标越出边界自动升级——光标可拖到
      // overlay 任意处，ghost 全程跟手。去外部仍由「拖动中按热键 → stage-drag-hotkey」显式升级。
      // 已删旧的「越界即升级」逻辑
      // （原按 .drop-area 边界 + STAGE_REORDER_ESCAPE_PX 判定）：不小心蹭出边界再拖回会被误判成拖去外部而中止重排。
      updateStageReorder(e.clientX, e.clientY);
    }
  }, [dragoutAutoClose, search, beginNativeDragOut, startStageReorder, updateStageReorder, cancelStageReorder, computeLassoSelection, snapshotLassoRects]);
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
    setClipboard(normalizeClipboardHistory(await clipboardApi.getHistory()));
  }, []);
  const openStageThumbnailDirectory = useCallback(() => {
    cacheApi.openStageThumbnailDirectory().catch(() => {});
  }, []);
  const clearStageThumbnailCache = useCallback(async () => {
    try {
      await cacheApi.clearStageThumbnailCache();
      setThumbCacheCleared(true);
      setTimeout(() => setThumbCacheCleared(false), 1500);
    } catch {}
  }, []);
  const openClipboardImageDirectory = useCallback(() => {
    cacheApi.openClipboardImageDirectory().catch(() => {});
  }, []);
  const clearClipboardImageCache = useCallback(async () => {
    try {
      await cacheApi.clearClipboardImageCache();
      await refreshClipboard();
      setImgCacheCleared(true);
      setTimeout(() => setImgCacheCleared(false), 1500);
    } catch {}
  }, [refreshClipboard]);
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
      setClipboard(normalizeClipboardHistory(await clipboardApi.getHistory()));
    } catch {}
  }, [store]);
  const copyAndPaste = useCallback((item:Pasteable) => { // 剪贴板历史 + 中转条目共用：取走（写回剪贴板+焦点交还+Ctrl+V）
    if (launchingRef.current) return; // 与启动共用锁：动画进行中忽略
    // 实际粘贴：hide+交还焦点+Ctrl+V 全在 Rust 命令内（流程不变），此处仅负责调用
    const doPaste = async () => {
      const {invoke}=await import("@tauri-apps/api/core");
      if (item.type === "text") { try { await invoke("paste_clipboard",{text:item.content}); } catch{ await hideWorkbench(); } }
      else if (item.type === "file" && item.items) { try { await invoke("set_clipboard_files",{paths:item.items.map(f=>f.path)}); } catch{ await hideWorkbench(); } }
      else { try { await invoke("set_clipboard_image",{base64:(await hydrateContent(item)) ?? "",origPath:item.orig_path??null,time:item.time??null}); } catch{ await hideWorkbench(); } } // 步骤2：图片 content 现取
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
  const activateClipboardItem = useCallback((item: ClipItem) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    copyAndPaste(item);
  }, [copyAndPaste]);
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
    if (s.type === "file" && missingIdsRef.current.has(s.id)) return;
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
    if (!stageMultiselect) {
      if (missingIdsRef.current.has(s.id)) return; // 含失效路径的条目只留恢复/清理动作，不把不完整引用送进粘贴链。
      copyAndPaste(s);
      return;
    }
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
      const allFiles = sel.length > 0 && sel.every(x => x.type === "file" && !missingIds.has(x.id));
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
    const missingFile = missingIds.has(s.id) && s.type === "file" ? s.items?.find(f => missingPaths.has(f.path)) : undefined;
    if (missingFile) {
      if (s.items?.length === 1) items.push({ label: t("重新定位…"), action: () => relinkStageItem(s) });
      items.push({ label: t("复制原路径"), action: () => copyMissingStagePath(missingFile.path) });
    } else if (s.type === "file" && s.items?.[0]?.path) {
      items.push({
        label: t("打开所在目录"),
        action: async () => {
          hideWorkbench(); // 先隐藏全屏毛玻璃覆盖层，避免 explorer 在其下冷起时 backdrop-filter 抢 GPU 卡顿
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("reveal_in_explorer", { path: s.items![0].path });
        },
      });
      items.push({ label: t("复制到剪贴板"), action: () => copyStageToClipboard(s) });
    } else {
      items.push({ label: t("复制到剪贴板"), action: () => copyStageToClipboard(s) });
    }
    items.push({ label: t("删除该项目"),   action: () => removeStage(s.id) });
    openCtxMenu(e, items);
  }, [stageMultiselect, stageSel, stage, missingPaths, missingIds, openCtxMenu, copyAndPaste, saveStage, copyStageToClipboard, removeStage, relinkStageItem, copyMissingStagePath, t]);
  const stageItemActions = useMemo<StageItemActions>(() => ({
    activate: handleStageClick,
    openContextMenu: openStageCtxMenu,
    togglePin: toggleStagePin,
    copy: copyStageToClipboard,
    remove: removeStage,
    open: openStageFile,
  }), [handleStageClick, openStageCtxMenu, toggleStagePin, copyStageToClipboard, removeStage, openStageFile]);
  const stageItemPointer = useMemo<StageItemPointerHandlers>(() => ({
    pointerDown: handleStagePointerDown,
    pointerMove: handleStagePointerMove,
    pointerUp: handleStagePointerUp,
    lostPointerCapture: handleStageLostPointerCapture,
  }), [handleStagePointerDown, handleStagePointerMove, handleStagePointerUp, handleStageLostPointerCapture]);

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
    items.push({ label: t("加入中转站"),  action: () => addToStage(c) });
    items.push({ label: t("删除该条目"),    action: () => deleteClipItem(c.time) });
    openCtxMenu(e, items);
  }, [openCtxMenu, copyToClipboard, addToStage, deleteClipItem, t]);
  const clipboardPanelActions = useMemo<ClipboardPanelActions>(() => ({
    activate: activateClipboardItem,
    addToStage,
    copy: copyToClipboard,
    delete: deleteClipItem,
    openContextMenu: openClipCtxMenu,
  }), [activateClipboardItem, addToStage, copyToClipboard, deleteClipItem, openClipCtxMenu]);
  const clipboardPanelDrag = useMemo<ClipboardPanelDragHandlers>(() => ({
    pointerDown: handleClipPointerDown,
    pointerMove: handleClipPointerMove,
    pointerUp: handleClipPointerUp,
    pointerCancel: handleClipPointerCancel,
    lostPointerCapture: () => endClipDrag(),
  }), [handleClipPointerDown, handleClipPointerMove, handleClipPointerUp, handleClipPointerCancel, endClipDrag]);

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

  const changeEnhQuery = useCallback((query: string) => {
    setEnhQuery(query);
    setEnhSelIdx(0);
  }, []);
  const addEnhancedPreviewToLauncher = useCallback(async (preview: EnhancedSearchPreview) => {
    const r = preview.r;
    const result = r.kind === "app" ? addAppToLauncher(r.app)
      : await addFsToLauncher(r.kind === "fs"
        ? r
        : { path: preview.path, name: r.kind === "stage" ? r.name : preview.title, ext: r.kind === "stage" ? r.item.ext : undefined, isDir: r.kind === "stage" ? !!r.item.isDir : false });
    toastAddResult(result, "launcher", preview.title);
  }, [addAppToLauncher, addFsToLauncher, toastAddResult]);
  const addEnhancedFileToStage = useCallback(async (result: Extract<EnhResult, { kind: "fs" }>, title: string) => {
    toastAddResult(await addFsToStage(result), "stage", title);
  }, [addFsToStage, toastAddResult]);
  const enhancedSearchActions = useMemo<EnhancedSearchActions>(() => ({
    activate: activateEnh,
    reveal: revealPath,
    addPreviewToLauncher: addEnhancedPreviewToLauncher,
    addFileToStage: addEnhancedFileToStage,
  }), [activateEnh, revealPath, addEnhancedPreviewToLauncher, addEnhancedFileToStage]);

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

  const changePageSearch = useCallback((value: string) => {
    const target = resolveHeaderSearchTarget({
      defaultMode: searchDefaultModeRef.current,
      pageSearchForced: pageSearchForcedRef.current,
      enhancedPinned: enhPinnedRef.current,
    });
    if (target === "enhanced") {
      // 顶栏虽由两种搜索共用，但两套 query 独立；增强模式输入不能污染底层页面筛选。
      setEnhQuery(value);
      setEnhSelIdx(0);
      if (value && !enhOpenRef.current) {
        setEnhOpen(true);
        setEnhPinned(true);
      }
    } else {
      setSearch(value);
    }
  }, []);


  // ── 键盘 ──
  useEffect(() => {
    if (!visible) return;
    const onKey=(e:KeyboardEvent)=>{
      // 右键菜单是纯鼠标浮层（无键盘交互）：任何键盘/热键操作都顺带关掉它，避免切页/关页后残留悬浮。
      // Escape 交由下方分层逻辑处理（第一次 Esc 只关菜单、不关页），故此处排除。
      if(ctxMenuRef.current && e.key!=="Escape") setCtxMenu(null);
      if (e.key === "Escape") {
        e.preventDefault();
        const target = resolveEscapeTarget({
          clipDragActive: !!clipDragRef.current?.active,
          lassoActive: lassoStateRef.current.active,
          contextMenuOpen: !!ctxMenuRef.current,
          enhancedSearchOpen: enhOpenRef.current,
          stageRecoveryOpen: stageRecoveryOpenRef.current,
          launcherManagerOpen: launcherManageOpenRef.current,
          appPickerOpen: pickerOpenRef.current,
          stageSelectionActive: !!stageSelRef.current.size || stageMultiselectRef.current,
          launcherSelectionActive: launcherSelIdx >= 0,
          settingsOpen,
        });
        switch (target) {
          case "clip-drag":
            endClipDrag();
            return;
          case "lasso":
            setLassoState(state => ({ ...state, active: false }));
            dropAreaRef.current?.classList.remove("lasso-active");
            lassoArmedRef.current = false;
            return;
          case "context-menu":
            setCtxMenu(null);
            return;
          case "enhanced-search":
            setEnhOpen(false);
            setEnhPinned(false);
            setEnhQuery("");
            if (searchDefaultModeRef.current === "enhanced") pageSearchForcedRef.current = true;
            searchRef.current?.focus();
            return;
          case "stage-recovery":
            setStageRecoveryOpen(false);
            return;
          case "launcher-manager":
            setLauncherManageOpen(false);
            setLauncherImportPreview(null);
            return;
          case "app-picker":
            setPickerOpen(false);
            setPickerQuery("");
            return;
          case "stage-selection":
            setStageSel(new Set<number>());
            setStageMultiselect(false);
            stageAnchorRef.current = null;
            return;
          case "launcher-selection":
            setLauncherSelIdx(-1);
            searchRef.current?.focus();
            return;
          case "settings":
            setSettingsOpen(false);
            return;
          case "workbench":
            setVisible(false);
            hideWorkbench();
            return;
        }
      }
      // 增强层打开时 Ctrl+↑↓ 是保留导航键，必须先于可自定义的 enhHotkey 匹配。
      // 否则用户把增强热键录成 Ctrl+方向键后，这里会被下方 toggle 分支提前吞掉；捕获阶段注册
      // 也确保顶栏/增强输入框的原生编辑行为无权截断这条应用级导航。
      if(enhOpen && e.ctrlKey && !e.shiftKey && !e.altKey && (e.key==="ArrowDown"||e.key==="ArrowUp")){
        e.preventDefault();
        const st = enhSectionStarts;
        if(e.key==="ArrowDown"){
          const nxt = st.find(s => s > enhSelIdx);
          if(nxt !== undefined) selectByKeyboard(nxt);
        }else{
          const curStart = [...st].reverse().find(s => s <= enhSelIdx) ?? 0;
          if(enhSelIdx > curStart) selectByKeyboard(curStart);
          else { const prv = [...st].reverse().find(s => s < curStart); if(prv !== undefined) selectByKeyboard(prv); }
        }
        return;
      }
      if(matchComboEvent(e, enhHotkey)){
        e.preventDefault();
        const plan = resolveSearchModeToggle({
          enhancedOpen: enhOpen,
          pageQuery: search,
          defaultMode: searchDefaultModeRef.current,
        });
        setEnhOpen(plan.enhancedOpen);
        setEnhPinned(plan.enhancedPinned);
        setEnhQuery(plan.enhancedQuery);
        pageSearchForcedRef.current = plan.pageSearchForced;
        if(plan.enhancedOpen)setEnhSelIdx(0);
        searchRef.current?.focus();
        return;
      }
      // 中和默认 Tab 焦点遍历（防焦点逃逸到模态背后的按钮 / 旧死 filteredApps 导航）。Tab 作为热键已被上面 matchComboEvent 先处理。
      if(e.key==="Tab"){e.preventDefault();return;}
      if(settingsOpen||pickerOpen)return; // 设置 / picker 打开时屏蔽应用导航/启动按键
      if(enhOpen){ // 增强搜索接管导航，屏蔽下面 launcher 键（字母键不拦截，正常输入到 enhInput）
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
    window.addEventListener("keydown",onKey,true);
    return ()=>window.removeEventListener("keydown",onKey,true);
  }, [visible, search, filteredApps, launchApp, settingsOpen, pickerOpen, enhOpen, enhResults, enhSectionStarts, enhSelIdx, activateEnh, enhHotkey, filteredLauncher, launcherSelIdx, openLauncherItem]);

  const headerSearchTarget = resolveHeaderSearchTarget({
    defaultMode: searchDefaultMode,
    pageSearchForced: pageSearchForcedRef.current,
    enhancedPinned: enhPinned,
  });

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}${fileDragOver ? " file-drag-active" : ""}`} onContextMenu={e=>e.preventDefault()}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <WorkbenchSearchHeader search={headerSearchTarget === "enhanced" ? enhQuery : search} searchRef={searchRef} t={t} onSearchChange={changePageSearch}/>
        <div className="top-right">
          <Clock lang={lang}/>
          <button className="settings-btn" onClick={()=>setSettingsOpen(true)} title={t("设置")} aria-label={t("设置")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>
      <main className="main-area">
        <LauncherPanel
          ref={launcherDropRef}
          items={filteredLauncher}
          totalCount={launcher.length}
          search={search}
          selectedIndex={launcherSelIdx}
          missingIds={missingLauncherIds}
          thumbnails={stageThumbs}
          t={t}
          onOpenManager={openLauncherManager}
          onOpenPicker={openLauncherPicker}
          onOpenItem={openLauncherItem}
          onOpenContextMenu={openLauncherCtxMenu}
          onPointerDown={handleLauncherPointerDown}
        />
        <section className="center-panel">
          <div className="stage-section-header">
            <span className="section-label">{t("文件中转区")}</span>
            {stageMultiselect ? (
              <div className="stage-multi-toolbar">
                {stageSel.size > 0 && <span className="stage-sel-count">{t("已选 {n}", {n: stageSel.size})}</span>}
                <button className="stage-batch-btn" disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))?t("取走并粘贴到上个窗口"):t("仅文件可批量取走")}
                  onClick={()=>{const sel=stage.filter(x=>stageSel.has(x.id));copyAndPaste({type:"file",items:sel.flatMap(x=>x.items??[])});setStageSel(new Set());setStageMultiselect(false);}}>{t("取走")}</button>
                <button className={`stage-batch-btn${batchCopied?" copied":""}`} disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))?t("复制到剪贴板"):t("仅文件可批量复制")}
                  onClick={async()=>{const sel=stage.filter(x=>stageSel.has(x.id));await writeItemToClipboard({type:"file",items:sel.flatMap(x=>x.items??[])});setBatchCopied(true);setTimeout(()=>setBatchCopied(false),1000);}}>{t("复制")}</button>
                <button className="stage-batch-btn" disabled={stageSel.size===0}
                  onClick={()=>{saveStage(stage.filter(x=>!stageSel.has(x.id)));setStageSel(new Set());}}>{t("删除")}</button>
                <button className="stage-batch-btn stage-batch-cancel"
                  onClick={()=>{setStageSel(new Set());setStageMultiselect(false);stageAnchorRef.current=null;}}>{t("完成")}</button>
              </div>
            ) : (
              <div className="stage-multi-toolbar">
                {missingStageItems.length > 0 && <button className="stage-batch-btn stage-missing-action" onClick={openStageRecovery} title={t("处理失效条目")}>{t("失效 {n} 项", { n: missingStageItems.length })}</button>}
                <button className="stage-batch-btn" disabled={!stage.length}
                  onClick={()=>setStageMultiselect(true)} title={t("进入多选模式")}>{t("多选")}</button>
              </div>
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
              ? <div className={`stage-grid${stageMultiselect?" stage-multiselect":""}`}>{filteredStage.map((s,idx)=>(
                  <StageGridCard
                    key={s.id}
                    item={s}
                    index={idx}
                    selected={stageSel.has(s.id)}
                    missing={missingIds.has(s.id)}
                    multiselect={stageMultiselect}
                    persistAll={stagePersist}
                    copied={copiedStageId===s.id}
                    imageThumbnail={s.contentFile ? stageThumbs[stageImageThumbKey(s.contentFile)] : undefined}
                    fileThumbnail={s.items?.[0]?.path ? stageThumbs[s.items[0].path] : undefined}
                    t={t}
                    actions={stageItemActions}
                    pointer={stageItemPointer}
                  />
                ))}</div>
              : <div className={`stage-list${stageMultiselect?" stage-multiselect":""}`}>{filteredStage.map((s,idx)=>(
                  <StageListRow
                    key={s.id}
                    item={s}
                    index={idx}
                    selected={stageSel.has(s.id)}
                    missing={missingIds.has(s.id)}
                    multiselect={stageMultiselect}
                    persistAll={stagePersist}
                    copied={copiedStageId===s.id}
                    imageThumbnail={s.contentFile ? stageThumbs[stageImageThumbKey(s.contentFile)] : undefined}
                    fileThumbnail={s.items?.[0]?.path ? stageThumbs[s.items[0].path] : undefined}
                    t={t}
                    actions={stageItemActions}
                    pointer={stageItemPointer}
                  />
                ))}</div>
            ) : search.trim() ? <p className="empty-hint">{t("无匹配")}</p> : (
              <div className="stage-empty-guide" aria-label={t("将文件拖到这里")}>
                <span className="stage-empty-guide-icon"><IconDrop size={26}/></span>
                <span className="stage-empty-guide-title">{t("将文件拖到这里")}</span>
                <span className="stage-empty-guide-subtitle">{t("也可从剪贴板固定到中转区")}</span>
              </div>
            )}
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
        <ClipboardPanel
          items={filteredClip}
          search={search}
          thumbnails={clipThumbs}
          copiedTime={copiedTime}
          t={t}
          actions={clipboardPanelActions}
          drag={clipboardPanelDrag}
        />
      </main>
      {/* ── 增强搜索层（始终挂载，靠 class 切换显隐，沿用 overlay-visible/hidden 模式避免卸载闪烁）── */}
      <EnhancedSearchLayer
        open={enhOpen}
        pinned={enhPinned}
        query={enhQuery}
        inputRef={enhInputRef}
        resultsRef={enhResultsRef}
        rows={enhRows}
        resultCount={enhResults.length}
        sectionCount={enhSections.length}
        searchDefaultMode={searchDefaultMode}
        enhancedHotkeyLabel={comboLabel(enhHotkey)}
        searchEngine={searchEngine}
        everythingAvailable={everythingAvailable}
        indexReady={indexReady}
        preview={enhPreview}
        t={t}
        actions={enhancedSearchActions}
        onQueryChange={changeEnhQuery}
        onResultsMouseMove={trackEnhResultsPointer}
      />
      {/* ── 启动器「添加应用」picker（复用 settings-modal 样式 + enh-result 列表项）── */}
      {pickerOpen && (
        <LauncherPickerDialog
          query={pickerQuery}
          inputRef={pickerInputRef}
          results={pickerResults}
          launcherPicking={launcherPicking}
          t={t}
          onClose={() => { setPickerOpen(false); setPickerQuery(""); }}
          onQueryChange={setPickerQuery}
          onPickPath={pickLauncherPath}
          onAddApp={addAppToLauncher}
        />
      )}
      {/* 失效项不再随扫描静默消失：集中列出并让用户决定重新定位或删除整个条目。 */}
      {stageRecoveryOpen && (
        <StageRecoveryDialog
          items={missingStageItems}
          missingPaths={missingPaths}
          t={t}
          onClose={() => setStageRecoveryOpen(false)}
          onRelink={relinkStageItem}
          onCopyPath={copyMissingStagePath}
          onRemove={removeStage}
        />
      )}
      {/* 启动台批量管理：选择态只存在于此，不干扰主启动台的打开和拖拽排序。 */}
      {launcherManageOpen && (
        <LauncherManagerDialog
          items={launcher}
          selected={launcherManageSelected}
          preview={launcherImportPreview}
          busy={launcherLayoutBusy}
          t={t}
          onClose={() => { setLauncherManageOpen(false); setLauncherImportPreview(null); }}
          onBackFromPreview={() => setLauncherImportPreview(null)}
          onConfirmImport={confirmLauncherLayoutImport}
          onToggleAll={toggleLauncherManageAll}
          onToggleItem={toggleLauncherManageItem}
          onDeleteSelected={deleteSelectedLauncherItems}
          onChooseImport={chooseLauncherLayoutImport}
          onExport={exportLauncherLayout}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          tab={settingsTab}
          version={__APP_VERSION__}
          t={t}
          general={{
            theme,
            lang,
            autostartEnabled,
            onChangeTheme: changeTheme,
            onChangeLang: changeLang,
            onChangeAutostart: changeAutostart,
          }}
          launcher={{
            count: launcher.length,
            onOpenPicker: openLauncherPicker,
            onOpenManager: openLauncherManager,
            onClear: clearLauncher,
          }}
          stage={{
            layout: stageLayout,
            count: stage.length,
            max: stageMax,
            missingCount: missingStageItems.length,
            dragoutAutoClose,
            persist: stagePersist,
            showShortcuts,
            thumbnailCacheCleared: thumbCacheCleared,
            onChangeLayout: changeStageLayout,
            onClear: clearStage,
            onOpenRecovery: openStageRecovery,
            onCleanupMissing: cleanupMissingStage,
            onChangeMax: changeStageMax,
            onChangeDragoutAutoClose: changeDragoutAutoClose,
            onChangePersist: changeStagePersist,
            onChangeShowShortcuts: changeShowShortcuts,
            onOpenThumbnailDirectory: openStageThumbnailDirectory,
            onClearThumbnailCache: clearStageThumbnailCache,
          }}
          clipboard={{
            count: clipboard.length,
            max: clipCacheMax,
            imageCacheCleared: imgCacheCleared,
            onChangeMax: changeClipCacheMax,
            onClear: clearClipboard,
            onOpenImageDirectory: openClipboardImageDirectory,
            onClearImageCache: clearClipboardImageCache,
          }}
          search={{
            defaultMode: searchDefaultMode,
            engine: searchEngine,
            everythingAvailable,
            redetected: evtRedetected,
            dirs: searchDirs,
            dirPicking,
            enhancedHotkeyLabel: comboLabel(enhHotkey),
            onChangeDefaultMode: changeSearchDefaultMode,
            onChangeEngine: changeSearchEngine,
            onRedetectEverything: redetectEverything,
            onPickDir: pickSearchDir,
            onRemoveDir: removeSearchDir,
          }}
          hotkeys={{
            combo: hotkeyCombo,
            input: hotkeyInput,
            error: hotkeyError,
            enhancedCombo: enhHotkey,
            enhancedInput: enhHotkeyInput,
            enhancedError: enhHotkeyError,
            recording,
            onInputChange: setHotkeyInput,
            onEnhancedInputChange: setEnhHotkeyInput,
            onApply: changeHotkey,
            onApplyEnhanced: changeEnhHotkey,
            onToggleRecording: target => {
              if (target === "main") setHotkeyError("");
              else setEnhHotkeyError("");
              setRecording(current => current === target ? null : target);
            },
          }}
          onTabChange={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <WorkbenchFooter
        hotkeyCombo={hotkeyCombo}
        enhancedHotkey={enhHotkey}
        enhancedOpen={enhOpen}
        version={__APP_VERSION__}
        t={t}
      />
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
