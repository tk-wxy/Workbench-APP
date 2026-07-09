# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-09（续93：启动器网格键盘导航，已提交，见 §0）
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

- **当前稳定功能**：热键呼出（长按 momentary + 短按 toggle，键态轮询驱动，组合可自定义/录制式）+ Esc 关闭 + light dismiss；三类型剪贴板历史/粘贴/复制/持久化 + 图片原图缓存 janitor；中转区多选/框选/批量 file/拖入/拖出，条目**可选持久化**（设置→中转站「持久化」，默认关闭=拖出成功后自动消失），**容量可调**（设置→中转站「上限条数」20/50/100/200，默认 20）；启动器收藏托盘（含拖拽排序）；增强搜索 + 文件索引（内置/可选 Everything 双引擎）；设置面板（常规/启动台/中转站/剪贴板/搜索/快捷键/关于）；**界面语言中/英文切换**（设置→常规，含托盘菜单同步）。
- **续93（已提交，用户已确认测试通过）**：启动器（收藏托盘）网格新增键盘导航（Start 菜单风）——搜索框内 `↓` 进网格，网格内 `←→↑↓` 二维移动（列数按 DOM `offsetTop` 动态算）、`Enter` 打开（复用 `openLauncherItem`+放大动画）、行首`←`/首行`↑`/`Esc` 回搜索框；未进网格时保留旧 `filteredApps[0]` Enter 兜底。复用既有 `.app-tile.selected`（CSS 零新增），未碰窗口/焦点/热键最高危区。版本号 0.3.4→0.3.5（PATCH）。
- **续92（已提交，用户已确认测试通过）**：增强搜索（Ctrl+K）结果新增右键菜单——打开/复制到剪贴板/打开所在目录/加入启动台/加入中转区，按 kind 取可用子集，全部复用现有 `ctxMenu` 基础设施 + 动作 handler（零新增 Rust/剪贴板/i18n）。附带修复：键盘/热键操作（Ctrl+Space 关页、Ctrl+K 切页等）现在会自动关闭该右键菜单。版本号 0.3.3→0.3.4（PATCH）。
- **续91（已提交，用户已确认测试通过）**：中转区多选模式下卡片悬浮不再露出单条操作按钮（`.stage-card-actions`/list 布局的 `.clip-copy-btn` 等），纯 CSS 门控（容器加 `stage-multiselect` class），未动 JS 状态机。版本号 0.3.2→0.3.3（PATCH）。
- **续90（已提交，用户已确认测试通过）**：①中转站容量从硬编码 20 改为可配置（20/50/100/200，纯前端 store 持久化，无需 Rust 同步）；②`.stage-grid` 从 flex-wrap 改 CSS Grid（`auto-fill` + `justify-content:center`）修复方格卡片左右缝隙不对称。版本号 0.3.1→0.3.2（PATCH）。
- **续89**：全局 `user-select:none` 加在 `html` 根（`src/App.css`），`input`/`textarea` 例外保留文本编辑；修复此前拖拽/点击时界面文本大片被框选变蓝的观感问题。此前零散加的 `.launcher-reordering`/`.stage-reordering`/`.lasso-active`/`#overlay.dragging` 局部 user-select 规则仍保留（现为冗余但无害，未清理）。版本号 0.3.0→0.3.1（PATCH）。
- **续88（已提交 `e218c93`/`093bb4f`，五轮 GUI 修复）**：中转区「区内拖动排位」+ 与拖出转移共存，含"按热键升级为原生拖出并投放"。代码已完整提交，非工作树遗留（此前 §0 的"工作树未提交"记录为过时笔误，续90/续91 文档更新时漏改，现已订正）。详见 §0A / DECISIONS §18。
- **最高危提醒**：窗口/焦点/热键/剪贴板改动前必须重读 `CLAUDE.md` 铁律。尤其：别改 `tauri.conf.json` 的 `transparent:true`/`focus:false`；别让前端管 hide；别回退 RegisterHotKey 事件驱动 show/hide；新增剪贴板读写必须过 `CLIPBOARD_LOCK`。
- **续75 GUI 反馈遗留已核实为完成态**（`9ff95c7`/`be03400`，早于续88 即已合入 master，此前未随「续N」命名记录，MEMORY 长期漏更）：
  - ⓪a 抓手光标已舍去——`.app-tile` 无 cursor 覆盖，`.launcher-reordering` 无 grabbing，仅保留 `user-select:none`（见 `App.css` 行 101 注释）。
  - ⓪b 拖动跟随已实现——`launcher-drag-ghost`：`cloneNode` 生成 fixed 定位副本、指针移动直接写 DOM style 跟手（零 React 渲染），源格改 `opacity:0` 由 ghost 代替，松手 180ms 回落后再清 ghost/class。
