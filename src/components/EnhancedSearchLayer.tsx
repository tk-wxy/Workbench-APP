import { Fragment, type MouseEventHandler, type ReactNode, type RefObject } from "react";
import { FileGlyph, IconExplorer, IconSearch } from "../icons";
import type { FileGlyphArgs, FileGroup } from "../lib/format";
import type { EnhResult } from "../types";

type Translate = (zh: string, vars?: Record<string, string | number>) => string;

interface PreviewFact {
  label: string;
  value: string;
  title?: string;
  pending?: boolean;
}

interface PreviewRow extends PreviewFact {
  rtl?: boolean;
}

export interface EnhancedSearchPreview {
  r: EnhResult;
  title: string;
  badge: string;
  group: FileGroup;
  low: string | null;
  hi: string | null;
  photo: boolean;
  glyph: FileGlyphArgs | null;
  text: string | null;
  loc: string | null;
  locText: string;
  stats: PreviewFact[];
  rows: PreviewRow[];
  path: string;
}

export interface EnhancedSearchActions {
  activate: (result: EnhResult) => void;
  reveal: (path: string) => void;
  addPreviewToLauncher: (preview: EnhancedSearchPreview) => void;
  addFileToStage: (result: Extract<EnhResult, { kind: "fs" }>, title: string) => void;
}

interface EnhancedSearchLayerProps {
  open: boolean;
  pinned: boolean;
  query: string;
  inputRef: RefObject<HTMLInputElement>;
  resultsRef: RefObject<HTMLDivElement>;
  rows: ReactNode;
  resultCount: number;
  sectionCount: number;
  searchDefaultMode: "page" | "enhanced";
  enhancedHotkeyLabel: string;
  searchEngine: "builtin" | "everything";
  everythingAvailable: boolean;
  indexReady: boolean;
  preview: EnhancedSearchPreview | null;
  t: Translate;
  actions: EnhancedSearchActions;
  onQueryChange: (query: string) => void;
  onResultsMouseMove: MouseEventHandler<HTMLDivElement>;
}

export default function EnhancedSearchLayer({
  open,
  pinned,
  query,
  inputRef,
  resultsRef,
  rows,
  resultCount,
  sectionCount,
  searchDefaultMode,
  enhancedHotkeyLabel,
  searchEngine,
  everythingAvailable,
  indexReady,
  preview,
  t,
  actions,
  onQueryChange,
  onResultsMouseMove,
}: EnhancedSearchLayerProps) {
  const hasQuery = !!query.trim();

  return (
    <div className={`enh-layer${open ? " enh-open" : ""}${pinned ? " enh-pinned" : ""}`}>
      <div className="enh-search-box">
        <IconSearch size={18}/>
        <input
          ref={inputRef}
          className="enh-search-input"
          placeholder={t("搜索应用、中转、剪贴板…")}
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          spellCheck={false}
        />
        <span className="enh-hint">
          {sectionCount > 1 && <><kbd>Ctrl+↑↓</kbd> {t("换区")} · </>}
          {searchDefaultMode === "enhanced" && <><kbd>{enhancedHotkeyLabel}</kbd> {t("界面搜索")} · </>}
          <kbd>Esc</kbd> {t("关闭")}
        </span>
      </div>
      {hasQuery && searchEngine === "everything" && !everythingAvailable
        ? <div className="enh-index-hint">{t("Everything 未运行，已回退内置搜索")}</div>
        : !indexReady && hasQuery ? <div className="enh-index-hint">{t("文件索引建立中…")}</div> : null}
      <div className="enh-body">
        <div className="enh-results" ref={resultsRef} onMouseMove={onResultsMouseMove}>
          {resultCount ? rows : <p className="empty-hint">{hasQuery ? t("无匹配") : t("输入以搜索")}</p>}
        </div>
        {preview && (
          <aside className="enh-preview" data-kind={preview.r.kind}>
            <div className="enh-pv-head">
              <div className={`enh-pv-icon${preview.photo ? " enh-pv-icon-img" : ""}`}>
                {preview.low && <img className={`enh-pv-ic-low${preview.hi ? " is-hidden" : ""}`} src={preview.low} alt="" draggable={false}/>}
                {preview.hi && <img src={preview.hi} alt="" draggable={false}/>}
                {!preview.low && !preview.hi && <FileGlyph size={56} {...(preview.glyph ?? {})}/>}
              </div>
              <div className="enh-pv-identity">
                <div className="enh-pv-title" title={preview.title}>{preview.title}</div>
                <div className="enh-pv-badge" data-group={preview.group}>{preview.badge}</div>
              </div>
            </div>
            <div className="enh-pv-content">
              <div className={`enh-pv-loc${preview.loc ? "" : " enh-pv-loc-source"}`} title={preview.locText}>
                <IconExplorer size={13} className="enh-pv-loc-ic"/>
                <span className="enh-pv-loc-t">{preview.locText}</span>
              </div>
              {preview.text && <div className="enh-pv-text">{preview.text.slice(0, 600)}</div>}
              {preview.stats.length > 0 && (
                <div className="enh-pv-stats">
                  {preview.stats.map((fact, index) => (
                    <div className="enh-pv-stat" key={index} title={fact.title}>
                      <div className={`enh-pv-stat-v${fact.pending ? " enh-pv-pending" : ""}`}>{fact.value}</div>
                      <div className="enh-pv-stat-l">{fact.label}</div>
                    </div>
                  ))}
                </div>
              )}
              {preview.rows.length > 0 && (
                <dl className="enh-pv-rows">
                  {preview.rows.map((row, index) => (
                    <Fragment key={index}>
                      <dt>{row.label}</dt>
                      <dd className={`${row.rtl ? "enh-pv-rtl" : ""}${row.pending ? " enh-pv-pending" : ""}`.trim() || undefined} title={row.title ?? row.value}>{row.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
            <div className="enh-pv-actions">
              <button className="enh-pv-btn enh-pv-btn-primary" onClick={() => actions.activate(preview.r)}>
                {preview.r.kind === "clip" ? t("取走粘贴") : t("打开")}
              </button>
              {preview.path && <button className="enh-pv-btn" onClick={() => actions.reveal(preview.path)}>{t("打开所在目录")}</button>}
              {preview.path && preview.r.kind !== "clip" && <button className="enh-pv-btn" onClick={() => actions.addPreviewToLauncher(preview)}>{t("加入启动台")}</button>}
              {preview.r.kind === "fs" && <button className="enh-pv-btn" onClick={() => actions.addFileToStage(preview.r as Extract<EnhResult, { kind: "fs" }>, preview.title)}>{t("加入中转区")}</button>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
