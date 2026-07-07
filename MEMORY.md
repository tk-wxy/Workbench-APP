# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-07（续85：新增中/英文界面语言切换，设置→常规可选，见 §0）
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

- **当前稳定功能**：热键呼出（长按 momentary + 短按 toggle，键态轮询驱动，组合可自定义/录制式）+ Esc 关闭 + light dismiss；三类型剪贴板历史/粘贴/复制/持久化 + 图片原图缓存 janitor；中转区多选/框选/批量 file/拖入/拖出；启动器收藏托盘（含拖拽排序）；增强搜索 + 文件索引（内置/可选 Everything 双引擎）；设置面板（常规/启动台/中转站/剪贴板/搜索/快捷键/关于）；**界面语言中/英文切换**（设置→常规，含托盘菜单同步）。
- **最高危提醒**：窗口/焦点/热键/剪贴板改动前必须重读 `CLAUDE.md` 铁律。尤其：别改 `tauri.conf.json` 的 `transparent:true`/`focus:false`；别让前端管 hide；别回退 RegisterHotKey 事件驱动 show/hide；新增剪贴板读写必须过 `CLIPBOARD_LOCK`。
- **最近状态（续85）——新增中/英文界面语言切换 + 版本号从 0.1.0 起修**：`src/i18n.ts` 字典式 `t()`（key=中文原文），设置→常规新增语言行；Rust 托盘菜单经 `set_tray_language` 命令同步；`tsc`/`cargo check` 均通过，人工 review 修正 2 处撞 key（"关闭"/"应用"一词多义）。同会话顺带修复版本号一直停在 0.1.0 未同步的问题：三处版本文件（`package.json`/`Cargo.toml`/`tauri.conf.json`）升至 **0.2.0**，`App.tsx` 两处硬编码版本号改为 `vite.config.ts` `define: __APP_VERSION__` 注入 `package.json` 的版本（单一来源，不再手动同步两份字符串；后两个 Rust/Tauri 版本文件仍需手动同步）。GUI 实测待用户操作。详见 §0A 续85 / DECISIONS §19。
- **上一状态（续84）——「拖出后自动关闭=关闭」重构为"拖动保持界面"模型，GUI 三轮通过**：`关闭`时拖动全程界面可见（区内落点交自窗口 IDropTarget）、去外部靠拖动中按热键手动隐藏、`DRAG_IN_PROGRESS` 让热键 monitor 让路防白闪；`开启`维持原样。未做（非 bug）：区内重排（Phase 2）、keepOpen 外部拖单 text 到 Chromium 不粘。详见 §0A 续84 / DECISIONS §18 续84。
- **待办（续75 GUI 反馈遗留，启动台拖拽打磨）**：
  - ⓪a 舍去抓手光标——grab/grabbing 实测卡顿，回退光标改动（`.app-tile` cursor 恢复默认、`.launcher-reordering` 去 grabbing）。
  - ⓪b 被拖项目跟随观感——源 `opacity:0` 后拖动中项目"消失"；先在真实拖拽下加日志确认 ghost 是否跟手到位，再决定强化跟随还是让源半可见。
- **下一步候选（无阻塞）**：① 启动器键盘导航；② 文件结果右键「打开所在目录」+ 命中高亮回传；③ 索引目录可配置；④ 增强搜索纳入剪贴板条目；⑤ file/folder 收藏的非拖入入口；⑥ 拖出边角补测（text→记事本等；核心路径已实测通过，低风险）；⑦ Gemini/contenteditable 文本拖入硬边界（用户计划未来攻克，方向需绕开「dragover 不落 caret」根因，见 HISTORY 续73 记录）。
- **阻塞 / 待决策**：无。

## 0A. 最近状态细节 〔滚动窗口 ≤3 会话；更早的详记在 HISTORY.md〕

