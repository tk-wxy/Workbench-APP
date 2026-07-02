# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-02（续81：三大 md 文档优化——HISTORY.md 归档 + §0A 滚动窗口 + 单一真相源约定）
>
> **文档分工**：规则铁律 → `CLAUDE.md`（唯一 agent 规则入口）；决策根因 → `DECISIONS.md`（目录带一行摘要，按需选读）；本文件 = 现状快照 + 最近 ≤3 个会话详记；历史 → `HISTORY.md`（默认不读，考古用 Grep 按「续N」定位）。
>
> **维护方式**：
> - 标〔快照〕的小节 = 覆盖更新，反映当前真实状态
> - §0A = 滚动窗口，只留最近 ≤3 个会话详记；写入新详记时把最老一条整段迁入 `HISTORY.md`「一、会话详记归档」顶部，本文件不留副本
> - 每次结构性改动完成后：① 更新 §0 短快照 ② 本会话详记写 §0A（同时迁出最老一条） ③ 改顶部日期
> - **单一真相源**：每个事实只落一处（硬规则→CLAUDE.md / 根因→DECISIONS.md / 现状→本文件 / 历史→HISTORY.md，git log 已有的不重复记），其他位置只放一行指针
> - **短行原则**：详记写多行短 bullet，禁止数千字符单行（毁掉 Read offset / Grep 局部读取）；严禁粘大段代码

---

## 0. 当前状态 / 下一步 〔快照，会话入口〕

- **当前稳定功能**：热键呼出（长按 momentary + 短按 toggle，键态轮询驱动，组合可自定义/录制式）+ Esc 关闭 + light dismiss；三类型剪贴板历史/粘贴/复制/持久化 + 图片原图缓存 janitor；中转区多选/框选/批量 file/拖入/拖出；启动器收藏托盘（含拖拽排序）；增强搜索 + 文件索引（内置/可选 Everything 双引擎）；设置面板（常规/启动台/中转站/剪贴板/搜索/快捷键/关于）。
- **最高危提醒**：窗口/焦点/热键/剪贴板改动前必须重读 `CLAUDE.md` 铁律。尤其：别改 `tauri.conf.json` 的 `transparent:true`/`focus:false`；别让前端管 hide；别回退 RegisterHotKey 事件驱动 show/hide；新增剪贴板读写必须过 `CLIPBOARD_LOCK`。
- **最近状态（续81，纯文档，零代码改动）**：三大 md 优化——新建 `HISTORY.md` 归档全部变更记录与老化详记；MEMORY 瘦身；CLAUDE.md 铁律去叙事；DECISIONS 目录加摘要。详见 §0A。
- **上一状态（续80）**：修「点击粘贴偶发失败」——焦点交还盲等 `sleep(150ms)` 改守卫轮询 `wait_foreground_handback`。GUI 实测文本→Chrome 通过；file/image 与高负载场景待日常观察。同会话删除 `AGENTS.md`。详见 §0A + DECISIONS §3 延伸。
- **待办（续75 GUI 反馈遗留，启动台拖拽打磨）**：
  - ⓪a 舍去抓手光标——grab/grabbing 实测卡顿，回退光标改动（`.app-tile` cursor 恢复默认、`.launcher-reordering` 去 grabbing）。
  - ⓪b 被拖项目跟随观感——源 `opacity:0` 后拖动中项目"消失"；先在真实拖拽下加日志确认 ghost 是否跟手到位，再决定强化跟随还是让源半可见。
- **下一步候选（无阻塞）**：① 启动器键盘导航；② 文件结果右键「打开所在目录」+ 命中高亮回传；③ 索引目录可配置；④ 增强搜索纳入剪贴板条目；⑤ file/folder 收藏的非拖入入口；⑥ 拖出边角补测（text→记事本等；核心路径已实测通过，低风险）；⑦ Gemini/contenteditable 文本拖入硬边界（用户计划未来攻克，方向需绕开「dragover 不落 caret」根因，见 HISTORY 续73 记录）。
- **阻塞 / 待决策**：无。

## 0A. 最近状态细节 〔滚动窗口 ≤3 会话；更早的详记在 HISTORY.md〕