- **下一步候选（无阻塞）**：① 增强搜索结果的键盘导航已具备（↑↓/Enter），启动器键盘导航续93 已完成——可考虑「Ctrl+K 增强搜索也支持 ←→ 或 Tab 在 Tier 间跳」等细化；② 索引目录可配置；③ 增强搜索纳入剪贴板条目（让搜索成唯一入口）；④ file/folder 收藏的非拖入入口；⑤ 拖出边角补测（text→记事本等；核心路径已实测通过，低风险）；⑥ Gemini/contenteditable 文本拖入硬边界（用户计划未来攻克，方向需绕开「dragover 不落 caret」根因，见 HISTORY 续73 记录）。

## 0A. 最近状态细节 〔滚动窗口 ≤3 会话；更早的详记在 HISTORY.md〕

### 续92（2026-07-09，src/App.tsx，用户已确认测试通过并提交）——增强搜索结果新增右键菜单
- **需求**：增强搜索（Ctrl+K）条目加右键菜单，菜单项：打开 / 复制到剪贴板 / 打开所在目录 / 加入启动台 / 加入中转区。
- **实现**：新增 `openEnhCtxMenu(e,r)`，`onContextMenu` 挂到 `.enh-result` div。复用现有 `ctxMenu` 基础设施（`openCtxMenu`/`CtxMenuItem`）+ 已有动作 handler（`activateEnh`/`writeItemToClipboard`/`reveal_in_explorer`/`addFsToLauncher`/`addFsToStage`/`addAppToLauncher`/`copyStageToClipboard`）——**零新增 Rust 命令 / 剪贴板路径 / i18n 词条**（全部复用已有翻译键）。抽了 `revealPath` 小 helper 去重。
- **按 kind 取可用子集**：`fs` 全 5 项；`app` 无「加入中转区」（中转=文件转移语义，应用不适用），复制到剪贴板复制其 .lnk/.exe 路径；`stage`（enhTier1 已过滤恒 file 类型）无「加入中转区」（已在中转区）。stage 恒 file → `activateEnh` 的 `items[0].path` 恒有效，无崩溃风险。
- **小缺陷修复（用户 GUI 反馈）**：右键菜单是纯鼠标浮层（无键盘交互），原本键盘/热键操作不关它、导致切页/关页后残留悬浮。补两处 `setCtxMenu(null)`：① keydown 处理器顶部 blanket 关闭（`ctxMenuRef.current && e.key!=="Escape"` → 关菜单但不 return，让按键照常执行，如 Ctrl+K 关菜单+切页一气呵成；Esc 走既有分层分支，第一次只关菜单）；② `hotkey-hide` 事件批量复位（全局热键 Ctrl+Space 关页被 Rust 消费、不经前端 keydown，只能在此事件清）。
- **验证**：`npx tsc --noEmit` 零错误；用户 GUI 实测右键三类条目菜单 + Ctrl+Space/Ctrl+K/Esc/方向键关闭菜单均确认通过。
- **提交**：`aa06635`（feat，含小缺陷修复）+ `643d29f`（chore 版本号 0.3.3→0.3.4，PATCH）。
- **文件**：`src/App.tsx`（`openEnhCtxMenu`/`revealPath`/keydown blanket/hotkey-hide 复位/`.enh-result` onContextMenu）。

