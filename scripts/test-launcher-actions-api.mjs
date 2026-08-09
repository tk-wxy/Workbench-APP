import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-launcher-actions-"));
try {
  const output = path.join(temp, "api.mjs");
  await build({ entryPoints: [path.join(root, "src/platform/launcherActionsApi.ts")], outfile: output, bundle: true, platform: "node", format: "esm", external: ["@tauri-apps/api/core"] });
  const { createLauncherActionsApi } = await import(pathToFileURL(output));
  const calls = [];
  const api = createLauncherActionsApi(async (command, args) => {
    calls.push({ command, args });
    if (command === "get_file_info") return { name: "x", path: "C:/x", ext: "", isDir: false, size: 0 };
    return command;
  });
  await api.pickFile();
  await api.pickFolder();
  await api.getFileInfo("C:/x");
  await api.writeLayoutExport("C:/out", "{}");
  await api.readLayoutImport("C:/in.json");
  assert.deepEqual(calls, [
    { command: "pick_file", args: undefined },
    { command: "pick_folder", args: undefined },
    { command: "get_file_info", args: { path: "C:/x" } },
    { command: "write_launcher_layout_export", args: { dir: "C:/out", content: "{}" } },
    { command: "read_launcher_layout_import", args: { path: "C:/in.json" } },
  ]);
  console.log("启动器操作平台边界 —— 选择、信息与布局文件\n  ✓ 五类命令及参数保持\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

