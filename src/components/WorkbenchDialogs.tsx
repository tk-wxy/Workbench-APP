import type { RefObject } from "react";
import type { makeT } from "../i18n";
import type { AppInfo, LauncherImportPreview, LauncherItem, StageItem } from "../types";
import { FileGlyph, IconClose, IconSearch, IconWarn } from "../icons";
import HighlightText from "./HighlightText";

type TFn = ReturnType<typeof makeT>;

export interface LauncherPickerDialogProps {
  query: string;
  inputRef: RefObject<HTMLInputElement>;
  results: { app: AppInfo; ranges: [number, number][] }[];
  launcherPicking: boolean;
  t: TFn;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onPickPath: (kind: "file" | "folder") => void;
  onAddApp: (app: AppInfo) => void;
}

export function LauncherPickerDialog({
  query,
  inputRef,
  results,
  launcherPicking,
  t,
  onClose,
  onQueryChange,
  onPickPath,
  onAddApp,
}: LauncherPickerDialogProps) {
  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-modal picker-modal" onClick={event => event.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">{t("添加到启动台")}</span>
          <button className="settings-close" onClick={onClose} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
        </div>
        <div className="picker-search">
          <IconSearch size={16}/>
          <input ref={inputRef} className="picker-search-input" autoFocus placeholder={t("搜索要添加的应用…")} value={query} onChange={event => onQueryChange(event.target.value)} spellCheck={false}/>
        </div>
        <div className="picker-browse">
          <span className="picker-browse-label">{t("或收藏任意文件 / 文件夹：")}</span>
          <button className="settings-action" onClick={() => onPickPath("file")} disabled={launcherPicking}>{t("浏览文件…")}</button>
          <button className="settings-action" onClick={() => onPickPath("folder")} disabled={launcherPicking}>{t("浏览文件夹…")}</button>
        </div>
        <div className="picker-list">
          {results.length ? results.map(({ app, ranges }) => (
            <div key={app.path} className="enh-result" onClick={() => onAddApp(app)} title={t("点击添加到启动器")}>
              <div className="enh-result-icon">{app.icon ? <img src={app.icon} alt=""/> : <span>{app.name[0]}</span>}</div>
              <span className="enh-result-label"><HighlightText text={app.name} ranges={ranges}/></span>
            </div>
          )) : <p className="empty-hint">{query.trim() ? t("无匹配应用") : t("暂无可添加应用")}</p>}
        </div>
        <div className="picker-foot">{t("点击添加，可连续添加；")}<kbd>Esc</kbd> {t("关闭")}</div>
      </div>
    </div>
  );
}

export interface StageRecoveryDialogProps {
  items: StageItem[];
  missingPaths: Set<string>;
  t: TFn;
  onClose: () => void;
  onRelink: (item: StageItem) => void;
  onCopyPath: (path: string) => void;
  onRemove: (id: number) => void;
}

export function StageRecoveryDialog({ items, missingPaths, t, onClose, onRelink, onCopyPath, onRemove }: StageRecoveryDialogProps) {
  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-modal stage-recovery-modal" onClick={event => event.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">{t("处理中转站失效项")}</span>
          <button className="settings-close" onClick={onClose} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
        </div>
        <div className="stage-recovery-list">
          {items.map(item => {
            const lost = (item.items ?? []).filter(file => missingPaths.has(file.path));
            const singleLost = item.type === "file" && item.items?.length === 1 && lost.length === 1;
            const label = item.name || item.items?.[0]?.name || t("文件");
            return <div key={item.id} className="stage-recovery-item">
              <div className="stage-recovery-main">
                <IconWarn size={16}/>
                <div>
                  <div className="stage-recovery-name" title={label}>{label}</div>
                  <div className="stage-recovery-meta">{t("原文件已失踪（可能被删除或移动）")}</div>
                  {lost.map(file => <div key={file.path} className="stage-recovery-path" title={file.path}>{file.path}</div>)}
                </div>
              </div>
              <div className="stage-recovery-actions">
                {singleLost && <button className="settings-action" onClick={() => onRelink(item)}>{t("重新定位…")}</button>}
                {lost[0] && <button className="settings-action" onClick={() => onCopyPath(lost[0].path)}>{t("复制原路径")}</button>}
                <button className="settings-action danger" onClick={() => onRemove(item.id)}>{t("删除该项目")}</button>
              </div>
            </div>;
          })}
          {!items.length && <p className="empty-hint">{t("暂无失效条目")}</p>}
        </div>
        <div className="picker-foot">{t("失效条目会保留在中转站，直到你主动处理。")}</div>
      </div>
    </div>
  );
}

