import { memo, type MouseEvent, type PointerEvent } from "react";
import { fmtSize } from "../lib/format";
import { buildSearchExcerpt, STAGE_GRID_SEARCH_EXCERPT, STAGE_LIST_SEARCH_EXCERPT, type TextRange } from "../domain/pageSearchPresentation";
import HighlightText from "./HighlightText";
import { FileGlyph, IconCheck, IconCopy, IconOpen, IconPin, IconTrash, IconWarn } from "../icons";
import type { StageItem } from "../types";

type Translate = (zh: string, vars?: Record<string, string | number>) => string;

export interface StageItemActions {
  activate: (event: MouseEvent, item: StageItem, index: number) => void;
  openContextMenu: (event: MouseEvent, item: StageItem) => void;
  togglePin: (id: number) => void;
  copy: (item: StageItem) => void;
  remove: (id: number) => void;
  open: (item: StageItem) => void;
}

export interface StageItemPointerHandlers {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  lostPointerCapture: () => void;
}

interface StageItemViewProps {
  item: StageItem;
  index: number;
  selected: boolean;
  missing: boolean;
  multiselect: boolean;
  persistAll: boolean;
  copied: boolean;
  imageThumbnail?: string;
  fileThumbnail?: string;
  t: Translate;
  actions: StageItemActions;
  pointer: StageItemPointerHandlers;
  highlightRanges: TextRange[];
  pageSearchActive: boolean;
  newlyAdded: boolean;
  onNewlyAddedAnimationEnd: (id: number) => void;
}

const rootTitle = (item: StageItem, missing: boolean, multiselect: boolean, t: Translate, grid: boolean) => {
  if (missing) return t("原文件已失踪（可能被删除或移动）");
  if (multiselect) return t("单击选中 / 取消");
  if (item.type === "file") return grid
    ? t("单击取走（写回剪贴板并粘贴），拖出可拖到其他应用")
    : t("单击取走（写回剪贴板并粘贴）");
  return grid ? t("单击取走（粘贴到上个窗口），拖出可拖到其他应用") : t("单击取走（粘贴到上个窗口）");
};

export const StageGridCard = memo(function StageGridCard({
  item,
  index,
  selected,
  missing,
  multiselect,
  persistAll,
  copied,
  imageThumbnail,
  fileThumbnail,
  t,
  actions,
  pointer,
  highlightRanges,
  pageSearchActive,
  newlyAdded,
  onNewlyAddedAnimationEnd,
}: StageItemViewProps) {
  const rawExt = (item.ext || item.items?.[0]?.ext || "").replace(/^\./, "");
  const isAnyDir = !!item.isDir;
  const cardName = item.type === "image" ? t("图片")
    : item.type === "text" ? (item.content?.slice(0, 12) || t("文本"))
      : item.count !== 1 ? t("{n} 个文件", { n: item.count ?? 0 }) : (item.name || item.items?.[0]?.name || t("文件"));
  const cardMeta = item.type === "image" ? t("图片")
    : item.type === "text" ? t("文本")
      : isAnyDir ? t("文件夹") : rawExt ? `.${rawExt}` : t("文件");
  const textPreview = pageSearchActive && highlightRanges.length
    ? buildSearchExcerpt(item.content || "", highlightRanges, STAGE_GRID_SEARCH_EXCERPT)
    : { text: item.content || "", ranges: [] as TextRange[] };
  const pin = persistAll ? null : (
    <button
      type="button"
      className={`stage-card-dot${item.pinned ? " pinned" : ` type-${item.type}`}`}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); actions.togglePin(item.id); }}
      title={item.pinned ? t("已固定：取走 / 拖出后保留（点击取消）") : t("点击固定：取走 / 拖出后仍保留在中转区")}
    >
      {item.pinned ? <span className="dot-pin"><IconPin/></span> : <span className="dot-type"/>}
    </button>
  );

  return (
    <div
      data-stage-id={item.id}
      className={`stage-card${selected ? " selected" : ""}${missing ? " stage-missing" : ""}${newlyAdded ? " stage-new" : ""}`}
      draggable={false}
      onDragStart={event => event.preventDefault()}
      onClick={event => actions.activate(event, item, index)}
      onContextMenu={event => actions.openContextMenu(event, item)}
      onPointerDown={pointer.pointerDown}
      onPointerMove={pointer.pointerMove}
      onPointerUp={pointer.pointerUp}
      onPointerCancel={pointer.pointerUp}
      onLostPointerCapture={pointer.lostPointerCapture}
      onAnimationEnd={newlyAdded ? () => onNewlyAddedAnimationEnd(item.id) : undefined}
      title={rootTitle(item, missing, multiselect, t, true)}
    >
      {missing && <span className="stage-missing-badge" title={t("原文件已失踪（可能被删除或移动）")}><IconWarn size={15}/></span>}
      {item.type === "image" && (
        <div className="stage-card-thumb">
          {pin}
          {imageThumbnail
            ? <img className="cover" draggable={false} src={imageThumbnail} alt=""/>
            : item.content
              ? <img className="cover" draggable={false} src={item.content.startsWith("data:") ? item.content : `data:image/png;base64,${item.content}`} alt=""/>
              : <FileGlyph isImage size={34}/>}
        </div>
      )}
      {item.type === "text" && (
        <div className="stage-card-thumb">
          {pin}
          <div className="stage-card-text-preview"><HighlightText text={textPreview.text} ranges={textPreview.ranges} variant="body"/></div>
        </div>
      )}
      {item.type === "file" && (
        <div className="stage-card-thumb">
          {pin}
          <div className="stage-card-icon-wrap">
            {item.items?.[0]?.icon
              ? <img src={item.items[0].icon} alt="" draggable={false} style={{ width: 34, height: 34, objectFit: "contain" }}/>
              : <FileGlyph size={30} isDir={isAnyDir} isImage={item.items?.[0]?.isImage} ext={item.ext ?? item.items?.[0]?.ext ?? ""}/>}
          </div>
          {item.items?.[0]?.isImage && fileThumbnail && <img className="cover" draggable={false} src={fileThumbnail} alt=""/>}
        </div>
      )}
      <div className="stage-card-label">
        <span className="stage-card-name"><HighlightText text={cardName} ranges={item.type === "text" ? [] : highlightRanges}/></span>
        <span className="stage-card-meta">{cardMeta}</span>
      </div>
      <div className="stage-card-actions">
        {!missing && (
          <button className="stage-card-act-btn" onClick={event => { event.stopPropagation(); actions.copy(item); }} title={copied ? t("已复制") : t("复制到剪贴板")}>
            {copied ? <IconCheck/> : <IconCopy/>}
          </button>
        )}
        <button className="stage-card-act-btn" onClick={event => { event.stopPropagation(); actions.remove(item.id); }} title={t("删除")}><IconTrash/></button>
      </div>
    </div>
  );
});

