import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue, Fragment } from "react";
import "./App.css";
import { makeT, type Lang } from "./i18n";
import { IMG_EXTS, dirOf, fileGlyphFor } from "./lib/format";
import { fuzzyScore, typeKeywords } from "./lib/fuzzy";
import { tokenFromCode, parseComboStr, comboLabel } from "./lib/hotkey";
import LauncherPanel from "./components/LauncherPanel";
import ClipboardPanel, { type ClipboardPanelActions, type ClipboardPanelDragHandlers } from "./components/ClipboardPanel";
import { StageGridCard, StageListRow, type StageItemActions, type StageItemPointerHandlers } from "./components/StageItems";
import EnhancedSearchLayer, { type EnhancedSearchActions, type EnhancedSearchPreview } from "./components/EnhancedSearchLayer";
import { Clock, WorkbenchFooter, WorkbenchSearchHeader } from "./components/WorkbenchChrome";
import HighlightText from "./components/HighlightText";
import SettingsDialog, { type SettingsTab } from "./components/SettingsDialog";
import { LauncherManagerDialog, LauncherPickerDialog, StageRecoveryDialog } from "./components/WorkbenchDialogs";
import { enhancedResultKey as enhKey } from "./domain/enhancedSearch";
import { type ClipboardCategory } from "./domain/clipboardCategory";
import { buildClipboardPageSearch } from "./domain/clipboardPageSearch";
import { appUsageScore } from "./domain/appUsage";
import { createDismissLifecycle, type DismissLifecycle } from "./domain/dismissLifecycle";
import { createLauncherId, LAUNCHER_MAX } from "./domain/launcherLayout";
import { STAGE_MAX_OPTIONS } from "./domain/stageSettings";
import {
  buildNativeDragLabel,
  buildNativeDragMeta,
  nextNativeDragSessionId,
  shouldFinishNativeDragHandoff,
  type NativeDragPreviewStyle,
} from "./domain/dragPreview";
import { matchPageSearch, type TextRange } from "./domain/pageSearchPresentation";
import { useWorkbenchPersistence } from "./hooks/useWorkbenchPersistence";
import { stageImageThumbKey, useThumbnailCaches } from "./hooks/useThumbnailCaches";
import { useEnhancedSearchQuery } from "./hooks/useEnhancedSearchQuery";
import { useEnhancedSearchPreview } from "./hooks/useEnhancedSearchPreview";
import { useEnhancedSearchSelection } from "./hooks/useEnhancedSearchSelection";
import { useEnhancedSearchResults } from "./hooks/useEnhancedSearchResults";
import { useSearchSynchronization } from "./hooks/useSearchSynchronization";
import { useClipboardDragController } from "./hooks/useClipboardDragController";
import { useLauncherActions, type AddResult } from "./hooks/useLauncherActions";
import { useStageInteractionController } from "./hooks/useStageInteractionController";
import { useGlobalKeyboardRouter } from "./hooks/useGlobalKeyboardRouter";
import {
  createIdleStageInteraction,
  insertStageItemAtAnchor,
  insertStageItemsAtAnchor,
  resolveStageInsertSlot,
  stageInsertAnchorForSlot,
  stageInsertMarkerForSlot,
  type LassoRect,
  type StageInsertAnchor,
  type StageInteractionState,
} from "./domain/stageInteraction";
import { resolveWorkbenchFileDropZone } from "./domain/clipboardDrag";
import { hideStageInsertMarker, showStageInsertMarker } from "./lib/stageInsertMarker";
import { createNativeDragGhost, positionNativeDragGhost } from "./lib/nativeDragGhost";
import { perf } from "./lib/perfTrace";
import { cacheApi } from "./platform/cacheApi";
import { clipboardApi } from "./platform/clipboardApi";
import { subscribeNativeEvents } from "./platform/nativeEvents";
import { openWorkbenchStore, runStartupStep, startupNative, type WorkbenchStore } from "./platform/workbenchStartup";
import { createPassiveEventHandlers, normalizeClipboardHistory, type ClipboardOriginalDegradedPayload } from "./shell/passiveEventHandlers";
import { resolveHeaderSearchTarget, resolveHideResetPlan } from "./shell/uiPolicies";
import type {
  AppInfo,
  AppUsage,
  ClipItem,
  EnhResult,
  FileEntry,
  FileItem,
  LauncherItem,
  Pasteable,
  StageItem,
} from "./types";
import { IconCheck, IconSettings, FileGlyph,
         IconCamera, IconExplorer, IconDownload, IconMonitor, IconTerminal, IconCalculator, IconDrop } from "./icons";

// ── 类型 ──
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

type DragPreviewReadyPayload = { session_id?: number; mode: string };


/// 搜索现场（页面搜索/增强搜索）保留时长：隐藏时若仍带着搜索现场则不立即复位，保留此时长供用户
/// 多次呼出继续浏览；每次隐藏重新起算，呼出即取消计时；超时在隐藏中静默复位，下次呼出全新。
const SEARCH_KEEP_MS = 10_000;
// 剪贴板分类仅是临时视图上下文：隐藏后给快速来回切换保留 10 秒，超时回到“全部”。
const CLIPBOARD_CATEGORY_KEEP_MS = 10_000;
/// 续146 起废弃的 store key（功能已删，但 plugin-store 不会自动回收未知 key，会一直躺在 JSON 里）。
/// ⚠ 别把 `file-list` 加进来——它是只写不读的**老格式迁移兜底**，仍在 store 载入路径上用着。
const DEAD_STORE_KEYS = ["standalone-enh-hotkey", "stage-drag-out-enabled", "stage-drag-auto-hide"] as const;
async function hideWorkbench() { try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("hide_window"); } catch{} }

// ── 文件中转：转换 + 写剪贴板助手 ──
const stageId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000); // 稳定唯一 id（key/去重）
function fileEntryToStage(f: FileEntry): StageItem {
  const isImage = IMG_EXTS.includes(f.ext.toLowerCase());
  return { id: stageId(), type: "file", items: [{ path: f.path, name: f.name, ext: f.ext, isImage, icon: f.icon }], count: 1, name: f.name, ext: f.ext, isDir: f.isDir, size: f.size };
}

