import type { ClipItem } from "../types";

export type NativeClipboardDragItem = {
  type: ClipItem["type"];
  content: string | null;
  items: string[] | null;
  orig_path: string | null;
  time: number;
};

export type ClipboardDragDispatch = (command: string, args: Record<string, unknown>) => void;

export function createClipboardDragApi(dispatch: ClipboardDragDispatch) {
  return {
    setActive(active: boolean) {
      dispatch("set_clip_drag_active", { active });
    },
    start(item: NativeClipboardDragItem) {
      dispatch("start_drag_out", { items: [item], forceHide: true });
    },
  };
}

export const clipboardDragApi = {
  setActive(active: boolean) {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_clip_drag_active", { active }))
      .catch(() => {});
  },
  start(item: NativeClipboardDragItem) {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("start_drag_out", { items: [item], forceHide: true }))
      .catch(() => {});
  },
};
