# Workbench — 开发日志

> 本文件记录每次开发会话的具体工作：做了什么、改了什么文件、遇到的问题、下一步计划。
> **每次开发会话开始**：读本文件了解上下文；**每次会话结束**：更新本文件归档。
>
> 关联文档：`CLAUDE.md`（铁律与硬规则）· `DECISIONS.md`（架构决策根因）· `MEMORY.md`（项目现状快照与变更记录）

---

## 当前任务 〔快照〕

- **进行中**：增强搜索内置引擎（✅ 已完成并 GUI 验证通过）
- **下一步**：Everything 集成（用户可选切换的外部搜索引擎）
- **待决策**：无

---

## 会话归档

### 2026-07-01 #2 — 增强搜索内置引擎

**背景**：当前 `filesearch.rs` 只覆盖 5 个硬编码目录、子串匹配、30min 重建周期，覆盖面与新鲜度是短板。

**完成**：

| 模块 | 改动 | 文件 |
|------|------|------|
| 扫描目录可配化 | `scan_dirs()` 读 store key `scan-dirs`，兜底默认 5 目录 | `filesearch.rs` |
| 子序列匹配 | `subsequence_match()`："vsc"→"Visual Studio Code" | `filesearch.rs` |
| recency 排序 | `IndexEntry.mtime_secs` + `recency_bonus()`（今天+50/本周+30/本月+10） | `filesearch.rs` |
| 手动重建 | `rebuild_index` 命令 + 设置面板按钮 | `filesearch.rs` + `App.tsx` |
| 设置面板 | 新增「搜索」tab：状态/条目数/目录管理/立即重建 | `App.tsx` + `App.css` |
| 周期缩短 | 30min → 10min | `filesearch.rs` |

**命令注册**：`get_scan_dirs` / `rebuild_index` → `lib.rs`

**GUI 验证**：✅ 通过（索引状态显示、立即重建、目录添加移除、子序列搜索均可正常使用，新下载文件手动重建后立即可搜）

**提交**：`c9fdfce` + `a8bf1f5`

**未做 / 留后续**：
- Everything 集成（下一阶段）
- 文件系统监听增量更新（notify crate，复杂度高，优先级低）

---

### 2026-07-01 #1 — 续52+53 收尾 + Ctrl+V 重构

**背景**：`src-tauri/` 被误删后从 git 恢复，续52/53 代码+文档在磁盘但未提交。

**完成**：
- 恢复 `src-tauri/` 目录
- 验证编译通过（cargo check / clippy / tsc）
- 提交续52（clip_images janitor）+ 续53（Explorer 文件夹图片粘贴三分叉）
- 审查截图粘贴实现弊端，确认桌面分支 hide+sleep 不可移除（class 检测必需）
- 抽取 `paste_ctrl_v()` 消除 4 处 Ctrl+V 重复代码（-22 行）
- 更新 `.gitignore` 屏蔽 `.reasonix/` 和 `reasonix.toml`

**提交**：`05bd54c` + `007e0b5` + `31a14d4` + `8f88629`

**关键决策**：
- 桌面分支 hide+sleep 不重构：overlay 遮着看不到背后窗口类名，150ms 开销可忽略
- 续53 三分叉（桌面/Explorer/其余app）稳定性分析：Win10 完全兼容，CF_HDROP 路径复用已验证的 `set_clipboard_files` idiom

---

## 文件索引

| 文件 | 用途 | 更新频率 |
|------|------|----------|
| `CLAUDE.md` | 铁律、硬规则、死胡同 | 结构性改动时 |
| `DECISIONS.md` | 架构决策根因 | 新决策 / 推翻旧结论时 |
| `MEMORY.md` | 项目现状快照 + 功能清单 + 变更记录 | 每次提交后 |
| `DEVLOG.md` | 开发过程记录 + 会话归档 | 每次会话开始/结束 |
