import type { MouseEvent, PointerEvent } from "react";
import { ago, fileGlyphFor } from "../lib/format";
import { buildSearchExcerpt, CLIPBOARD_SEARCH_EXCERPT, type TextRange } from "../domain/pageSearchPresentation";
import HighlightText from "./HighlightText";
import {
  FileGlyph,
  IconBox,
  IconCamera,
  IconCheck,
  IconClipboard,
  IconCopy,
  IconPaperclip,
  IconTrash,
  IconWarn,
} from "../icons";
import type { ClipItem } from "../types";

type Translate = (zh: string, vars?: Record<string, string | number>) => string;

export interface ClipboardPanelActions {
  activate: (item: ClipItem) => void;
  addToStage: (item: ClipItem) => void;
  copy: (item: ClipItem) => void;
  delete: (time: number) => void;
  openContextMenu: (event: MouseEvent, item: ClipItem) => void;
}

export interface ClipboardPanelDragHandlers {
  pointerDown: (event: PointerEvent, item: ClipItem) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: () => void;
  lostPointerCapture: () => void;
}

interface ClipboardCardProps {
  item: ClipItem;
  thumbnail?: string;
  copied: boolean;
  t: Translate;
  actions: ClipboardPanelActions;
  drag: ClipboardPanelDragHandlers;
  highlightRanges: TextRange[];
  searchActive: boolean;
}

function ClipboardCard({
  item,
  thumbnail,
  copied,
  t,
  actions,
  drag,
  highlightRanges,
  searchActive,
}: ClipboardCardProps) {
  const textContent = item.content || "";
  const textPreview = searchActive && highlightRanges.length
    ? buildSearchExcerpt(textContent, highlightRanges, CLIPBOARD_SEARCH_EXCERPT)
    : { text: `${textContent.slice(0, 100)}${textContent.length > 100 ? "…" : ""}`, ranges: [] as TextRange[] };
  const fileLabel = item.count === 1 ? item.items?.[0]?.name || "" : t("{n}个文件", { n: item.count ?? 0 });
  return (
    <div
      className="clip-block"
      onClick={() => actions.activate(item)}
      onPointerDown={event => drag.pointerDown(event, item)}
      onPointerMove={drag.pointerMove}
      onPointerUp={drag.pointerUp}
      onPointerCancel={drag.pointerCancel}
      onLostPointerCapture={drag.lostPointerCapture}
      onContextMenu={event => actions.openContextMenu(event, item)}
      title={item.type === "text" ? t("单击左键粘贴") : item.type === "file" ? t("单击左键粘贴文件") : t("单击左键复制")}
    >
      {item.type === "image" ? <>
        {thumbnail
          ? <img className="clip-image" src={thumbnail} alt="" draggable={false}/>
          : <div className="clip-image clip-image-ph" aria-hidden/>}
        {item.orig_degraded && (
          <span className="clip-degraded-badge" title={t("原图不可用，复制、粘贴或拖出时将使用缩略图")}>
            <IconWarn size={15}/>
          </span>
        )}
      </> : item.type === "file" ? (
        <div className="file-clip-preview">
          <span className="clip-file-icon"><FileGlyph size={20} {...fileGlyphFor(item)}/></span>
          <span className="file-clip-info"><HighlightText text={fileLabel} ranges={highlightRanges}/></span>
        </div>
      ) : (
        <span className={`clip-preview${searchActive && highlightRanges.length ? " search-snippet" : ""}`}><HighlightText text={textPreview.text} ranges={textPreview.ranges} variant="body"/></span>
      )}
      <div className="clip-foot">
        <span className="clip-time">
          {item.type === "image" ? <IconCamera size={11}/> : item.type === "file" ? <IconPaperclip size={11}/> : null}
          {ago(item.time, t)}
        </span>
        <div className="clip-actions">
          <button className="clip-stage-btn" onClick={event => { event.stopPropagation(); actions.addToStage(item); }} title={t("加入中转站")}><IconBox size={14}/></button>
          <button className={`clip-copy-btn${copied ? " copied" : ""}`} onClick={event => { event.stopPropagation(); actions.copy(item); }} title={copied ? t("已复制") : t("复制到剪贴板")}>
            {copied ? <IconCheck size={14}/> : <IconCopy size={14}/>}
          </button>
          <button className="clip-del-btn" onClick={event => { event.stopPropagation(); actions.delete(item.time); }} title={t("删除")}><IconTrash size={14}/></button>
        </div>
      </div>
    </div>
  );
}

interface ClipboardPanelProps {
  items: ClipItem[];
  search: string;
  thumbnails: Record<number, string>;
  copiedTime: number | null;
  t: Translate;
  actions: ClipboardPanelActions;
  drag: ClipboardPanelDragHandlers;
  highlights: ReadonlyMap<number, TextRange[]>;
}

function ClipboardPanel({
  items,
  search,
  thumbnails,
  copiedTime,
  t,
  actions,
  drag,
  highlights,
}: ClipboardPanelProps) {
  const hasSearch = !!search.trim();

  return (
    <section className="clip-panel">
      <div className="stage-section-header">
        <span className="section-label">{t("剪贴板历史")}</span>
      </div>
      <div className={`clip-list${!items.length && !hasSearch ? " clip-list-empty" : ""}`}>
        {items.length ? items.map(item => (
          <ClipboardCard
            key={item.time}
            item={item}
            thumbnail={thumbnails[item.time]}
            copied={copiedTime === item.time}
            t={t}
            actions={actions}
            drag={drag}
            highlightRanges={highlights.get(item.time) ?? []}
            searchActive={hasSearch}
          />
        )) : hasSearch ? <p className="empty-hint">{t("无匹配")}</p> : (
          <div className="clip-empty-guide" aria-label={t("复制内容会自动出现在这里")}>
            <span className="clip-empty-guide-icon"><IconClipboard size={26}/></span>
            <span className="clip-empty-guide-title">{t("复制内容会自动出现在这里")}</span>
            <span className="clip-empty-guide-subtitle">{t("支持文本、文件和图片")}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export default ClipboardPanel;
