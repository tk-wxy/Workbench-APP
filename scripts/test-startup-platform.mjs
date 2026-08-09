// Startup platform contract tests. Exercise the real command facade and step isolation while
// keeping Tauri itself external to this Node test.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "startup-platform-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/platform/workbenchStartup.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@tauri-apps/api/core", "@tauri-apps/plugin-store"],
  outfile,
  logLevel: "error",
});

const { createStartupNative, runStartupStep } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};

console.log("\n启动平台边界 —— 命令映射与分步骤隔离");

const calls = [];
const replies = {
  existing_stage_images: ["stage-1.png"],
  get_file_info: { path: "C:/a.txt", name: "a.txt", ext: "txt", isDir: false },
  load_launcher_icons: { "icon-1.png": "data:image/png;base64,a" },
  "plugin:autostart|is_enabled": true,
};
const native = createStartupNative(async (command, args) => {
  calls.push([command, args]);
  return replies[command];
});

await native.setTrayLanguage("en");
await native.setClipCacheMax(50);
await native.setSearchDirs(["D:/docs"]);
await native.setSearchEngine("everything");
const existing = await native.existingStageImages(["stage-1.png"]);
const info = await native.getFileInfo("C:/a.txt");
const icons = await native.loadLauncherIcons(["icon-1.png"]);
await native.setDragoutAutoClose(false);
const autostart = await native.isAutostartEnabled();

check("启动命令顺序保持", calls.map(([command]) => command).join(",") === [
  "set_tray_language",
  "set_clip_cache_max",
  "set_search_dirs",
  "set_search_engine",
  "existing_stage_images",
  "get_file_info",
  "load_launcher_icons",
  "set_dragout_auto_close",
  "plugin:autostart|is_enabled",
].join(","));
check("命令参数使用 Rust 约定字段", calls[2][1].dirs[0] === "D:/docs" && calls[7][1].enabled === false);
check("返回类型不被平台层改写", existing[0] === "stage-1.png" && info.name === "a.txt" && !!icons["icon-1.png"] && autostart === true);

const reports = [];
check("成功步骤返回 true", await runStartupStep("成功项", async () => {}, (message, error) => reports.push([message, error])));
check("失败步骤返回 false", !(await runStartupStep("损坏项", async () => { throw new Error("bad"); }, (message, error) => reports.push([message, error]))));
check("失败日志保留步骤名", reports.length === 1 && reports[0][0].includes("损坏项失败"));

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