### 续81（2026-07-02，纯文档，零代码改动）——三大 md 文档优化
- **动因**：MEMORY.md 膨胀至 195KB（Read 全文超工具上限），§0A 单条 bullet 长达数千字符；同一事实最多重复 4 处；CLAUDE.md 每会话自动加载且叙事占比高——tokens 消耗大、局部读取失效。
- **改动**：
  - 新建 `HISTORY.md`：原 MEMORY §九（全部变更记录）+ §0A 老化详记（续23~续78 等）**逐字迁入，零信息删除**。
  - `MEMORY.md`：§0 重写为短快照；§0A 改滚动窗口（≤3 会话，多行短 bullet 格式）；§一~八快照保留并修正陈旧项（§五功能清单、§六命令表补新条目）；§九改为一行指针。
  - `CLAUDE.md`：铁律去叙事——硬规则全保留，踩坑经过压缩为一行 + DECISIONS §指针；会话开始改为渐进式读取协议；「强制记忆更新」升级为完整文档维护约定（滚动窗口/单一真相源/短行原则）。
  - `DECISIONS.md`：**仅动目录**——每 § 加一行结论摘要、修正编号漂移（旧目录把 §13 git 历史标成 §12、把 §14 拖入标成「废弃」而实际已推翻实现），正文一字未改。
- **验证**：Grep 抽查关键规则（CLIPBOARD_LOCK / fWide / show 三约束 / 死胡同清单）在 CLAUDE.md 全部命中；归档采用 sed 按行号逐字提取 + 字节数核对，确认迁移完整。
- **文件**：`CLAUDE.md` / `MEMORY.md` / `DECISIONS.md`（仅目录）/ `HISTORY.md`（新）。

### 续80（2026-07-02，仅 clipboard.rs + 文档）——点击粘贴不稳定修复（焦点交还守卫轮询）
- **症状与诊断**：点击历史项粘贴偶发失败、但手动 Ctrl+V 能粘上 → 剪贴板写入已成功，失败全在「hide → 盲等 150ms → 注入 Ctrl+V」后半段：`window.hide()` 是异步派发，负载高时 150ms 赌输，`GetForegroundWindow` 仍返回本窗口/NULL → Ctrl+V 注入进已隐藏的自家 WebView；还会污染 file/image 的 class 三分叉。
- **修复（单变量）**：新增 `wait_foreground_handback(&app, tag)`——10ms 采样至前台「非本窗口且非 NULL」，上限 500ms 超时保底继续，确认后 50ms 落定余量（常量 `FOCUS_HANDBACK_POLL_MS/MAX_MS/SETTLE_MS`；self hwnd 取法同 `start_focus_watch`）；替换 paste/filepaste/imgpaste 三处 `sleep(150ms)`，补齐带 tag 日志（文本路径原先零日志、失败不可诊断）。
- **已识别未修**（详见 DECISIONS §3 延伸续80）：① show 时未快照原前台 HWND（`SetForegroundWindow(GetForegroundWindow())` 恒等空操作），结构性改流程暂缓；② UIPI 提权目标静默吞 SendInput，无解只能将来提示；③ 物理修饰键未中和。若再偶发失败，先看 `[paste]/[filepaste]/[imgpaste] handback` 日志的 timeout 与 fg class 定位是①还是②。
- **验证**：`cargo clippy` 8 条基线不变、新代码零警告；**GUI 实测（2026-07-02，用户）文本→Chrome 对话框成功**（waited=0ms / timeout=false / fg class 正确，全程 114ms，比旧盲等还快）；file/image 路径与高负载场景待日常观察。
- **文件**：`src-tauri/src/clipboard.rs`。文档同步：CLAUDE.md 焦点交还铁律改守卫轮询、DECISIONS §3 延伸记根因。同会话应用户要求删除 `AGENTS.md`（Codex 副本，零信息丢失），CLAUDE.md 成唯一规则入口。

### 续79（2026-07-01，纯前端，GUI 未实测）——设置面板按功能域重构
- `SETTINGS_TABS` 扩为 常规/启动台/中转站/剪贴板/搜索/快捷键/关于：常规只留背景主题 + 开机自启；启动台页含收藏数量/添加应用/清空/手动排序标注；中转站页承接显示布局 + 清空中转条目；剪贴板页只留历史条数/清空历史/图片原图缓存；搜索页承接呼出默认搜索模式 + 搜索引擎/额外目录。
- CSS：`.settings-action` 普通按钮 hover 中性样式、清空类加 `.danger` 才红色 hover；新增 `.settings-inline-actions` / `.settings-row-value`。
- **验证**：`npx tsc --noEmit` + `npm run build` 通过；GUI 观感待用户实测。文件：`src/App.tsx` / `src/App.css`。

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
  lib.rs           # 主逻辑：窗口全屏、热键监听/焦点 light dismiss、托盘、Tauri setup/命令注册（续54 拆分后 ~530行）
  clipboard.rs     # 剪贴板子系统：历史/粘贴/复制/janitor/后台监听；clipboard::init 封装 setup 时序（续54 从 lib.rs 拆出，~1038行）
  apps.rs          # 应用扫描：Start Menu .lnk 解析、ExtractIconEx 图标提取、get_file_info、resolve_lnk
  dragdrop.rs      # 中转区原生拖入：自注册 IDropTarget，Drop emit files-dropped
  filesearch.rs    # 文件系统搜索：后台预建内存索引（独立线程，双缓冲原子替换，零前端阻塞）
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
- **当前热键**：`Ctrl+Space`——show/hide 由 `GetAsyncKeyState` 物理键态轮询驱动（`start_hotkey_monitor`，25ms）；RegisterHotKey 仅空 handler 消费按键防泄漏。长按 momentary / 短按 toggle，分界 `HOTKEY_TAP_MAX_MS=250ms`
- **DPI**：开发机 200% 缩放（3200×2000 物理分辨率），窗口几何改动需考虑缩放
- **工作区尺寸**：运行时用 `SPI_GETWORKAREA` 动态获取（非硬编码），保留任务栏
- **开发端口**：Vite `1430`，HMR `1431`

