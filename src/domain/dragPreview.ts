import type { makeT } from "../i18n";

export type NativeDragPreviewStyle = "card";
type Translate = ReturnType<typeof makeT>;

type DragLabelItem = {
  type: "text" | "image" | "file";
  content?: string;
  name?: string;
  count?: number;
  orig_path?: string;
  items?: Array<{ name: string }>;
};

const MAX_DRAG_LABEL_UNITS = 13;

function dragLabelUnits(value: string): number {
  return Array.from(value).reduce((units, char) => units + (char.charCodeAt(0) <= 0x7f ? 0.56 : 1), 0);
}

function filename(path: string | undefined): string {
  const parts = path?.split(/[\\/]/).filter(Boolean) ?? [];
  return parts[parts.length - 1] ?? "";
}

function truncateLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  let units = 0;
  let result = "";
  for (const char of normalized) {
    const next = char.charCodeAt(0) <= 0x7f ? 0.56 : 1;
    if (units + next + 1 > MAX_DRAG_LABEL_UNITS) return `${result}…`;
    result += char;
    units += next;
  }
  return result;
}

export function formatNativeDragPreviewLabel(baseLabel: string, itemCount: number): string {
  const suffix = itemCount > 1 ? `  ×${itemCount}` : "";
  const maxBaseUnits = Math.max(4, MAX_DRAG_LABEL_UNITS - dragLabelUnits(suffix));
  let units = 0;
  let result = "";
  let truncated = false;
  for (const char of baseLabel.trim()) {
    const next = char.charCodeAt(0) <= 0x7f ? 0.56 : 1;
    if (units + next + 1 > maxBaseUnits) {
      truncated = true;
      break;
    }
    result += char;
    units += next;
  }
  return `${result}${truncated ? "…" : ""}${suffix}`;
}

export function nativeDragPreviewHotspot(): { x: number; y: number } {
  return { x: 12, y: 12 };
}

let dragSessionCounter = 0;

export function nextNativeDragSessionId(now = Date.now()): number {
  dragSessionCounter = (dragSessionCounter + 1) % 1000;
  return now * 1000 + dragSessionCounter;
}

export function shouldFinishNativeDragHandoff(activeSession: number | null, eventSession?: number): boolean {
  return activeSession !== null && (eventSession === undefined || activeSession === eventSession);
}

export function buildNativeDragLabel(item: DragLabelItem, t: Translate): string {
  if (item.type === "text") return truncateLabel(item.content || "") || t("文本");
  if (item.type === "image") {
    return truncateLabel(item.name || item.items?.[0]?.name || filename(item.orig_path)) || t("图片");
  }
  const count = item.count ?? item.items?.length ?? 0;
  if (count > 1) return t("{n} 个文件", { n: count });
  return truncateLabel(item.name || item.items?.[0]?.name || filename(item.orig_path)) || t("文件");
}

export function buildNativeDragMeta(item: DragLabelItem & { ext?: string; isDir?: boolean }, t: Translate): string {
  if (item.type === "image") return t("图片");
  if (item.type === "text") return t("文本");
  if (item.isDir) return t("文件夹");
  const ext = item.ext || item.items?.[0]?.name.split(".").pop();
  return ext && ext !== item.items?.[0]?.name ? `.${ext.replace(/^\./, "")}` : t("文件");
}