export const StageListRow = memo(function StageListRow({
  item,
  index,
  selected,
  missing,
  multiselect,
  persistAll,
  copied,
  imageThumbnail,
  fileThumbnail,
  t,
  actions,
  pointer,
  highlightRanges,
  pageSearchActive,
  newlyAdded,
  onNewlyAddedAnimationEnd,
}: StageItemViewProps) {
  const rawText = item.content || "";
  const textPreview = pageSearchActive && highlightRanges.length
    ? buildSearchExcerpt(rawText, highlightRanges, STAGE_LIST_SEARCH_EXCERPT)
    : { text: rawText.slice(0, 60) || t("文本"), ranges: [] as TextRange[] };
  const label = item.type === "text" ? textPreview.text
    : item.type === "image" ? t("图片")
      : item.count !== 1 ? t("{n} 个文件", { n: item.count ?? 0 }) : (item.name || item.items?.[0]?.name || t("文件"));
  const imageSource = imageThumbnail || item.content;

  return (
    <div
      data-stage-id={item.id}
      className={`stage-item${selected ? " selected" : ""}${missing ? " stage-missing" : ""}${newlyAdded ? " stage-new" : ""}`}
      draggable={false}
      onDragStart={event => event.preventDefault()}
      onClick={event => actions.activate(event, item, index)}
      onContextMenu={event => actions.openContextMenu(event, item)}
      onPointerDown={pointer.pointerDown}
      onPointerMove={pointer.pointerMove}
      onPointerUp={pointer.pointerUp}
      onPointerCancel={pointer.pointerUp}
      onLostPointerCapture={pointer.lostPointerCapture}
      onAnimationEnd={newlyAdded ? () => onNewlyAddedAnimationEnd(item.id) : undefined}
      title={rootTitle(item, missing, multiselect, t, false)}
    >
      {item.type === "image" && imageSource
        ? <img className="stage-thumb" draggable={false} src={imageSource} alt=""/>
        : item.type === "file" && item.items?.[0]?.isImage && item.items?.[0]?.path && fileThumbnail
          ? <img className="stage-thumb" draggable={false} src={fileThumbnail} alt=""/>
          : item.type === "file" && item.items?.[0]?.icon
            ? <img className="stage-thumb" draggable={false} src={item.items[0].icon} alt=""/>
            : <span className="stage-emoji">{item.type === "text"
              ? <FileGlyph cat="doc" size={20}/>
              : <FileGlyph size={20} isDir={item.isDir} isImage={item.items?.[0]?.isImage} ext={item.ext ?? item.items?.[0]?.ext ?? ""}/>}</span>}
      {missing && <span className="stage-missing-badge" title={t("原文件已失踪（可能被删除或移动）")}><IconWarn size={15}/></span>}
      <span className="stage-title"><HighlightText text={label} ranges={item.type === "text" ? textPreview.ranges : highlightRanges} variant={item.type === "text" ? "body" : "name"}/></span>
      {item.type === "file" && item.count === 1 && item.size ? <span className="stage-meta">{fmtSize(item.size)}</span> : null}
      {!persistAll && (
        <button
          className={`stage-pin-btn${item.pinned ? " pinned" : ""}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); actions.togglePin(item.id); }}
          title={item.pinned ? t("已固定：取走 / 拖出后保留（点击取消）") : t("点击固定：取走 / 拖出后仍保留在中转区")}
        ><IconPin/></button>
      )}
      <div className="stage-actions">
        {!missing && (
          <button className={`clip-copy-btn${copied ? " copied" : ""}`} onClick={event => { event.stopPropagation(); actions.copy(item); }} title={copied ? t("已复制") : t("复制到剪贴板")}>
            {copied ? <IconCheck/> : <IconCopy/>}
          </button>
        )}
        {!missing && item.type === "file" && <button className="stage-open-btn" onClick={event => { event.stopPropagation(); actions.open(item); }} title={t("打开")}><IconOpen/></button>}
        <button className="clip-del-btn" onClick={event => { event.stopPropagation(); actions.remove(item.id); }} title={t("移除")}><IconTrash/></button>
      </div>
    </div>
  );
});