function snapshotStageInsertRects(container: HTMLDivElement | null, layout: "list" | "grid") {
  if (!container) return [];
  const selector = layout === "grid" ? ".stage-card" : ".stage-item";
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).flatMap<LassoRect>(element => {
    const id = Number(element.dataset.stageId);
    if (Number.isNaN(id)) return [];
    const rect = element.getBoundingClientRect();
    return [{ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  });
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
// 时长与放大幅度都由 CSS 控制；原生 hide 以 opacity transitionend 为准，避免依赖脚本计时。
// 全局轻提示（toast）驻留时长，须与 App.css 的 @keyframes toast-flash 总时长一致（进 12% / 停 / 出 18%）。
// 「一闪而过」定位：只报「做成了什么」，不承载可交互内容、不要求用户确认、绝不拦截点击。
const TOAST_MS = 1600;
// 「加入启动台/中转区」的结果：重复与超上限此前都是静默失败（early-return / slice 丢弃），
// 调用方分辨不出，直接报「已添加」会说谎。三态回报让提示与实际结果一致。
// 顶层克隆浮层的数据：图标 + 点击瞬间的屏幕坐标（getBoundingClientRect）。
// 用克隆而非就地 transform——避开 .app-grid/.app-panel/.main-area 的 overflow 裁剪。
// 续142b：克隆改 cloneNode(源图标容器)，尺寸/底色由克隆自身携带、精确贴合，不再靠 React 重渲 + 猜百分比（旧 75% → 比磁贴小一圈、点击瞬间"缩一下"）。

// ── App（简化版：无动画，纯条件渲染）──
export default function App() {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const searchValueRef = useRef(""); searchValueRef.current = search; // 供 hotkey-hide 闭包读最新值（判定有无搜索现场）
  const [clipboardCategory, setClipboardCategory] = useState<ClipboardCategory>("all");
  const clipboardCategoryRef = useRef<ClipboardCategory>("all"); clipboardCategoryRef.current = clipboardCategory;
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stage, setStage] = useState<StageItem[]>([]); // 文件中转区：混合条目（文件/文本/图片）
  const [launcher, setLauncher] = useState<LauncherItem[]>([]); // 启动器收藏托盘（手动策展，持久化）
  // 启动台不预扫：只记录用户点击过的条目的最近一次存在性结果，且不落盘，避免下次显示陈旧状态。
  const [missingLauncherIds, setMissingLauncherIds] = useState<Set<number>>(new Set());
  const launcherMissingScanTokenRef = useRef(new Map<number, number>()); // 同项连点时，只采用最后一次检查结果
  const [appUsage, setAppUsage] = useState<Record<string,AppUsage>>({});
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
  // 点击驱动的关闭要等 CSS 的真实过渡结束再交给原生 hide。不能用固定 200ms 定时器：首帧合成稍晚时，
  // 定时器会抢在 opacity 归零前隐藏透明窗口，DWM 偶发留下黑色残影。热键/失焦路径不走这里，仍须即时 hide。
  // lifecycle 的 1s watchdog 只兜 transitionend 缺失，不能参与正常视觉时序。
  const dismissLifecycleRef = useRef<DismissLifecycle | null>(null);
  if (dismissLifecycleRef.current === null) {
    dismissLifecycleRef.current = createDismissLifecycle({
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    });
  }
  const dismissLifecycle = dismissLifecycleRef.current;
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
    rememberStageContentFile,
    hasLauncherIconFile,
  } = useWorkbenchPersistence({ storeRef, setStage });
  const [stageSel, setStageSel] = useState<Set<number>>(new Set<number>()); // 中转区多选（选中的 StageItem.id）
  const [stageMultiselect, setStageMultiselect] = useState(false); // 多选模式开关（显式进入，非按住修饰键）
  const [stageLayout, setStageLayout] = useState<"list"|"grid">("list"); // 中转区布局：列表 / 方格
  const stageLayoutRef = useRef(stageLayout); stageLayoutRef.current = stageLayout;
  const [dragoutAutoClose, setDragoutAutoClose] = useState(true); // 中转站拖出后是否自动关闭窗口（与 Rust DRAGOUT_AUTO_CLOSE 同步）
  const dragoutAutoCloseRef = useRef(dragoutAutoClose); dragoutAutoCloseRef.current = dragoutAutoClose; // 供 drag-out-done 监听闭包读最新值
  const [stagePersist, setStagePersist] = useState(false); // 中转站文件持久化：开启后移出/拖出不再自动移除条目，需手动删除（纯前端，无需 Rust 同步）
  const stagePersistRef = useRef(stagePersist); stagePersistRef.current = stagePersist; // 供 drag-out-done 监听闭包读最新值
  const [showShortcuts, setShowShortcuts] = useState(true); // 中转区下方「快捷入口」行是否显示（纯前端 store 持久化）；关闭时空间归还给中转区 drop-area（flex:1 自动铺满）
  const { stageThumbs, clipThumbs } = useThumbnailCaches({ stage, launcher, clipboard });
  const stageThumbsRef = useRef(stageThumbs); stageThumbsRef.current = stageThumbs;
  const clipThumbsRef = useRef(clipThumbs); clipThumbsRef.current = clipThumbs;
  // 中转区 file 条目「原文件失踪」路径集。每次呼出时后台批量 exists() 扫一遍（check_stage_paths）。
  // 不用实时文件监听（分散父目录 watcher 代价高/网络盘不支持），只在呼出这个「该看的时刻」懒扫。
  // 失效引用必须保留给用户处理：重新定位、复制原路径或删除整项，绝不静默删掉。
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set()); // 复用既有 stageRef（行 216）读最新 stage
  const missingPathsRef = useRef<Set<string>>(new Set()); missingPathsRef.current = missingPaths;
  const stageMissingScanGenerationRef = useRef(0); // 新一轮或 hide 后，旧结果一律作废
  const stageMissingScanTimerRef = useRef<number | null>(null);
  const [stageRecoveryOpen, setStageRecoveryOpen] = useState(false);

  const beginDismiss = useCallback((onComplete: () => void) => {
    dismissLifecycle.begin(onComplete);
    setDismissing(true);
  }, [dismissLifecycle]);

  const finishDismiss = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
    dismissLifecycle.complete();
  }, [dismissLifecycle]);

  useEffect(() => () => dismissLifecycle.cancel(), [dismissLifecycle]);

  const stageRecoveryOpenRef = useRef(false); stageRecoveryOpenRef.current = stageRecoveryOpen;
  const [batchCopied, setBatchCopied] = useState(false); // 批量复制 ✓ 反馈
  const stageSelRef = useRef<Set<number>>(new Set<number>()); stageSelRef.current = stageSel; // 供 Esc keydown 闭包读最新（仿 ctxMenuRef 模式）
  const stageMultiselectRef = useRef(false); stageMultiselectRef.current = stageMultiselect; // 同上
  const stageAnchorRef = useRef<number|null>(null); // shift 区间选择锚点 index
  const dropAreaRef = useRef<HTMLDivElement | null>(null); // 中转区 .drop-area，命中检测用
  const launcherDropRef = useRef<HTMLDivElement | null>(null); // 启动器 .app-grid，OLE 拖入落点判断用
  const dragLayerRef = useRef<HTMLDivElement | null>(null); // 顶层拖拽预览层，承载 DOM clone ghost
  const nativeHandoffGhostRef = useRef<{ sessionId: number; element: HTMLElement } | null>(null);
  const removeNativeHandoffGhost = useCallback((sessionId?: number) => {
    const current = nativeHandoffGhostRef.current;
    if (!current || !shouldFinishNativeDragHandoff(current.sessionId, sessionId)) return;
    current.element.remove();
    nativeHandoffGhostRef.current = null;
  }, []);
  const stageInsertMarkerRef = useRef<HTMLDivElement | null>(null); // 外来条目拖入的轻量插入槽位；fixed 覆盖层，不参与 grid/list 布局
  const nativeFileDragActiveRef = useRef(false);
  const nativeStageInsertRectsRef = useRef<LassoRect[]>([]);
  // 中转条目拖出（续71）：按下记录起点，move 超阈值 → emit drag-out-begin（Rust 接管 OLE DoDragDrop）
  // mode：idle=未决出/pending；reorder=区内重排中（续87）；native=已交给 Rust OLE，JS 侧不再处理
  const dragOutRef = useRef<StageInteractionState>(createIdleStageInteraction());
  // 续97：本次 OLE 拖出的落点其实落回自身 overlay（内部拖，非真正投放到外部）→ files-dropped 置位、drag-out-done 据此不删条目。
  const droppedOnSelfRef = useRef(false);
  // 续110：本次原生拖出的来源——中转站(stage) 还是剪贴板(clip)。drag-out-done handler 据此分流：
  //   clip 来源"拖出后剪贴板不变"，不走任何删条目/copyAndPaste 逻辑（中转站的 draggedIds 与其无关）。
  const dragOutSourceRef = useRef<"stage" | "clip">("stage");
  // 中转区内重排（续87，仿启动台 FLIP 方案）：仅「拖出后自动关闭」关闭时，单项拖动走此逻辑，ghost 跟手 + FLIP 排序。
  // 自动关闭开启时，超过阈值直接进入原生拖出并隐藏；关闭时仍不使用曾被否决的越界/时间升级，
  // 如需去外部则在重排中按热键，经 stage-drag-hotkey → beginNativeDragOut 交接。
  const stageReorderRef = useRef<{
    active: boolean; tiles: HTMLElement[]; rects: { left: number; top: number; width: number; height: number }[];
    ghostEl: HTMLElement | null; srcEl: HTMLElement | null; srcIdx: number; insertIdx: number;
    grabOffsetX: number; grabOffsetY: number; lastClientX: number; lastClientY: number;
  }>({ active: false, tiles: [], rects: [], ghostEl: null, srcEl: null, srcIdx: -1, insertIdx: -1, grabOffsetX: 0, grabOffsetY: 0, lastClientX: 0, lastClientY: 0 });
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
  const [enhContentReady, setEnhContentReady] = useState(false);
  const [enhPinned, setEnhPinned] = useState(false); // true=打字触发（顶栏为输入框，不覆盖顶栏）；false=Ctrl+K触发（全覆盖+独立搜索框）
  const [enhQuery, setEnhQuery] = useState("");
  const [launcherSelIdx, setLauncherSelIdx] = useState(-1); // 启动器网格键盘选中项（-1=未选中，焦点在搜索框）
  const [enhAdded, setEnhAdded] = useState<{path:string;target:"stage"|"launcher"}|null>(null); // 操作按钮 ✓ 反馈
  const enhInputRef = useRef<HTMLInputElement>(null);
  const enhResultsRef = useRef<HTMLDivElement>(null); // 结果列表容器：选中高亮命令式加 class 时的查询根（续127）
  const enhOpenRef = useRef(false); enhOpenRef.current = enhOpen; // 供 Esc keydown 闭包读最新
  const enhPinnedRef = useRef(false); enhPinnedRef.current = enhPinned; // 供 onChange 闭包读最新 pinned 状态
  const pageSearchForcedRef = useRef(false); // enhanced 模式下用户主动按 Ctrl+K 切到界面搜索，本次呼出有效
  // 先让常驻的轻量 shell 开始入场，再挂结果行与预览。否则快捷键打开的同一帧既要
  // 建立/布局至多 500 行，又要把整层变换送进合成器，动画首帧会被主线程工作截断。
  useEffect(() => {
    if (!enhOpen) {
      setEnhContentReady(false);
      return;
    }
    let contentFrame = 0;
    const shellFrame = requestAnimationFrame(() => {
      contentFrame = requestAnimationFrame(() => setEnhContentReady(true));
    });
    return () => {
      cancelAnimationFrame(shellFrame);
      if (contentFrame) cancelAnimationFrame(contentFrame);
    };
  }, [enhOpen]);
  // 搜索引擎（续57）：内置自建索引 / 可选 Everything；持久化 store，运行时由 Rust set_search_engine 应用
  const [searchEngine, setSearchEngine] = useState<"builtin"|"everything">("builtin");
  const {
    pinyin,
    itemsRevision: searchItemsRevision,
    indexReady,
    setIndexReady,
    everythingAvailable,
    setEverythingAvailable,
  } = useSearchSynchronization({
    apps,
    stage,
    clipboard,
    appUsage,
    t,
    enhancedOpen: enhOpen,
    settingsOpen,
    searchEngine,
  });
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
  const [searchDirs, setSearchDirs] = useState<string[]>([]); // 内置引擎额外扫描根目录（如 D:\）
  const [dirPicking, setDirPicking] = useState(false); // 文件夹选择框是否已弹出（防重复弹）
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
  const [evtRedetected, setEvtRedetected] = useState(false); // 「重新检测」✓ 反馈
  // 呼出默认搜索模式：page=顶栏界面搜索（默认），enhanced=直接进增强搜索层
  const [searchDefaultMode, setSearchDefaultMode] = useState<"page"|"enhanced">("page");
  const searchDefaultModeRef = useRef<"page"|"enhanced">("page");
  searchDefaultModeRef.current = searchDefaultMode;
  // 启动器「添加应用」picker 模态（复用 settings-modal 样式）

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
  const showToast = useCallback((msg:string) => showToastRef.current(msg), []);
  const toastAddResult = useCallback((res:AddResult, target:"launcher"|"stage", name:string) => {
    const where = target==="launcher" ? t("启动台") : t("中转站");
    if (res==="duplicate") showToast(t("已在{where}中：{name}", {where, name}));
    else if (res==="full") showToast(t("{where}已满（{n}）", {where, n:target==="launcher"?LAUNCHER_MAX:stageMax}));
    else showToast(t("已添加到{where}：{name}", {where, name}));
  }, [showToast, t, stageMax]);
  const {
    pickerOpen,
    pickerQuery,
    setPickerQuery,
    pickerOpenRef,
    pickerInputRef,
    launcherPicking,
    managerOpen: launcherManageOpen,
    managerOpenRef: launcherManageOpenRef,
    managerSelected: launcherManageSelected,
    importPreview: launcherImportPreview,
    layoutBusy: launcherLayoutBusy,
    addApp: addAppToLauncher,
    addFileSystemItem: addFsToLauncher,
    pickPath: pickLauncherPath,
    openManager: openLauncherManager,
    closeManager: closeLauncherManager,
    openPicker: openLauncherPicker,
    closePicker: closeLauncherPicker,
    toggleManagerItem: toggleLauncherManageItem,
    toggleManagerAll: toggleLauncherManageAll,
    deleteManagerSelection: deleteSelectedLauncherItems,
    exportLayout: exportLauncherLayout,
    chooseLayoutImport: chooseLauncherLayoutImport,
    confirmLayoutImport: confirmLauncherLayoutImport,
    removeItem: removeLauncherItem,
    clearImportPreview: clearLauncherImportPreview,
  } = useLauncherActions({
    launcher,
    saveLauncher,
    setSettingsOpen,
    notifyAddResult: toastAddResult,
    showToast,
    t,
  });
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
    let clipboardCategoryKeepTimer: ReturnType<typeof setTimeout> | null = null;
    // 搜索现场复位：页面搜索 + 增强搜索全部状态，hotkey-hide 的「立即/延迟」两路复用
    const resetSearchState = () => { setEnhOpen(false); setEnhPinned(false); setEnhQuery(""); setEnhSelIdx(0); clearEnhancedSearchResults(); setSearch(""); pageSearchForcedRef.current = false; };
    // 可恢复工作现场与危险瞬态分开：多选/管理弹层保留 10 秒；拖拽、框选、菜单仍在 hide 当场清。
    const resetRetainedUiState = () => {
      setStageSel(new Set<number>());
      setStageMultiselect(false);
      stageAnchorRef.current = null;
      closeLauncherPicker();
      closeLauncherManager();
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
          if (clipboardCategoryKeepTimer !== null) { clearTimeout(clipboardCategoryKeepTimer); clipboardCategoryKeepTimer = null; }
          setVisible(true);
          scheduleStageMissingScan();
        }); // 失效检查延后到首屏可操作后，绝不阻塞呼出。
        await register("hotkey-hide", () => {
          cancelStageMissingScan();
          endClipDrag();
          removeNativeHandoffGhost();
          resetStageInteractionForHide();
          nativeFileDragActiveRef.current = false;
          nativeStageInsertRectsRef.current = [];
          if (fileDragLeaveTimer) { clearTimeout(fileDragLeaveTimer); fileDragLeaveTimer = null; }
          hideStageInsertMarker(stageInsertMarkerRef.current);
          setFileDragOver(false);
          dismissLifecycle.cancel();
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

          if (clipboardCategoryKeepTimer !== null) clearTimeout(clipboardCategoryKeepTimer);
          if (clipboardCategoryRef.current !== "all") {
            clipboardCategoryKeepTimer = setTimeout(() => {
              clipboardCategoryKeepTimer = null;
              setClipboardCategory("all");
            }, CLIPBOARD_CATEGORY_KEEP_MS);
          } else {
            clipboardCategoryKeepTimer = null;
          }
        }); // 复位（续88：任何窗口隐藏都兜底清一次区内重排残留状态，防 ghost 卡死；菜单/toast 同样立即清）
        // 性能优化步骤2：image 条目 content 已不入前端 state，无法再按 content 做乐观去重。
        // 改为回拉 Rust 权威历史（get_clipboard_history 已剥图片 content、且 Rust 侧已按 ahash 去重 R24）。
        // 事件仅在真实外部复制时触发（自写回流被 R21 抑制），此处一次 IPC 开销可忽略。
        await register("clipboard-update", passiveEventHandlers.onClipboardUpdate);
        // 原生拖入（S3b）：只接受启动台/中转站两个明确区域；落在剪贴板或空白区不产生项目。
        // pt 是 Windows 屏幕物理像素，÷ devicePixelRatio 转 CSS px 后与 getBoundingClientRect 比对。
        await register("files-dropped", async (event: any) => {
          const payload = event.payload as { paths: string[]; x: number; y: number };
          const paths = payload.paths ?? [];
          if (!paths.length) return;
          // 一次 drop 消费一次 DragEnter 时冻结的布局快照。立即清空共享 ref，避免上一轮延迟的
          // DragLeave 计时器尚未执行时，新一轮 DragEnter 误复用旧卡片坐标。
          const dropStageRects = nativeStageInsertRectsRef.current;
          nativeStageInsertRectsRef.current = [];
          if (fileDragLeaveTimer) { clearTimeout(fileDragLeaveTimer); fileDragLeaveTimer = null; }
          nativeFileDragActiveRef.current = false;
          hideStageInsertMarker(stageInsertMarkerRef.current);
          // 「保持界面」模式下，我们自己的中转拖出落回窗口内也会经 IDropTarget→files-dropped（draggedIds 尚未清）。
          // 与外部文件拖入区分：区内拖出且落点在启动台 → 走下方启动台添加（等同拖入收藏）；落回中转区 →
          // 区内重排属后续阶段，暂跳过（避免把自身当外部文件重复添加）。
          const internalStageDrag = dragOutRef.current.draggedIds.length > 0;
          const internalWorkbenchDrag = internalStageDrag || dragOutSourceRef.current === "clip";
          const cssX = payload.x / window.devicePixelRatio;
          const cssY = payload.y / window.devicePixelRatio;
          const stageRect = dropAreaRef.current?.getBoundingClientRect();
          const launcherRect = launcherDropRef.current?.getBoundingClientRect();
          const dropZone = resolveWorkbenchFileDropZone({ x: cssX, y: cssY }, stageRect, launcherRect);
          // 续97：内部拖出落回自身 overlay（非启动台）——即"拖了一下又落回本窗口"，属未真正投放到外部。
          // 标记之，供随后到达的 drag-out-done 跳过删除（OS 仍会回传 copy，否则会误判成功投放而删条目）。
          if (internalStageDrag && dropZone !== "launcher") {
            droppedOnSelfRef.current = true;
          }
          if (!dropZone) {
            // 尤其是剪贴板项经热键升级为原生拖出、隐藏后又重新呼出：松手若在剪贴板区，
            // 不能沿用之前悬停过中转站的高亮/兜底路由，把它误加进中转站。
            if (internalWorkbenchDrag) droppedOnSelfRef.current = true;
            setFileDragOver(false);
            return;
          }
          if (internalStageDrag && dropZone === "stage") { setFileDragOver(false); return; }
          const { invoke } = await import("@tauri-apps/api/core");
          if (dropZone === "launcher") {
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
            // 仅落点明确位于中转区时，转为 StageItem。
            const built: StageItem[] = [];
            for (const p of paths) {
              try {
                built.push(fileEntryToStage(await invoke<FileEntry>("get_file_info", { path: p })));
              } catch (error) {
                console.warn(`[events] files-dropped 加入中转站失败：${p}`, error);
              }
            }
            if (!built.length) return;
            const point = { x: cssX, y: cssY };
            const rects = dropStageRects.length
              ? dropStageRects
              : snapshotStageInsertRects(dropAreaRef.current, stageLayoutRef.current);
            const slot = resolveStageInsertSlot(point, rects, stageLayoutRef.current);
            const anchor = stageInsertAnchorForSlot(slot, rects);
            const next = insertStageItemsAtAnchor(stageRef.current, built, anchor, stageMaxRef.current);
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
          nativeFileDragActiveRef.current = true;
          // 每次 DragEnter 都刷新：同一 OLE 拖动跨子 HWND 重入时成本很小；真实的新拖动若恰好在
          // 100ms leave 防抖窗口内开始，也不会复用上一轮冻结坐标。
          nativeStageInsertRectsRef.current = snapshotStageInsertRects(dropAreaRef.current, stageLayoutRef.current);
          setFileDragOver(true);
        });
        await register<{ x: number; y: number }>("file-drag-over", event => {
          if (!nativeFileDragActiveRef.current) return;
          const point = { x: event.payload.x / window.devicePixelRatio, y: event.payload.y / window.devicePixelRatio };
          const stageRect = dropAreaRef.current?.getBoundingClientRect();
          const launcherRect = launcherDropRef.current?.getBoundingClientRect();
          if (resolveWorkbenchFileDropZone(point, stageRect, launcherRect) !== "stage") {
            hideStageInsertMarker(stageInsertMarkerRef.current);
            return;
          }
          const rects = nativeStageInsertRectsRef.current;
          const slot = resolveStageInsertSlot(point, rects, stageLayoutRef.current);
          showStageInsertMarker(stageInsertMarkerRef.current, stageInsertMarkerForSlot(slot, rects, stageLayoutRef.current));
        });
        await register("file-drag-leave", () => {
          fileDragLeaveTimer = setTimeout(() => {
            nativeFileDragActiveRef.current = false;
            nativeStageInsertRectsRef.current = [];
            hideStageInsertMarker(stageInsertMarkerRef.current);
            setFileDragOver(false);
          }, 100);
        });
        // 拖出完成（续71，续86 修正）：effect==="move"|"copy" 均视为投放成功 → 从中转区移除被拖出的条目
        // （draggedIds 在拖出触发时已快照）；取消(Esc)/none → 保留。
        // 续86 修正根因：文件跨盘拖出、图片/文本拖到绝大多数非 Explorer 目标，OS 回传的都是 copy 而非
        // move（move 只在同盘 Explorer 间搬移等少数场景出现）——旧版「仅 move 才移除」导致 copy 效果的
        // text/image/file 条目拖出成功后仍滞留中转区（不符合"移出即消失"的中转直觉）。改为凡投放成功
        // （非取消/none）即视为已移出。overlay 已被 Rust 隐藏，此处只改状态 + 落盘，用户重按热键再呼出。
        // 持久化开关（stagePersistRef，续86 同批新增）——开启时跳过下方两处移除，条目仅可手动删除；
        // 移除仍严格挂在 Rust 回传的「非 none」（已确认成功投放）之后，只是多加一道门。
        await register<DragPreviewReadyPayload>("drag-preview-ready", event => {
          if (event.payload.session_id === undefined) return;
          removeNativeHandoffGhost(event.payload.session_id);
          finishClipNativeHandoff(event.payload.session_id);
        });
        await register<string>("drag-out-done", async (event) => {
          removeNativeHandoffGhost();
          finishClipNativeHandoff();
          const dr = dragOutRef.current;
          // 续110：剪贴板来源的原生拖出——"拖出后剪贴板不变"。中转站的 draggedIds/持久化/copyAndPaste
          // 逻辑与其无关，全部跳过；复位来源 + 兜底清 clip 让路标志（Rust do_drag_on_main 通常已清，幂等）后返回。
          if (dragOutSourceRef.current === "clip") {
            dragOutSourceRef.current = "stage";
            droppedOnSelfRef.current = false;
            setClipDragActiveNative(false);
            return;
          }
          // 续97：本次 OLE 落点落回自身 overlay（files-dropped 已置位 droppedOnSelfRef）——非真正外部投放。
          // OS 仍回传 copy（overlay 自身 IDropTarget 接受），但不应删条目/清选区。命中则保留一切、直接返回。
          // 这正是"多选拖动后什么也没做（区内小幅拖动+立刻松手，落回本窗口）却误删选中项"的根因（单项因先走区内重排、
          // 落回区内只是重排不起 OLE，故无此症）。真正拖到外部落地时不经此分支（落点非本窗口→无 files-dropped 自标记）。
          if (droppedOnSelfRef.current) {
            droppedOnSelfRef.current = false;
            dr.draggedIds = [];
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
          upgradeReorderFromHotkey();
        });
        // 续110：剪贴板项纯 JS 拖动中按热键 → Rust monitor emit 此事件（而非直接 hide）。仿 un10：把纯 JS ghost
        // 升级为原生拖出（beginClipDragOut：force_hide=true，窗口仍可见时先起手 DoDragDrop，再由 Rust 隐藏 overlay）。
        await register("clip-drag-hotkey", () => {
          const ds = clipDragRef.current;
          if (!ds?.active) return; // 未激活（理论上 monitor 不会在此发）——保险起见忽略
          beginClipDragOut(ds.item);
        });
        // D2：Rust 在粘贴/复制/拖出消费时首次发现原图不可用，持久标记后同步当前卡片。
        // badge 是主提示；toast 只在界面仍可见的首次消费降级时补一句，避免粘贴已隐藏后留下幽灵提示。
        await register<ClipboardOriginalDegradedPayload>("clipboard-original-degraded", event => passiveEventHandlers.onClipboardOriginalDegraded(event.payload));
    });
    return () => {
      eventScope.dispose();
      nativeFileDragActiveRef.current = false;
      nativeStageInsertRectsRef.current = [];
      hideStageInsertMarker(stageInsertMarkerRef.current);
      if (fileDragLeaveTimer) clearTimeout(fileDragLeaveTimer);
      if (searchKeepTimer) clearTimeout(searchKeepTimer);
      if (uiKeepTimer) clearTimeout(uiKeepTimer);
      if (clipboardCategoryKeepTimer) clearTimeout(clipboardCategoryKeepTimer);
    };
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
    appUsageScore(appUsage[b.path],nowS) - appUsageScore(appUsage[a.path],nowS) || a.name.localeCompare(b.name)
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
        || appUsageScore(appUsage[b.app.path],nowS) - appUsageScore(appUsage[a.app.path],nowS) // 同分按使用打分
        || a.app.name.localeCompare(b.app.name))                                       // 再按字母
      .slice(0, 200)
      .map(({ app, ranges }) => ({ app, ranges }));
  }, [search, sortedApps, appUsage]);

  // 启动器键盘选中：滚入视野；关闭覆盖层 / 搜索过滤态变化时复位到「未选中」（焦点回搜索框）
  useEffect(() => {
    if (launcherSelIdx >= 0) document.querySelector(".app-tile.selected")?.scrollIntoView({ block: "nearest" });
  }, [launcherSelIdx]);
  useEffect(() => { setLauncherSelIdx(-1); }, [visible, search]);

  // One model is shared by rows, preview, Enter and cross-section keyboard navigation.
  // Built-in hit order remains Rust-authoritative; Everything keeps the legacy local Tier1.
  const {
    sections: enhSections,
    results: enhResults,
    sectionStarts: enhSectionStarts,
    headingByIndex: enhHeadAt,
  } = useEnhancedSearchResults({
    engine: searchEngine,
    query: enhQuery,
    apps,
    sortedApps,
    stage,
    clipboard,
    appUsage,
    pinyin,
    builtinHits,
    fileResults: fsResults,
    everythingFileLimit: ENH_FILE_LIMIT_EVERYTHING,
    minFileSection: ENH_MIN_SECTION,
    t,
  });
  const {
    selectedIndex: enhSelIdx,
    setSelectedIndex: setEnhSelIdx,
    selectByKeyboard,
    onRowEnter: onEnhRowEnter,
    cancelPendingHover: cancelHoverSelect,
    trackPointer: trackEnhResultsPointer,
  } = useEnhancedSearchSelection(enhOpen, enhResults);
  // Selection still owns only interaction intent; its input is the flattened domain model above.

  // Async metadata, image caches and the synchronous preview view model share one feature controller.
  const enhPreview = useEnhancedSearchPreview({
    open: enhOpen && enhContentReady,
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
  const stagePageSearch = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return { items: stage, highlights: new Map<number, TextRange[]>() };
    const items: StageItem[] = [];
    const highlights = new Map<number, TextRange[]>();
    for (const s of stage) {
      const name = s.type === "text" ? (s.content || "") : s.type === "image" ? "图片" : (s.name || s.items?.[0]?.name || "文件");
      const match = matchPageSearch(q, name, typeKeywords({ type: s.type, ext: s.ext ?? s.items?.[0]?.ext, isImage: s.items?.[0]?.isImage }));
      if (!match.matches) continue;
      items.push(s);
      highlights.set(s.id, match.ranges);
    }
    return { items, highlights };
  }, [stage, deferredSearch]);
  const filteredStage = stagePageSearch.items;
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
  const clipboardPageSearch = useMemo(
    () => buildClipboardPageSearch(clipboard, deferredSearch, clipboardCategory),
    [clipboard, clipboardCategory, deferredSearch],
  );
  const filteredClip = clipboardPageSearch.items;
  // 启动器过滤：有 search 时按名称模糊过滤，无 search 直接返回原列表（持久化/拖入/picker 行为不受影响）
  const launcherPageSearch = useMemo(() => {
    const q = deferredSearch.trim();
    if (!q) return { items: launcher, highlights: new Map<number, TextRange[]>() };
    const items: LauncherItem[] = [];
    const highlights = new Map<number, TextRange[]>();
    for (const item of launcher) {
      const match = matchPageSearch(q, item.name, []);
      if (!match.matches) continue;
      items.push(item);
      highlights.set(item.id, match.ranges);
    }
    return { items, highlights };
  }, [launcher, deferredSearch]);
  const filteredLauncher = launcherPageSearch.items;

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
    // 放大暂留：克隆图标到顶层浮层做 scale+淡出，覆盖层整体淡出露桌面，过渡实际结束后再 Rust hide
    launchingRef.current = true;
    const r = iconEl.getBoundingClientRect();
    spawnLaunchClone(iconEl, r); // 克隆（源仍可见时）
    iconEl.style.opacity = "0"; launchSrcElRef.current = iconEl; // 源图标即时隐藏，克隆顶替（防"两个图标"）
    beginDismiss(() => { void hideWorkbench(); }); // 覆盖层淡出（与剪贴板粘贴共用）
  }, [beginDismiss, recordUse, spawnLaunchClone]);
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
    beginDismiss(() => { void hideWorkbench(); });
  }, [beginDismiss, launchApp, spawnLaunchClone]);

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

  // 增强搜索 fs 结果加入中转区（允许重复，置顶）。
  const addFsToStage = useCallback(async (r:{path:string;name:string;ext:string;isDir:boolean}):Promise<AddResult> => {
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
  // 剪贴板项「加入中转站」：允许重复；每次操作都生成独立条目并置顶。
  // 条目等价语义保留在 domain/stageItemIdentity.ts，但不参与插入决策。
  const addToStage = useCallback(async (c:ClipItem, anchor: StageInsertAnchor = { at: "start" }) => {
    c = { ...c, content: await hydrateContent(c) }; // 剪贴板图片按 time 现取，仅在本次动作局部变量中短驻
    let contentFile: string | undefined;
    if (c.type==="image" && c.content) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        contentFile = (await invoke<(string|null)[]>("save_stage_images", { images:[c.content] }))[0] ?? undefined;
      } catch {}
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
    saveStage(insertStageItemAtAnchor(stageRef.current, item, anchor, stageMaxRef.current));
  }, [saveStage,rememberStageContentFile]);
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
  const {
    dragItem: clipDragItem,
    dragStateRef: clipDragRef,
    ghostRef: clipGhostRef,
    suppressClickRef,
    setNativeActive: setClipDragActiveNative,
    endDrag: endClipDrag,
    finishNativeHandoff: finishClipNativeHandoff,
    pointerDown: handleClipPointerDown,
    pointerMove: handleClipPointerMove,
    pointerUp: handleClipPointerUp,
    pointerCancel: handleClipPointerCancel,
    beginNativeDragOut: beginClipDragOut,
  } = useClipboardDragController({
    dropAreaRef,
    insertMarkerRef: stageInsertMarkerRef,
    stageLayout,
    dragOutSourceRef,
    droppedOnSelfRef,
    addToStage,
    getDragLabel: item => buildNativeDragLabel(item, makeT(langRef.current)),
    getDragMeta: item => buildNativeDragMeta(item, makeT(langRef.current)),
    getDragPreview: item => item.type === "image"
      ? clipThumbsRef.current[item.time] ?? null
      : item.items?.[0]?.isImage
        ? clipThumbsRef.current[item.time] ?? item.items[0].icon ?? null
        : item.items?.[0]?.icon ?? null,
  });
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
  const beginNativeDragOut = useCallback((ids: number[], forceHide = false, point?: { x: number; y: number }, sourceElement?: HTMLElement) => {
    const dr = dragOutRef.current;
    dr.mode = "native";
    dr.draggedIds = ids;
    dragOutSourceRef.current = "stage"; // 续110：中转站来源，drag-out-done 走原有删条目/持久化逻辑
    droppedOnSelfRef.current = false; // 续97：每次拖出重置「落回自身」标记，等 files-dropped 内部落点再置位
    const previewStyle: NativeDragPreviewStyle = "card";
    const dragT = makeT(langRef.current);
    const sourceId = Number(sourceElement?.dataset.stageId);
    const orderedIds = Number.isNaN(sourceId) ? ids : [sourceId, ...ids.filter(id => id !== sourceId)];
    const selectedItems = orderedIds.flatMap(id => {
      const item = stageRef.current.find(candidate => candidate.id === id);
      return item ? [item] : [];
    });
    const sessionId = nextNativeDragSessionId();
    const previewFor = (s: StageItem) => {
      if (s.contentFile) return stageThumbsRef.current[stageImageThumbKey(s.contentFile)] ?? null;
      const first = s.items?.[0];
      if (!first) return null;
      if (first.isImage) return stageThumbsRef.current[first.path] ?? first.icon ?? null;
      return first.icon ?? null;
    };
    const handoffPoint = point ?? (stageReorderRef.current.lastClientX || stageReorderRef.current.lastClientY
      ? { x: stageReorderRef.current.lastClientX, y: stageReorderRef.current.lastClientY }
      : undefined);
    const sourceRect = sourceElement?.getBoundingClientRect();
    const hotspot = sourceRect && handoffPoint
      ? {
          x: Math.max(4, Math.min(68, ((handoffPoint.x - sourceRect.left) / Math.max(1, sourceRect.width)) * 72)),
          y: Math.max(4, Math.min(90, ((handoffPoint.y - sourceRect.top) / Math.max(1, sourceRect.height)) * 94)),
        }
      : stageReorderRef.current.grabOffsetX || stageReorderRef.current.grabOffsetY
        ? { x: stageReorderRef.current.grabOffsetX, y: stageReorderRef.current.grabOffsetY }
        : { x: 12, y: 12 };
    if (selectedItems[0] && handoffPoint) {
      removeNativeHandoffGhost();
      const element = createNativeDragGhost({
        style: previewStyle,
        type: selectedItems[0].type,
        label: buildNativeDragLabel(selectedItems[0], dragT),
        meta: buildNativeDragMeta(selectedItems[0], dragT),
        preview: previewFor(selectedItems[0]),
        previewMode: selectedItems[0].type === "image" || !!selectedItems[0].items?.[0]?.isImage ? "cover" : "icon",
        textPreview: selectedItems[0].content ?? null,
        itemCount: selectedItems.length,
      });
      element.classList.add("native-handoff-ghost");
      const host = dragLayerRef.current ?? document.body;
      element.style.position = host === dragLayerRef.current ? "absolute" : "fixed";
      positionNativeDragGhost(element, previewStyle, handoffPoint.x, handoffPoint.y, hotspot);
      host.appendChild(element);
      nativeHandoffGhostRef.current = { sessionId, element };
    }
    const dragItems = selectedItems.map(s => ({
      type: s.type,
      content: s.content ?? null,
      content_file: s.contentFile ?? null,
      items: s.items?.map(f => f.path) ?? null,
      orig_path: s.orig_path ?? null,
      drag_preview: previewFor(s),
      drag_label: buildNativeDragLabel(s, dragT),
      drag_meta: buildNativeDragMeta(s, dragT),
      drag_preview_kind: s.type === "image" || !!s.items?.[0]?.isImage ? "cover" : "icon",
      drag_hotspot_x: hotspot.x,
      drag_hotspot_y: hotspot.y,
      drag_theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      drag_dpr: window.devicePixelRatio,
      drag_session_id: sessionId,
    }));
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("start_drag_out", { items: dragItems, forceHide }))
      .catch(() => removeNativeHandoffGhost(sessionId));
  }, [removeNativeHandoffGhost]);
  // FLIP 快照 + ghost 建立：与启动台 handleLauncherPointerDown 的 onMove 激活段同构，选择器按当前 stageLayout 决定。
  const startStageReorder = useCallback((id: number, srcEl: HTMLElement, clientX: number, clientY: number) => {
    const container = dropAreaRef.current;
    const srcIdx = stageRef.current.findIndex(s => s.id === id);
    if (!container || srcIdx === -1) return;
    const selector = stageLayout === "grid" ? ".stage-card" : ".stage-item";
    const tiles = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const rects = tiles.map(t => { const r = t.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const item = stageRef.current[srcIdx];
    const previewStyle: NativeDragPreviewStyle = "card";
    const sourceRect = srcEl.getBoundingClientRect();
    const grabOffsetX = Math.max(4, Math.min(68, ((clientX - sourceRect.left) / Math.max(1, sourceRect.width)) * 72));
    const grabOffsetY = Math.max(4, Math.min(90, ((clientY - sourceRect.top) / Math.max(1, sourceRect.height)) * 94));
    tiles.forEach(t => t.classList.add("stage-shift"));
    const preview = previewStyle === "card"
      ? item.contentFile
        ? stageThumbsRef.current[stageImageThumbKey(item.contentFile)] ?? null
        : item.items?.[0]?.path
          ? stageThumbsRef.current[item.items[0].path] ?? null
          : null
      : null;
    const ghostEl = createNativeDragGhost({
      style: previewStyle,
      type: item.type,
      label: buildNativeDragLabel(item, makeT(langRef.current)),
      meta: buildNativeDragMeta(item, makeT(langRef.current)),
      preview,
      previewMode: item.type === "image" || !!item.items?.[0]?.isImage ? "cover" : "icon",
      textPreview: item.content ?? null,
      itemCount: 1,
    });
    ghostEl.classList.add("stage-drag-ghost");
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
      zIndex: inDragLayer ? "" : "100003",
      visibility: "visible",
      pointerEvents: "none",
    });
    ghostHost.appendChild(ghostEl);
    srcEl.classList.add("stage-dragging-src");
    document.getElementById("overlay")?.classList.add("stage-reordering");
    stageReorderRef.current = { active: true, tiles, rects, ghostEl, srcEl, srcIdx, insertIdx: srcIdx, grabOffsetX, grabOffsetY, lastClientX: clientX, lastClientY: clientY };
    setStageReorderActiveNative(true); // 告知 Rust：light-dismiss 本阶段让路（热键 monitor 续88 起不再让路）
  }, [stageLayout, setStageReorderActiveNative]);
  const updateStageReorder = useCallback((clientX: number, clientY: number) => {
    const st = stageReorderRef.current;
    if (!st.active || !st.ghostEl) return;
    st.lastClientX = clientX;
    st.lastClientY = clientY;
    st.ghostEl.style.transform = `translate3d(${clientX - st.grabOffsetX}px,${clientY - st.grabOffsetY}px,0) scale(1.04)`;
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
  const {
    lasso: lassoState,
    lassoRef: lassoStateRef,
    lassoVisualRef,
    suppressClickRef: suppressStageClickRef,
    cancelLasso,
    resetForHide: resetStageInteractionForHide,
    upgradeReorderFromHotkey,
    lassoPointerDown: handleLassoPointerDown,
    lassoPointerMove: handleLassoPointerMove,
    lassoPointerUp: handleLassoPointerUp,
    itemPointerDown: handleStagePointerDown,
    itemPointerMove: handleStagePointerMove,
    itemPointerUp: handleStagePointerUp,
    itemLostPointerCapture: handleStageLostPointerCapture,
  } = useStageInteractionController({
    interactionRef: dragOutRef,
    dropAreaRef,
    launcherDropRef,
    stageRef,
    selectedRef: stageSelRef,
    multiselectRef: stageMultiselectRef,
    missingIdsRef,
    anchorRef: stageAnchorRef,
    stageLayout,
    autoClose: dragoutAutoClose,
    searchActive: !!search.trim(),
    clipDragActive: () => !!clipDragRef.current?.active,
    setSelected: setStageSel,
    setMultiselect: setStageMultiselect,
    startReorder: startStageReorder,
    updateReorder: updateStageReorder,
    commitReorder: commitStageReorder,
    cancelReorder: cancelStageReorder,
    reorderActive: () => stageReorderRef.current.active,
    setNativeReorderActive: setStageReorderActiveNative,
    beginNativeDragOut,
    dropToLauncher: dropStageItemToLauncher,
    showToast,
    t,
  });
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
    const showPasteError = (error: unknown) => {
      const err = String(error);
      const key = err.includes("paste-target-elevated")
        ? "无法粘贴到以管理员身份运行的应用"
        : err.includes("paste-modifier-held")
          ? "请松开修饰键后重试粘贴"
          : "粘贴失败";
      showToastRef.current(makeT(langRef.current)(key));
    };
    const startPaste = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      // 安全预检必须发生在任何淡出/写剪贴板之前；实际命令仍会二次校验，封住动画期间目标变化。
      try {
        await invoke("check_paste_ready");
      } catch (error) {
        showPasteError(error);
        return;
      }
      const doPaste = async () => {
        try {
          if (item.type === "text") await invoke("paste_clipboard",{text:item.content});
          else if (item.type === "file" && item.items) await invoke("set_clipboard_files",{paths:item.items.map(f=>f.path)});
          else await invoke("set_clipboard_image",{base64:(await hydrateContent(item)) ?? "",origPath:item.orig_path??null,time:item.time??null});
        } catch (error) {
          showPasteError(error);
        }
      };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { await doPaste(); return; }
      launchingRef.current = true;
      beginDismiss(() => { void (async () => {
        if (!launchingRef.current) return;
        try { await doPaste(); }
        finally { setDismissing(false); launchingRef.current = false; }
      })(); });
    };
    void startPaste();
  }, [beginDismiss]);
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
    perf.mark("input"); // 性能专项 t0：input→echo / input→paint 两段以此为起点
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
  const enhRows = useMemo(() => perf.time("row-build", () => {
    perf.record("rows", enhResults.length);
    return enhResults.map((r,i)=>{
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
          });
  }), [enhResults, enhHeadAt, enhAdded, lang, t, onEnhRowEnter, cancelHoverSelect, openEnhCtxMenu, activateEnh, addFsToStage, addFsToLauncher, addAppToLauncher, toastAddResult]);

  // 选中高亮 + 滚入视野。**高亮命令式加 class，不进 React**（续127，说明见 onEnhRowEnter 附近）。
  //
  // ⚠️ 依赖必须是 **enhRows 本身**，不能只写 enhResults：
  // enhRows 重建时（如点了「中转/启动台」按钮使 enhAdded 变化）React 会按 `className="enh-result"`
  // 重渲这些行，**把命令式加上的 .selected 抹掉**；此时 enhSelIdx/enhResults 都没变，
  // effect 若不重跑，高亮就凭空消失、直到下次按 ↑↓ 才回来。
  // enhRows 的引用恰好在「行被重建」时才变，正是需要的那个信号。
  useEffect(() => {
    if (!enhOpen || !enhContentReady) return;
    const box = enhResultsRef.current;
    if (!box) return;
    box.querySelector(".enh-result.selected")?.classList.remove("selected");
    const cur = box.querySelector<HTMLElement>(`.enh-result[data-idx="${enhSelIdx}"]`);
    cur?.classList.add("selected");
    cur?.scrollIntoView({ block: "nearest" });
    // 性能专项：本 effect 在提交后跑，rAF 回调即绘制后——每个 mark 实例每段只记一次（perfTrace 内去重），
    // 方向键导航导致的重跑不会污染「输入→绘制」。
    requestAnimationFrame(() => {
      perf.since("input", "input→paint");
      perf.since("results", "results→paint");
    });
  }, [enhSelIdx, enhOpen, enhContentReady, enhRows]);

  // 性能专项：输入回显段（enhQuery 提交 + 绘制后的第一帧）。
  useEffect(() => {
    if (!enhOpen) return;
    const frame = requestAnimationFrame(() => {
      perf.since("open", "open→first-paint");
      perf.since("input", "input→echo");
    });
    return () => cancelAnimationFrame(frame);
  }, [enhQuery, enhOpen]);

  // 性能专项：层开/关各采一次 JS heap；关闭时把本轮汇总经 perf_report 落到 Rust stderr（与 [perf] 分段同流）。
  useEffect(() => {
    if (!perf.on) return;
    if (enhOpen) perf.heap("open");
    else { perf.heap("close"); perf.dump(); }
  }, [enhOpen]);

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
      perf.mark("input");
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


  useGlobalKeyboardRouter({
    visible,
    search,
    settingsOpen,
    pickerOpen,
    enhancedOpen: enhOpen,
    enhancedResults: enhResults,
    enhancedSectionStarts: enhSectionStarts,
    enhancedSelectedIndex: enhSelIdx,
    enhancedHotkey: enhHotkey,
    launcherItems: filteredLauncher,
    launcherSelectedIndex: launcherSelIdx,
    filteredApps,
    searchRef,
    launcherGridRef: launcherDropRef,
    contextMenuRef: ctxMenuRef,
    clipDragActive: () => !!clipDragRef.current?.active,
    lassoActive: () => lassoStateRef.current.active,
    enhancedOpenRef: enhOpenRef,
    stageRecoveryOpenRef,
    launcherManagerOpenRef: launcherManageOpenRef,
    pickerOpenRef,
    stageSelectedRef: stageSelRef,
    stageMultiselectRef,
    searchDefaultModeRef,
    pageSearchForcedRef,
    setContextMenu: setCtxMenu,
    setEnhancedOpen: setEnhOpen,
    setEnhancedPinned: setEnhPinned,
    setEnhancedQuery: setEnhQuery,
    setEnhancedSelectedIndex: setEnhSelIdx,
    selectEnhancedByKeyboard: selectByKeyboard,
    activateEnhanced: activateEnh,
    setStageRecoveryOpen,
    closeLauncherManager,
    closePicker: closeLauncherPicker,
    setStageSelected: setStageSel,
    setStageMultiselect,
    stageAnchorRef,
    setLauncherSelectedIndex: setLauncherSelIdx,
    setSettingsOpen,
    setVisible,
    endClipDrag,
    cancelLasso,
    hideWorkbench,
    openLauncherItem,
    launchApp,
  });

  const headerSearchTarget = resolveHeaderSearchTarget({
    defaultMode: searchDefaultMode,
    pageSearchForced: pageSearchForcedRef.current,
    enhancedPinned: enhPinned,
  });

  return (
   <>
    <div id="overlay" className={`overlay-simple${visible ? " overlay-visible" : " overlay-hidden"}${dismissing ? " dismissing" : ""}${fileDragOver ? " file-drag-active" : ""}`} onContextMenu={e=>e.preventDefault()} onTransitionEnd={finishDismiss}>
      {/* ── 顶栏 ── */}
      <header className="top-bar">
        <WorkbenchSearchHeader search={headerSearchTarget === "enhanced" ? enhQuery : search} enhanced={headerSearchTarget === "enhanced"} searchRef={searchRef} t={t} onSearchChange={changePageSearch}/>
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
          search={deferredSearch}
          selectedIndex={launcherSelIdx}
          missingIds={missingLauncherIds}
          thumbnails={stageThumbs}
          t={t}
          onOpenManager={openLauncherManager}
          onOpenPicker={openLauncherPicker}
          onOpenItem={openLauncherItem}
          onOpenContextMenu={openLauncherCtxMenu}
          onPointerDown={handleLauncherPointerDown}
          highlights={launcherPageSearch.highlights}
        />
        <section className="center-panel">
          <div className="stage-section-header">
            <span className="section-label">{t("文件中转区")}</span>
            <div className="stage-multi-toolbar">
              {stageMultiselect ? <>
                {stageSel.size > 0 && <span className="stage-sel-count">{t("已选 {n}", {n: stageSel.size})}</span>}
                <button className="stage-batch-btn" disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))?t("取走并粘贴到上个窗口"):t("仅文件可批量取走")}
                  onClick={()=>{const sel=stage.filter(x=>stageSel.has(x.id));copyAndPaste({type:"file",items:sel.flatMap(x=>x.items??[])});setStageSel(new Set());setStageMultiselect(false);}}>{t("取走")}</button>
                <button className={`stage-batch-btn${batchCopied?" copied":""}`} disabled={stageSel.size===0||!stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))}
                  title={stageSel.size>0&&stage.filter(x=>stageSel.has(x.id)).every(x=>x.type==="file"&&!missingIds.has(x.id))?t("复制到剪贴板"):t("仅文件可批量复制")}
                  onClick={async()=>{const sel=stage.filter(x=>stageSel.has(x.id));await writeItemToClipboard({type:"file",items:sel.flatMap(x=>x.items??[])});setBatchCopied(true);setTimeout(()=>setBatchCopied(false),1000);}}>{t("复制")}</button>
                <button className="stage-batch-btn" disabled={stageSel.size===0}
                  onClick={()=>{saveStage(stage.filter(x=>!stageSel.has(x.id)));setStageSel(new Set());}}>{t("删除")}</button>
              </> : (
                missingStageItems.length > 0 && <button className="stage-batch-btn stage-missing-action" onClick={openStageRecovery} title={t("处理失效条目")}>{t("失效 {n} 项", { n: missingStageItems.length })}</button>
              )}
              {/* 保持此节点与右侧锚点不变：切换模式时批量操作只向左展开，避免点击目标被卸载后闪跳。 */}
              <button key="stage-mode-toggle" className={`stage-batch-btn stage-mode-toggle${stageMultiselect ? " stage-batch-cancel" : ""}`}
                disabled={!stageMultiselect && !stage.length}
                onClick={()=>{setStageSel(new Set());setStageMultiselect(!stageMultiselect);stageAnchorRef.current=null;}}
                title={stageMultiselect ? t("退出多选模式") : t("进入多选模式")}>{stageMultiselect ? t("完成") : t("多选")}</button>
            </div>
          </div>
          <div className="drop-area" ref={dropAreaRef}
            onPointerDown={handleLassoPointerDown} onPointerMove={handleLassoPointerMove}
            onPointerUp={handleLassoPointerUp} onPointerCancel={handleLassoPointerUp}>
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
                    highlightRanges={stagePageSearch.highlights.get(s.id) ?? []}
                    pageSearchActive={!!deferredSearch.trim()}
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
                    highlightRanges={stagePageSearch.highlights.get(s.id) ?? []}
                    pageSearchActive={!!deferredSearch.trim()}
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
          search={deferredSearch}
          category={clipboardCategory}
          thumbnails={clipThumbs}
          copiedTime={copiedTime}
          t={t}
          actions={clipboardPanelActions}
          drag={clipboardPanelDrag}
          highlights={clipboardPageSearch.highlights}
          onCategoryChange={setClipboardCategory}
        />
      </main>
      {/* ── 增强搜索层：轻量 shell 常驻以保留呼出动画；结果 DOM / preview 仅在打开时挂载 ── */}
      <EnhancedSearchLayer
        open={enhOpen}
        pinned={enhPinned}
        query={enhQuery}
        inputRef={enhInputRef}
        resultsRef={enhResultsRef}
        rows={enhOpen && enhContentReady ? enhRows : null}
        resultCount={enhOpen && enhContentReady ? enhResults.length : 0}
        sectionCount={enhOpen && enhContentReady ? enhSections.length : 0}
        searchDefaultMode={searchDefaultMode}
        enhancedHotkeyLabel={comboLabel(enhHotkey)}
        searchEngine={searchEngine}
        everythingAvailable={everythingAvailable}
        indexReady={indexReady}
        preview={enhOpen && enhContentReady ? enhPreview : null}
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
          onClose={closeLauncherPicker}
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
          onClose={closeLauncherManager}
          onBackFromPreview={clearLauncherImportPreview}
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
    {lassoState.active && <div className="stage-lasso" ref={lassoVisualRef}/>}
    <div className="stage-insert-marker" ref={stageInsertMarkerRef}/>
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
      <div className="clip-drag-ghost native-drag-ghost native-drag-ghost-card stage-card stage-drag-ghost"
        ref={el=>{ clipGhostRef.current=el; const d=clipDragRef.current; if(el&&d) el.style.transform=`translate3d(${d.x-d.hotspotX}px,${d.y-d.hotspotY}px,0) scale(1.04)`; }}
        style={{position:"fixed",pointerEvents:"none",zIndex:100002}}>
        <div className="stage-card-thumb">
          <span className={`stage-card-dot type-${clipDragItem.type}`}><span className="dot-type"/></span>
          {clipDragItem.type === "text"
            ? <div className="stage-card-text-preview">{clipDragItem.content || t("文本")}</div>
            : (clipDragItem.type === "image" || !!clipDragItem.items?.[0]?.isImage) && clipThumbs[clipDragItem.time]
              ? <img className="cover" src={clipThumbs[clipDragItem.time]} alt="" draggable={false}/>
              : <div className="stage-card-icon-wrap">
                  {clipDragItem.items?.[0]?.icon
                    ? <img className="native-stage-card-icon" src={clipDragItem.items[0].icon} alt="" draggable={false}/>
                    : <FileGlyph size={30} {...fileGlyphFor(clipDragItem)}/>}
                </div>}
        </div>
        <div className="stage-card-label">
          <span className="stage-card-name">{buildNativeDragLabel(clipDragItem,t)}</span>
          <span className="stage-card-meta">{buildNativeDragMeta(clipDragItem,t)}</span>
        </div>
      </div>
    )}
   </>
  );
}
