# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-08（续91：多选模式悬浮不露单条操作按钮，待用户确认，见 §0）
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
- **续91（本次会话，待用户 GUI 确认，未提交）**：中转区多选模式下卡片悬浮不再露出单条操作按钮（`.stage-card-actions`/list 布局的 `.clip-copy-btn` 等），纯 CSS 门控（容器加 `stage-multiselect` class），未动 JS 状态机。`npx tsc --noEmit` 通过。
- **续90（已提交，用户已确认测试通过）**：①中转站容量从硬编码 20 改为可配置（20/50/100/200，纯前端 store 持久化，无需 Rust 同步）；②`.stage-grid` 从 flex-wrap 改 CSS Grid（`auto-fill` + `justify-content:center`）修复方格卡片左右缝隙不对称。版本号 0.3.1→0.3.2（PATCH）。
- **续89**：全局 `user-select:none` 加在 `html` 根（`src/App.css`），`input`/`textarea` 例外保留文本编辑；修复此前拖拽/点击时界面文本大片被框选变蓝的观感问题。此前零散加的 `.launcher-reordering`/`.stage-reordering`/`.lasso-active`/`#overlay.dragging` 局部 user-select 规则仍保留（现为冗余但无害，未清理）。版本号 0.3.0→0.3.1（PATCH）。
- **⚠️ 中转区「区内拖动排位」（续88）功能接近完成，五轮修复"按热键升级为原生拖出并投放"，代码在工作树未提交，等本轮 GUI 复测**——见下条。
- **最高危提醒**：窗口/焦点/热键/剪贴板改动前必须重读 `CLAUDE.md` 铁律。尤其：别改 `tauri.conf.json` 的 `transparent:true`/`focus:false`；别让前端管 hide；别回退 RegisterHotKey 事件驱动 show/hide；新增剪贴板读写必须过 `CLIPBOARD_LOCK`。
- **最近状态（续88 五轮，本次会话）——补"按热键升级为原生拖出"触发器**：GUI 实测确认四轮的②（热键关界面）已生效，但暴露①真面目=**"拖动中按热键关界面成功、但松手后无文件落地"**。根因：用户转移手势是"拖起→按热键隐藏→拖到目标松手"，全程不越 drop-area 边界；而续88 只在"越界"时才把纯 JS 区内重排升级为原生 DoDragDrop——按热键那刻还没有任何原生拖，直接 hide 就把手势取消了（且隐藏后 DoDragDrop 的 SetCapture 必失败，隐藏必须晚于起手）。修复：把"按热键"也作为升级触发器——monitor 在 `stage_reorder_active()` 期间改为 emit `stage-drag-hotkey`（不 hide 不让路），前端据此 `cancelStageReorder()`+`beginNativeDragOut([id], forceHide=true)`；`start_drag_out`/`do_drag_on_main` 加 `force_hide` 参数（无视 keepOpen 强制隐藏收场，且**先起手 DoDragDrop 再隐藏**）；`STAGE_REORDER_ACTIVE`→`DRAG_IN_PROGRESS` 无缝交接（`cancelStageReorder` 只清 JS 现场、do_drag_on_main 先置 DRAG_IN_PROGRESS 再清 STAGE_REORDER，防交接空窗被提前 hide）。三处 build 零错误，GUI 待复测。详见 §0A 续88 五轮 / DECISIONS §18。
- **待办（续75 GUI 反馈遗留，启动台拖拽打磨）**：
  - ⓪a 舍去抓手光标——grab/grabbing 实测卡顿，回退光标改动（`.app-tile` cursor 恢复默认、`.launcher-reordering` 去 grabbing）。
  - ⓪b 被拖项目跟随观感——源 `opacity:0` 后拖动中项目"消失"；先在真实拖拽下加日志确认 ghost 是否跟手到位，再决定强化跟随还是让源半可见。
- **下一步候选（无阻塞）**：① 启动器键盘导航；② 文件结果右键「打开所在目录」+ 命中高亮回传；③ 索引目录可配置；④ 增强搜索纳入剪贴板条目；⑤ file/folder 收藏的非拖入入口；⑥ 拖出边角补测（text→记事本等；核心路径已实测通过，低风险）；⑦ Gemini/contenteditable 文本拖入硬边界（用户计划未来攻克，方向需绕开「dragover 不落 caret」根因，见 HISTORY 续73 记录）。
- **阻塞 / 待决策**：中转区「区内拖动排位」（续88）等本轮 GUI 复测——重点验证"拖起条目→按热键隐藏→拖到外部松手→文件落地"整条转移链是否闭合（devtools console 看 `[stage-drag] hotkey during reorder → 升级…` + `[dragout] DoDragDrop begin … force_hide=true` + `drag-out-done effect=…`）。

