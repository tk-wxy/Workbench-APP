import type { StageInsertMarker } from "../domain/stageInteraction";

export function showStageInsertMarker(element: HTMLDivElement | null, marker: StageInsertMarker | null) {
  if (!element || !marker) {
    if (element) element.style.display = "none";
    return;
  }
  element.dataset.orientation = marker.orientation;
  Object.assign(element.style, {
    display: "block",
    left: `${marker.left}px`,
    top: `${marker.top}px`,
    width: `${marker.width}px`,
    height: `${marker.height}px`,
  });
}

export function hideStageInsertMarker(element: HTMLDivElement | null) {
  if (element) element.style.display = "none";
}
