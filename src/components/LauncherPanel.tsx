import { forwardRef, memo, type MouseEvent, type PointerEvent } from "react";
import { IMG_EXTS } from "../lib/format";
import { FileGlyph, IconRocket, IconWarn } from "../icons";
import type { LauncherItem } from "../types";

type Translate = (zh: string, vars?: Record<string, string | number>) => string;

interface LauncherTileProps {
  item: LauncherItem;
  selected: boolean;
  missing: boolean;
  thumbnail?: string;
  t: Translate;
  onOpen: (item: LauncherItem, iconEl: HTMLElement | null) => void;
  onContextMenu: (event: MouseEvent, item: LauncherItem) => void;
  onPointerDown: (event: PointerEvent, id: number) => void;
}

const LauncherTile = memo(function LauncherTile({
  item,
  selected,
  missing,
  thumbnail,
  t,
  onOpen,
  onContextMenu,
  onPointerDown,
}: LauncherTileProps) {
  const imageThumbnail = item.kind === "file"
    && !!item.ext
    && IMG_EXTS.includes(item.ext.toLowerCase())
    && thumbnail;

  return (
    <div
      className={`app-tile${selected ? " selected" : ""}${missing ? " launcher-missing" : ""}`}
      draggable={false}
      onClick={event => onOpen(item, event.currentTarget.querySelector<HTMLElement>(".app-tile-icon"))}
      onContextMenu={event => onContextMenu(event, item)}
      onPointerDown={event => onPointerDown(event, item.id)}
      title={item.kind === "app" ? t("单击启动") : t("单击打开")}
    >
      {missing && (
        <span className="launcher-missing-badge" title={t("原文件已失踪（可能被删除或移动）")}>
          <IconWarn size={15}/>
        </span>
      )}
      <div className="app-tile-icon">
        {imageThumbnail
          ? <img className="app-tile-thumb" src={imageThumbnail} alt="" draggable={false}/>
          : item.icon
            ? <img src={item.icon} alt="" draggable={false}/>
            : item.kind === "folder"
              ? <FileGlyph isDir size={42}/>
              : item.kind === "file"
                ? <FileGlyph ext={item.ext ?? ""} size={42}/>
                : <span>{item.name[0]}</span>}
      </div>
      <div className="app-tile-label-wrap"><span className="app-tile-label">{item.name}</span></div>
    </div>
  );
});

interface LauncherPanelProps {
  items: LauncherItem[];
  totalCount: number;
  search: string;
  selectedIndex: number;
  missingIds: Set<number>;
  thumbnails: Record<string, string>;
  t: Translate;
  onOpenManager: () => void;
  onOpenPicker: () => void;
  onOpenItem: (item: LauncherItem, iconEl: HTMLElement | null) => void;
  onOpenContextMenu: (event: MouseEvent, item: LauncherItem) => void;
  onPointerDown: (event: PointerEvent, id: number) => void;
}

const LauncherPanel = memo(forwardRef<HTMLDivElement, LauncherPanelProps>(function LauncherPanel({
  items,
  totalCount,
  search,
  selectedIndex,
  missingIds,
  thumbnails,
  t,
  onOpenManager,
  onOpenPicker,
  onOpenItem,
  onOpenContextMenu,
  onPointerDown,
}, ref) {
  const hasSearch = !!search.trim();

  return (
    <section className="app-panel">
      <div className="stage-section-header">
        <span className="section-label">{t("启动器")}</span>
        <div className="launcher-header-actions">
          <button className="stage-batch-btn" onClick={onOpenManager} title={t("批量管理")}>{t("批量管理")}</button>
          <button className="stage-batch-btn" onClick={onOpenPicker} title={t("添加到启动台")}>{t("添加")}</button>
        </div>
      </div>
      <div className={`app-grid${!totalCount && !hasSearch ? " app-grid-empty" : ""}`} ref={ref}>
        {items.map((item, index) => (
          <LauncherTile
            key={item.id}
            item={item}
            selected={index === selectedIndex}
            missing={missingIds.has(item.id)}
            thumbnail={thumbnails[item.path]}
            t={t}
            onOpen={onOpenItem}
            onContextMenu={onOpenContextMenu}
            onPointerDown={onPointerDown}
          />
        ))}
        {!items.length && (hasSearch ? <p className="empty-hint">{t("无匹配")}</p> : (
          <div className="launcher-empty-guide" aria-label={t("添加常用应用")}>
            <span className="launcher-empty-guide-icon"><IconRocket size={26}/></span>
            <span className="launcher-empty-guide-title">{t("添加常用应用")}</span>
            <span className="launcher-empty-guide-subtitle">{t("拖入应用，或点击右上角“添加”")}</span>
          </div>
        ))}
      </div>
    </section>
  );
}));

export default LauncherPanel;
