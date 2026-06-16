# Workbench — 项目记忆（memory）

> **最后更新**：2026-06-16
>
> **关联文档**：规则铁律看 `CLAUDE.md`；决策根因看 `DECISIONS.md`；本文件 = 项目现状快照 + 变更记录。
>
> **维护方式**：
> - 标〔快照〕的小节 = 覆盖更新，反映当前真实状态
> - 标〔追加〕的小节 = 只往后加
> - 每次结构性改动完成后：① 更新对应〔快照〕 ② 追加「变更记录」 ③ 改顶部日期

---

## 0. 当前状态 / 下一步 〔快照〕

- **当前稳定**：Ctrl+Space 热键 toggle + 三类型剪贴板（文本/图片/文件）粘贴 + 后台监听 + 全屏无缝
- **进行中**：← 无
- **下一步**：Esc 关闭修复（幽灵界面）、闪烁优化、文件中转区独立于剪贴板文件历史
- **阻塞 / 待决策**：← 无

---

## 一、项目概览 〔快照〕

Windows 全屏"第二桌面"工具——热键 Ctrl+Space toggle 呼出覆盖全屏的功能界面。

| 层 | 技术栈 | 职责 |
|---|---|---|
| 前端 UI | React 18 + TypeScript + Vite + Tailwind CSS | 界面渲染、交互 |
| 桌面层 | Tauri 2.0（Rust） | 窗口管理、全局热键、剪贴板、系统托盘、应用扫描 |

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包
```

---

## 二、前端（src/）〔快照〕

```
src/
  App.tsx          # 主组件：三栏布局 + 剪贴板面板 + 热键事件监听
  App.css          # Win11 暗色主题 + 毛玻璃 + 全屏布局
  main.tsx         # React DOM 入口
  index.css        # Tailwind CSS v4 入口
  vite-env.d.ts    # Vite 类型声明
```

关键依赖：`react@18`、`@tauri-apps/api@2`、`@tauri-apps/plugin-store`、`framer-motion`（已安装未使用，CSS 动画已替代）

---

## 三、Rust 后端（src-tauri/）〔快照〕

```
src-tauri/src/
  lib.rs           # 主逻辑：窗口全屏、热键 handler、剪贴板后台线程、Tauri 命令（~400行）
  apps.rs          # 应用扫描：Start Menu .lnk 解析、ExtractIconEx 图标提取、get_file_info
  main.rs          # Rust 入口