## 0A. 最近状态细节 〔滚动窗口 ≤3 会话；更早的详记在 HISTORY.md〕

### 续90（2026-07-08，src/App.tsx + src/App.css + src/i18n.ts，用户已确认测试通过并提交）——中转站容量可配置 + 方格卡片间距对称修复
- **需求 1**：中转站容量扩张，此前硬编码仅 20 个条目上限。
- **实现**：`STAGE_MAX`（前端硬编码常量，Rust 侧无对应数组/上限）改为可配置——`STAGE_MAX_DEFAULT=20`+`STAGE_MAX_OPTIONS=[20,50,100,200]`；新增 `stageMax` state + `stageMaxRef`（供 `files-dropped` 一次性事件监听闭包读最新值，同 `clipCacheMaxRef` 惯例）；`changeStageMax` 持久化到 store（`"stage-max"`），无需 invoke 同步 Rust；缩小上限时用 `stage.slice(0,n)` 立即截断（保留较新的）。设置面板「中转站」新增「上限条数」`seg` 控件（20/50/100/200）。选 200 而非对齐剪贴板的 100 上限：中转 file 条目只存路径+小图标，比剪贴板可能内联的整张缩略图/全文轻得多，扩容成本更低。
- **需求 2**：中转区最右边文件卡片到右边缘的缝隙大于最左边到左边缘，要求对称。
- **根因**：`.stage-grid` 原用 `display:flex;flex-wrap:wrap`——flex-wrap 逐行独立左对齐，行尾剩余空间只堆在右侧。
- **修复**：改用 CSS Grid（`grid-template-columns:repeat(auto-fill,80px)` + `justify-content:center`）——列数对整个网格只算一次并整体居中，剩余空间对称分给左右两侧；末行只有一张卡时仍按原列位靠左，不会被单独居中显得突兀。
- **验证**：`npm run build`（含 tsc + 版本一致性检查）通过；FLIP 拖动重排逻辑（`getBoundingClientRect` 驱动，与 flex/grid 无关）确认不受影响。用户 GUI 实测两项均确认符合预期。
- **提交**：`41e7eb9`（feat 容量可配置）+ `e7edb56`（fix 网格对称）+ `981aa88`（chore 版本号 0.3.1→0.3.2，PATCH）。

### 续89（2026-07-08，src/App.css，用户已确认测试通过并提交）——修复界面拖拽时文本被意外框选变蓝
- **症状**：日常操作（拖动卡片、在顶栏/列表上按住鼠标移动等）容易触发浏览器原生文字框选，界面文本大片变蓝，观感不像桌面应用。
- **根因**：此前只在特定拖拽场景（启动台/中转区重排、剪贴板长按拖拽、框选）零散加了局部 `user-select:none`，未覆盖的普通点击拖动路径（如顶栏、按钮间隙误触发的原生文字选择）没有防护。
- **修复**：`src/App.css` 顶部 `html{user-select:none;-webkit-user-select:none;}` 全局禁用，`input,textarea{user-select:text;-webkit-user-select:text;}` 例外保留搜索框/热键录入框等正常文本编辑。此前局部规则未删（冗余但无害）。
- **验证**：`npm run build` 通过（含版本一致性检查）；用户手动测试拖拽启动台/中转卡片/顶栏/剪贴板列表确认不再泛蓝，搜索框/热键输入框文本选择正常。
- **提交**：`0711893`（fix）+ `03941b4`（chore 版本号 0.3.0→0.3.1，PATCH）。

### 续91（2026-07-08，src/App.tsx + src/App.css，待用户 GUI 确认）——多选模式下卡片悬浮不再露出单条操作按钮
- **需求**：中转区多选状态下，光标悬浮卡片时不应再弹出「复制/删除」等单条操作按钮（与批量操作栏语义打架，多选时不该再暴露单条操作入口）。
- **实现**：`stage-grid`/`stage-list` 容器按 `stageMultiselect` 加条件 class `stage-multiselect`；CSS 新增 `.stage-grid.stage-multiselect .stage-card:hover .stage-card-actions{opacity:0;pointer-events:none;}` 与 list 布局对应的 `.clip-copy-btn/.clip-del-btn/.stage-open-btn` 规则，覆盖非多选态下已有的 `:hover{opacity:1}` 规则。未改任何 JS 逻辑/状态机，纯 CSS 门控。
- **验证**：`npx tsc --noEmit` 零错误；GUI 待用户实测（悬浮遮罩不出现、多选切换回单选后悬浮操作按钮恢复正常）。
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