---

## 五、核心功能模块 〔快照〕

- ✅ 全局热键呼出/隐藏：键态轮询驱动，**长按 momentary + 短按 toggle**；组合可自定义（录制式输入 + 表驱动 `parse_combo`，默认 Ctrl+Space）
- ✅ 全屏窗口 + 毛玻璃背景（`transparent:true` + `backdrop-filter: blur`）+ 无缝贴合（SPI_GETWORKAREA + 动态 offset 补偿 + `clamp_window_bottom`）
- ✅ Esc 关闭 + light dismiss（点外部应用自动隐藏，arm-after-focus 状态机）
- ✅ 系统托盘常驻 + 开机自启
- ✅ 启动器收藏托盘：手动策展持久化（app/file/folder），app picker、.lnk 拖入提取图标、拖拽排序（Launchpad 式让路）、放大启动动画
- ✅ 剪贴板历史（文本/图片/文件三类型）：后台监听 + 粘贴（图片按目标三分叉落地）+「只复制」按钮（seq 水位防回流）+ 持久化 + 条数四档可配 + 原图落盘 & janitor + aHash 去重
- ✅ 文件中转区：混合条目（file/text/image）、📌钉入、单击取走粘贴/复制/打开/删除、多选/框选/批量、双布局（列表/方格）、原生拖入（IDropTarget）+ 拖出（DoDragDrop）
- ✅ 增强搜索（默认 Ctrl+K，可自定义）：应用 + 中转 + 文件系统（内置索引 / 可选 Everything 双引擎），分组渲染 + 键盘导航 + 系统图标
- ✅ 顶栏普通搜索：三区就地联动过滤（与增强搜索分工独立）
- ✅ 快捷入口（常用 Windows 位置快速打开 + 截屏）
- ✅ 设置面板（左侧条目导航 + 右侧详情）：常规/启动台/中转站/剪贴板/搜索/快捷键/关于
- 📋 窗口偶发闪烁（图片解码时加重，预渲染方案已大幅缓解，剩余概率未知）

---

## 六、Tauri 命令 & 事件 〔快照〕

