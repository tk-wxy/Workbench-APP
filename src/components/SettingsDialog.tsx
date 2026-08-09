import type { makeT, Lang } from "../i18n";
import { LAUNCHER_MAX } from "../domain/launcherLayout";
import { STAGE_MAX_OPTIONS } from "../domain/stageSettings";
import {
  IconBox,
  IconCheck,
  IconClipboard,
  IconClose,
  IconInfo,
  IconKeyboard,
  IconRocket,
  IconSearch,
  IconSettings,
} from "../icons";

type TFn = ReturnType<typeof makeT>;
type Theme = "dark" | "light" | "system";
type SearchMode = "page" | "enhanced";
type SearchEngine = "builtin" | "everything";
type StageLayout = "list" | "grid";
export type RecordingTarget = null | "main" | "enh";

const SETTINGS_TABS = [
  { id: "general", Icon: IconSettings, label: "常规" },
  { id: "launcher", Icon: IconRocket, label: "启动台" },
  { id: "stage", Icon: IconBox, label: "中转站" },
  { id: "clipboard", Icon: IconClipboard, label: "剪贴板" },
  { id: "search", Icon: IconSearch, label: "搜索" },
  { id: "hotkeys", Icon: IconKeyboard, label: "快捷键" },
  { id: "about", Icon: IconInfo, label: "关于" },
] as const;

const CLIPBOARD_MAX_OPTIONS = [10, 20, 50, 100] as const;

export type SettingsTab = typeof SETTINGS_TABS[number]["id"];

export interface GeneralSettingsModel {
  theme: Theme;
  lang: Lang;
  autostartEnabled: boolean;
  onChangeTheme: (theme: Theme) => void;
  onChangeLang: (lang: Lang) => void;
  onChangeAutostart: (enabled: boolean) => void;
}

export interface LauncherSettingsModel {
  count: number;
  onOpenPicker: () => void;
  onOpenManager: () => void;
  onClear: () => void;
}

export interface StageSettingsModel {
  layout: StageLayout;
  count: number;
  max: number;
  missingCount: number;
  dragoutAutoClose: boolean;
  persist: boolean;
  showShortcuts: boolean;
  thumbnailCacheCleared: boolean;
  onChangeLayout: (layout: StageLayout) => void;
  onClear: () => void;
  onOpenRecovery: () => void;
  onCleanupMissing: () => void;
  onChangeMax: (max: number) => void;
  onChangeDragoutAutoClose: (enabled: boolean) => void;
  onChangePersist: (enabled: boolean) => void;
  onChangeShowShortcuts: (enabled: boolean) => void;
  onOpenThumbnailDirectory: () => void;
  onClearThumbnailCache: () => void;
}

export interface ClipboardSettingsModel {
  count: number;
  max: number;
  imageCacheCleared: boolean;
  onChangeMax: (max: number) => void;
  onClear: () => void;
  onOpenImageDirectory: () => void;
  onClearImageCache: () => void;
}

export interface SearchSettingsModel {
  defaultMode: SearchMode;
  engine: SearchEngine;
  everythingAvailable: boolean;
  redetected: boolean;
  dirs: string[];
  dirPicking: boolean;
  enhancedHotkeyLabel: string;
  onChangeDefaultMode: (mode: SearchMode) => void;
  onChangeEngine: (engine: SearchEngine) => void;
  onRedetectEverything: () => void;
  onPickDir: () => void;
  onRemoveDir: (dir: string) => void;
}

export interface HotkeySettingsModel {
  combo: string;
  input: string;
  error: string;
  enhancedCombo: string;
  enhancedInput: string;
  enhancedError: string;
  recording: RecordingTarget;
  onInputChange: (value: string) => void;
  onEnhancedInputChange: (value: string) => void;
  onApply: (value: string) => void;
  onApplyEnhanced: (value: string) => void;
  onToggleRecording: (target: Exclude<RecordingTarget, null>) => void;
}

export interface SettingsDialogProps {
  tab: SettingsTab;
  version: string;
  t: TFn;
  general: GeneralSettingsModel;
  launcher: LauncherSettingsModel;
  stage: StageSettingsModel;
  clipboard: ClipboardSettingsModel;
  search: SearchSettingsModel;
  hotkeys: HotkeySettingsModel;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
}

