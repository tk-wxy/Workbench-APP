import {
  formatNativeDragPreviewLabel,
  type NativeDragPreviewStyle,
} from "../domain/dragPreview";

type NativeDragGhostOptions = {
  style: NativeDragPreviewStyle;
  type: "text" | "image" | "file";
  label: string;
  meta: string;
  preview: string | null;
  previewMode?: "cover" | "icon";
  textPreview?: string | null;
  itemCount: number;
};

export function createNativeDragGhost(options: NativeDragGhostOptions): HTMLDivElement {
  const root = document.createElement("div");
  root.className = `native-drag-ghost native-drag-ghost-${options.style} stage-card stage-drag-ghost`;
  root.dataset.previewStyle = options.style;

  const thumb = document.createElement("div");
  thumb.className = "stage-card-thumb";
  const dot = document.createElement("span");
  dot.className = `stage-card-dot type-${options.type}`;
  const dotType = document.createElement("span");
  dotType.className = "dot-type";
  dot.appendChild(dotType);
  thumb.appendChild(dot);

  if (options.type === "text") {
    const text = document.createElement("div");
    text.className = "stage-card-text-preview";
    text.textContent = options.textPreview?.trim() || options.label;
    thumb.appendChild(text);
  } else if (options.preview && options.previewMode === "cover") {
    const image = document.createElement("img");
    image.className = "cover";
    image.src = options.preview;
    image.alt = "";
    image.draggable = false;
    thumb.appendChild(image);
  } else {
    const iconWrap = document.createElement("div");
    iconWrap.className = "stage-card-icon-wrap";
    if (options.preview) {
      const image = document.createElement("img");
      image.className = "native-stage-card-icon";
      image.src = options.preview;
      image.alt = "";
      image.draggable = false;
      iconWrap.appendChild(image);
    } else {
      const fallback = document.createElement("span");
      fallback.className = `native-stage-card-fallback native-stage-card-fallback-${options.type}`;
      iconWrap.appendChild(fallback);
    }
    thumb.appendChild(iconWrap);
  }

  const label = document.createElement("div");
  label.className = "stage-card-label";
  const name = document.createElement("span");
  name.className = "stage-card-name";
  name.textContent = formatNativeDragPreviewLabel(options.label, options.itemCount);
  const meta = document.createElement("span");
  meta.className = "stage-card-meta";
  meta.textContent = options.meta;
  label.append(name, meta);
  root.append(thumb, label);

  if (options.itemCount > 1) {
    const badge = document.createElement("span");
    badge.className = "native-stage-card-count";
    badge.textContent = `×${options.itemCount}`;
    root.appendChild(badge);
  }
  return root;
}

export function positionNativeDragGhost(
  element: HTMLElement,
  _style: NativeDragPreviewStyle,
  clientX: number,
  clientY: number,
  hotspot = { x: 12, y: 12 },
): void {
  element.style.transform = `translate3d(${clientX - hotspot.x}px,${clientY - hotspot.y}px,0) scale(1.04)`;
}