src-tauri/tauri.conf.json   # 窗口配置：transparent:true/alwaysOnTop/decorations:false
src-tauri/capabilities/default.json
src-tauri/Cargo.toml
```

关键 crate：
- `tauri-plugin-global-shortcut` — 全局热键（RegisterHotKey）
- `tauri-plugin-autostart` — 开机自启
- `tauri-plugin-store` — 前端数据持久化
- `arboard` — 剪贴板文本/图片读写
- `enigo` — 模拟 Ctrl+V 键盘事件
- `image` — 图片缩略图缩放
- `parselnk` — Windows .lnk 文件解析
- `walkdir` — Start Menu 目录遍历
- `flate2` — PNG 压缩
- `windows 0.58` — Win32 API FFI（CF_HDROP、SetForegroundWindow、GetClipboardSequenceNumber、SPI_GETWORKAREA）

---

## 四、关键配置 〔快照〕

- **窗口**：`transparent:true / decorations:false / alwaysOnTop:true / skipTaskbar:true / visible:false / focus:false`
- **当前热键**：`Ctrl+Space`
- **DPI**：开发机 200% 缩放（3200×2000 物理分辨率），窗口几何改动需考虑缩放
- **工作区尺寸**：运行时用 `SPI_GETWORKAREA` 动态获取（非硬编码），保留任务栏
- **开发端口**：Vite `1430`，HMR `1431`

---

## 五、核心功能模块 〔快照〕

- ✅ 全局热键 toggle 呼出/隐藏（Ctrl+Space，纯 toggle 无长短按）
- ✅ 全屏窗口 + 毛玻璃背景（`transparent:true` + `backdrop-filter: blur`）
- ✅ 全屏缝隙修复（SPI_GETWORKAREA + 动态 offset 补偿）
- ✅ 系统托盘常驻 + 开机自启
- ✅ 应用启动器（扫描 Start Menu / 图标提取 / 搜索 / 点击启动）
- ✅ 剪贴板文本（复制/粘贴，auto Ctrl+V 到焦点窗口）
- ✅ 剪贴板图片（后台缩略图缓存/历史切换粘贴/原图 Ctrl+V）
- ✅ 剪贴板文件（CF_HDROP 格式检测/写入/粘贴，单文件+多文件）
- ✅ 文件中转区（拖入暂存/元信息显示/拖出/持久化到 store）
- ✅ 快捷入口（常用 Windows 位置快速打开）
- 📋 Esc 关闭偶尔不生效（幽灵界面问题）
- 📋 窗口约 15-20 次开关出现一次闪烁（图片时加重）

---

## 六、Tauri 命令 & 事件 〔快照〕

**命令**（前端 `invoke`）：
| 命令 | 用途 |
|------|------|
| `get_clipboard_history` | 获取后台缓存的剪贴板历史 |
| `paste_clipboard` | 写入文本到剪贴板 + 焦点交还 + Ctrl+V |
| `set_clipboard_image` | 图片粘贴：历史图写回剪贴板 + 焦点交还 + Ctrl+V |
| `set_clipboard_files` | 文件粘贴：构造 CF_HDROP + 焦点交还 + Ctrl+V |
| `read_clipboard` | 读取剪贴板（文本+图片，含大图缩放） |
| `read_clipboard_text` | 仅读文本（轮询用，跳过图片编码） |
| `hide_window` | 前端主动隐藏窗口 |
| `open_file` | 用默认程序打开文件/文件夹 |
| `launch_app` | 启动应用（`.exe`/`.lnk` 目标） |
| `scan_start_menu` | 扫描开始菜单 .lnk 文件（带缓存） |
| `refresh_apps` | 强制刷新应用列表 |
| `get_file_info` | 获取文件/文件夹元信息 |
| `notify_hidden` | 通知 Rust 窗口已隐藏 |

**事件**（Rust `emit` → 前端监听）：
| 事件 | 用途 |
|------|------|
| `hotkey-show` / `hotkey-hide` | 热键 toggle 同步前端 visible 状态 |
| `clipboard-update` | 后台监听检测到新剪贴板内容，实时推送 |

---

## 七、打包 / 发布流程 〔快照〕

```bash
npm run tauri build    # → src-tauri/target/release/workbench-app.exe
```

- 产物路径：`src-tauri/target/release/workbench-app.exe`
- Release 模式：`windows_subsystem = "windows"`（无控制台窗口）
- 当前未配置签名 / 安装包

---

## 八、已知问题 / 待优化 〔快照〕

- **闪烁**：窗口约 15-20 次开关闪一次，图片 `<img>` 解码叠加 opacity 过渡时加重（独立问题，未根治）
- **Esc 关闭**：偶尔不生效（幽灵界面——页面视觉消失但仍拦截点击）
- **应用图标提取**：UWP 应用（如 Windows Terminal）提取失败，fallback 首字母
- **剪贴板图片**：历史图片粘贴的是缩略图(1024px)非原图（`set_clipboard_image` 从系统剪贴板重读原图，当前图有效，历史图只有缩略图）
- **多显示器**：当前仅适配主显示器工作区

---

## 九、变更记录 〔追加〕

### 2026-06-16
- 初始化项目记忆体系：CLAUDE.md（铁律）+ DECISIONS.md（决策根因）+ MEMORY.md（本文件）
- 完成 CF_HDROP 文件剪贴板：后台监听检测、DROPFILES 写入粘贴、前端 file 类型渲染
- 修复 fWide=FALSE→TRUE bug（UTF-16 路径解析失败）
- 修复跨类型去重误删 bug（文件条目错误清除文本条目）
- 图片粘贴延迟优化：去除冗余 get_image+set_image 读写循环，当前图直接 Ctrl+V
- sleep 优化：250ms→150ms（焦点交还）
- 前端 items/count 字段丢失修复（Bug 1+2，两处 ClipItem 构造不完整）
- 剪贴板后台监听从实时编码重构为缓存架构（消除弹出延迟）
- Git: a7c13b6 / d11bcf2 / 38df8b9 / c04585c