export default function SettingsDialog({
  tab,
  version,
  t,
  general,
  launcher,
  stage,
  clipboard,
  search,
  hotkeys,
  onTabChange,
  onClose,
}: SettingsDialogProps) {
  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-modal" onClick={event => event.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">{t("设置")}</span>
          <button className="settings-close" onClick={onClose} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav">
            {SETTINGS_TABS.map(item => (
              <button key={item.id} className={`settings-nav-item${tab === item.id ? " settings-nav-active" : ""}`} onClick={() => onTabChange(item.id)}>
                <span className="settings-nav-icon"><item.Icon size={16}/></span>{t(item.label)}
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {tab === "general" && (<>
              <div className="settings-panel-title">{t("常规")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("背景主题")}</span>
                <div className="seg">
                  {([ ["dark", "深色"], ["light", "浅色"], ["system", "系统"] ] as const).map(([value, label]) => (
                    <button key={value} className={`seg-btn${general.theme === value ? " seg-active" : ""}`} onClick={() => general.onChangeTheme(value)}>{t(label)}</button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("语言")}</span>
                <div className="seg">
                  {([ ["zh", "中文"], ["en", "English"] ] as const).map(([value, label]) => (
                    <button key={value} className={`seg-btn${general.lang === value ? " seg-active" : ""}`} onClick={() => general.onChangeLang(value)}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("开机自启")}</span>
                <div className="seg">
                  <button className={`seg-btn${general.autostartEnabled ? " seg-active" : ""}`} onClick={() => general.onChangeAutostart(true)}>{general.lang === "en" ? "On" : "开启"}</button>
                  <button className={`seg-btn${!general.autostartEnabled ? " seg-active" : ""}`} onClick={() => general.onChangeAutostart(false)}>{general.lang === "en" ? "Off" : "关闭"}</button>
                </div>
              </div>
              <p className="settings-hint">{t("这里仅保留全局外观与启动行为；启动台、中转站、剪贴板和搜索分别在独立条目中设置。")}</p>
            </>)}
            {tab === "launcher" && (<>
              <div className="settings-panel-title">{t("启动台")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("收藏条目")}<span className="settings-row-sub">{launcher.count} / {LAUNCHER_MAX}</span></span>
                <div className="settings-inline-actions">
                  <button className="settings-action" onClick={launcher.onOpenPicker}>{t("添加到启动台")}</button>
                  <button className="settings-action" onClick={launcher.onOpenManager}>{t("批量管理")}</button>
                  <button className="settings-action danger" onClick={launcher.onClear} disabled={!launcher.count}>{t("清空")}</button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("排序方式")}<span className="settings-row-sub">{t("拖拽调整")}</span></span>
                <span className="settings-row-value">{t("手动排序")}</span>
              </div>
              <p className="settings-hint">{t("启动台只负责打开应用、文件或文件夹；与中转站的取走粘贴动作保持分离。")}</p>
            </>)}
            {tab === "stage" && (<>
              <div className="settings-panel-title">{t("中转站")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("显示布局")}</span>
                <div className="seg">
                  <button className={`seg-btn${stage.layout === "list" ? " seg-active" : ""}`} onClick={() => stage.onChangeLayout("list")}>{t("列表")}</button>
                  <button className={`seg-btn${stage.layout === "grid" ? " seg-active" : ""}`} onClick={() => stage.onChangeLayout("grid")}>{t("方格")}</button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("中转条目")}<span className="settings-row-sub">{stage.count} / {stage.max}</span></span>
                <button className="settings-action danger" onClick={stage.onClear} disabled={!stage.count}>{t("清空")}</button>
              </div>
              {stage.missingCount > 0 && (
                <div className="settings-row">
                  <span className="settings-row-label">{t("失效条目")}<span className="settings-row-sub">{t("{n} 条", { n: stage.missingCount })}</span></span>
                  <div className="settings-inline-actions">
                    <button className="settings-action" onClick={stage.onOpenRecovery}>{t("处理失效项")}</button>
                    <button className="settings-action danger" onClick={stage.onCleanupMissing}>{t("清理失效")}</button>
                  </div>
                </div>
              )}
              <div className="settings-row">
                <span className="settings-row-label">{t("上限条数")}</span>
                <div className="seg">
                  {STAGE_MAX_OPTIONS.map(max => (
                    <button key={max} className={`seg-btn${stage.max === max ? " seg-active" : ""}`} onClick={() => stage.onChangeMax(max)}>{max}</button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("拖出后自动关闭")}</span>
                <div className="seg">
                  <button className={`seg-btn${stage.dragoutAutoClose ? " seg-active" : ""}`} onClick={() => stage.onChangeDragoutAutoClose(true)}>{general.lang === "en" ? "On" : "开启"}</button>
                  <button className={`seg-btn${!stage.dragoutAutoClose ? " seg-active" : ""}`} onClick={() => stage.onChangeDragoutAutoClose(false)}>{general.lang === "en" ? "Off" : "关闭"}</button>
                </div>
              </div>
              <p className="settings-hint">{t("中转站存放手动钉入或拖入的文件、文本、图片条目；左键动作为取走粘贴。「开启」（默认）：拖动条目会立即隐藏界面，便于拖到外部应用（资源管理器等）。「关闭」：拖动时界面保持显示，可拖到启动台或中途取消（松手到空白处 / 按 Esc）；要拖到外部应用时，拖动中按一下呼出热键即可隐藏界面、再松手落地。")}</p>
              <div className="settings-row">
                <span className="settings-row-label">{t("持久化")}</span>
                <div className="seg">
                  <button className={`seg-btn${stage.persist ? " seg-active" : ""}`} onClick={() => stage.onChangePersist(true)}>{general.lang === "en" ? "On" : "开启"}</button>
                  <button className={`seg-btn${!stage.persist ? " seg-active" : ""}`} onClick={() => stage.onChangePersist(false)}>{general.lang === "en" ? "Off" : "关闭"}</button>
                </div>
              </div>
              <p className="settings-hint">{t("「关闭」（默认）：条目确认成功移出/拖出后自动从中转区移除。「开启」：条目移出/拖出后仍保留在中转区，除非手动删除。")}</p>
              <div className="settings-row">
                <span className="settings-row-label">{t("底部快捷入口")}</span>
                <div className="seg">
                  <button className={`seg-btn${stage.showShortcuts ? " seg-active" : ""}`} onClick={() => stage.onChangeShowShortcuts(true)}>{general.lang === "en" ? "Show" : "显示"}</button>
                  <button className={`seg-btn${!stage.showShortcuts ? " seg-active" : ""}`} onClick={() => stage.onChangeShowShortcuts(false)}>{general.lang === "en" ? "Hide" : "隐藏"}</button>
                </div>
              </div>
              <p className="settings-hint">{t("中转区下方的截屏 / 文件管理器 / 下载等快捷按钮。隐藏后这块空间归还给中转区，可容纳更多条目。")}</p>
              <div className="settings-row">
                <span className="settings-row-label">{t("缩略图缓存")}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="settings-action" onClick={stage.onOpenThumbnailDirectory}>{t("打开文件夹")}</button>
                  <button className={`settings-action danger${stage.thumbnailCacheCleared ? " copied" : ""}`} onClick={stage.onClearThumbnailCache}>{stage.thumbnailCacheCleared ? <><IconCheck size={12}/> {t("已清空")}</> : t("清空缓存")}</button>
                </div>
              </div>
              <p className="settings-hint">{t("中转区图片文件的缩略图缓存，命中后重启秒开。清空后下次显示会按需重新生成，不影响原文件。")}</p>
            </>)}
            {tab === "clipboard" && (<>
              <div className="settings-panel-title">{t("剪贴板")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("历史保存条数")}</span>
                <div className="seg">
                  {CLIPBOARD_MAX_OPTIONS.map(max => (
                    <button key={max} className={`seg-btn${clipboard.max === max ? " seg-active" : ""}`} onClick={() => clipboard.onChangeMax(max)}>{max}</button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">{t("剪贴板历史")}<span className="settings-row-sub">{t("{n} 条", { n: clipboard.count })}</span></span>
                <button className="settings-action danger" onClick={clipboard.onClear} disabled={!clipboard.count}>{t("清空")}</button>
              </div>
              <p className="settings-hint">{t("复制的文本、图片、文件会自动记录，最多保留 {n} 条。", { n: clipboard.max })}</p>
              <div className="settings-row">
                <span className="settings-row-label">{t("图片原图缓存")}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="settings-action" onClick={clipboard.onOpenImageDirectory}>{t("打开文件夹")}</button>
                  <button className={`settings-action danger${clipboard.imageCacheCleared ? " copied" : ""}`} onClick={clipboard.onClearImageCache}>{clipboard.imageCacheCleared ? <><IconCheck size={12}/> {t("已清空")}</> : t("清空缓存")}</button>
                </div>
              </div>
              <p className="settings-hint">{t("历史图片原图存放于此，清空后历史图粘贴退回缩略图质量。")}</p>
            </>)}
            {tab === "search" && (<>
              <div className="settings-panel-title">{t("搜索")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("呼出默认搜索")}</span>
                <div className="seg">
                  <button className={`seg-btn${search.defaultMode === "page" ? " seg-active" : ""}`} onClick={() => search.onChangeDefaultMode("page")}>{t("界面搜索")}</button>
                  <button className={`seg-btn${search.defaultMode === "enhanced" ? " seg-active" : ""}`} onClick={() => search.onChangeDefaultMode("enhanced")}>{t("增强搜索")}</button>
                </div>
              </div>
              <p className="settings-hint">{search.defaultMode === "enhanced" ? t("呼出后顶栏输入直接进入增强搜索；{combo}切换为界面搜索。", { combo: search.enhancedHotkeyLabel }) : t("呼出后顶栏搜索过滤界面内容；{combo}进入增强搜索（共用顶栏）。", { combo: search.enhancedHotkeyLabel })}</p>
              <div className="settings-row">
                <span className="settings-row-label">{t("搜索引擎")}</span>
                <div className="seg">
                  <button className={`seg-btn${search.engine === "builtin" ? " seg-active" : ""}`} onClick={() => search.onChangeEngine("builtin")}>{t("内置")}</button>
                  <button className={`seg-btn${search.engine === "everything" ? " seg-active" : ""}`} onClick={() => search.onChangeEngine("everything")}>Everything</button>
                </div>
              </div>
              {search.engine === "everything" && (
                <div className="settings-row">
                  <span className="settings-row-label">{t("连接状态")}<span className="settings-row-sub">{search.everythingAvailable ? t("已连接") : t("未连接")}</span></span>
                  <button className={`settings-action${search.redetected ? " copied" : ""}`} onClick={search.onRedetectEverything}>{search.redetected ? <><IconCheck size={12}/> {t("已检测")}</> : t("重新检测")}</button>
                </div>
              )}
              {search.engine === "everything" && !search.everythingAvailable && <p className="settings-hint settings-hint-error">{t("未检测到 Everything（需安装 Everything 并保持其后台运行，DLL 已随应用内置）。查询将自动回退到内置引擎。换 DLL / 启动 Everything 后点「重新检测」即可热更新，无需重启。")}</p>}
              {search.engine === "everything" && search.everythingAvailable && <p className="settings-hint">{t("已连接 Everything，查询覆盖全盘、即时。")}</p>}
              <p className="settings-hint">{t("内置引擎扫描整个用户目录（含下方额外目录），无需任何外部依赖；Everything 覆盖全盘但需另装。")}</p>
              {search.engine === "builtin" && (<>
                <div className="settings-row">
                  <span className="settings-row-label">{t("额外扫描目录")}</span>
                  <button className="settings-action" onClick={search.onPickDir} disabled={search.dirPicking}>{t("浏览…")}</button>
                </div>
                {search.dirs.length > 0 ? <div className="search-dir-list">{search.dirs.map(dir => (
                  <div key={dir} className="search-dir-item"><span className="search-dir-path" title={dir}>{dir}</span><button className="search-dir-remove" onClick={() => search.onRemoveDir(dir)} title={t("移除")}><IconClose size={14}/></button></div>
                ))}</div> : <p className="settings-hint">{t("默认仅扫描用户目录（桌面/下载/文档…）。如需搜其他盘符，在此添加根目录。")}</p>}
                <p className="settings-hint">{t("添加目录后约几秒完成后台重建即可搜到；node_modules / .git 等噪音目录自动跳过。")}</p>
              </>)}
            </>)}
            {tab === "hotkeys" && (<>
              <div className="settings-panel-title">{t("快捷键")}</div>
              <div className="settings-row">
                <span className="settings-row-label">{t("呼出 / 隐藏")}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input className="hotkey-input" value={hotkeys.input} onChange={event => hotkeys.onInputChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); hotkeys.onApply(hotkeys.input); } }} placeholder={t("如 ctrl+shift+f")} spellCheck={false} readOnly={hotkeys.recording === "main"}/>
                  <button className={`settings-action${hotkeys.recording === "main" ? " recording" : ""}`} onClick={() => hotkeys.onToggleRecording("main")}>{hotkeys.recording === "main" ? t("按下快捷键…") : t("录制")}</button>
                  <button className="settings-action" onClick={() => hotkeys.onApply(hotkeys.input)}>{t("应用")}</button>
                </div>
              </div>
              {hotkeys.error && <p className="settings-hint settings-hint-error">{t(hotkeys.error)}</p>}
              {hotkeys.combo !== "ctrl+space" && <button className="settings-action" onClick={() => hotkeys.onApply("ctrl+space")}>{t("恢复默认")}</button>}
              <div className="settings-row">
                <span className="settings-row-label">{t("增强搜索")}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input className="hotkey-input" value={hotkeys.enhancedInput} onChange={event => hotkeys.onEnhancedInputChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); hotkeys.onApplyEnhanced(hotkeys.enhancedInput); } }} placeholder={t("如 ctrl+k")} spellCheck={false} readOnly={hotkeys.recording === "enh"}/>
                  <button className={`settings-action${hotkeys.recording === "enh" ? " recording" : ""}`} onClick={() => hotkeys.onToggleRecording("enh")}>{hotkeys.recording === "enh" ? t("按下快捷键…") : t("录制")}</button>
                  <button className="settings-action" onClick={() => hotkeys.onApplyEnhanced(hotkeys.enhancedInput)}>{t("应用")}</button>
                </div>
              </div>
              {hotkeys.enhancedError && <p className="settings-hint settings-hint-error">{t(hotkeys.enhancedError)}</p>}
              {hotkeys.enhancedCombo !== "ctrl+k" && <button className="settings-action" onClick={() => hotkeys.onApplyEnhanced("ctrl+k")}>{t("恢复默认")}</button>}
              <p className="settings-hint">{t("点「录制」后直接按下组合键自动填入；也可手动输入。")}</p>
              <p className="settings-hint" style={{ marginTop: "4px" }}>{t("格式：ctrl+x · alt+q · ctrl+shift+x · f9")}</p>
              <p className="settings-hint" style={{ marginTop: "4px" }}>{t("· 不支持 Win 键及 Alt+Space / Alt+F4（系统保留）")}<br/>{t("· 修饰键 Ctrl / Shift / Alt 可选；纯主键会全局抢占该键，慎设")}<br/>{t("· 中文输入法下录制前请先切换到英文输入法")}</p>
              <div className="settings-row"><span className="settings-row-label">{t("关闭面板")}</span><kbd>Esc</kbd></div>
              <div className="settings-row"><span className="settings-row-label">{t("应用导航")}</span><kbd>↑↓</kbd></div>
              <div className="settings-row"><span className="settings-row-label">{t("启动选中应用")}</span><kbd>Enter</kbd></div>
              <p className="settings-hint">{t("长按 = 按住显示松开关闭；短按 = 切换显隐。")}</p>
            </>)}
            {tab === "about" && (
              <>
                <div className="settings-panel-title">{t("关于")}</div>
                <div className="settings-about">
                  <div>Workbench <b>v{version}</b></div>
                  <div>{t("Windows 全屏「第二桌面」工具")}</div>
                  <div>{t("应用启动器 · 文件中转 · 剪贴板历史")}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
