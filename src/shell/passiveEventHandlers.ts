import type { AppInfo, ClipItem } from "../types";

export type ClipboardOriginalDegradedPayload = {
  time?: number;
  reason?: string;
  visible?: boolean;
};

type PassiveEventPorts = {
  loadClipboardHistory: () => Promise<ClipItem[]>;
  replaceClipboard: (history: ClipItem[]) => void;
  updateClipboard: (update: (current: ClipItem[]) => ClipItem[]) => void;
  setIndexReady: (ready: boolean) => void;
  setApps: (apps: AppInfo[]) => void;
  notifyOriginalFallback: () => void;
};

// Keep only the lightweight fields returned by get_clipboard_history. In particular, image
// content must not become resident in front-end state again (R51).
export const normalizeClipboardHistory = (history: readonly ClipItem[]): ClipItem[] =>
  history.map(entry => ({
    type: entry.type,
    content: entry.content,
    time: entry.time,
    items: entry.items,
    count: entry.count,
    orig_path: entry.orig_path,
    orig_degraded: entry.orig_degraded,
  }));

export function createPassiveEventHandlers(ports: PassiveEventPorts) {
  return {
    onClipboardUpdate: async () => {
      ports.replaceClipboard(normalizeClipboardHistory(await ports.loadClipboardHistory()));
    },
    onFileIndexReady: (count: number | null | undefined) => {
      ports.setIndexReady((count ?? 0) > 0);
    },
    onAppsReady: (apps: AppInfo[] | null | undefined) => {
      const list = apps ?? [];
      if (list.length) ports.setApps(list);
    },
    onClipboardOriginalDegraded: (payload: ClipboardOriginalDegradedPayload | null | undefined) => {
      const time = payload?.time;
      if (time != null) {
        ports.updateClipboard(current =>
          current.map(item => item.time === time ? { ...item, orig_degraded: true } : item),
        );
      }
      if (payload?.reason === "consume-fallback" && payload.visible) {
        ports.notifyOriginalFallback();
      }
    },
  };
}