**命令**（前端 `invoke`）：
| 命令 | 用途 |
|------|------|
| `get_clipboard_history` | 获取后台缓存的剪贴板历史 |
| `paste_clipboard` | 写入文本到剪贴板 + 焦点交还 + Ctrl+V |
| `set_clipboard_image` | 图片粘贴：历史图写回剪贴板 + 焦点交还 + Ctrl+V（`orig_path` 优先读原图文件，失败降级缩略图）|
| `set_clipboard_files` | 文件粘贴：CF_HDROP + 焦点交还 + Ctrl+V（桌面走 SHFileOperation）|
| `hide_window` | 前端主动隐藏窗口（纯 hide + emit hotkey-hide）|
| `open_file` | 用默认程序打开文件/文件夹 |
| `launch_app` | 启动应用（`.exe`/`.lnk` 目标） |
| `scan_start_menu` | 扫描开始菜单 .lnk 文件（带缓存） |
| `refresh_apps` | 强制刷新应用列表（已注册，前端暂未接入）|
| `get_file_info` | 获取文件/文件夹元信息 |
| `delete_clipboard_item` | 从后台缓存删除指定剪贴板条目（按 time）|
| `clear_clipboard_history` | 清空后台 CLIP_CACHE 全部条目（设置面板"清空"）|
| `copy_text_to_clipboard` | 只复制文本到当前剪贴板（不粘贴/不隐藏；seq 水位防回流历史）|
| `copy_image_to_clipboard` | 只复制图片到当前剪贴板（`orig_path` 优先读原图文件，失败降级缩略图；不粘贴/不隐藏）|
| `open_clip_image_dir` | 用 Explorer 打开 `clip_images/` 原图缓存目录 |
| `clear_clip_image_cache` | 删除 `clip_images/` 内全部文件（不删目录；降级/自愈由 paste fallback + load strip 兜底）|
| `copy_files_to_clipboard` | 只复制文件 CF_HDROP 到当前剪贴板（同上）|
| `reveal_in_explorer` | 在资源管理器中高亮目标文件（/select,path）|
| `trigger_screenshot` | hide overlay + emit hotkey-hide + 150ms + enigo Win+Shift+S |
| `search_files` | 文件系统搜索：纯内存子串打分查询后台索引（µs 级，限 50 条）；结果附带 Shell 图标（extension 去重后批量提取，随结果同步返回）|
| `get_file_icons` | 批量获取文件/文件夹 Shell 图标（base64 PNG data URL），单次 COM init 覆盖整批；search_files 内部已调用，前端也可单独用 |
| `get_index_status` | 返回搜索状态 `{ready,count,engine,everythingAvailable}`（前端显示「建立中…」/「Everything 未运行」用）|
| `set_search_engine` | 切换搜索引擎（"builtin"/"everything"）；持久化前端 store 负责，命令不写 store |
| `set_search_dirs` | 设置内置引擎额外扫描根目录并触发一次后台重建；持久化前端 store 负责 |
| `reload_everything` | 热更新 Everything：丢弃旧 DLL 句柄重载，返回重载后是否可用（换 DLL / 启动 Everything 后无需重启）|
| `resolve_lnk` | 解析 .lnk 快捷方式：提取图标 + 去后缀名称（拖入启动器存 kind:"app"）|
| `set_hotkey` | 运行时切换呼出热键：parse_combo → register(new) 成功 → unregister(old) → 更新 HOTKEY_VK_KEYS/CURRENT_SHORTCUT；失败保留旧组合并 Err；不写 store（持久化前端负责）|
| `set_clip_cache_max` | 运行时调整剪贴板历史条数上限（四档 10/20/50/100；持久化前端 store 负责）|
| `start_drag_out` | 中转区拖出：worker 构建 IDataObject 格式 → 主线程 DoDragDrop（DECISIONS §18）|

**事件**（Rust `emit` → 前端监听）：
| 事件 | 用途 |
|------|------|
| `hotkey-show` / `hotkey-hide` | 热键 toggle 同步前端 visible 状态 |
| `clipboard-update` | 后台监听检测到新剪贴板内容，实时推送 |
| `file-index-ready` | 文件索引后台线程每次建/重建完成推送条目数（前端增强搜索据此置 indexReady）|
| `apps-ready` | 应用扫描后台线程（start_apps_worker）扫完一次性推送 apps 列表（消除首次呼出卡顿）|
| `files-dropped` | 原生拖入：`{paths,x,y}` 物理像素，前端判落点入启动器/中转 |
| `file-drag-enter` / `file-drag-leave` | 拖入悬停：前端 100ms 防抖后驱动双区高亮（HTML5 dragenter 在 dragDropEnabled:false 下不触发，故走 Rust emit）|
| `drag-out-done` | 拖出完成：回传 effect（move→按 draggedIds 移除条目并落盘；copy/none→保留；单 text+copy→回退 copyAndPaste）|

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
- **应用图标提取**：UWP 应用（如 Windows Terminal）提取失败，fallback 首字母
- **「只复制」按钮图片粘不进文件夹/桌面**：`copy_image_to_clipboard`（卡片右下角「只复制」）放的是位图(CF_DIB)，用户自行 Ctrl+V 只能粘进接受图片的目标（输入框/Word/画图）；文件夹/桌面只收 CF_HDROP 文件格式。注意区别：点整张卡片触发的**自动粘贴**（`set_clipboard_image`）有桌面检测分支，走 SHFileOperation 落地为文件，桌面/文件夹正常可用。**已决定「只复制」保持 CF_DIB**（用户 2026-06-20 确认，不做双格式/临时 PNG 方案，别当 TODO 去"修"）。若日后真要支持：copy_image 同时落临时 PNG + 写 CF_HDROP（双格式上剪贴板）
- **多显示器**：当前仅适配主显示器工作区
- ~~中转区与快捷入口视觉重合~~：**已修（2026-06-21）**。`center-panel` 改 `overflow:hidden`（固定高度分配），`drop-area` 加 `overflow-y:auto`（内部独立滚动），快捷入口始终可见。

---

## 九、变更记录 〔已归档〕

全部变更记录（2026-06-14 起，续1~续80）已迁至 `HISTORY.md`「二、变更记录」；新变更记录直接追加到 HISTORY.md，本节只留此指针。查历史用 Grep 按「续N」/日期/关键词定位。