export interface LauncherManagerDialogProps {
  items: LauncherItem[];
  selected: Set<number>;
  preview: LauncherImportPreview | null;
  busy: boolean;
  t: TFn;
  onClose: () => void;
  onBackFromPreview: () => void;
  onConfirmImport: () => void;
  onToggleAll: () => void;
  onToggleItem: (id: number) => void;
  onDeleteSelected: () => void;
  onChooseImport: () => void;
  onExport: () => void;
}

export function LauncherManagerDialog({
  items,
  selected,
  preview,
  busy,
  t,
  onClose,
  onBackFromPreview,
  onConfirmImport,
  onToggleAll,
  onToggleItem,
  onDeleteSelected,
  onChooseImport,
  onExport,
}: LauncherManagerDialogProps) {
  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-modal launcher-manager-modal" onClick={event => event.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">{t("启动台批量管理")}</span>
          <button className="settings-close" onClick={onClose} title={t("关闭")} aria-label={t("关闭")}><IconClose size={20}/></button>
        </div>
        {preview ? (
          <div className="launcher-import-preview">
            <div className="settings-panel-title">{t("导入预览")}</div>
            <p>{t("将新增 {n} 项", { n: preview.items.length })}</p>
            {preview.duplicates > 0 && <p>{t("跳过重复 {n} 项", { n: preview.duplicates })}</p>}
            {preview.invalid > 0 && <p>{t("忽略无效 {n} 项", { n: preview.invalid })}</p>}
            {preview.overCapacity > 0 && <p>{t("受上限影响，未导入 {n} 项", { n: preview.overCapacity })}</p>}
            <p className="settings-hint">{t("导入采用合并方式，不会覆盖已有收藏。")}</p>
            <div className="launcher-manager-actions">
              <button className="settings-action" onClick={onBackFromPreview}>{t("返回")}</button>
              <button className="settings-action" onClick={onConfirmImport} disabled={!preview.items.length}>{t("确认导入")}</button>
            </div>
          </div>
        ) : (<>
          <div className="launcher-manager-toolbar">
            <span>{t("已选 {n} 项", { n: selected.size })}</span>
            <div className="settings-inline-actions">
              <button className="settings-action" onClick={onToggleAll} disabled={!items.length}>{selected.size === items.length && items.length ? t("取消全选") : t("全选")}</button>
              <button className="settings-action danger" onClick={onDeleteSelected} disabled={!selected.size}>{t("删除已选（{n}）", { n: selected.size })}</button>
            </div>
          </div>
          <div className="launcher-manager-list">
            {items.length ? items.map(item => (
              <label key={item.id} className={`launcher-manager-item${selected.has(item.id) ? " selected" : ""}`}>
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggleItem(item.id)}/>
                <div className="launcher-manager-icon">{item.icon ? <img src={item.icon} alt=""/> : <FileGlyph ext={item.ext} isDir={item.kind === "folder"}/>}</div>
                <span className="launcher-manager-name" title={item.name}>{item.name}</span>
                <span className="launcher-manager-kind">{t(item.kind === "app" ? "应用程序" : item.kind === "folder" ? "文件夹" : "文件")}</span>
              </label>
            )) : <p className="empty-hint">{t("暂无收藏条目")}</p>}
          </div>
          <div className="launcher-manager-foot">
            <span className="settings-hint">{t("布局文件可用于备份或迁移；导入不会覆盖已有收藏。")}</span>
            <div className="settings-inline-actions">
              <button className="settings-action" onClick={onChooseImport} disabled={busy}>{t("导入布局")}</button>
              <button className="settings-action" onClick={onExport} disabled={!items.length || busy}>{t("导出布局")}</button>
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}