### 续85（2026-07-07，src/i18n.ts 新增 + App.tsx + lib.rs）——新增中/英文界面语言切换
- **需求**：设置里可切换界面语言，默认中文，新增英文。`App.tsx` 单文件 ~1860 行，UI 文本几乎全硬编码中文。
- **方案**：新文件 `src/i18n.ts` — 字典式 `EN_DICT: Record<中文,英文>`，key 直接用中文原文（不发明语义 key）；`makeT(lang)` 返回 `t(zh, vars?)`，缺项 fallback 回中文（不会白屏）；动态文案（`ago()`/"已选 {n} 项"）用 `{占位符}` 模板复用同一套字典。
- **App.tsx**：新增 `lang`/`t` state（`useMemo(makeT)`），持久化到 store `"language"` key（同 `theme` 惯例）；`changeLang` 同时 invoke `set_tray_language` 同步托盘；时钟 `toLocaleTimeString` 按 lang 切 `zh-CN`/`en-US`；委派 subagent 做机械替换——全文件 ~230 处 `t(...)` 包裹 + ~145 条字典项（设置面板 7 个 tab、主界面、右键菜单、toast、空状态全覆盖）。
- **Rust（`lib.rs`）**：托盘菜单"显示窗口"/"退出"是唯一 `t()` 管不到的用户可见文案——`MenuItem<Wry>` 存进 `app.manage(TrayMenuItems)`，新增 `set_tray_language` 命令 `.set_text()` 运行时切换；前端读取语言设置后主动 invoke 一次同步。3 条热键校验 Rust `Err(String)` 不改 Rust，原文录入字典，渲染时 `t(hotkeyError)` 包一层复用。
- **人工 review 修正 2 处撞 key**（字典 key=中文原文的固有代价，详见 DECISIONS §19）：①`"关闭"` 本兼有 Esc-关闭 与 开关 Off 两义，开关按钮改为调用点直写 `lang==="en"?"Off":"关闭"`，不查字典；连带修正中转站设置提示段落里引用的 "Open"/"Close" 改回 "On"/"Off" 保持与按钮一致。②`"应用"` 本兼有名词 App 与动词 Apply 两义，搜索结果徽章同样绕开字典直写 `lang==="en"?"App":"应用"`。
- **验证**：`npx tsc --noEmit` + `cargo check --lib` 均零错误；人工逐段 review 全量 diff（设置面板七个 tab/主界面/剪贴板/中转区/启动台/增强搜索/右键菜单）。**语言切换 GUI 实测已由用户完成并确认提交**（commit `9f5a01f`）。
- **版本号追加修复（同会话，用户提出）**：讨论后采用**手动 SemVer**（非自动每提交递增）——功能加 minor、修复加 patch，在你认为的"检查点"手动 bump 并配 `git tag`。本次定为 v0.2.0（新功能：语言切换）。`package.json`/`Cargo.toml`/`tauri.conf.json` 三处同步改 0.2.0；`vite.config.ts` 新增 `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`（Node 侧 `readFileSync` 读 `package.json`），`src/vite-env.d.ts` 声明该全局，`App.tsx` 两处 `v0.1.0` 硬编码改用 `__APP_VERSION__`。`npm run build` 验证过产物 JS 里确实内联出 "0.2.0" 两处。**仍手动**的部分：`Cargo.toml`/`tauri.conf.json` 与 `package.json` 版本号无自动同步机制，三处不一致不会报错，下次 bump 版本时三个文件都要记得改。
- **文件**：`src/i18n.ts`（新）/ `src/App.tsx` / `src-tauri/src/lib.rs` / `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `vite.config.ts` / `src/vite-env.d.ts`。

### 续84（2026-07-07，dragout.rs + lib.rs + App.tsx）——重构「拖出后自动关闭=关闭」为"拖动保持界面"模型（Phase 1+1b，待 GUI 复测）
- **需求澄清（续83 方向作废）**：用户三场景实为**区内拖动**：① 拖到一半发现选错需取消（现状拖动即隐藏，看不到没法取消）；② 拖动调整卡片顺序；③ 框选+拖动到启动台。共同点=**拖动全过程界面不能消失**。续83「拖出后重新显示」在松手后才显示、拖动中界面照样消失，对三场景全无用。
- **统一模型（用户敲定）**：拖动仍是唯一手段（OLE DoDragDrop），只改"何时隐藏界面"。`关闭`=拖动全程不隐藏，区内落点交给窗口自身 IDropTarget；拖到外部应用由用户**拖动中手动按热键隐藏**再松手（"与原版相比只是界面关闭改为手动"）。
- **Phase 1（界面不消失 + 区内落点）**：`dragout.rs` 撤续83 re-show；`auto_close=false` 时不 spawn 60ms SW_HIDE、DoDragDrop 返回后不 hide、延迟 50ms set_focus。`App.tsx`：`files-dropped` 加 `internalDrag`（`dragOutRef.draggedIds` 非空）判定，区内落回中转暂 no-op（避免重复添加，区内重排=Phase 2）、落启动台走既有添加；`drag-out-done` 单 text `copyAndPaste` 回退在 keepOpen 时跳过；新增 `dragoutAutoCloseRef`。
- **Phase 1b（拖动中手动隐藏去外部）**：`lib.rs` 加 `pub current_hotkey_vks()`（读 HOTKEY_VK_KEYS 快照）；`dragout.rs` `auto_close=false` 时改 spawn **自轮询线程**（20ms 读 GetAsyncKeyState，热键上升沿 → SW_HIDE + `manually_hidden`=true + emit hotkey-hide，触发一次即退；`drag_done` 兜底退出）。收尾分支改为 `if auto_close || manually_hidden { hide+同步 tao+activate_drop_target } else { 保持可见+set_focus }`。热键 monitor **不改**——它只在用户按热键（=想隐藏）时才 queue 一个 hide()，与本模型同向，无害。
- **GUI 实测（续84 首轮，用户）**：核心前提**已验证成立**——日志 `[dragdrop] Drop 1 path(s) at (…)`＋`DoDragDrop end hr=0x40100 effect=1→copy` 证明**自前 OLE 拖动能被自窗口 IDropTarget 收到**（场景③启动台成立）。首轮"失败"实为测了当时未实现的外部流程。
- **GUI 实测（续84 次轮，用户）**：**主流程合格**——`关闭`模式拖动中按热键→界面隐藏→松手到 Windows Terminal(CASCADIA)成功落地粘贴（日志见"保持界面模式：拖动中按热键→手动隐藏 overlay"+ activate 交还 CASCADIA）。**残留缺陷：手动隐藏后松手落地时白闪一下**。诊断：两模式唯一差异=手动隐藏流程有用户按热键→**热键 monitor 介入**（并发 toggle 操作窗口可见性）；`开启`自动隐藏 monitor 不介入、无白闪。
- **白闪修复（复测通过）**：加 `DRAG_IN_PROGRESS: AtomicBool`（`do_drag_on_main` 起手置位/收尾清位，`pub drag_in_progress()`）；`lib.rs` 热键 monitor 循环开头判定——拖动期间**只跟踪键态、不做 show/hide toggle**（`prev_combo=combo; down_at=None; continue`），窗口可见性拖动期间由 dragout 独占。`cargo check` 过、clippy 维持 8 基线。**GUI 复测：白闪已消除**。新铁律「拖动期间窗口可见性由 dragout 独占」已入 CLAUDE.md。
- **已知窄边界**：keepOpen 下"外部拖单 text 到 Chromium"仍不粘（copyAndPaste 被 keepOpen 跳过、前端无法区分是否已手动隐藏）；区内重排=Phase 2（暂 no-op）；text 项无 CF_HDROP 故不能落启动台（本就不应落）。
- **验证**：`cargo check --lib` 零 error；`tsc` Phase 1 已过（1b 仅 Rust + hint 字符串）。**待 GUI 复测**：关闭模式下 ①拖到启动台入库、②拖动中按热键→界面隐藏→松手到外部应用文件落地、③中途取消保留、④开启模式回归。
- **文件**：`src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs` / `src/App.tsx`。

### 续83（2026-07-07，dragout.rs + lib.rs + App.tsx）——新增「拖出后自动关闭」设置
- **动因**：用户反馈中转区任何超阈值拖动都会触发完整 OLE 拖出并隐藏窗口，但有时拖动只是想调整位置/误触发，不希望窗口消失。中转区目前无独立"区内重排"手势（与启动台纯前端拖拽重排不同），任何拖动一律进 `start_drag_out`→`DoDragDrop`。
- **设计取舍（已与用户确认）**：设置关闭时**无条件**重新显示窗口——不区分 move/copy/cancel，即使真投放成功到外部窗口窗口也会重新弹出并抢回前台焦点，**覆盖续82 的前台交还修复**（此时跳过 `activate_drop_target`，反正马上被抢回没有意义）。
- **实现**：`dragout.rs` 新增 `static DRAGOUT_AUTO_CLOSE: AtomicBool`（默认 true）+ `get/set_dragout_auto_close` 命令（`lib.rs` 注册）；持久化前端 store 负责，命令不写 store（同 `set_hotkey`/`set_clip_cache_max` 惯例）。关闭时的重新显示复刻呼出三约束（`emit("hotkey-show")` 先于 `show()`；`set_focus()` 延迟 50ms，防白闪），同 `tray_toggle`/热键 show 路径配方。前端：`dragoutAutoClose` state + `changeDragoutAutoClose`（`store.set`+`invoke`），设置面板「中转站」tab 新增 `seg-btn` 开启/关闭行。
- **验证**：`cargo check --lib` 零 error、`tsc --noEmit` 零错误；**GUI 实测通过**——关键破局点是把 PowerShell 自动化脚本调 `SetProcessDPIAware()`（否则非 DPI-aware 进程看到的虚拟化 1600×1000 坐标与 App 实际 CSS 坐标不对齐，点击全部偏移/落空，此前多次误判"点击关掉了弹窗"）；改用真实物理坐标（3200×2000）后，一次成功点开 设置→中转站，看到新增行「拖出后自动关闭」+ 开启/关闭双态 + 提示文案全部正确渲染，且**两个方向点击都成功**（关闭→开启的高亮切换、`workbench-data.json` 落盘值同步校验通过）。**仍未覆盖**：真实拖拽文件出窗口时两态的实际观感（需要人工拖拽手势）。
- **文件**：`src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs`（命令注册）/ `src/App.tsx`。文档同步：DECISIONS §18 续83。

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
