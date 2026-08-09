// Launcher layout domain tests. Bundle the real TypeScript module and inject deterministic IDs
// and timestamps so import/export rules are verified without native dialogs or filesystem I/O.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "launcher-layout-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/launcherLayout.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { LAUNCHER_MAX, buildLauncherLayoutExport, previewLauncherImport } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};
const throwsMessage = (task, expected) => {
  try { task(); return false; } catch (error) { return error instanceof Error && error.message === expected; }
};

console.log("\n启动台布局领域 —— 导入校验、去重、容量与可携带导出");

check("启动台上限保持 200", LAUNCHER_MAX === 200);
check("非法 JSON 使用稳定错误 key", throwsMessage(() => previewLauncherImport("{", []), "导入文件不是有效的 JSON"));
check("null 文档使用格式错误 key", throwsMessage(() => previewLauncherImport("null", []), "导入文件格式不正确"));
check(
  "错误格式版本使用不支持错误 key",
  throwsMessage(() => previewLauncherImport(JSON.stringify({ format: "other", version: 2, items: [] }), []), "不是受支持的启动台布局文件"),
);

let nextId = 100;
const current = [{ id: 1, kind: "app", name: "Existing", path: "C:/existing.exe", icon: null }];
const validIcon = "data:image/png;base64,abc";
const preview = previewLauncherImport(JSON.stringify({
  format: "workbench-launcher",
  version: 1,
  exportedAt: "ignored",
  items: [
    { kind: "app", name: "  Added App  ", path: "  C:/added.exe  ", icon: validIcon },
    { kind: "file", name: "Duplicate existing", path: "C:/existing.exe" },
    { kind: "file", name: "Duplicate incoming", path: "C:/added.exe" },
    { kind: "unknown", name: "Bad kind", path: "C:/bad" },
    { kind: "file", name: "   ", path: "C:/blank" },
    { kind: "file", name: "Bad optional fields", path: "C:/note.txt", ext: "x".repeat(65), icon: "https://example/icon.png" },
    { kind: "folder", name: "Docs", path: "C:/docs", ext: "", icon: null },
  ],
}), current, () => nextId++);

check("名称与路径会 trim", preview.items[0].name === "Added App" && preview.items[0].path === "C:/added.exe");
check("ID 由注入工厂确定", preview.items.map(item => item.id).join(",") === "100,101,102");
check("现有路径和文档内路径统一去重", preview.duplicates === 2);
check("无效 kind/空名称计入 invalid", preview.invalid === 2);
check("非法图标降级为 null", preview.items[1].icon === null);
check("过长扩展名被丢弃", preview.items[1].ext === undefined);
check("合法 data image 图标保留", preview.items[0].icon === validIcon);

const almostFull = Array.from({ length: LAUNCHER_MAX - 1 }, (_, index) => ({
  id: index,
  kind: "file",
  name: `item-${index}`,
  path: `C:/item-${index}`,
  icon: null,
}));
const capacityPreview = previewLauncherImport(JSON.stringify({
  format: "workbench-launcher",
  version: 1,
  items: [
    { kind: "file", name: "one", path: "C:/new-one" },
    { kind: "file", name: "two", path: "C:/new-two" },
    { kind: "file", name: "three", path: "C:/new-three" },
  ],
}), almostFull, () => 999);
check("容量只接收剩余槽位", capacityPreview.items.length === 1);
check("超容量条目显式计数", capacityPreview.overCapacity === 2);

const exported = buildLauncherLayoutExport([{
  id: 42,
  kind: "file",
  name: "Portable",
  path: "C:/portable.txt",
  ext: "txt",
  iconFile: "private-cache.png",
}], "2026-08-04T00:00:00.000Z");
check("导出格式与时间稳定", exported.format === "workbench-launcher" && exported.version === 1 && exported.exportedAt === "2026-08-04T00:00:00.000Z");
check("导出不携带 id/iconFile", !("id" in exported.items[0]) && !("iconFile" in exported.items[0]));
check("缺失内嵌图标规范化为 null", exported.items[0].icon === null);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
