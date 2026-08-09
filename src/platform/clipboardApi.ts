import type { ClipItem } from "../types";

export type ClipboardInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createClipboardApi(invoke: ClipboardInvoke) {
  return {
    getHistory: () => invoke<ClipItem[]>("get_clipboard_history"),
  };
}

const invokeClipboard: ClipboardInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

export const clipboardApi = createClipboardApi(invokeClipboard);
