# Agent 入口路由

> **本文件是所有 AI 编码助手（Antigravity / Gemini / Codex / Copilot 等）的预读入口。**
> 核心规则、铁律、项目上下文均在 `CLAUDE.md`——请**立即预读** `CLAUDE.md` 全文。

## 必读文件（按优先级）

1. **`CLAUDE.md`** — 唯一规则真相源：技术栈、铁律（窗口/焦点/热键/剪贴板）、死胡同清单、协作约定、强制记忆更新规则。**每次会话开始必须读取。**
2. **`MEMORY.md` §0** — 当前进度/待办/下一步（快照）。与当前任务相关时继续读 §0A。
3. **`DECISIONS.md`** — 架构决策与踩坑根因（按需选读，先看目录摘要）。
4. **`HISTORY.md`** — 历史归档（默认不读，考古时用 Grep 按「续N」/关键词定位）。

## 项目概要

Windows 全屏"第二桌面"工具：热键 toggle 呼出覆盖全屏的功能界面（应用启动器 / 文件中转 / 剪贴板历史），用完优雅消失。

| 层 | 技术栈 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | Tauri 2.0（Rust） |

## 核心约束（摘要，详见 CLAUDE.md）

- **窗口/焦点/热键/剪贴板**是最高危区，改动前必须读完 `CLAUDE.md` 铁律章节
- `tauri.conf.json` 锁定项：`transparent:true` / `focus:false` **不能改**
- 可见性唯一真相 = `window.is_visible()`（Rust），**前端不管 hide**
- 全局热键 = `GetAsyncKeyState` 物理键态轮询，**不用** `RegisterHotKey` 事件驱动 show/hide
- 新增剪贴板读写必须过 `CLIPBOARD_LOCK`
- 默认先诊断再修改：先读代码/日志/决策记录确认根因
- 完成任务前必须更新 `MEMORY.md`

## 常用命令

```bash
npm install
npm run tauri dev      # 开发运行
npm run tauri build    # 打包
```

---

> ⚠️ **不要在本文件添加新规则。** 所有规则的单一真相源是 `CLAUDE.md`，本文件仅作路由指针。