### 续93（2026-07-09，src/App.tsx，用户已确认测试通过并提交）——启动器网格新增键盘导航（Start 菜单风）
- **需求**：启动器（收藏托盘）加键盘操作——↑↓←→ 移动选中、Enter 打开，此前只有「顶栏搜索非空时 Enter 起动 filteredApps[0]」的兜底。
- **实现**：新增 `launcherSelIdx` state（-1=未选中/焦点在搜索框）。keydown 处理器加 launcher 网格导航块：
  - 未选中(idx<0)：仅 `↓` 进入网格（setIdx 0）；`←→↑` 不 preventDefault，留给搜索输入框做光标编辑（Start 菜单式：先打字过滤，↓ 才进结果）。
  - 已选中(idx>=0)：`←→` ±1、`↑↓` ±cols 二维移动并 clamp；行首 `←`/首行 `↑` 退回搜索框（setIdx -1 + searchRef.focus）；`Enter` 打开选中项（复用 `openLauncherItem`，含放大动画，iconEl 取 `.app-tile.selected .app-tile-icon`）。
  - **列数 `cols` 按 DOM 动态算**（`.app-tile` 首行同 `offsetTop` 计数），不硬编码——契合高 DPI/响应式铁律。
- **兜底保留**：未进入网格(idx<0)时 Enter 仍走旧 `filteredApps[0]` 起动路径。
- **Esc 分层链新增一段**：选中态(idx>=0)先解除选中+回搜索框、再关页（插在 stageSel 之后、settings 之前，用直接值非 ref——已随 idx 入 effect deps）。
- **复用与零新增**：高亮复用既有 `.app-tile.selected`（CSS 行 91，与 :hover 同背景）→ **CSS 零新增**；两 effect——选中项 `scrollIntoView` + `visible`/`search` 变化复位 idx=-1（打字过滤即退出网格，语义自洽）。`.app-tile` className 加 `${i===launcherSelIdx?" selected":""}`。
- **未碰最高危区**：呼出 set_focus 不动，纯 JS 键处理。effect deps 补 `filteredLauncher/launcherSelIdx/openLauncherItem`。
- **验证**：`npx tsc --noEmit` 零错误；用户 GUI 实测 ↓进网格/四向移动/Enter起动+动画/搜索框内←→编辑不误入网格/首行↑·行首←·Esc 回搜索框 均确认通过。
- **提交**：`822017f`（feat）+ `3825372`（chore 版本号 0.3.4→0.3.5，PATCH）。
- **文件**：`src/App.tsx`（`launcherSelIdx` state / 两 effect / keydown 网格导航块 + Esc 一段 / `.app-tile` selected class）。

### 续91（2026-07-08，src/App.tsx + src/App.css，用户已确认测试通过并提交）——多选模式下卡片悬浮不再露出单条操作按钮
- **需求**：中转区多选状态下，光标悬浮卡片时不应再弹出「复制/删除」等单条操作按钮（与批量操作栏语义打架，多选时不该再暴露单条操作入口）。
- **实现**：`stage-grid`/`stage-list` 容器按 `stageMultiselect` 加条件 class `stage-multiselect`；CSS 新增 `.stage-grid.stage-multiselect .stage-card:hover .stage-card-actions{opacity:0;pointer-events:none;}` 与 list 布局对应的 `.clip-copy-btn/.clip-del-btn/.stage-open-btn` 规则，覆盖非多选态下已有的 `:hover{opacity:1}` 规则。未改任何 JS 逻辑/状态机，纯 CSS 门控。
- **验证**：`npx tsc --noEmit` 零错误；用户 GUI 实测确认通过（悬浮遮罩不出现、多选切换回单选后悬浮操作按钮恢复正常）。
- **提交**：`57242b1`（fix）+ 版本号 0.3.2→0.3.3（PATCH，随后单独提交）。
- **文件**：`src/App.tsx`（两处 className 拼接）、`src/App.css`（两条新增规则）。

（续88「中转区拖动排位」详记已迁入 HISTORY.md，功能仍未完成，见上方 §0 阻塞项）
- **文件**：`src/App.tsx` / `src/App.css` / `src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs`。文档同步：claude.md 铁律（热键让路→emit 升级 + 无缝交接）+ 反查表 2 行 + dragout.rs 结构行 `force_hide` + DECISIONS §18 续88「四轮/五轮修复」。

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
- ✅ 文件中转区：混合条目（file/text/image）、📌钉入、单击取走粘贴/复制/打开/删除、多选/框选/批量、双布局（列表/方格）、原生拖入（IDropTarget）+ 拖出（DoDragDrop，拖出后是否自动关闭窗口可配置，续83）
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
| `get_dragout_auto_close` / `set_dragout_auto_close` | 拖出后是否自动关闭窗口（默认 true）；关闭时 DoDragDrop 返回后重新显示 overlay，不区分 move/copy/cancel；持久化前端 store 负责（续83）|

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
