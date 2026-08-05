import type { FileEntry } from "../types";

export type SearchPreviewInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export function createSearchPreviewApi(invoke: SearchPreviewInvoke) {
  return {
    getFileInfo: (path: string) => invoke<FileEntry>("get_file_info", { path }),
    getLargeIcon: (path: string) => invoke<string | null>("get_large_icon", { path }),
    getThumbnail: (path: string) => invoke<string>("get_stage_thumbnail", { path }),
  };
}

const invokeSearchPreview: SearchPreviewInvoke = async <T>(command: string, args: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

export const searchPreviewApi = createSearchPreviewApi(invokeSearchPreview);
