// Extracted view contract tests: bundle the real TSX components and render them without a browser.
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "component-contracts-"));
const outfile = join(dir, "bundle.mjs");
await build({
  stdin: {
    contents: [
      'export { default as LauncherPanel } from "./src/components/LauncherPanel";',
      'export { default as ClipboardPanel } from "./src/components/ClipboardPanel";',
      'export { StageGridCard, StageListRow } from "./src/components/StageItems";',
      'export { default as EnhancedSearchLayer } from "./src/components/EnhancedSearchLayer";',
      'export { WorkbenchSearchHeader, WorkbenchFooter } from "./src/components/WorkbenchChrome";',
      'export { default as SettingsDialog } from "./src/components/SettingsDialog";',
      'export { LauncherPickerDialog, StageRecoveryDialog, LauncherManagerDialog } from "./src/components/WorkbenchDialogs";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "component-contracts.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});
const { LauncherPanel, ClipboardPanel, StageGridCard, StageListRow, EnhancedSearchLayer, WorkbenchSearchHeader, WorkbenchFooter, SettingsDialog, LauncherPickerDialog, StageRecoveryDialog, LauncherManagerDialog } = await import(pathToFileURL(outfile).href);

const noop = () => {};
const t = (zh, vars) => vars ? zh.replace(/\{(\w+)\}/g, (_, key) => String(vars[key])) : zh;
let failed = 0;
const check = (name, condition, html = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${html ? `\n      ${html.slice(0, 300)}` : ""}`);
};

console.log("\n抽取组件 —— DOM / 缩略图 / 常驻层契约");

const launcherHtml = renderToStaticMarkup(createElement(LauncherPanel, {
  items: [{ id: 1, kind: "file", name: "photo.png", path: "C:/photo.png", ext: "png" }],
  totalCount: 1,
  search: "",
  selectedIndex: 0,
  missingIds: new Set([1]),
  thumbnails: { "C:/photo.png": "data:image/png;base64,thumb" },
  t,
  onOpenManager: noop,
  onOpenPicker: noop,
  onOpenItem: noop,
  onOpenContextMenu: noop,
  onPointerDown: noop,
}));
check("启动台保留 app-grid / app-tile 选择器", launcherHtml.includes('class="app-grid"') && launcherHtml.includes("app-tile selected launcher-missing"), launcherHtml);
check("启动台图片文件只渲染传入缩略图", launcherHtml.includes('class="app-tile-thumb"') && launcherHtml.includes("base64,thumb"), launcherHtml);

const clipItem = { type: "image", time: 7, orig_degraded: true };
const clipboardHtml = renderToStaticMarkup(createElement(ClipboardPanel, {
  items: [clipItem],
  search: "",
  thumbnails: { 7: "data:image/png;base64,clipthumb" },
  copiedTime: 7,
  t,
  actions: { activate: noop, addToStage: noop, copy: noop, delete: noop, openContextMenu: noop },
  drag: { pointerDown: noop, pointerMove: noop, pointerUp: noop, pointerCancel: noop, lostPointerCapture: noop },
}));
check("剪贴板保留 clip-block 与降级标记", clipboardHtml.includes('class="clip-block"') && clipboardHtml.includes("clip-degraded-badge"), clipboardHtml);
check("剪贴板图片只渲染传入缩略图", clipboardHtml.includes("base64,clipthumb") && !clipboardHtml.includes("orig_path"), clipboardHtml);

const stageItem = { id: 9, type: "file", items: [{ path: "C:/lost.txt", name: "lost.txt", ext: "txt", isImage: false }], count: 1, name: "lost.txt", ext: "txt" };
const stageCommon = {
  item: stageItem,
  index: 0,
  selected: true,
  missing: true,
  multiselect: false,
  persistAll: false,
  copied: false,
  t,
  actions: { activate: noop, openContextMenu: noop, togglePin: noop, copy: noop, remove: noop, open: noop },
  pointer: { pointerDown: noop, pointerMove: noop, pointerUp: noop, lostPointerCapture: noop },
};
const stageGridHtml = renderToStaticMarkup(createElement(StageGridCard, stageCommon));
const stageListHtml = renderToStaticMarkup(createElement(StageListRow, stageCommon));
check("中转双布局保留 data-stage-id 与根选择器", stageGridHtml.includes('data-stage-id="9"') && stageGridHtml.includes("stage-card selected stage-missing") && stageListHtml.includes("stage-item selected stage-missing"), stageGridHtml + stageListHtml);
check("失效中转项不渲染复制/打开操作", !stageGridHtml.includes("复制到剪贴板") && !stageListHtml.includes('title="打开"'), stageGridHtml + stageListHtml);

const enhancedHtml = renderToStaticMarkup(createElement(EnhancedSearchLayer, {
  open: false,
  pinned: false,
  query: "",
  inputRef: { current: null },
  resultsRef: { current: null },
  rows: null,
  resultCount: 0,
  sectionCount: 0,
  searchDefaultMode: "page",
  enhancedHotkeyLabel: "Ctrl+K",
  searchEngine: "builtin",
  everythingAvailable: false,
  indexReady: false,
  preview: null,
  t,
  actions: { activate: noop, reveal: noop, addPreviewToLauncher: noop, addFileToStage: noop },
  onQueryChange: noop,
  onResultsMouseMove: noop,
}));
check("增强搜索关闭时仍保持 enh-layer 挂载", enhancedHtml.includes('class="enh-layer"') && enhancedHtml.includes("输入以搜索"), enhancedHtml);

const headerHtml = renderToStaticMarkup(createElement(WorkbenchSearchHeader, {
  search: "query",
  searchRef: { current: null },
  t,
  onSearchChange: noop,
}));
check("顶栏抽取后保留品牌与搜索选择器", headerHtml.includes('class="top-left"') && headerHtml.includes('class="global-search"') && headerHtml.includes('value="query"'), headerHtml);

const footerHtml = renderToStaticMarkup(createElement(WorkbenchFooter, {
  hotkeyCombo: "ctrl+space",
  enhancedHotkey: "ctrl+k",
  enhancedOpen: false,
  version: "0.22.0",
  t,
}));
check("底栏抽取后保留快捷键与版本信息", footerHtml.includes('class="bottom-bar"') && footerHtml.includes("Ctrl+Space") && footerHtml.includes("Workbench v0.22.0"), footerHtml);

const settingsHtml = renderToStaticMarkup(createElement(SettingsDialog, {
  tab: "about",
  version: "0.23.0",
  t,
  general: {},
  launcher: {},
  stage: {},
  clipboard: {},
  search: {},
  hotkeys: {},
  onTabChange: noop,
  onClose: noop,
}));
check("设置弹层保留导航、面板和版本信息", settingsHtml.includes('class="settings-nav"') && settingsHtml.includes('class="settings-panel"') && settingsHtml.includes("Workbench <b>v0.23.0</b>"), settingsHtml);

const pickerHtml = renderToStaticMarkup(createElement(LauncherPickerDialog, {
  query: "cal",
  inputRef: { current: null },
  results: [{ app: { path: "C:/calc.exe", name: "Calculator", icon: null }, ranges: [[0, 2]] }],
  launcherPicking: false,
  t,
  onClose: noop,
  onQueryChange: noop,
  onPickPath: noop,
  onAddApp: noop,
}));
check("应用选择弹层保留搜索与浏览入口", pickerHtml.includes("picker-modal") && pickerHtml.includes("picker-search-input") && pickerHtml.includes("浏览文件夹"), pickerHtml);
check("应用选择高亮保持闭区间范围", pickerHtml.includes(">Cal</span>culator"), pickerHtml);

const recoveryHtml = renderToStaticMarkup(createElement(StageRecoveryDialog, {
  items: [],
  missingPaths: new Set(),
  t,
  onClose: noop,
  onRelink: noop,
  onCopyPath: noop,
  onRemove: noop,
}));
check("失效恢复弹层保留空态与恢复容器", recoveryHtml.includes("stage-recovery-modal") && recoveryHtml.includes("暂无失效条目"), recoveryHtml);

const managerHtml = renderToStaticMarkup(createElement(LauncherManagerDialog, {
  items: [],
  selected: new Set(),
  preview: null,
  busy: false,
  t,
  onClose: noop,
  onBackFromPreview: noop,
  onConfirmImport: noop,
  onToggleAll: noop,
  onToggleItem: noop,
  onDeleteSelected: noop,
  onChooseImport: noop,
  onExport: noop,
}));
check("启动台管理弹层保留工具栏与布局动作", managerHtml.includes("launcher-manager-modal") && managerHtml.includes("导入布局") && managerHtml.includes("导出布局"), managerHtml);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
