export interface AppInfo {
  name: string;
  // packaged=true means a UWP/AUMID shell path; callers must launch it instead of treating it as a filesystem path.
  path: string;
  icon: string | null;
  packaged?: boolean;
}

export interface AppUsage {
  count: number;
  last_used: number;
}

// Rust apps.rs uses #[serde(rename_all = "camelCase")]; keep these fields aligned.
export interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  ext: string;
  icon?: string | null;
  modified?: number | null;
  created?: number | null;
  entries?: number | null;
  entriesCapped?: boolean;
  width?: number | null;
  height?: number | null;
  target?: string | null;
}

export interface FileItem {
  path: string;
  name: string;
  ext: string;
  isImage: boolean;
  icon?: string | null;
}

export interface ClipItem {
  type: "text" | "image" | "file";
  content?: string;
  time: number;
  items?: FileItem[];
  count?: number;
  orig_path?: string;
  orig_degraded?: boolean;
}

export interface StageItem {
  id: number;
  type: "text" | "image" | "file";
  // text body, or an image base64 fallback before externalization succeeds.
  content?: string;
  // Once externalized, image content stays in app_data_dir and is loaded only when an action needs it.
  contentFile?: string;
  items?: FileItem[];
  count?: number;
  name?: string;
  ext?: string;
  isDir?: boolean;
  size?: number;
  orig_path?: string;
  pinned?: boolean;
}

// ClipItem and StageItem deliberately share this action-facing shape.
export type Pasteable = {
  type: "text" | "image" | "file";
  content?: string;
  contentFile?: string;
  items?: FileItem[];
  orig_path?: string;
  time?: number;
};

// LauncherItem intentionally remains distinct from StageItem: its primary action is open/launch.
export interface LauncherItem {
  id: number;
  kind: "app" | "file" | "folder";
  name: string;
  /** In-memory data URL; persistence replaces it with iconFile when possible. */
  icon?: string | null;
  /** Filename under app_data_dir/launcher_icons in the persisted representation. */
  iconFile?: string;
  path: string;
  ext?: string;
}

export interface LauncherLayoutItem {
  kind: LauncherItem["kind"];
  name: string;
  path: string;
  ext?: string;
  icon?: string | null;
}

export interface LauncherLayoutExport {
  format: "workbench-launcher";
  version: 1;
  exportedAt: string;
  items: LauncherLayoutItem[];
}

export type LauncherImportPreview = {
  items: LauncherItem[];
  duplicates: number;
  invalid: number;
  overCapacity: number;
};

export type EnhResult =
  | { kind: "app"; app: AppInfo; ranges: [number, number][] }
  | { kind: "stage"; item: StageItem; name: string; ranges: [number, number][] }
  | { kind: "clip"; item: ClipItem; name: string; ranges: [number, number][] }
  | { kind: "fs"; path: string; name: string; ext: string; isDir: boolean; icon?: string | null; iconKey?: string };

export type BuiltinSearchHit =
  | { kind: "app" | "stage" | "clip"; key: string }
  | { kind: "fs"; path: string; name: string; ext: string; isDir: boolean; iconKey: string; icon?: string | null };
