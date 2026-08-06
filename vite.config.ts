import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"));

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // 单一版本号来源：package.json（tauri.conf.json / Cargo.toml 仍需手动同步）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // 测量包构建时显式打开；普通 dev/release 编译成 false，前端启动不做任何探测 IPC。
    __WORKBENCH_PERF__: JSON.stringify(process.env.WORKBENCH_PERF === "1"),
  },

  // 阻止 Vite 在编辑器中打开浏览器（使用 Tauri 窗口）
  clearScreen: false,

  server: {
    // Tauri 需要固定端口用于开发
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    // 响应 Tauri 窗口的请求
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  // 生产环境时的相对路径
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri 在 Windows 使用 Chromium，在 macOS 和 Linux 使用 WebKit
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // 不要混淆构建输出大小
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // 为调试构建生成 sourcemap
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
