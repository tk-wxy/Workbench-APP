import type {
  LauncherImportPreview,
  LauncherItem,
  LauncherLayoutExport,
  LauncherLayoutItem,
} from "../types";

export const LAUNCHER_MAX = 200;

export const createLauncherId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

// The portable layout deliberately excludes id/iconFile. Those values only identify local
// in-memory state and app-data files; embedded icons remain portable and are externalized again
// through the launcher's single persistence path after import.
export function buildLauncherLayoutExport(
  items: readonly LauncherItem[],
  exportedAt = new Date().toISOString(),
): LauncherLayoutExport {
  return {
    format: "workbench-launcher",
    version: 1,
    exportedAt,
    items: items.map(({ kind, name, path, ext, icon }): LauncherLayoutItem => ({
      kind,
      name,
      path,
      ext,
      icon: icon ?? null,
    })),
  };
}

// Validate and normalize the whole document before the confirmation action can write anything.
// Existing and within-document paths are deduplicated; over-capacity items are reported instead
// of being silently appended and then truncated.
export function previewLauncherImport(
  text: string,
  current: readonly LauncherItem[],
  createId: () => number = createLauncherId,
): LauncherImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("导入文件不是有效的 JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("导入文件格式不正确");

  const doc = raw as Partial<LauncherLayoutExport>;
  if (doc.format !== "workbench-launcher" || doc.version !== 1 || !Array.isArray(doc.items)) {
    throw new Error("不是受支持的启动台布局文件");
  }

  const knownPaths = new Set(current.map(item => item.path));
  const accepted: LauncherItem[] = [];
  let duplicates = 0;
  let invalid = 0;
  for (const candidate of doc.items) {
    if (!candidate || typeof candidate !== "object") {
      invalid++;
      continue;
    }
    const value = candidate as Partial<LauncherLayoutItem>;
    const kind = value.kind;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const path = typeof value.path === "string" ? value.path.trim() : "";
    if (
      (kind !== "app" && kind !== "file" && kind !== "folder")
      || !name
      || !path
      || name.length > 256
      || path.length > 32767
    ) {
      invalid++;
      continue;
    }
    if (knownPaths.has(path)) {
      duplicates++;
      continue;
    }
    knownPaths.add(path);

    // Imports may come from older versions or other machines. An invalid icon only drops the
    // icon; the item remains usable through FileGlyph/name fallback.
    const icon = typeof value.icon === "string"
      && value.icon.startsWith("data:image/")
      && value.icon.length <= 300_000
      ? value.icon
      : null;
    const ext = typeof value.ext === "string" && value.ext.length <= 64 ? value.ext : undefined;
    accepted.push({ id: createId(), kind, name, path, ext, icon });
  }

  const room = Math.max(0, LAUNCHER_MAX - current.length);
  return {
    items: accepted.slice(0, room),
    duplicates,
    invalid,
    overCapacity: Math.max(0, accepted.length - room),
  };
}
