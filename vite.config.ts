import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

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
