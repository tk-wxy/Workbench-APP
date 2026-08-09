import type { FileEntry } from "../types";

export type LauncherActionsInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createLauncherActionsApi(invoke: LauncherActionsInvoke) {
  return {
    pickFile: () => invoke<string | null>("pick_file"),
    pickFolder: () => invoke<string | null>("pick_folder"),
    getFileInfo: (path: string) => invoke<FileEntry>("get_file_info", { path }),
    writeLayoutExport: (dir: string, content: string) => invoke<string>("write_launcher_layout_export", { dir, content }),
    readLayoutImport: (path: string) => invoke<string>("read_launcher_layout_import", { path }),
  };
}

export const launcherActionsApi = {
  async pickFile() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("pick_file");
  },
  async pickFolder() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("pick_folder");
  },
  async getFileInfo(path: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FileEntry>("get_file_info", { path });
  },
  async writeLayoutExport(dir: string, content: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("write_launcher_layout_export", { dir, content });
  },
  async readLayoutImport(path: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("read_launcher_layout_import", { path });
  },
};

