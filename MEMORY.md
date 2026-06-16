# Workbench — 项目记忆（memory）

> **最后更新**：2026-06-16
>
> **关联文档**：规则铁律看 `CLAUDE.md`；决策根因看 `docs/DECISIONS.md`；本文件 = **项目现状快照 + 变更记录**，是迁移到新会话 / 新对话时带走的那一份。
>
> **维护方式（给 Claude Code）**：
> - 标〔快照〕的小节 = **覆盖更新**，永远反映当前真实状态（旧内容直接改掉）。
> - 标〔追加〕的小节 = **只往后加**，不改历史。
> - 每次发生结构性改动 / 完成一个功能 / 修掉一个 bug：① 更新对应〔快照〕小节 ② 在「九、变更记录」追加一行 ③ 改顶部"最后更新"日期。
> - 铁律、决策根因**不在本文件重复**，只指向 CLAUDE.md / DECISIONS.md，避免两处不同步。

---

## 0. 当前状态 / 下一步 〔快照〕

- **进行中**：←
- **下一步**：←
- **阻塞 / 待决策**：←

---

## 一、项目概览 〔快照〕

一句话：Windows 全屏"第二桌面"工具——热键 toggle 呼出覆盖全屏的功能界面（应用启动器 / 文件中转 / 剪贴板历史），用完优雅消失。

| 层 | 技术栈 | 职责 |
|---|---|---|
| 前端 UI | React 18 + TypeScript + Vite + Tailwind CSS | 界面、交互 |
| 桌面 / 系统层 | Tauri 2.0（Rust） | 窗口、全局热键、剪贴板、系统托盘、应用扫描 |
| 产物 | Tauri 打包单 exe | 目标 ~5MB 包体 / ~30MB 内存 |

运行 / 构建：
```bash
npm install
npm run tauri dev      # 开发（脚本名以 package.json 为准）
npm run tauri build    # 打包
```

---

## 二、前端（src/）〔快照〕

核心文件结构：
```
src/
  App.tsx          # 前端主入口
  ...              # ← Claude Code: 扫描后补全（组件 / 样式 / hooks）
```

关键依赖（运行时）：← Claude Code: 从 package.json 补全

---

## 三、Rust 后端（src-tauri/）〔快照〕

核心目录：
```
src-tauri/src/
  lib.rs           # 主逻辑：窗口、全局热键、剪贴板、Tauri 命令
  apps.rs          # 应用扫描 / ExtractIconEx 图标提取
  ...              # ← Claude Code: 补全
src-tauri/tauri.conf.json   # 窗口配置
src-tauri/Cargo.toml
```

关键依赖（crate）：
- `tauri-plugin-global-shortcut` — 全局热键（底层 RegisterHotKey）
- `arboard` — 剪贴板文本 / 图片读写
- `enigo` — 模拟 Ctrl+V 粘贴
- `image` — 图片缩略图缩放（FilterType::Triangle）
- `windows` / `winapi` — CF_HDROP、SetForegroundWindow、GetClipboardSequenceNumber 等 FFI
- ← Claude Code: 其余补全

---

## 四、关键配置 〔快照〕

- **窗口（tauri.conf.json）**：`transparent:true` / `decorations:false` / `alwaysOnTop:true` / `skipTaskbar:true` / `visible:false` / `focus:false`（不可随意改，原因见 DECISIONS §4）
- **当前热键绑定**：← 填写（如 `Ctrl+反引号`）
- **环境变量**：桌面应用，当前无 / ← 如有则列出
- **自启动 / 托盘**：已启用

---

## 五、核心功能模块 〔快照〕

状态图例：✅ 稳定　🚧 进行中　📋 待办

- ✅ 全局热键 toggle 呼出 / 隐藏（非 Alt 修饰键）
- ✅ 全屏透明窗口 + 毛玻璃背景 + 高 DPI 缝隙修复
- ✅ 系统托盘常驻 + 开机自启
- ✅ 应用启动器（扫描开始菜单 / 图标提取 / 点击启动）
- ✅ 剪贴板历史（文字 / 图片 / 文件三类，点击粘贴到焦点处）
- 📋 文件中转区（拖入暂存，独立于剪贴板文件历史）
- 📋 应用区横向图标行布局 / 模块间去边界
- 📋 快捷入口自定义 / 应用频率排序验证

> 铁律不在此重复，完整见 `CLAUDE.md`。

---

## 六、Tauri 命令 & 事件 〔快照〕

前后端通过 Tauri IPC 通信（不是 HTTP API）。

命令（前端 `invoke`）：
- `get_clipboard_history()` — 取剪贴板缓存
- ← Claude Code: 按 lib.rs 实际补全

事件（Rust `emit` → 前端监听）：
- `clipboard-update` — 剪贴板内容变化推送
- ← Claude Code: 补全（如窗口显隐状态同步事件）

---

## 七、打包 / 发布流程 〔快照〕

- ← Claude Code: 补全（build 命令、产物路径、签名 / 安装包形式等）

---

## 八、已知问题 / 待优化 〔快照〕

- **闪烁**：约 15–20 次开关闪一次，图片渲染时加重；独立小问题，未根治。
- ← 其余随时补充

---

## 九、变更记录 〔追加〕

### 2026-06-16
- 建立项目记忆体系：`CLAUDE.md`（规则铁律）+ `docs/DECISIONS.md`（决策根因）+ 本文件（现状快照 + 变更记录）。