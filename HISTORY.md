# Workbench — 历史归档（HISTORY）

> **本文件默认不读，不进会话上下文**。它是 `MEMORY.md` 的历史尾巴：已老化的会话详记 + 全部变更记录，只用于考古（追查某次改动的来龙去脉）。查找方式：用 Grep 按「续N」/ 关键词 / 日期定位到具体条目，**不要整读本文件**。
>
> - 规则铁律 → `CLAUDE.md`；决策根因 → `DECISIONS.md`；当前状态/待办 → `MEMORY.md`。
> - 维护方式：只追加、不修改。`MEMORY.md §0A` 的详记老化（超出最近 3 个会话）时整段迁入下方「一、会话详记归档」顶部；变更记录追加进「二、变更记录」。

---

## 一、会话详记归档（原 MEMORY §0A 老化条目，大致按 续N 倒序；2026-07-07 续81 迁入）

### 续85（2026-07-07，src/i18n.ts 新增 + App.tsx + lib.rs，2026-07-08 续88 迁入）——新增中/英文界面语言切换
- **需求**：设置里可切换界面语言，默认中文，新增英文。`App.tsx` 单文件 ~1860 行，UI 文本几乎全硬编码中文。
- **方案**：新文件 `src/i18n.ts` — 字典式 `EN_DICT: Record<中文,英文>`，key 直接用中文原文（不发明语义 key）；`makeT(lang)` 返回 `t(zh, vars?)`，缺项 fallback 回中文（不会白屏）；动态文案（`ago()`/"已选 {n} 项"）用 `{占位符}` 模板复用同一套字典。
- **App.tsx**：新增 `lang`/`t` state（`useMemo(makeT)`），持久化到 store `"language"` key（同 `theme` 惯例）；`changeLang` 同时 invoke `set_tray_language` 同步托盘；时钟 `toLocaleTimeString` 按 lang 切 `zh-CN`/`en-US`；委派 subagent 做机械替换——全文件 ~230 处 `t(...)` 包裹 + ~145 条字典项（设置面板 7 个 tab、主界面、右键菜单、toast、空状态全覆盖）。
- **Rust（`lib.rs`）**：托盘菜单"显示窗口"/"退出"是唯一 `t()` 管不到的用户可见文案——`MenuItem<Wry>` 存进 `app.manage(TrayMenuItems)`，新增 `set_tray_language` 命令 `.set_text()` 运行时切换；前端读取语言设置后主动 invoke 一次同步。3 条热键校验 Rust `Err(String)` 不改 Rust，原文录入字典，渲染时 `t(hotkeyError)` 包一层复用。
- **人工 review 修正 2 处撞 key**（字典 key=中文原文的固有代价，详见 DECISIONS §19）：①`"关闭"` 本兼有 Esc-关闭 与 开关 Off 两义，开关按钮改为调用点直写 `lang==="en"?"Off":"关闭"`，不查字典；连带修正中转站设置提示段落里引用的 "Open"/"Close" 改回 "On"/"Off" 保持与按钮一致。②`"应用"` 本兼有名词 App 与动词 Apply 两义，搜索结果徽章同样绕开字典直写 `lang==="en"?"App":"应用"`。
- **验证**：`npx tsc --noEmit` + `cargo check --lib` 均零错误；人工逐段 review 全量 diff（设置面板七个 tab/主界面/剪贴板/中转区/启动台/增强搜索/右键菜单）。**语言切换 GUI 实测已由用户完成并确认提交**（commit `9f5a01f`）。
- **版本号追加修复（同会话，用户提出）**：本次定为 v0.2.0（新功能：语言切换）。`package.json`/`Cargo.toml`/`tauri.conf.json` 三处同步改 0.2.0；`vite.config.ts` 新增 `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`（Node 侧 `readFileSync` 读 `package.json`），`src/vite-env.d.ts` 声明该全局，`App.tsx` 两处 `v0.1.0` 硬编码改用 `__APP_VERSION__`。`npm run build` 验证过产物 JS 里确实内联出 "0.2.0" 两处。
- **版本号规则正式落地 + 用户 review 后二次加固（同会话，写入 `CLAUDE.md`「版本号规则」）**：用户确认改动已验证/测试通过后，agent 自行判断 MINOR/PATCH 幅度、bump 三处版本文件、提交为**紧跟功能提交之后的独立 commit**（参考先例 `9f5a01f`→`3123a6d`，不强制合并进同一 commit），不用再单独问"要不要顺便改版本号"（对"未要求不擅自提交"铁律的明确例外，仅限版本号提交）；**MAJOR 永远先问用户**，不得自主判断。用户 review 后指出的 3 处不足已修：①新增 `scripts/check-version-sync.mjs` + `npm run version:check`，`npm run build` 前置跑它——三处版本号不一致直接报错中止（此前"无自动校验"的空档已堵上，脚本用 sabotage 测试验证过确实会在不一致时退出码非 0）；②规则文字改精确为"独立 commit"而非易读成"合并进同一 commit"；③规则里加一句明确「续N」会话计数与 SemVer 版本号是两套独立编号、不对应，避免误读。
- **文件**：`src/i18n.ts`（新）/ `src/App.tsx` / `src-tauri/src/lib.rs` / `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `vite.config.ts` / `src/vite-env.d.ts` / `scripts/check-version-sync.mjs`（新）/ `CLAUDE.md`。

### 续84（2026-07-07，dragout.rs + lib.rs + App.tsx，2026-07-08 续87 迁入）——重构「拖出后自动关闭=关闭」为"拖动保持界面"模型（Phase 1+1b，GUI 复测通过）
- **需求澄清（续83 方向作废）**：用户三场景实为**区内拖动**：① 拖到一半发现选错需取消（现状拖动即隐藏，看不到没法取消）；② 拖动调整卡片顺序；③ 框选+拖动到启动台。共同点=**拖动全过程界面不能消失**。续83「拖出后重新显示」在松手后才显示、拖动中界面照样消失，对三场景全无用。
- **统一模型（用户敲定）**：拖动仍是唯一手段（OLE DoDragDrop），只改"何时隐藏界面"。`关闭`=拖动全程不隐藏，区内落点交给窗口自身 IDropTarget；拖到外部应用由用户**拖动中手动按热键隐藏**再松手（"与原版相比只是界面关闭改为手动"）。
- **Phase 1（界面不消失 + 区内落点）**：`dragout.rs` 撤续83 re-show；`auto_close=false` 时不 spawn 60ms SW_HIDE、DoDragDrop 返回后不 hide、延迟 50ms set_focus。`App.tsx`：`files-dropped` 加 `internalDrag`（`dragOutRef.draggedIds` 非空）判定，区内落回中转暂 no-op（避免重复添加，区内重排=Phase 2）、落启动台走既有添加；`drag-out-done` 单 text `copyAndPaste` 回退在 keepOpen 时跳过；新增 `dragoutAutoCloseRef`。
- **Phase 1b（拖动中手动隐藏去外部）**：`lib.rs` 加 `pub current_hotkey_vks()`（读 HOTKEY_VK_KEYS 快照）；`dragout.rs` `auto_close=false` 时改 spawn **自轮询线程**（20ms 读 GetAsyncKeyState，热键上升沿 → SW_HIDE + `manually_hidden`=true + emit hotkey-hide，触发一次即退；`drag_done` 兜底退出）。收尾分支改为 `if auto_close || manually_hidden { hide+同步 tao+activate_drop_target } else { 保持可见+set_focus }`。热键 monitor **不改**——它只在用户按热键（=想隐藏）时才 queue 一个 hide()，与本模型同向，无害。
- **GUI 实测（首轮）**：核心前提**已验证成立**——日志 `[dragdrop] Drop 1 path(s) at (…)`＋`DoDragDrop end hr=0x40100 effect=1→copy` 证明**自前 OLE 拖动能被自窗口 IDropTarget 收到**（场景③启动台成立）。首轮"失败"实为测了当时未实现的外部流程。
- **GUI 实测（次轮）**：**主流程合格**——`关闭`模式拖动中按热键→界面隐藏→松手到 Windows Terminal(CASCADIA)成功落地粘贴（日志见"保持界面模式：拖动中按热键→手动隐藏 overlay"+ activate 交还 CASCADIA）。**残留缺陷：手动隐藏后松手落地时白闪一下**。诊断：两模式唯一差异=手动隐藏流程有用户按热键→**热键 monitor 介入**（并发 toggle 操作窗口可见性）；`开启`自动隐藏 monitor 不介入、无白闪。
- **白闪修复（复测通过）**：加 `DRAG_IN_PROGRESS: AtomicBool`（`do_drag_on_main` 起手置位/收尾清位，`pub drag_in_progress()`）；`lib.rs` 热键 monitor 循环开头判定——拖动期间**只跟踪键态、不做 show/hide toggle**（`prev_combo=combo; down_at=None; continue`），窗口可见性拖动期间由 dragout 独占。`cargo check` 过、clippy 维持 8 基线。**GUI 复测：白闪已消除**。新铁律「拖动期间窗口可见性由 dragout 独占」已入 CLAUDE.md。
- **已知窄边界**：keepOpen 下"外部拖单 text 到 Chromium"仍不粘（copyAndPaste 被 keepOpen 跳过、前端无法区分是否已手动隐藏）；区内重排=Phase 2（暂 no-op）；text 项无 CF_HDROP 故不能落启动台（本就不应落）。
- **验证**：`cargo check --lib` 零 error；`tsc` Phase 1 已过（1b 仅 Rust + hint 字符串）。GUI 复测：①拖到启动台入库 ②拖动中按热键→界面隐藏→松手到外部应用文件落地 ③中途取消保留 ④开启模式回归——均通过。
- **文件**：`src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs` / `src/App.tsx`。

### 续83（2026-07-07，dragout.rs + lib.rs + App.tsx，2026-07-08 续86 迁入）——新增「拖出后自动关闭」设置
- **动因**：用户反馈中转区任何超阈值拖动都会触发完整 OLE 拖出并隐藏窗口，但有时拖动只是想调整位置/误触发，不希望窗口消失。中转区目前无独立"区内重排"手势（与启动台纯前端拖拽重排不同），任何拖动一律进 `start_drag_out`→`DoDragDrop`。
- **设计取舍（已与用户确认）**：设置关闭时**无条件**重新显示窗口——不区分 move/copy/cancel，即使真投放成功到外部窗口窗口也会重新弹出并抢回前台焦点，**覆盖续82 的前台交还修复**（此时跳过 `activate_drop_target`，反正马上被抢回没有意义）。
- **实现**：`dragout.rs` 新增 `static DRAGOUT_AUTO_CLOSE: AtomicBool`（默认 true）+ `get/set_dragout_auto_close` 命令（`lib.rs` 注册）；持久化前端 store 负责，命令不写 store（同 `set_hotkey`/`set_clip_cache_max` 惯例）。关闭时的重新显示复刻呼出三约束（`emit("hotkey-show")` 先于 `show()`；`set_focus()` 延迟 50ms，防白闪），同 `tray_toggle`/热键 show 路径配方。前端：`dragoutAutoClose` state + `changeDragoutAutoClose`（`store.set`+`invoke`），设置面板「中转站」tab 新增 `seg-btn` 开启/关闭行。
- **验证**：`cargo check --lib` 零 error、`tsc --noEmit` 零错误；**GUI 实测通过**——关键破局点是把 PowerShell 自动化脚本调 `SetProcessDPIAware()`（否则非 DPI-aware 进程看到的虚拟化 1600×1000 坐标与 App 实际 CSS 坐标不对齐，点击全部偏移/落空，此前多次误判"点击关掉了弹窗"）；改用真实物理坐标（3200×2000）后，一次成功点开 设置→中转站，看到新增行「拖出后自动关闭」+ 开启/关闭双态 + 提示文案全部正确渲染，且**两个方向点击都成功**（关闭→开启的高亮切换、`workbench-data.json` 落盘值同步校验通过）。**仍未覆盖**：真实拖拽文件出窗口时两态的实际观感（需要人工拖拽手势）。
- **文件**：`src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs`（命令注册）/ `src/App.tsx`。文档同步：DECISIONS §18 续83。

### 续82（2026-07-07，仅 dragout.rs + 文档，2026-07-07 续85 迁入）——修拖出到 cmd/终端后目标失焦「像卡死」
- **症状**：拖 text/image 到 cmd/PowerShell/Windows Terminal，drop 落地成功但目标 2-3s 无焦点、看着像卡死，手动点一下才活；记事本/Word 正常。
- **诊断（先加取证日志再动手）**：装逐调用 + 前台采样日志。image→终端真实日志：`DoDragDrop` 876ms 干净返回、收尾 878ms、**此后 conhost 零回调**我方 IDataObject → 证伪原假设「conhost 攥数据对象卡 STA 泵消息」（microsoft/terminal #13498 那条线）。前台采样暴露根因：**drop 后 `GetForegroundWindow` 仍是本窗口约 2-3s**，之后系统才落到终端。
- **根因**：conhost/cmd/终端收到 drop **不自我激活**；我们拖拽中裸 `ShowWindow(SW_HIDE)` 隐藏 overlay 没触发另一窗口激活 → 本（隐藏）窗口仍持前台 → 目标干等。
- **修复（`dragout.rs` `activate_drop_target`，单一新增焦点动作，门控 `hr==DRAGDROP_S_DROP`）**：drop 成功后取光标落点顶层窗口（`GetCursorPos`→`WindowFromPoint`→`GetAncestor(GA_ROOT)`，守卫非本窗口），先裸 `SetForegroundWindow`；**若前台没转过去**（cmd/终端被前台锁挡住、裸调返回 false）走 `AttachThreadInput(本→目标,TRUE)`→`SetForegroundWindow`→`AttachThreadInput(...,FALSE)` 强制转移。`AttachThreadInput`/`GetCurrentThreadId` 走裸 extern（windows crate 需未启用 feature）。
- **验证**：`cargo clippy --lib` 维持 8 基线、dragout.rs 0 新警告；**GUI 实测（2026-07-07，用户）cmd/终端通过**（`attached=true ok2=true`，采样从 ~200ms 起即终端、失焦消失）。诊断探针已收敛回精简日志（仅留 `[dragout] 前台交还落点 → <class>` 一行）。记事本/Paint/Explorer/Esc 回归待用户顺带确认。
- **文件**：`src-tauri/src/dragout.rs`。文档同步：CLAUDE.md 反查表 + DECISIONS §18 续82。

### 续81（2026-07-02，纯文档，零代码改动，2026-07-07 续84 迁入）——三大 md 文档优化
- **动因**：MEMORY.md 膨胀至 195KB（Read 全文超工具上限），§0A 单条 bullet 长达数千字符；同一事实最多重复 4 处；CLAUDE.md 每会话自动加载且叙事占比高——tokens 消耗大、局部读取失效。
- **改动**：
  - 新建 `HISTORY.md`：原 MEMORY §九（全部变更记录）+ §0A 老化详记（续23~续78 等）**逐字迁入，零信息删除**。
  - `MEMORY.md`：§0 重写为短快照；§0A 改滚动窗口（≤3 会话，多行短 bullet 格式）；§一~八快照保留并修正陈旧项（§五功能清单、§六命令表补新条目）；§九改为一行指针。
  - `CLAUDE.md`：铁律去叙事——硬规则全保留，踩坑经过压缩为一行 + DECISIONS §指针；会话开始改为渐进式读取协议；「强制记忆更新」升级为完整文档维护约定（滚动窗口/单一真相源/短行原则）。
  - `DECISIONS.md`：**仅动目录**——每 § 加一行结论摘要、修正编号漂移（旧目录把 §13 git 历史标成 §12、把 §14 拖入标成「废弃」而实际已推翻实现），正文一字未改。
- **验证**：Grep 抽查关键规则（CLIPBOARD_LOCK / fWide / show 三约束 / 死胡同清单）在 CLAUDE.md 全部命中；归档采用 sed 按行号逐字提取 + 字节数核对，确认迁移完整。
- **文件**：`CLAUDE.md` / `MEMORY.md` / `DECISIONS.md`（仅目录）/ `HISTORY.md`（新）。

### 续80（2026-07-02，仅 clipboard.rs + 文档，2026-07-07 续83 迁入）——点击粘贴不稳定修复（焦点交还守卫轮询）
- **症状与诊断**：点击历史项粘贴偶发失败、但手动 Ctrl+V 能粘上 → 剪贴板写入已成功，失败全在「hide → 盲等 150ms → 注入 Ctrl+V」后半段：`window.hide()` 是异步派发，负载高时 150ms 赌输，`GetForegroundWindow` 仍返回本窗口/NULL → Ctrl+V 注入进已隐藏的自家 WebView；还会污染 file/image 的 class 三分叉。
- **修复（单变量）**：新增 `wait_foreground_handback(&app, tag)`——10ms 采样至前台「非本窗口且非 NULL」，上限 500ms 超时保底继续，确认后 50ms 落定余量（常量 `FOCUS_HANDBACK_POLL_MS/MAX_MS/SETTLE_MS`；self hwnd 取法同 `start_focus_watch`）；替换 paste/filepaste/imgpaste 三处 `sleep(150ms)`，补齐带 tag 日志（文本路径原先零日志、失败不可诊断）。
- **已识别未修**（详见 DECISIONS §3 延伸续80）：① show 时未快照原前台 HWND（`SetForegroundWindow(GetForegroundWindow())` 恒等空操作），结构性改流程暂缓；② UIPI 提权目标静默吞 SendInput，无解只能将来提示；③ 物理修饰键未中和。若再偶发失败，先看 `[paste]/[filepaste]/[imgpaste] handback` 日志的 timeout 与 fg class 定位是①还是②。
- **验证**：`cargo clippy` 8 条基线不变、新代码零警告；**GUI 实测（2026-07-02，用户）文本→Chrome 对话框成功**（waited=0ms / timeout=false / fg class 正确，全程 114ms，比旧盲等还快）；file/image 路径与高负载场景待日常观察。
- **文件**：`src-tauri/src/clipboard.rs`。文档同步：CLAUDE.md 焦点交还铁律改守卫轮询、DECISIONS §3 延伸记根因。同会话应用户要求删除 `AGENTS.md`（Codex 副本，零信息丢失），CLAUDE.md 成唯一规则入口。

### 续79（2026-07-01，纯前端，GUI 未实测）——设置面板按功能域重构（2026-07-07 续82 迁入）
- `SETTINGS_TABS` 扩为 常规/启动台/中转站/剪贴板/搜索/快捷键/关于：常规只留背景主题 + 开机自启；启动台页含收藏数量/添加应用/清空/手动排序标注；中转站页承接显示布局 + 清空中转条目；剪贴板页只留历史条数/清空历史/图片原图缓存；搜索页承接呼出默认搜索模式 + 搜索引擎/额外目录。
- CSS：`.settings-action` 普通按钮 hover 中性样式、清空类加 `.danger` 才红色 hover；新增 `.settings-inline-actions` / `.settings-row-value`。
- **验证**：`npx tsc --noEmit` + `npm run build` 通过；GUI 观感待用户实测。文件：`src/App.tsx` / `src/App.css`。

- **新增（续78，纯前端，GUI 未实测 2026-07-01）——启动台拖拽预览承载层优化**：在续77 已确认可见的基础上做结构收敛，不改排序/让路/回落算法，也不改视觉参数。新增 `dragLayerRef` 与顶层 `<div className="drag-layer">`（与 `#overlay` 同级，`position:fixed; inset:0; z-index:100003; pointer-events:none; overflow:visible`），启动台拖拽 ghost 仍由 `srcEl.cloneNode(true)` 创建，但优先 append 到 `.drag-layer`，并在 layer 内用 `position:absolute + left/top` 按 viewport 坐标跟手；仅当 ref 异常为空时 fallback 到 `document.body + position:fixed + z-index:100003`。`.launcher-drag-ghost` 自身去掉全局 z-index，层级由 `.drag-layer` 统一管理。这样避免散挂 body 后靠单节点抢层级，后续其他拖拽预览也可复用该层。**验证**：`npx tsc --noEmit` 通过，`npm run build` 通过。文件：`src/App.tsx` / `src/App.css`。
- **新增（续77，纯前端，GUI 未实测 2026-07-01）——启动台拖拽更换位置细节打磨**：在续75 Launchpad 式让路基础上只改视觉/ghost 坐标层，不动排序/让路/回落算法。① 去掉 `.app-tile{cursor:grab}` 与 `.launcher-reordering *{cursor:grabbing!important}`，拖拽期间仅保留 `user-select:none`，避免 WebView2 下抓手光标带来的卡顿感；② ghost 从“React state 渲染的替身卡片”改为“DOM 直克隆的悬浮副本”：超阈值激活时 `srcEl.cloneNode(true)`，加 `.launcher-drag-ghost` 后直接插入 `document.body`，`pointerdown` 记录鼠标在源卡片内的 `grabOffsetX/Y` 与源 `width/height`，拖动时用 `client - offset` 写 left/top，松手回落到落点槽位左上角后移除，效果更接近系统桌面拖图标；③ `.launcher-drag-ghost` 去掉 `translate(-50%,-50%)`，改为 top-left 定位 + `scale(1.05)` 抬起感。**续77b 根因修正**：前版仍不可见是因为 `#overlay` 的 `z-index:99999` 高于 `body` 下 ghost 的 `z-index:9999`，现 CSS 与内联样式均设 `z-index:100003`（高于 overlay/ctx-menu/settings），并强制 `position/display/opacity/visibility/pointerEvents`。**续77c 视觉微调**：用户确认可见后，将悬浮副本 opacity 调淡到 0.72、背景/边框同步变轻、移除 box-shadow。源格仍保持 `opacity:0`，避免让路时与滑入格子重叠。**验证**：`npx tsc --noEmit` 通过，`npm run build` 通过。文件：`src/App.tsx` / `src/App.css`。
- **新增（续75，纯前端，静态验证通过 / GUI 未实测 2026-07-01）——启动台拖拽细节打磨（在续74 基础上）**：把"竖线指示插入点"升级为 **Launchpad 式让路**，并修掉一个真 bug + 三处手感打磨。① **ghost 首帧闪现修复（真 bug）**：续74 激活时 `setLauncherDragSource` 触发 React 渲染、但同一次 `onMove` 读 `launcherGhostRef` 时 ref 未 commit（null）→ ghost 首帧用 JSX `style={{left:0,top:0}}` + `translate(-50%,-45%)` 摆在屏幕左上角、要等下一次 pointermove 才跳到鼠标。修复：state 类型加 `{x,y}`，激活时塞入当次鼠标坐标，ghost 首帧 `style={{left:x,top:y}}` 直接定位。② **Launchpad 式让路（FLIP）**：激活瞬间用 `getBoundingClientRect` 采集所有 `.app-grid .app-tile` 的**固定原始槽位快照**（`{left,top,width,height}[]`），之后**插入判断 `calcInsert` 与让路位移 `applyShift` 全基于这份快照**——绝不用实时 rect（格子 transform 移动后 `getBoundingClientRect` 含位移、会污染插入判断，是让路能稳定工作的关键）。`applyShift(insertIdx)`：`target=insertIdx>srcIdx?insertIdx-1:insertIdx`，对每个非源格 `i` 求它在去源序列里的顺序 `k=i<srcIdx?i:i-1`、跳过 target 槽得 `newSlot=k<target?k:k+1`，写 `transform:translate(dx,dy)`（`dx/dy=rects[newSlot]-rects[i]`）。**穷举 n=1..6 全部 112 组合验证**：每次恰空出 1 个槽且 = target（ghost 落点），零失败。③ **松手回落**：`onUp` 给 ghost 开 `left/top transition` 飞到落点空槽中心（`rects[target]`），180ms 后统一 commit（清 transform/class → `setLauncherDragSource(null)` → 重排持久化）；`launcherLandingRef` 守卫回落期不被新 pointerdown 采集脏几何。④ **ghost 淡入+抬起**：CSS `@keyframes launcher-ghost-pop`（opacity 0→.95、scale .82→1.08，180ms），元素创建时自动跑一次；回落改 `left/top`、动画改 `transform`，两者正交不冲突。⑤ **抓手光标**：`.app-tile{cursor:grab}` + `.launcher-reordering *{cursor:grabbing!important}`。**源格子改 `opacity:0`**（续74 是 0.2，让路后会与移过来的格子重叠）。**架构守恒**：仍是"零 React 渲染 DOM 直操作 + window 级 pointer 监听"，React state 只触发 ghost 内容渲染一次。删除续74 的 `updateInsert` + `.launcher-insert-before` 竖线 CSS（已全局无引用）。**验证**：`tsc --noEmit` 零错误 + `npm run build`（tsc && vite build）通过 + FLIP 槽位映射 112 组合穷举零失败。**GUI 实测反馈（2026-07-01，用户）**：让路动画 / ghost 首帧修复 / 松手回落 / 淡入抬起 均正常。**两处待打磨（本次仅记录、未实现）**：① **抓手光标 grab/grabbing 实测有卡顿** → 用户要求**舍去该细节**（后续回退光标改动：`.app-tile` cursor 恢复默认、`.launcher-reordering` 去掉 grabbing）；② **拖动时被拖项目「消失」缺跟随观感** → 现状源 `.launcher-dragging-src{opacity:0}` 完全隐藏、由 ghost 代替，用户反馈拖动过程中希望**被拖项目明确跟在光标上**才协调；需排查 ghost 实际是否显示/跟手到位（若 ghost 未如预期跟随=bug，若已跟随则是希望强化跟随可见性/让源半可见），下次动手前先在真实拖拽下加日志确认 ghost DOM 位置。文件：`src/App.tsx`（state 类型 + `launcherLandingRef` + `handleLauncherPointerDown` 全量重写 + ghost JSX style）/ `src/App.css`（`.launcher-shift`/`.launcher-dragging-src`/`.launcher-ghost-pop`/grab 光标，删 insert-before）。
- **当前稳定**：Ctrl+Space 热键（长按 momentary + 短按 toggle，键态轮询驱动）+ Esc 关闭 + light dismiss（点外部应用自动隐藏）+ 三类型剪贴板（文本/图片/文件）粘贴（含桌面落地）+ 后台监听 + 全屏无缝 + 呼出白闪修复 + 剪贴板条目删除 + 设置面板（**左侧条目导航 + 右侧详情**：常规/启动台/中转站/剪贴板/搜索/快捷键/关于）+ 去阴影（`set_shadow(false)`）+ 底部蓝缝消除 + 底部贴齐任务栏顶（`clamp_window_bottom` 修 set_shadow 后 WebView 遮任务栏）+ 剪贴板卡片「只复制到剪贴板」按钮（不粘贴、seq 水位防回流）+ **剪贴板历史持久化**（落盘 `clip_history.json`，重启后历史完整读回）+ **剪贴板历史条数可配置**（设置面板四档 10/20/50/100，默认 20，持久化重启保留）+ **开机自启可配置**（设置 → 常规 → 开启/关闭，`tauri-plugin-autostart` 写注册表）+ **历史图片粘贴原图**（落盘 `clip_images/{time}.png`，detached write，小图跳过，设置面板「打开文件夹/清空缓存」；**续52 起解耦 janitor 自动管上限**——周期孤儿清理 + 总量封顶 500MB，不进 `CLIPBOARD_LOCK`；**续53 起图片粘贴按目标窗口类三分叉**——桌面→SHFileOperation 落地 / 资源管理器文件夹(CabinetWClass·ExploreWClass)→CF_HDROP 落地真 PNG（大图复用已落盘原图、零解码）/ 其余 app→位图，消除「文件夹粘不进」+「大图粘贴卡顿」）+ **中转区多选 + 批量操作**（Ctrl/Shift 多选，批量取走/复制/删除，仅 file 同质可批量上剪贴板）+ **增强搜索独立页**（Ctrl+K 呼出同 overlay 内视图层，搜应用 + 中转 file 条目，↑↓ + Enter 激活，纯前端）+ **顶栏普通搜索四区联动**（输入即同时过滤启动台/中转/剪贴板，名称内容优先 + 类型词叠加，与 Ctrl+K 独立）+ **启动器收藏托盘**（手动策展持久化，app picker，.lnk 拖入提取图标存 kind:"app"，S3a/S3b/S3c GUI 实测通过 2026-06-25）+ **增强搜索接入文件系统**（Ctrl+K 分两组 Tier1+Tier2，文件结果分隔线+防抖+未就绪提示，filesearch.rs 后台索引，S4a/S4b/S4c GUI 实测通过 2026-06-25）+ **自定义热键 V2**（V2-1：`parse_combo` 表驱动任意组合，53 条主键，三键 GUI 实测通过；V2-2：正式文本输入 UI + Enter 触发 + 格式提示 + 底栏动态 kbd + `changeHotkey` 类型放宽为 string + 清理 PROBE/V21-TEMP，**全部 GUI 实测通过（2026-06-25）**）
- **新增（续74，纯前端，GUI 实测通过 2026-07-01）——启动台条目拖拽排序（全量重写）**：启动器收藏托盘支持鼠标拖拽调整顺序，松手后持久化。**架构：全 DOM 直操作 + window 全局监听**，绕过 React setState 渲染延迟，彻底保证跟手。① `pointerdown` 时动态注册 `window.addEventListener("pointermove"/"pointerup"/"pointercancel")`，用完即移除（无残留）；② 激活后 ghost 位置直写 `ghost.style.left/top`，insert 指示线直写 `el.classList.add/remove("launcher-insert-before")`，两者**零 React 渲染**；③ `#[draggable=false]`+`<img draggable={false}>`消灭系统禁止光标；④ 激活时给 `#overlay` 加 `.launcher-reordering`（`user-select:none!important`）彻底禁文字选中；⑤ `search` 非空时 `pointerdown` 直接 return（过滤态禁排序）；⑥ 松手按 `finalInsert→srcIdx` 重排，位置不变跳过 `saveLauncher`（减少不必要 I/O）。**首次重写（续73）踩坑根因**：① `setPointerCapture` 与 WebView2 系统拖拽光标冲突 → 禁止图标；② `useEffect` 同步 `launcherDragRef` 有一帧延迟 → 偶尔失效；③ 旧 `setLauncherDrag` setState 驱动 ghost → 不跟手；④ 无全局 `user-select:none` → 文字选中。**全部排查后在续74 重写解决**。`tsc --noEmit` 零错误。文件：`src/App.tsx`（`handleLauncherPointerDown` + state 重组 + JSX `draggable={false}` + ghost ref 渲染）/ `src/App.css`（`.launcher-reordering` + `.launcher-drag-ghost` 重写 + `.launcher-insert-before::before`）。
- **新增（续73，纯前端，GUI 实测通过 2026-07-01）——启动台 file/folder 条目启动动画对齐 app**：原 `openLauncherItem` 对 `file`/`folder` 直接 `hideWorkbench()` + `open_file`，跳过放大暂留动画。改为复用 `launchApp` 同套流程：立即 `invoke("open_file")`（不阻塞动画）→ `getBoundingClientRect()` 取图标坐标 → `setLaunchAnim`（emoji 作 `iconText`）→ `setDismissing(true)` → `setTimeout(hideWorkbench, LAUNCH_ANIM_MS)`。`LaunchAnim` 接口新增 `iconText?: string` 字段，克隆浮层 JSX 渲染优先级 `icon(base64) > iconText(emoji) > name[0]`。`tsc --noEmit` 零错误。文件：`src/App.tsx`。text 条目的 OLE 拖出受 Chromium 限制无法落地到浏览器 `<input>`/contenteditable（续71 已知）。本次在 `src/App.tsx` 的 `drag-out-done` 监听里加前置分支：当 `effect !== "move"` 且被拖出的恰为**单个 text 条目**时，回退到 `copyAndPaste(item)`（复用现有出口：写剪贴板 + SetForegroundWindow + enigo Ctrl+V），并按取走语义从中转区移除 + 清 `stageSel`/`stageMultiselect` + 落盘，然后 `return` 不走后续 move 逻辑。被拖条目由 `dr.draggedIds` 映射 `stageRef.current` 还原。约束遵守：未改 `copyAndPaste` 本体、未碰 Rust、file/image 不变（限定 `length===1 && type==="text"`）。`tsc` 零错误。**实测结果（日志 + 用户验证）**：文本拖到浏览器多数窗口/Word/写字板**成功，无双粘**；Gemini 等 contenteditable 失败（焦点还在）。**核心判定依据（别改成「无论 effect 一律回退」会双粘）**：会原生插入的目标（Word/写字板）返回 `move` → 走 move 分支、native 已插入、不回退；返回 `copy` 的恰是 Chromium 输入框——不原生插入（痼疾）但拖拽已落 caret，回退 Ctrl+V 正好补上。**即 `copy ⟺ 不原生插入`，二者同源 → 结构上无双粘**（非侥幸）。**残留理论风险**：非 Chromium 原生 app 若对文本返回 `copy` 且原生插入 → 双粘；实测常见编辑器返回 move，未触发，**碰到再按窗口 class 分叉**（像图片粘贴三分叉那样），现在不预先过度设计。**Gemini 失败=硬边界**：contenteditable 的 dragover 不落 caret，回退 Ctrl+V 无处粘；OLE 层无法区分「copy 且插入」与「copy 未插入」（浏览器病态同形），故无干净解（含 Rust 侧 GetData 追踪也不可靠，已在会话推演排除）。**📌 待办（用户后续会尝试攻克）**：Gemini/contenteditable 文本拖入失败是当前已知硬边界，用户计划未来专门解决——届时方向需绕开「dragover 不落 caret」这一根因（可能路线：落点合成点击设 caret、或注入 JS、或换非 OLE 通道），现暂记不动。文件：`src/App.tsx`。
- **新增（续71，Rust 新模块 + 前端，GUI 实测通过 2026-06-29）——中转区拖出 drag-out（DoDragDrop STA 线程模型）**：在中转条目上按下并拖动超 `DRAG_OUT_THRESHOLD_PX=12` → overlay 隐藏 → 系统 OLE `DoDragDrop` 接管鼠标 → 拖到目标 app（Explorer/桌面/记事本/Paint）松手完成传递。新模块 `src-tauri/src/dragout.rs`（source 侧，与 `dragdrop.rs` 拖入正交）：① **线程模型铁律（首版踩坑后修正）**——`DoDragDrop` **必须在主线程**（已 OleInitialize STA、持前台窗口 + mousedown 的鼠标 capture）：前端 `invoke("start_drag_out")` → worker `build_formats`（重活）→ `run_on_main_thread(do_drag_on_main)` → 主线程 DoDragDrop 阻塞。**hide 在 DoDragDrop 之后**——起手 60ms 后由 worker 发裸 `ShowWindow(SW_HIDE)`（模态循环泵之），**绝不 hide-before**（释放 capture → 拖拽不启动，首版死胡同）。② **IDataObject** 存源字节、`GetData` 现 `GlobalAlloc` 拷一份交调用方（OLE 协议，免双重释放），`EnumFormatEtc` 用系统 `SHCreateStdEnumFmtEtc`（免手写 IEnumFORMATETC，Explorer 依赖），其余方法 `E_NOTIMPL`。③ **格式**：file/image 汇入一份 CF_HDROP（image 落地真 PNG，复刻 write_cf_hdrop 内存布局但不写剪贴板）；单图额外 CF_DIB（BITMAPINFOHEADER+BGRA 自底向上，供 Paint）；纯单条 text → CF_UNICODETEXT。④ **image 临时文件**：优先 orig_path 原图（不删、保全分辨率），否则 base64→`%TEMP%\workbench_dragout_*.png`，drop 后 detached `sleep(5s)` 删 temp；`StageItem`+`clipToStage` 补 `orig_path` 透传。⑤ **IDropSource**：QueryContinueDrag 按 LBUTTON/Esc 决定续拖/DROP/CANCEL。⑥ **前端**：`dragOutRef`（无 state）+ 条目 onPointerDown/Move/Up，超阈值按 `stageSel` 决定拖单个/全选→`invoke("start_drag_out",{items})`；`drag-out-done` 监听 effect==="move" 则按 draggedIds 快照移除+落盘；与框选（续70）天然互斥（lasso closest 排除条目）。**自验**：`cargo check --lib` 零 error + `clippy` 8 基线 + `tsc` 零错误。**续71b 两个 GUI 实测才暴露的根因（已修，实测通过 2026-06-29，详见 DECISIONS §18 续71b）**：① **落地成 `download.png`（64×64 图标）而非真实文件** = WebView2 原生 HTML5 `<img>` 拖拽抢手势（卡片图标是 data-URL `<img>`，浏览器默认可拖；那次根本没走 Rust、无 `[dragout]` 日志）→ 修复：卡片 + img `draggable={false}`/容器 `onDragStart preventDefault`/CSS `-webkit-user-drag:none`，手势只剩 pointer→DoDragDrop。② **拖出后窗口呼不出、卡死须重启** = 收尾用裸 `ShowWindow(SW_HIDE)` 绕过 tao 可见性缓存 → tao 仍以为窗口可见 → 下次热键 `window.show()` 被 diff 成 no-op → 永不再现（进程没死、重启重置缓存）→ 修复：DoDragDrop 返回后收尾隐藏改走 Tauri `window.hide()` 同步缓存（拖拽中 60ms 裸 ShowWindow 不可避、保留）。**通用硬规则：裸 Win32 改窗口可见性后必须用 Tauri 同操作同步 tao 缓存。****GUI 实测全部通过（T1–T10）**：file/folder 拖异地真实落地 + MOVE 移除 + 不出 download.png + 不卡死 + 热键正常；image→Paint/Explorer（2 format=CF_HDROP+CF_DIB）正常；Esc 取消（0x00040101→none，三类型各验）条目保留；多选合并 CF_HDROP 全移除；与原生拖入并发互不影响。**text 拖出**：Word/写字板等经典文本目标正常插入（数据正确）；浏览器 `<input>`/contenteditable 收不进 = Chromium 对 OLE 文本拖入的已知挑剔、目标侧限制、非 bug（文本拖出用编辑器类目标）。文件：`src-tauri/src/dragout.rs`(新)/`src-tauri/src/lib.rs`(mod+命令注册)/`src/App.tsx`/`src/App.css`。
- **新增（续70，纯前端，零 Rust 改动）——中转区鼠标框选多选（GUI 实测通过，2026-06-29）**：在 `.drop-area` 空白处按下拖拽框选，扫过的 `.stage-card`/`.stage-item` 实时写入 `stageSel`，与显式多选（续34/34b）共用同一套 `stageSel`/`stageMultiselect` 状态。新增 `lassoState`/`lassoStateRef`/`lassoArmedRef` + `LASSO_THRESHOLD_PX=6`；三个 pointer handler 挂 `.drop-area`（down 排除条目/按钮/工具栏 + 仅左键 + 非卡片拖拽中；move 超阈值激活并实时算矩形相交；up 框空白则退出多选，**纯点击空白则取消选择**）；每条目加 `data-stage-id` 供选区映射；`.stage-lasso` 选区矩形以 `dropAreaRef` rect + scroll 偏移为基准；Esc 链最前插中止框选、`hotkey-hide` 同步复位。CSS 加 `.drop-area{position:relative}` + `.lasso-active` + `.stage-lasso`（复用 `var(--accent)` 兜底，零新增变量）。`tsc --noEmit` 零错误。文件：`src/App.tsx`、`src/App.css`。
- **新增（续69，纯前端，零 Rust 改动）——增强搜索统一 pinned 模式，删除旧全覆盖界面（GUI 未实测）**：`enhHotkey`（默认 Ctrl+K）在"界面搜索"和"增强搜索"两种模式下统一打开 pinned 增强搜索（共用顶栏输入框，enh-layer 显示在顶栏下方），不再区分 `searchDefaultMode`。① `enhHotkey` handler：删去旧 `else { setEnhPinned(false); setTimeout(()=>enhInputRef.current?.focus(),0) }` 路径，统一改为 `setEnhPinned(true); searchRef.current?.focus(); setEnhQuery(search)`（初始化 enhQuery 为顶栏当前内容）。② 新增 `enhPinnedRef`，顶栏 `onChange` 条件扩充：`searchDefaultMode==="enhanced" || enhPinnedRef.current` 时同步 enhQuery，保证 page 模式手动呼出 pinned enh 后输入仍同步。③ 设置→常规「呼出默认搜索」hint 文字更新。`tsc --noEmit` 零错误。文件：`src/App.tsx`。
- **新增（续68，仅 `filesearch.rs`，零前端 / 零 API 改动）——图标提取从查询路径前移到索引路径（图标预热缓存）**：原 `search_files` 每次查询现场调 Shell API（`SHGetFileInfoW`）提图标（虽 extension 去重，50 条仍叠 10-15 次提取在查询延迟上）。本次把提取时机前移到后台建索引时。① 新增静态 `ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>>`，key=扩展名小写(无点) 或 文件夹哨兵 `\0dir`（NUL 哨兵避免与无扩展名文件 ext="" 碰撞），value=base64 图标（失败存 None 仍保留 key）；② 新增 `build_icon_cache(&[IndexEntry])`——在后台 `build_index` 遍历完成后、替换全局索引前调用，按 key 去重、每类对一个代表路径调一次 `apps::get_file_icons`（单次 COM init 整批），与索引一起**双缓冲原子替换**（耗时 Shell 提取不持锁，守 §17 不变量）；③ `enrich_with_icons` 删除，`search_files` 改 `fill_icons_from_cache` 纯内存查表回填 → **查询路径零 Shell API 调用**；④ Everything 路径复用同一表（内置索引线程总会建表、与引擎无关），冷启动表空时 icon=None 降级，不为 Everything 单独触发提取。**续68b 修正缺陷**：首版把 .exe/.lnk 也并入扩展名归类 → 搜索结果不同 exe 显示同一图标（用户实测发现），已回退为 `icon_key` 对 .exe/.lnk **按完整路径区分**（同续67 旧行为）、其余仍按扩展名去重；index 时对每个 distinct exe/lnk 路径各提一次（appdata/node_modules 已剪枝，数量有限，后台线程零前台感知）。**取舍**：Everything 路径的 exe 若不在内置索引内 → 缓存无此 key → icon=None 走前端 emoji 降级（非错误图标，可接受）。**验证（CC 自验）**：`cargo clippy --lib` 8 基线不变；首版临时 `#[test]`（key 集合==扩展名集合）通过后已删。**GUI 未实测**（图标有无本身是续67 已有功能，本次仅移提取时机 + 修复 exe/lnk 归类）。文件：`src-tauri/src/filesearch.rs`（+ `everything.rs` 一行注释）/ `DECISIONS §17 图标预热`。
- **新增（续67，Rust + 前端）——增强搜索文件结果显示 Windows 系统原生图标（GUI 实测通过，2026-06-29）**：图标与搜索结果同步返回（单次 IPC），无中间 emoji 占位跳变。① `apps.rs`：`extract_icon_base64` 改 pub；`Compression::best()` → `Compression::fast()`（PNG 编码 3-5× 加速，32×32 图标无需最高压缩率）；新增 `get_file_icons` 批量命令（`lib.rs` 注册）。② `filesearch.rs`：`FileSearchResult` 加 `icon: Option<String>` 字段；新增 `enrich_with_icons()`——extension 去重（`.exe/.lnk` 按路径独立提取、文件夹共用一个代表、其余同扩展名只提一次代表路径），调用 `crate::apps::get_file_icons` 批量提取后回填；`search_files` 重构去掉 Everything early-return，两引擎统一走 `enrich_with_icons`。③ `everything.rs`：构造 `FileSearchResult` 补 `icon:None`。④ `App.tsx`：`fsResults` 类型加 `icon?`，`EnhResult` fs 变体加 `icon?`，`enhResults` memo 透传 icon，渲染直接用 `r.icon`；删掉上一轮的 `fsIcons` state + 异步 fetch effect（两步渲染是不流畅根因）。
- **新增（续66f/g/h/i，纯前端 CSS+JSX，零 Rust 改动）——中转卡片视觉精调 + 悬浮栏精简，全部 GUI 实测通过（2026-06-28）**：
  - **续66f（CSS 数值精调对齐启动台节奏）**：逐项缩小 `.stage-card*` 尺寸——卡片圆角 14→10px；文件图标容器 36→32px、圆角 8→7px；标签区 padding 下 6→5px、gap 1→0px，name 10.5→10px、meta 9.5→9px 各加 `line-height:1.4`；悬浮操作栏圆角 14→10px、gap 6→4px、底色 rgba(40,40,40,.88)→rgba(30,30,30,.90)（height:36px 锁死=label 实际高 ≈4+14+12.6+5），按钮 28→24px、圆角 7→6px、font 13→11px。**保留 `var(--*)` 主题色变量未硬编码**（不破坏暗色模式）。
  - **续66g（内容区加高对齐 hover 轮廓）**：缩略图/图片 cover/文本预览高度 48→60px，使卡片总高 ≈96px 对齐启动台 `.app-tile` hover 轮廓（grid `align-items:stretch` 拉伸到 2 行标签高 ≈95.6px）；信息栏（label）与悬浮操作栏高度不变。
  - **续66h（去冗余按钮）**：grid 卡片悬浮栏删掉「取走粘贴」(→箭头) 按钮——与卡片左键本体重复（`handleStageClick`→`copyAndPaste`，App.tsx:907）且使 file 卡片三按钮溢出 80px。
  - **续66i（打开→复制）**：悬浮栏统一为「复制到剪贴板 + 删除」两键（所有类型一致）——去掉 file 限定的「打开」(`openStageFile` 仍由 list 布局用)，改用 `copyStageToClipboard` + `copiedStageId` 的 ✓ 已复制反馈。复制=只写回剪贴板不粘贴，与左键「取走粘贴」互补不重复。
  - `tsc --noEmit` 零错误。文件：`src/App.css`（66f/g）+ `src/App.tsx`（66h/i）。
- **已完成（全部 GUI 实测通过）**：启动器重设计——S3a✓（持久化收藏托盘 + app picker）+ S3b✓（拖入落点双区判定）+ S3c✓（.lnk 拖入提取图标+名称→ kind:"app"）；增强搜索 Tier 2——S4a✓（filesearch.rs 文件系统后台索引）+ S4b✓（前端 Ctrl+K 接入文件结果，分组+分隔线+防抖）+ S4c✓（应用扫描改后台预建，消除首次呼出卡顿）。**续47✓（增强搜索键自定义）+ 续48✓（Tab 主键+焦点逃逸修复）+ 续50✓（拖入悬停双区高亮）——全部 GUI 实测通过（2026-06-26）。**
- **新增（续57，Rust + 前端）**：**双引擎搜索（内置 + 可选 Everything，设置可切换）**。① **内置扩面**（`filesearch.rs`）：扫描范围 5 子目录 → 整个 `%USERPROFILE%` + 用户可配置额外根目录（`EXTRA_DIRS`），`MAX_WALK_DEPTH` 8→10、`MAX_INDEX_ENTRIES` 200k→300k；打分升级为**多词 AND + 分层**（子串基线 ≥1500 恒高于子序列模糊 ≤1000，前缀/词首加权、短名微加权）。② **可选 Everything**（新模块 `everything.rs` + `libloading`）：运行时动态加载 `Everything64.dll`（SDK 文件）走 IPC 查询，不硬链接、缺失/未运行时 `is_available()=false` 优雅降级，所有调用经独立 `CALL_LOCK` 串行化。③ **引擎抽象**：`SEARCH_ENGINE` 静态 + `set_search_engine`/`set_search_dirs` 命令（持久化前端 store 负责），`search_files` 按引擎分发、Everything 失败**静默降级回内置**；`get_index_status` 回传 `engine`/`everythingAvailable`。④ **前端**：设置面板新增「搜索」tab（引擎 seg 切换 + 内置额外目录增删 + Everything 可用性提示），Ctrl+K 区分「Everything 未运行已回退」与「索引建立中」。**验证**：`cargo check`/`clippy` 8 基线零新增 + `tsc` 零错误 + 内置打分临时单测 5 过（已删）。文件：`src-tauri/src/filesearch.rs`/`everything.rs`(新)/`lib.rs`/`Cargo.toml`/`src/App.tsx`/`src/App.css`/`DECISIONS §17.1`。
- **新增（续57b，Rust + 前端）——集成 Everything64.dll + 热更新**：① **DLL 集成**——`Everything64.dll`（x86-64，90KB）落地 `src-tauri/`，`tauri.conf.json` 加 `bundle.resources` 随包发布；`everything.rs` `load_api` 多路径发现（资源目录/exe 目录/cwd/裸名），dev 与打包后均能找到。② **热更新**——`API` 由 `OnceLock` 改为 `Mutex<Option<EverythingApi>>`（兼缓存 + 串行化 IPC + 支持运行期 `reload()` 丢弃 FreeLibrary 后重载），`reload_everything` 命令 + 设置面板「重新检测」按钮 + 切到 Everything 时自动热检测 → **换 DLL / 启动 Everything 后无需重启**。③ **真链路已验证**（临时单测，Everything 运行中）：`is_available()=true`、全盘查询有结果（C:\ 与 D:\ 跨盘）、`reload()` 后仍可用，验后删测；`cargo check`/`clippy` 8 基线 + `tsc` 零错误。文件：`src-tauri/Everything64.dll`(新)/`src-tauri/tauri.conf.json`/`everything.rs`/`lib.rs`/`src/App.tsx`/`DECISIONS §17.1`。
- **新增（续57c，Rust + 前端）——Everything 引擎增强搜索结果太少修复**：根因=三处硬限把 Everything 钉死在 20 条（`search_files` 传 `limit:20` + 前端 `fsResults.slice(0,20)` + Rust `QUERY_LIMIT_CAP=50` 夹住 `set_max`）。修复：① `QUERY_LIMIT_CAP` 50→500；② 前端按引擎传 limit（常量 `ENH_FILE_LIMIT_EVERYTHING=200` / `ENH_FILE_LIMIT_BUILTIN=50`），查询 effect 加 `searchEngine` 依赖；③ Tier2 slice 20→200；④ 新增选中项 `scrollIntoView({block:"nearest"})`，长列表 ↑↓ 导航不丢焦点项（`.enh-results` 本就 `overflow-y:auto`）。**实测**（临时单测，Everything 运行中）：`query("e",20)`=20 条、`query("e",200)`=200 条，`set_max` 全链路生效；验后删测；`cargo clippy` 8 基线 + `tsc` 零错误。文件：`src-tauri/src/filesearch.rs`/`src/App.tsx`。
- **新增（续57d，Rust + 前端）——文件/文件夹显示修复**：现象=搜索结果里文件夹也全显示成「文件」（图标+badge）。根因（先验证后改）：**Tauri 不自动转换 serde 字段名**，`FileSearchResult` 序列化为 `is_dir`（snake_case）而前端读 `f.isDir`（camelCase）→ 运行时恒 `undefined`→ `isDir?…:…` 全走 false 分支→ 一律当文件。临时单测实证 `serde_json::to_string` 输出 `"is_dir":true`。修复：① `FileSearchResult` 加 `#[serde(rename_all="camelCase")]`（再验输出 `isDir`）；② `App.tsx` badge 由恒 `"文件"` 改 `r.isDir?"文件夹":"文件"`，Tier2 分隔线 `"文件"`→`"文件 / 文件夹"`（图标 `r.isDir?"📁":fi(ext)` 本就写对、此前因数据 undefined 失效）。`cargo clippy` 8 基线 + `tsc` 零错误。文件：`src-tauri/src/filesearch.rs`/`src/App.tsx`。
- **新增（续63，Rust + 前端）——中转区文件/文件夹 Windows 系统图标**：`FileInfo` 结构体加 `icon: Option<String>` 字段；`get_file_info` 命令调 `extract_icon_base64`（复用 apps.rs 现有函数，单次 COM 临时初始化，S_OK=0 时配对 `CoUninitialize`）。前端：① `FileEntry`/`FileItem` 接口各加 `icon?: string | null`；② `fileEntryToStage` 透传 icon；③ `addFsToStage` 改 async，先调 `get_file_info` 获取 icon；④ `addToStage` 改 async，单文件 clip 也异步补全 icon；⑤ 列表/方格两种布局均优先渲染 icon（`<img>` 替换 emoji），有 icon 则用、无 icon 降级 emoji；新增 `.stage-card-file-icon`（36×36 `object-fit:contain`）CSS 类。图标来源：`SHGetFileInfoW` 取系统图像列表→`ImageList_GetIcon`（无快捷箭头 overlay）→PNG base64，所有文件/文件夹类型通用，与启动器 app 图标来源相同。`cargo check` + `tsc` 零错误。文件：`src-tauri/src/apps.rs`/`src/App.tsx`/`src/App.css`。
- **新增（续62，纯前端）——方格卡片设计对齐 app-tile**：① 图标区 48×48/border-radius:10px 对齐 `.app-tile-icon`；② 名称 11px 双行截断对齐 `.app-tile-label`；③ **文字卡片**无图标——48px 高内嵌预览框（`var(--fill-2)` 底色，9px 3行截断文本）+ "PASTED" 徽标，Claude 粘贴卡片风格；④ 悬浮操作栏改用新类 `stage-card-act-btn`（白色图标，深色半透明底），按钮改为「取走粘贴（→箭头）」+「打开（file 限定）」+「删除」，替换旧 `clip-copy-btn/clip-del-btn`；⑤ grid gap 6→4px 对齐 app-grid。`tsc` 零错误。文件：`src/App.tsx`/`src/App.css`。
- **新增（续61，纯前端）——中转区双布局**：设置→常规新增「中转区布局」seg（列表/方格），持久化 `stage-layout`，启动时读回。方格模式：`.stage-grid`（`grid-template-columns: repeat(auto-fill,minmax(80px,1fr))`）+ `.stage-card`（上图标/下名称/底部绝对定位操作栏，`opacity:0→1 on hover`）。列表模式原样保留。所有操作（click/右键/多选/copiedStageId ✓/复制/删除/打开）两种布局均通过相同回调接入。`tsc` 零错误。文件：`src/App.tsx`/`src/App.css`。
- **新增（续59，纯前端）——增强搜索结果悬浮操作按钮**：`fs` 结果鼠标悬浮时，右侧 badge 淡出、浮现「中转」+「启动台」两个可点击按钮；`app` 结果仅浮现「启动台」按钮；`stage` 结果无变化。CSS：`.enh-result{position:relative}`+`.enh-result-actions`（`position:absolute;right:12px;top:50%;opacity:0→1`，`transition 120ms`）；badge 加 `transition:opacity`，`:hover` 时 badge `opacity:0`、actions `opacity:1`。新增回调 `addFsToStage`（按路径去重、置顶入中转）/ `addFsToLauncher`（按路径去重、kind="file"/"folder"，icon=null）。`tsc` 零错误。文件：`src/App.tsx`/`src/App.css`。
- **新增（续58，纯前端）——增强搜索 UI 优化**：① 搜索框上移（`.enh-layer` `padding-top: 14vh→8vh`）；② 文件结果（`fs` kind）在名称下方新增父目录路径次级行（`.enh-result-dir`，11px dim 色），模块级 `dirOf` 辅助函数提取路径最后分隔符前部分。`.enh-result-label` 拆出 `flex:1;min-width:0` 移到新 `.enh-result-meta` 包装层。`tsc` 零错误。文件：`src/App.tsx`/`src/App.css`。
- **新增（续57e，纯前端）——文件类型图标优化 + 统一单一真相源**：原本两套分叉的图标映射——搜索结果用的内联 `fi`（仅 ~17 扩展名，pdf/doc/xls/图片/mp4/mp3/zip/exe/txt）与剪贴板卡片用的 `getFileIcon`（较全）。新增**模块级 `extIcon(ext)`** 作单一真相源，两处共用：`fi = extIcon`、`getFileIcon` 复用 `extIcon`（仅保留 `isImage`/多文件 📦 特例）。覆盖扩展到主流全类型：图片 🖼️ / 视频 🎬 / 音频 🎵 / 压缩 🗜️ / **PDF 📕（distinct）** / Word 📝 / Excel 📊 / PPT 📽️ / 电子书 📚 / 镜像 💿 / 字体 🔤 / 代码 💻 / 可执行 ⚙️ / 文本配置 📃 / 兜底 📎。`tsc` 零错误。文件：`src/App.tsx`。
- **新增（续48，前端 + Rust）**：**收录 Tab 为主键 + 修 Tab 焦点逃逸 bug**。① **Tab 可录用**——原 token 表无 Tab（53 条），现前端 `tokenFromCode`/`HOTKEY_MAIN_TOKENS`/`comboLabel` + Rust `key_token`（`VK_TAB`/`Code::Tab`）各加一条（54 条）；裸 `Alt+Tab`（OS 窗口切换）进黑名单（同 Alt+Space/Alt+F4）。② **焦点逃逸 bug**——根因：设置打开时 `if(settingsOpen||pickerOpen)return;` 在 Tab 处理前早退 → 浏览器默认 Tab 遍历生效 + 模态无 focus trap → 焦点跳到背景按钮；关设置后旧 `Tab→filteredApps 导航`（S3a 后已不渲染）preventDefault 吃键无可见效果 → "没反应"。修复：删死的 filteredApps Tab 导航，改为 overlay 可见时统一 `if(e.key==="Tab"){preventDefault();return;}`（放在 settingsOpen 守卫**前**、matchComboEvent **后**）——焦点不再逃逸；Tab 作热键仍由 matchComboEvent 先处理。⚠️ 副作用：设置面板内 Tab 不能在输入框间跳（需点击；如要面板内循环再加 focus trap）。**tsc 零错误 + clippy 8 基线✓；GUI 实测通过（2026-06-26）**（录 Tab/Ctrl+Tab 成功并生效；设置内 Tab 不逃逸；关设置后 Tab 无副作用；Alt+Tab 被拒）。文件：`src/App.tsx` / `src-tauri/src/lib.rs`。
- **新增（续47，纯前端，零 Rust 改动）**：**增强搜索键（Ctrl+K）也可自定义**——原硬编码 `(e.ctrlKey||e.metaKey)&&key==="k"` 改为读 `enhHotkey` state（默认 `ctrl+k`，store key `enh-hotkey` 持久化）。增强搜索是**应用内快捷键**（仅 overlay 可见时生效、纯前端、不经 Rust/RegisterHotKey），与主呼出热键性质不同。复用录制基础设施：`recording` state 由 boolean 改为 `null|"main"|"enh"` 标记录哪个键，录制 useEffect 按 target 写回对应输入框。新增模块级共用工具 `tokenFromCode`（从录制 effect 提升）/ `parseComboStr`（解析+校验，规则同 Rust：禁 Win + 裸 Alt+Space/Alt+F4 + 恰 1 主键）/ `matchComboEvent`（keydown 精确匹配：修饰键全等 + 主键一致 + 无 Win）/ `comboLabel`（展示文案）。`changeEnhHotkey` 纯前端校验（非法/与呼出热键冲突→红字 2.5s）+ 持久化。设置→快捷键 tab 加「增强搜索」行（录制+应用+恢复默认，复用 `.hotkey-input`/`.settings-action`）；底栏改用 `comboLabel` 渲染主键 + 增强键。**tsc 零错误✓；GUI 实测通过（2026-06-26）**（录制替代键、按新键开关增强搜索、与呼出键冲突拒绝、重启持久化全正常）。文件：`src/App.tsx`（+4 module helper +3 state +changeEnhHotkey +录制 target 化 +keydown matchComboEvent +设置行 +底栏）。
- **新增（续46，前端 + Rust）**：**录制式热键 + 修饰键全可选 + 放开 Alt**。三件事：① **录制式输入**——快捷键 tab「应用」前加「录制」按钮，录制态 capture 阶段挂 `keydown`（`addEventListener(..,true)`+preventDefault/stopPropagation，抢在全局冒泡 `onKey` 前）→ `tokenFromCode` 映射 `e.code` 成 token 写回文本框（不自动应用，再点「应用」走 `changeHotkey`）。② **修饰键全可选**——`parse_combo` 去掉「必须含 Ctrl」，`has_ctrl/has_shift/has_alt` 各自可选动态构建 mods/vk_list（含全无=纯主键，会抢占该键、前端已警示）。③ **🔑 放开 Alt（spike 实测推翻 §9「Alt 死路」）**——探针证 RegisterHotKey 对 Alt+Q/Alt+Space 全可注册；运行时实测 Alt+Q：呼出/Esc/light dismiss/记事本菜单栏未激活/焦点回归全正常。根因：RegisterHotKey 消费整个组合，前台收不到 Alt → 不触发菜单栏激活；旧结论来自早期 JS/rdev 录入态、张冠李戴。落地：放开 Alt，**仅留小黑名单 Win + 裸 Alt+Space/Alt+F4**（OS 占用）。**验证**：tsc 零错误 + cargo clippy 8 基线不变；GUI 实测 Alt+Q 通过（2026-06-26，呼出/关闭/Esc/light dismiss/记事本菜单栏不激活全正常）。文件：`src-tauri/src/lib.rs`（parse_combo 重写 + 头注释）/ `src/App.tsx`（+recording state/useEffect/录制按钮，handler 放开 Alt）/ `src/App.css`（+`.settings-action.recording`）/ DECISIONS §9 续46 + CLAUDE.md（Alt 死胡同划掉）。
- **新增（续45，纯前端清理 + UI 完善）**：**自定义热键 V2-2**——删 PROBE V2-0（CapRow/logCap/probingRef/capLog/probe CSS）和 V21-TEMP harness（v21TempCombo/segmented）。`changeHotkey` 签名放宽为 `string`，输入 normalize toLowercase；新增 `hotkeyInput` state（编辑态与已提交值分离，成功时同步）；store 加载放宽接受任意非空字符串。热键 tab 改文本输入框 + 应用按钮（Enter 触发）+ 格式提示行。底栏 `<kbd>` 改动态渲染（ctrl→Ctrl/shift→Shift/space→Space/方向键→箭头）。`.hotkey-input` CSS 替换 `.probe-*`。**tsc 零错误✓；GUI 实测通过（2026-06-25）。**
- **新增（续44，Rust `parse_combo` 重写 + 前端 V21-TEMP harness）**：**自定义热键 V2-1**——`key_token` 表驱动任意 combo 替换 V1 白名单 `parse_combo`；blocklist win/alt；必须含 Ctrl；可选 Shift（三键轮询天然支持）；`key_token` 53 条（a-z/0-9/f1-f12/space/方向键）。`set_hotkey` register 错误 → "组合被占用或系统不可用"。单测 11 断言全过后已删。前端 `v21TempCombo` state + 文本框 + 应用按钮（V21-TEMP 标注）。**cargo check/clippy 零新增警告（8 基线不变）；tsc 零错误；单测实测通过已删；三键长短按 GUI 实测通过（2026-06-25，可正常开关，长短按符合预期）。**
- **新增（续42，Rust 后台线程 + 前端兜底语义）**：**应用扫描后台预建 S4c**——把 ~1.5s 的开始菜单扫描+图标提取从「前端首次 visible 时同步 invoke」挪到 setup 阶段 `start_apps_worker` 后台线程（`lib.rs`，仿 `start_index_worker`，延迟 1s）调用现有 `scan_start_menu`（**逻辑一字不动**，顺带缓存 `APP_CACHE`）→ `emit("apps-ready", apps)`。前端加 `un6` 监听 `apps-ready` 填充 `apps`；首次 visible 改兜底语义（`appsRef.current.length===0` 才 invoke `scan_start_menu` 兜底，命中缓存 ~120µs）。`sortedApps`/搜索链 deps 含 apps、自动响应、零改动。**cargo check/clippy 零新增警告（8 基线不变）；临时单测实测后台扫 114 apps 1.47s、缓存命中 117µs 已验删；T1–T6 GUI 实测通过（2026-06-24，首次呼出无卡顿）**
- **新增（续41，纯前端，零 Rust 改动）**：**增强搜索接入文件结果 S4b**——Ctrl+K 结果分两组：Tier 1（应用/中转，有查询 ≤10）在前 → `.enh-divider`「文件」分隔线 → Tier 2（`search_files` 文件 ≤20）在后，合并 ≤30。`EnhResult` 加 `fs` 支；`fsResults`/`indexReady` state；文件查询 **150ms 防抖** useEffect；`indexReady` 双来源（`file-index-ready` 事件 un5 + 打开时 `get_index_status` 兜底）；未就绪+有查询显示「文件索引建立中…」不阻塞 Tier 1。↑↓/Enter 跨组连续导航（divider 用 `Fragment` 不占索引）；文件激活走 `open_file`（不碰粘贴/焦点高危区）。**tsc 零错误已验；T1–T11 GUI 实测通过（2026-06-25）**（含 S4a `[fileindex] ready` 日志验证）
- **新增（续40，仅 Rust 后端，零前端改动）**：**文件系统索引 S4a**——新模块 `src-tauri/src/filesearch.rs`：独立后台线程 `start_index_worker`（setup 阶段 spawn，`sleep(3s)` 后用 `walkdir` 遍历 5 个默认目录 Desktop/Downloads/Documents/Pictures/Projects 建内存索引，30min 周期重建）；命令 `search_files(query,limit)` / `get_index_status()` 纯内存读 µs 级。**双缓冲原子替换**：耗时遍历不持锁，建完一次性换 Vec；`FILE_INDEX` 是全新独立 Mutex，与 `CLIPBOARD_LOCK`/`CLIP_CACHE` 无交集。`lib.rs` 加 `mod filesearch` + handler 注册 + setup 启动线程。**cargo check + clippy 零新增警告（8 条基线不变，无一在 filesearch）；临时单测实测遍历 µs 级 + 跳过 node_modules/隐藏 + 查询排序正确后已删**；GUI 层已通过 S4b 实测（2026-06-25）
- **新增（续39）**：**.lnk 拖入启动器**——`inLauncher` 分支内对 `.lnk` 路径调用新命令 `resolve_lnk`（`apps.rs`）：复用 `extract_icon_base64` 提取图标（`SHGetFileInfoW` 自动解析 .lnk），去掉后缀取干净名称，存为 `kind:"app"` 条目。左键走 `launchApp → ShellExecuteW(.lnk)`，与扫描加入的 app 条目完全一致。非 .lnk 走原有 `get_file_info` 路径，行为不变。**cargo check + tsc 零错误已验；T1–T6 GUI 实测通过（2026-06-25）**
- **新增（续38）**：**启动器 S3b**——外部文件拖入按松手坐标判定落点：启动器区（.app-grid）→入 `LauncherItem`（file/folder 持久化），中转区/区域外兜底→入 StageItem（原有行为）。落地区域 200ms drop-flash 闪烁确认。Rust 仅扩展 Drop emit payload 加 `{x,y}` 物理像素；前端 `÷ devicePixelRatio` 换算 CSS px 后与 `getBoundingClientRect()` 比对判区。**tsc 零错误、cargo check 零错误已验；T1–T8 GUI 实测通过（2026-06-24）**
- **新增（续37，纯前端，零 Rust 改动）**：**启动器重设计 S3a**——左侧面板从「自动扫描全量平铺(filteredApps)」改为「手动策展的持久化收藏托盘」。新增独立类型 `LauncherItem`（kind=app/file/folder，与 `StageItem` 不可合并：左键动作由区决定——启动器=打开/启动，中转=取走粘贴）。持久化 store key `launcher-items`（`LAUNCHER_MAX=60`）。app picker 模态（复用 settings-modal + enh-result 样式，搜索去重连续添加，Esc 关闭）。右键条目「从启动器移除」/file·folder「打开所在目录」。**自动扫描链 `scan_start_menu/apps/sortedApps/filteredApps` 全保留**喂增强(Ctrl+K)/普通搜索，面板不再渲染。⚠️ 副作用：顶栏普通搜索不再过滤左侧应用区（应用搜索改由 Ctrl+K 承担）；普通页方向键失去可见目标（保留不删，Enter 加 `search 非空` 守卫防误启动）。`.app-panel` 600→360px、`.app-grid` 6→4 列、中转区相应变宽。**tsc 零错误已验；T1–T10 GUI 实测通过（2026-06-25）**
- **新增（续23 GUI 实测通过）**：应用启动「放大暂留」动画（Mac 启动台式）——路线 B 克隆浮层 + 克制档 scale1.4/200ms，纯前端
- **新增（续24 实测通过）**：剪贴板粘贴消失动画统一为「快速淡出露桌面」（纯前端）。启动+粘贴共用 `dismissing` 状态
- **续25 已回退**：快捷键关闭也淡出——实测连续短按导致热键失灵/不灵敏，架构性冲突（淡出延长可见期破坏 toggle 的 is_visible 采样），已回退。详见下方记录 + CLAUDE.md 铁律警示
- **新增（续26 实测通过）**：文件中转区升级为「混合条目」模型（文件/文本/图片），剪贴板卡片 📌 钉入 + 中转条目单击取走（写回剪贴板+粘贴）/复制/打开/删除。store 由 `file-list`(路径数组)→`stage-items`(异构条目)、带旧格式迁移。**GUI 实测**：钉入/取走粘贴/复制/重启读回（含图片缩略图）全通过；迁移因本机无遗留 `file-list` 未触发（兜底逻辑，非 bug）
- **新增（续27 实测通过）**：原生拖入（drag-in）落地——`dragDropEnabled:false` + 自注册 IDropTarget（`dragdrop.rs`）接外部文件拖放，emit 路径 → 前端转 file StageItem 入中转。曾误判为死胡同（错误变量「先呼出再拖」+wry 占槽），spike 推翻、已实现。耐久性：setup 注册一次（「每次 show 重注册」实测破坏回调、已弃）。T1–T8 GUI 实测全过。**拖出 drag-out 未做**（需 DoDragDrop FFI，非死胡同、是未实现）
- **新增（续30 GUI 实测通过，纯前端）**：剪贴板卡片**长按拖拽到中转区**——Pointer Events 方案 A（移动超 `DRAG_THRESHOLD_PX=8` 才激活，短按仍走 onClick 粘贴不拦截）。激活后跟手克隆 `.clip-drag-ghost`（渲染为 #overlay 兄弟节点，避开 backdrop-filter 的 fixed 包含块陷阱）+ 中转区 `.drop-area.drag-over` 高亮；落点命中→`addToStage`（不粘贴），命中外→取消。`suppressClickRef` 抑制激活后随之而来的 onClick 误粘贴；`#overlay.dragging{user-select:none}` 防长按泛蓝。📌 按钮/右键菜单/复制删除按钮全保留（PointerDown 检测 `.clip-actions` 内则跳过）。零 Rust 改动。**T9 tsc 零错误已验；T1–T8 为 GUI 交互、本环境无法驱动，未实测**
- **新增（续31 GUI 实测通过，纯前端）**：剪贴板卡片 file 类型**按扩展名显示语义图标**——组件外纯函数 `getFileIcon(item: ClipItem)`，多文件→📦，依扩展名映射图片/视频/音频/压缩包/PDF/Office/代码/可执行/文本，兜底→📎。JSX 中 `file-clip-icon` 改为 `clip-file-icon`，调用 `getFileIcon`。CSS 新增 `.clip-file-icon`（1.25rem）。text/image 类型及卡片其余逻辑不变
- **新增（续32 GUI 实测通过，纯前端）**：**开机自启**——设置 → 常规 tab 新增「开机自启」开/关 seg 控件。`tauri-plugin-autostart`（已内置）通过 `plugin:autostart|enable/disable/is_enabled` 命令写/读 Windows 注册表开机启动项。启动时自动读取当前状态填充 UI；切换即时生效。零 Rust 改动
- **新增（续35，纯前端，零 Rust 改动）**：**增强搜索独立页**——Ctrl+K 呼出同一 overlay 内的全屏视图层（`.enh-layer`，靠 `.enh-open` class 切显隐，160ms 淡入上浮）。结果范围=应用（badge「应用」）+ 中转区 `type==="file"` 条目（badge「中转」），剪贴板/文件系统搜索不进（Tier 2 待做）。复用 `fuzzyScore`/`usageScore`/`HighlightText`/`sortedApps`/`launchApp`/`hideWorkbench`。键盘：Esc 链插入 enhOpen（ctxMenu→enhOpen→stageSel→settings→关窗）；enhOpen 时 ↑↓ + Enter 接管、屏蔽 launcher 导航；激活只走 `launchApp`（含动画+hide）或 `open_file`，**不碰粘贴/焦点交还/CLIPBOARD_LOCK**。空查询=常用应用兜底可直接 Enter。**tsc 零错误已验；T1–T11 GUI 实测通过（2026-06-25）**
- **新增（续64，纯前端，零 Rust 改动）——呼出默认搜索设置（GUI 实测通过）**：设置 → 常规 新增「呼出默认搜索」seg（界面搜索/增强搜索），持久化 store key `search-default-mode`。**核心行为**：enhanced 模式下顶栏 onChange 同步写 `search`+`enhQuery`，**不移动焦点**（彻底避免 IME 被打断），`v` 非空时以 **`enh-pinned` 模式**打开 enh-layer（`top:64px` 不覆盖顶栏，`.enh-search-box{display:none}` 隐藏 enh 内独立搜索框）——顶栏为唯一输入源，彻底消灭双输入源冗余。**`enhPinned` state**（`bool`）：打字触发=true，Ctrl+K 在 page 模式触发=false（全覆盖+聚焦 enhInput），Ctrl+K 在 enhanced 模式触发=true（pinned，焦点不动）。Esc/Ctrl+K 关/hotkey-hide 均 `setEnhPinned(false)` 复位。**Ctrl+K**：enhanced 模式下关 enh-layer 设 `pageSearchForcedRef=true`，再按 Ctrl+K 重开走 pinned 并清 flag；page 模式 Ctrl+K 走全覆盖（聚焦 enhInput，现有行为不变）。**IME**：不依赖 `isComposing`，焦点全程在顶栏。底栏提示动态化；enh-layer hint（非 pinned 时可见）显示「Ctrl+K 界面搜索 · Esc 关闭」。文件：`src/App.tsx`（+enhPinned state，Esc/Ctrl+K/hotkey-hide/onChange 各处），`src/App.css`（+`.enh-layer.enh-pinned` 两条规则）。
- **新增（续65，纯前端，零 Rust 改动）——中转区卡片视觉重设计（GUI 待测）**：方格卡片全面重设计：外壳（`--card-bg` 半透明白，14px 圆角，0.5px 边框）+ 1:1 缩略图区（`--card-thumb-bg` 内凹浅灰，与外壳分层）+ 标签区（border-top 分隔，name+meta 两行）；三类型差异化——图片 cover 铺满（修复原 `src={s.content}` bug，改 `data:image/png;base64,${s.content}`）/ 文本 4行截断预览 / 文件居中 icon-wrap（52px 圆角方块，优先 base64 系统图标）；右上角类型指示点（蓝/绿/粉）；`stage-grid` 列宽 80→100px，gap 4→8px；`--card-*` 四组 CSS 变量暗色/浅色双主题。文件：`src/App.css`（CSS 变量+卡片规则全替换），`src/App.tsx`（grid 卡片 JSX 全替换，list 不动）。
- **新增（续65e，纯 CSS，零 JSX/Rust 改动）——中转卡片尺寸收敛**：卡片固定宽度 110→80px，缩略图区 110×90→80×68px；`stage-grid` 改 flex wrap（配合固定宽度）；`stage-card-thumb-inner` 中间层移除（内容直接置于 thumb）；图片 src 安全判断（已含 data: 前缀不重复加）；icon-wrap 48→36px；文本预览 9.5px clamp:4；dot 5px 位置 5/5；label name 10.5px / meta 9.5px。**对齐启动台视觉节奏，预留设置可配置**。文件：`src/App.css`（数值全锁）。
- **新增（续66，纯前端，零 Rust 改动）——卡片三处细节**：① thumb 高度 68→58px（接近正方形），text-preview clamp 4→3；② 悬浮操作栏改为仅覆盖标签区（`bottom:0;height:36px`，不遮 thumb，按钮 28×28）；③ 文件夹条目渲染橙色 SVG folder（`#EF9F27`，内联 SVG 无需 Tabler 依赖，`isAnyDir` 判断已有）。文件：`src/App.css`（thumb 尺寸 + actions 样式），`src/App.tsx`（folder SVG 替换 📁 emoji）。
- **新增（2026-06-25，纯前端，零 Rust 改动）**：**顶栏 search 联动启动台过滤**——`filteredLauncher` useMemo（`search` 非空时 `launcher.filter(it => matchItem(q, it.name, []))`，空时直接返回 launcher）；JSX 数据源 `launcher.map` → `filteredLauncher.map`；空态 hint 区分「无收藏：拖入或点添加」vs「有收藏但无匹配：无匹配」。「＋ 添加」卡片不参与过滤（始终在 launcher-add 独立渲染）。**tsc 零错误✓；GUI 实测通过（2026-06-25）**
- **新增（续54，Rust 结构重构，零功能改动）**：**lib.rs 拆分——剪贴板子系统迁入 clipboard.rs**。lib.rs 1539→530 行；新建 `src-tauri/src/clipboard.rs`（~1038 行）收纳全部剪贴板代码（7 静态量全模块私有、12 可调常量、CF_HDROP FFI、监听/落盘/janitor/13 命令 + 辅助 base64/aHash/窗口类）。**纯搬迁、函数体一字未改**；新增 `clipboard::init(app, data_dir)` 封装 setup 时序（路径→load_clip_history→start_clipboard_monitor→start_clip_image_janitor，顺序不可变）。lib.rs setup 的 4-5 行剪贴板初始化收敛为一句 `clipboard::init(...)`；`generate_handler!` 13 命令加 `clipboard::` 前缀。命令用 `pub(crate)`（零新增 `pub`）。**验证（CC 自验）**：`cargo check --lib` 零 error✓；`cargo clippy --lib` 维持 8 条基线✓（lint 随代码迁移，集合/数量不变）；lib.rs 中 `CLIP_CACHE`/`CLIPBOARD_LOCK`/`SKIP_CLIP` 引用归零✓；`write_cf_hdrop` 函数体内无锁（锁加调用方铁律保持）✓。**GUI 实测通过（2026-06-27）**：呼出显示历史、文本/图片/文件粘贴、删除+重启持久化、只复制全正常。文件：`src-tauri/src/clipboard.rs`(新)/`src-tauri/src/lib.rs`/`CLAUDE.md`(§项目结构+1行)。
- **新增（续55，仅 Rust，零前端改动）**：**set_clipboard_image 分支③大图解码移出主线程**。`clipboard.rs` `set_clipboard_image` 第③分支（其余 app：Paint/聊天框等真吃位图的目标）原在主线程做全分辨率 RGBA 解码（3200×1998 ≈ 25MB）+ `set_image`，堵住热键键态轮询线程 → 「短时无法呼出」。本次把该分支「解码 + set_image + 焦点交还 + enigo Ctrl+V」整段搬入 `std::thread::spawn`，命令本体 spawn 后立即 `Ok(())` 返回。**主线程仍执行**：顶部 `hide()`+`sleep(150ms)`（class 检测依赖，不可移）、`GetForegroundWindow` 取 class1、分支路由。**子线程执行**：`SKIP_CLIP_EVENTS.store(2)` → 解码 → `{锁 CLIPBOARD_LOCK→set_image}` → `suppress_clip_until_now` → 焦点交还(GetForegroundWindow→SetForegroundWindow)→ Ctrl+V。锁纪律不变（CLIPBOARD_LOCK 只罩 set_image 临界区，hide/sleep/Ctrl+V 全在锁外）；防自写回流（store(2)+水位）顺序不变、仍在写前。子线程 detached 无调用方承接 `?` → 各错误就地 `eprintln`+return。**分支①(桌面 SHFileOperation)/②(文件夹 CF_HDROP) 及其他命令一字未动**。**验证**：`cargo check --lib` 零 error✓；`cargo clippy --lib` 维持 8 条基线✓；**GUI 实测通过（2026-06-27）**（粘 Paint 期间热键可呼出、内容正确、四路径回归正常）。文件：`src-tauri/src/clipboard.rs`。
- **新增（续56，仅 Rust，零前端改动）——修复截图大图复粘贴丢分辨率**：**根因**（先诊断后修，证据来自真实 `clip_history.json`）：大图条目偶发 `orig_path=None`（实测 3196×1997 / 3105×1162 两条无 orig_path、原图根本没落盘），复粘贴 `set_clipboard_image` 分支③ 找不到原图 → 降级 1024px 缩略图 → 大幅降分辨率。机制：监听有两条图片构建路径——内联分支（设 orig_path+落盘原图，正确）与 `image_to_cache_entry`（**只存缩略图、不设 orig_path**，被 `build_clip_entry` 回退路径调用）；而 `has_clipboard_image()` 用 `OpenClipboard` 包裹，截图工具写 DIB+临时 PNG 时短暂占用句柄 → `OpenClipboard` 失败 → 误报「无图片」→ 大图分流到 `image_to_cache_entry` → 丢原图。截图比普通复制更易触发（多占一会儿剪贴板）。**修复（两处）**：① 根因——`has_clipboard_image()` 去掉 `OpenClipboard/CloseClipboard` 包裹（`IsClipboardFormatAvailable` 本就无需打开剪贴板，Win32 文档），消除「忙→误报无图」竞态，大图稳定走内联分支；② 兜底——`image_to_cache_entry` 与内联分支对齐（大图保留原图、预置 orig_path、detached 落盘），任何残留走到该路径的大图也不再丢原图。**验证（CC 自验）**：`cargo check --lib` 零 error✓；`cargo clippy --lib` 维持 8 基线✓（OpenClipboard/CloseClipboard 仍被 read_clipboard_files/write_cf_hdrop 使用、无 unused）。**GUI 实测通过（2026-06-27）**：截图→点历史条目粘到 Paint 为全分辨率；连续多张截图复粘贴均全分辨率。已知取舍（两路径并存/回退路径无去重/极窄竞态，均非 bug）已归档 DECISIONS §6 延伸「续56」。⚠️ 已存在的旧坏条目（[1]/[18] 原图当初没存）无法追回、仍是缩略图，只对续56 之后的新复制生效。文件：`src-tauri/src/clipboard.rs`。

---

## 二、变更记录（原 MEMORY.md §九〔追加〕，最新在上）

### 2026-06-29 (中转区拖出 drag-out，续71，Rust 新模块 + 前端)
- **需求**：中转条目拖到外部应用（Explorer/桌面/记事本/Paint）完成传递。触发=条目上按下拖动超 `DRAG_OUT_THRESHOLD_PX=12`；多选拖任意选中项→拖全部；MOVE→移除、COPY/取消→保留；overlay 在 DoDragDrop 前隐藏、完成后不自动恢复。
- **Rust 新模块 `src-tauri/src/dragout.rs`**（source 侧，与 `dragdrop.rs` 拖入正交）：
  - **线程模型铁律（首版踩坑后修正）**：`DoDragDrop` **必须在主线程**（已 OleInitialize STA、持前台窗口 + capture）。链路：前端 `invoke("start_drag_out")` → worker 线程 `build_formats`（文件IO/base64/解码重活）→ `app.run_on_main_thread(do_drag_on_main)` → 主线程构建 IDataObject + DoDragDrop 阻塞。**不在主线程 init/uninit OLE**（复用 dragdrop setup 的，避免破坏拖入状态）。hide 在 DoDragDrop **之后**：起手 `HIDE_AFTER_START_MS=60ms` 由 worker 发裸 `ShowWindow(SW_HIDE)`（模态循环泵之）+ emit hotkey-hide。**💀 首版死胡同**：全塞 worker 线程 + hide-before → 隐藏丢鼠标 capture + worker 无窗口 SetCapture 失败 → 拖拽不启动（界面消失无投放）。诊断日志 `[dragout] start/DoDragDrop begin/DoDragDrop end hr=…` 三段。
  - **IDataObject**（`#[implement]`）：`formats: Vec<(u16, Vec<u8>)>` 存源字节，`GetData` 现 `GlobalAlloc` 拷一份交调用方（OLE 协议、本对象只持 Vec<u8>、免双重释放）；`QueryGetData` 查表；`EnumFormatEtc` 用系统 `SHCreateStdEnumFmtEtc`（Explorer 依赖、免手写 IEnumFORMATETC）；GetDataHere/SetData/DAdvise/DUnadvise/EnumDAdvise/GetCanonicalFormatEtc → `E_NOTIMPL`。
  - **IDropSource**（`#[implement]`）：QueryContinueDrag——Esc→`DRAGDROP_S_CANCEL`、LBUTTON 松→`DRAGDROP_S_DROP`、否则 S_OK；GiveFeedback→`DRAGDROP_S_USEDEFAULTCURSORS`。
  - **格式**：file+image 汇入一份 CF_HDROP（`build_dropfiles` 复刻 write_cf_hdrop 内存布局 fWide=1，但不写剪贴板）；单图额外 CF_DIB（`build_dib`：base64 PNG→RGBA→BITMAPINFOHEADER 40/32bpp/BI_RGB + 自底向上 BGRA）；纯单条 text→CF_UNICODETEXT。混合以文件为主、文本不并入。
  - **image temp**：优先 `orig_path` 原图（存在则引用、不删、保全分辨率），否则 base64→`std::env::temp_dir()/workbench_dragout_<ns>.png`（记入 temp 列表）；DoDragDrop 返回后嵌套 detached `sleep(TEMP_CLEANUP_DELAY_SECS=5)` 删 temp。
  - 裸 `extern "system"` GlobalAlloc/Lock/Unlock（isize 句柄，同 clipboard.rs idiom）；`DRAGDROP_S_*`/`DV_E_*`/`MK_LBUTTON` 手定义 HRESULT 常量避版本差异；自带一份 `base64_decode`（clipboard.rs 那份模块私有不可复用）。
- **lib.rs**：`mod dragout` + `generate_handler!` 注册命令 `dragout::start_drag_out`（首版用 `app.listen("drag-out-begin")` + emit 桥，第二版改命令 invoke 更可靠）。
- **前端 `src/App.tsx`**：常量 `DRAG_OUT_THRESHOLD_PX=12`；`StageItem`+`clipToStage` 补 `orig_path` 透传；`dragOutRef`（useRef 无 state，pressing/itemId/origin/draggedIds）+ `suppressStageClickRef`；`handleStagePointerDown/Move/Up` 挂在 `.stage-card`/`.stage-item`（读 `data-stage-id`，setPointerCapture）；move 超阈值按 `stageSelRef` 决定 ids（多选含按下项→全选 / 否则单项）→`invoke("start_drag_out",{items})`+置 suppress；`handleStageClick` 顶部加 suppress 守卫；`un9` 监听 `drag-out-done`（move→按 draggedIds 快照从 `stageRef.current` 移除+落盘+退多选）。与框选（续70）互斥靠 lasso 的 closest 排除条目。
- **自验**：`cargo check --lib` 零 error；`cargo clippy --lib` 维持 8 基线（修过一处 doc-list lint）；`tsc --noEmit` 零错误。
- **GUI 实测进展**：**首版失败**（界面消失、文件没落到 Explorer/桌面、日志无 `[dragout]` 行）→ 诊断根因=hide-before 丢 capture + worker 线程 SetCapture 失败 → **已修为主线程 DoDragDrop + hide-after（60ms）+ 命令 invoke + 三段诊断日志**。**第二版待用户重测** T1–T10；若仍失败，看 `[dragout] start/begin/end` 日志定位（无 start=命令没触发；有 begin 无 end=DoDragDrop 阻塞中/卡死；begin 立即 end 且 hr 异常=SetCapture 仍失败，需转 IDropSource 内 hide 或排查 run_on_main_thread 兼容性）。详见 DECISIONS §18。

### 2026-06-29 (中转区鼠标框选多选，续70，纯前端)
- **需求**：为中转区新增「鼠标框选多选」入口，与现有显式多选（续34/34b）共用 `stageSel`/`stageMultiselect` 状态。纯前端、零 Rust、零新增 CSS 变量。
- **实现**（`src/App.tsx` + `src/App.css`）：
  - **状态**：新增 `lassoState`（active/origin/current）+ `lassoStateRef`（渲染时同步，仿 stageSelRef）+ `lassoArmedRef`（down 通过排除判定才布防，move/up 据此区分「框选拖拽」与「条目上拖拽」）；常量 `LASSO_THRESHOLD_PX=6`。
  - **handlers**（挂在 `.drop-area`）：`handleLassoPointerDown`（仅左键 + `dragStateRef.active` 为 false + `e.target.closest(".stage-item,.stage-card,.stage-multi-toolbar,.stage-batch-bar,button")` 排除 → 记 origin + setPointerCapture，不立即激活）；`handleLassoPointerMove`（未布防/未按下 return；超 `LASSO_THRESHOLD_PX` 才 active=true + 加 `.lasso-active` class + `setStageMultiselect(true)`；`computeLassoSelection` 实时算选区矩形与各条目 `getBoundingClientRect()` 相交 → 写 `stageSel`）；`handleLassoPointerUp`/`onPointerCancel`（active 时清视觉，`stageSelRef.current.size===0` 则退出多选——框了空白）。
  - **选区映射**：每个 `.stage-card`/`.stage-item` 加 `data-stage-id={s.id}`，`computeLassoSelection` 按当前 `stageLayout` 查对应选择器、读 `dataset.stageId` 回填 id。两布局均支持。
  - **选区矩形**：`.drop-area` 内渲染 `.stage-lasso`，坐标以 `dropAreaRef.getBoundingClientRect()` 为 offset 基准 + `scrollLeft/scrollTop` 补偿（drop-area `overflow-y:auto`，滚动态对齐）。
  - **兼容点**：Esc 链最前插入「active 时先中止框选并 return」；`hotkey-hide` 复位同步重置 `lassoState`/`lassoArmedRef`/移除 class；与 `handleStageClick` 多选 toggle 共存（框选后可继续点选）。
  - **点空白取消选择**（GUI 实测后追加）：`handleLassoPointerUp` 的「未激活」分支（纯点击空白、未拖出框选）改为——若当前有选择/在多选模式则清空 `stageSel` + 退出多选。`lassoArmedRef` 已保证点的是空白区（条目/按钮在 down 阶段被排除、不 armed），不影响条目自身 toggle/取走粘贴。
  - **CSS**：`.drop-area{position:relative}`（新增，原无）+ `.lasso-active{user-select:none;cursor:crosshair}` + `.stage-lasso`（虚线框 + `color-mix` 半透明填充，复用 `var(--accent,#60a5fa)` 兜底，无新增变量）。
- **验证**：`tsc --noEmit` 零错误。**GUI 实测通过（2026-06-29）**：T1–T9 全过（框选拖拽出矩形 / 实时高亮 / 松手保留 / 条目上不触发 / 框空白不进多选 / 框后继续 toggle / Esc 两段 / 双布局 / OLE 拖入不触发）。实测后追加「点击中转区空白处取消选择」并 `tsc` 复验零错误。

### 2026-06-27 (修复截图大图复粘贴丢分辨率，续56，仅 Rust)
- **现象**：截图后点剪贴板历史条目复粘贴，图片大幅降低分辨率（约 3 倍，3200→1024）。
- **诊断（先不改代码、查真实数据）**：解析 `%APPDATA%\com.workbench.app\clip_history.json` + `clip_images/`——image 条目中 [2]3200×1994/[17]1609×713 有 orig_path 且原图存在；但 **[1]3196×1997、[18]3105×1162 是大图却 `orig_path=None`、原图根本没落盘**。`orig_path` 字面为 None（非「文件 missing」）→ 排除「detached 写晚了/被 janitor 删」，确认是**构建 entry 时就没设 orig_path**。
- **根因**：监听有两条图片构建路径——① 内联分支（`has_clipboard_image()` 真时走，设 orig_path + detached 落盘原图，正确）；② `image_to_cache_entry`（`build_clip_entry` 回退路径调用，**只存 1024px 缩略图、从不设 orig_path**）。而 `has_clipboard_image()` 用 `OpenClipboard` 包裹，**截图工具写 DIB+临时 PNG(CF_HDROP) 时短暂占用剪贴板句柄 → `OpenClipboard` 返回 0 → 误报「无图片」→ 落入 else 分支 → build_clip_entry → image_to_cache_entry → 大图丢原图**。外层检测成功的次数走内联分支（正常），故时好时坏；截图比普通 Ctrl+C 更易踩（多占一会儿剪贴板）。复粘贴时 `set_clipboard_image` 分支③ 见 `orig_path=None` → 降级缩略图。
- **修复（`src-tauri/src/clipboard.rs`，两处互补）**：
  - **① 根因**：`has_clipboard_image()` 去掉 `OpenClipboard/CloseClipboard` 包裹——`IsClipboardFormatAvailable` 无需打开剪贴板（Win32 文档，标准「open 前先 check」用法），消除「剪贴板忙→误报无图」竞态，大图稳定走内联分支。
  - **② 兜底**：`image_to_cache_entry` 与内联分支完全对齐（大图保留 full_img、预置 orig_path、`std::thread::spawn(save_clip_image_to_disk)` detached 落盘）。即使残留竞态再走到该路径，大图也不再丢原图。本路径无图片去重、entry 必入缓存 → 落盘文件必被引用、不产孤儿。
- **锁纪律**：未碰 CLIPBOARD_LOCK 任何调用点；image_to_cache_entry 的 spawn 仅即时返回（原图 PNG 重编码在 detached 线程、不在锁内）。`OpenClipboard/CloseClipboard` 仍被 `read_clipboard_files`/`write_cf_hdrop` 使用，无 unused。
- **验证**：`cargo check --lib` 零 error✓；`cargo clippy --lib` 维持 8 条基线✓。**GUI 实测通过（2026-06-27）**：截图→点历史条目粘 Paint 为全分辨率；连续多张截图复粘贴均全分辨率；四路径回归正常。
- **已知局限**：续56 之前产生的坏条目（[1]/[18] 原图当初未落盘）无法追回、仍只有缩略图；修复仅对之后的新复制生效。
- **关联**：续53「落地原图」机制的缺陷补丁；DECISIONS §6 图片缓存架构。

### 2026-06-27 (set_clipboard_image 分支③大图解码移出主线程，续55，仅 Rust)
- **根因**：`clipboard.rs` `set_clipboard_image` 第③分支（其余 app：Paint/聊天框等真吃位图的目标）在**主线程**做全分辨率 RGBA 解码（3200×1998 ≈ 25MB）+ `set_image`，堵住热键键态轮询线程 → 「短时无法呼出」。分支①(桌面 SHFileOperation)/②(文件夹 CF_HDROP 零解码) 无此问题，仅③需修。
- **修复**：把分支③「解码 + set_image + 焦点交还 + enigo Ctrl+V」整段搬入 `std::thread::spawn(move || {...})`，命令本体 spawn 后立即 `Ok(())` 返回，主线程不再被解码阻塞。`base64`/`orig_path` move 入子线程（此时分支①②已 return、二者完全 owned）；`app` 不被③使用、不 move（无 unused 警告）。
- **主/子线程划分**：① **主线程**——顶部 `hide()`+`sleep(150ms)`（class 检测依赖、不可移）、`GetForegroundWindow`+`get_window_class` 取 class1、三分叉路由；② **子线程**——`SKIP_CLIP_EVENTS.store(2)` → 解码(rgba_from_orig 或 base64) → `{锁 CLIPBOARD_LOCK → arboard set_image}` → `suppress_clip_until_now()` → `GetForegroundWindow`→`SetForegroundWindow` → enigo Ctrl+V。
- **铁律遵守**：CLIPBOARD_LOCK 只罩 set_image 的 OpenClipboard…CloseClipboard 临界区，hide/sleep/焦点交还/Ctrl+V 全在锁外（与分支①②锁纪律一致）；`SKIP_CLIP_EVENTS.store(2)`+`suppress_clip_until_now()` 仍在 set_image 写之前、顺序不变（防自写回流）；焦点交还流程一字未改。子线程 detached、无调用方承接 `?` → 4 处 `?`(base64_decode/load_from_memory/Clipboard::new/Enigo::new + set_image) 改为就地 `eprintln`+`return`。
- **未动**：分支①②、其他命令、clipboard.rs 其余代码、lib.rs、前端、tauri.conf.json。
- **验证**：`cargo check --lib` 零 error✓；`cargo clippy --lib` 维持 8 条基线✓。**GUI 实测通过（2026-06-27）**：G1 大截图(3200×1998)粘 Paint 期间 Ctrl+Space 仍可呼出（不卡）/ G2 粘完图片内容正确 / G3 文本·文件·图片粘桌面·图片粘文件夹四路径回归无异常。
- **关联**：DECISIONS §6 三分叉说明（分支③现为异步解码，①②不变）；CLAUDE.md 剪贴板节锁纪律不变。

### 2026-06-27 (lib.rs 拆分：剪贴板子系统迁入 clipboard.rs，续54，纯结构重构零功能改动)
- **目标**：lib.rs 1539 行过长，把高度内聚的剪贴板子系统（~960 行）拆到独立模块。**纯搬迁，函数体一字未改、无重构、无合并/拆分函数。**
- **新增文件**：`src-tauri/src/clipboard.rs`（~1038 行）。收纳：7 个剪贴板静态量（`SKIP_CLIP_EVENTS`/`SKIP_CLIP_UNTIL_SEQ`/`CLIPBOARD_LOCK`/`CLIP_HISTORY_PATH`/`CLIP_IMAGE_DIR`/`CLIP_CACHE_MAX_RUNTIME`/`CLIP_CACHE`，**全部模块私有**）+ 12 可调常量 + CF_HDROP FFI 块 + 辅助函数（now_ms/get_window_class/base64_*/compute_ahash/has_clipboard_image/read_clipboard_files/write_cf_hdrop/desktop_copy_files/parse_clip_image_time）+ 核心逻辑（image_to_cache_entry/build_clip_entry/save·load_clip_history/save_clip_image_to_disk/suppress_clip_until_now）+ janitor（sweep/start_clip_image_janitor）+ start_clipboard_monitor + 13 个 `#[tauri::command]`（均 `pub(crate)`，**零新增 `pub`**）。
- **新增 `clipboard::init(app, data_dir)`**：封装 setup 启动时序——路径初始化 → load_clip_history → start_clipboard_monitor → start_clip_image_janitor，**顺序锁进模块内不可变**（load 必先于 monitor 否则空缓存覆盖磁盘历史；janitor 靠起手 5s 软时序错开 load）。
- **lib.rs 改动**：① 顶部加 `mod clipboard;`（保留 mod 顺序）；② 删除全部迁出的常量/静态量/函数（sed 块删）；③ 删除 `use std::sync::atomic::Ordering` 与 `use std::time::{SystemTime, UNIX_EPOCH}`（迁出后无引用）；④ setup 内 4-5 行剪贴板初始化收敛为一句 `clipboard::init(app.handle(), &data_dir)`；⑤ `generate_handler!` 13 命令加 `clipboard::` 前缀。lib.rs 1539→**530 行**。
- **验证（CC 自验，全过）**：V1 `cargo check --lib` 零 error✓；V2 `cargo clippy --lib` 仍 8 条基线✓（lint 随代码迁文件，集合/数量不变，非新增）；V3 lib.rs 530 ≤ 640✓；V4 clipboard.rs 被 `mod clipboard` 引用、可编译✓；V5 13 命令均带 `clipboard::` 前缀✓；V6 lib.rs 中 `CLIP_CACHE`/`CLIPBOARD_LOCK`/`SKIP_CLIP` 引用归零✓（含改写一处旧注释）；V7 `write_cf_hdrop` 函数体内无锁（锁加调用方铁律保持）✓。
- **GUI 实测通过（2026-06-27）**：G1 呼出显示历史 / G2 文本·图片·文件粘贴各一次 / G3 删除+重启持久化 / G4 只复制一条历史面板更新——全部正常。
- **偏差点**：Prompt 列的常量名 `CLIP_CACHE_MAX_BYTES_DEFAULT`/`AHASH_BITS`/`AHASH_SIMILAR_THRESHOLD`/`DROP_*` 实际代码不存在，按实际名迁移（`CLIP_IMAGE_CACHE_MAX_BYTES`/`AHASH_MAX_HAMMING`/`AHASH_MAX_DIM_DELTA`，无 DROP_ 常量）。Prompt【绝对约束】列 CLAUDE.md「不动」但第四步又要求改 §项目结构——取第四步、只加 1 行结构索引（clipboard.rs），已在报告中标注此冲突。
- **关联**：CLAUDE.md §项目结构 +1 行；剪贴板铁律（锁序/CF_HDROP/janitor）全部随代码原样保留，未改任何不变量。

### 2026-06-26 (截图粘到文件夹走 CF_HDROP 落地真 PNG + 消除大图卡顿，续53)
- **git 裁决（取证在先）**：① 文件夹粘截图「失败」**不是回归**——图片粘贴自 `38df8b9`(06-15) 起就一直是 `set_image` 位图 + Ctrl+V，资源管理器文件夹(`CabinetWClass`)从不接受位图;桌面特判 `WorkerW/Progman`(`fefb623` 06-17 引入)从未匹配过文件夹类、也没被收窄;`CabinetWClass`/`ExploreWClass` 在全历史从未出现 → 文件夹落地是**新增能力**。用户「之前能粘」极可能是把「粘*文件*进文件夹」（本就支持，CF_HDROP）记成了「粘*截图*」。② 卡顿**是真回归**——`1d17e8b`(06-23 历史图改原图) 把非桌面分支解码从 base64 缩略图(≤1024px) 换成全分辨率原图(~25MB RGBA)，主线程同步跑堵住热键轮询;且对文件夹是「白解码」(位图收不下)。本次一并解决。
- **修复（`src-tauri/src/lib.rs` `set_clipboard_image`）**：非桌面分支按目标窗口类再分叉——**文件夹窗口(`CabinetWClass`/`ExploreWClass`)→ CF_HDROP 落地真 PNG**：大图(有 `orig_path`)直接拿 `clip_images/{time}.png` 路径走 `write_cf_hdrop`（**零解码**，根除文件夹卡顿）;小图(无 orig_path)解一次 base64 写一份 PNG 到 `clip_images/workbench_clip_{time}.png`，**由 janitor 孤儿清理兜底**（不自删，去掉原「固定 5s 延时删」的脆弱 race——Ctrl+V 异步、CPU 负载下可能 Explorer 读完前删坏）。**其余 app(Paint/聊天框)维持原 `set_image` 位图分支，行为不变**（含其大图解码，本次不动，避免一次多变量）。桌面分支 `desktop_copy_files` 不动。
- **铁律遵守**：CF_HDROP 锁加在【调用方】（`{ 锁 CLIPBOARD_LOCK → write_cf_hdrop }`，不进函数体，防与 copy 重入死锁）;锁块内仅 `OpenClipboard…CloseClipboard`，**不跨 hide/sleep/焦点交还/Ctrl+V**;临时文件写盘在锁外;写前 `SKIP_CLIP_EVENTS.store(2)` 防自写回流;焦点交还流程复用未改;`fWide=1` 由复用的 `write_cf_hdrop` 保证。
- **顺带**：`CLIP_IMAGE_CACHE_MAX_BYTES` 300MB → **500MB**（续52 janitor 定稿值，仅改常量字面量）。
- **验证（静态，CC 自检）**：`cargo check --lib` 零新增警告✓;`cargo clippy --lib` 维持 8 条基线✓;自查文件夹分支锁块内无 hide/sleep/Ctrl+V、临时文件写盘在锁外、`SKIP_CLIP_EVENTS` 已设✓。
- **GUI 实测通过**：T1 大截图粘文件夹→生成 PNG 且**无卡顿**(热键可立即呼出);T2 小截图粘文件夹→生成 PNG;T3 粘桌面行为不变;T4 粘 Paint/聊天框仍位图;T5 粘文件夹后历史面板无自写回流条目;T6 临时文件(小图)粘后清理不残留;T7 连续粘大图热键全程可呼出。**小图清理路径复测（2026-06-26）**：T2 小截图(≤1024px)粘文件夹生成 PNG、打开图像完整无损;T6 `clip_images/workbench_clip_*.png` 在下个 janitor sweep 周期被清、真正原图(数字名)不受影响——「落 clip_images 交 janitor 兜底」方案验证有效，无误删、无残留。
- **探针裁决（续53 后续，PROBE 取证已删）**：质疑「Win11 文件夹能粘 snip = Explorer 通用落地位图，CF_HDROP 分支是否冗余」。临时 PROBE 枚举剪贴板格式 + 官方文档双证：Win+Shift+S 截图剪贴板含 `CF_HDROP`+`Shell IDList Array`+`FileContents`+`FileGroupDescriptorW`（位图外另有整套 shell 文件格式），纯位图只有 CF_DIB/CF_DIBV5;MS Learn 证 Explorer 粘贴只认 CF_HDROP/FileDescriptor/FileContents、不认 CF_DIB;原始 bug（纯位图 set_image 粘文件夹失败）即纯位图否证。**裁决情况乙：纯位图粘不进文件夹，CF_HDROP 自落地分支必要、保留定稿;简化方案否决。** PROBE 程序裁决后已删（不进 master）。
- **收尾加固（情况乙）**：小图临时文件清理从「固定 5s 后台删」改为「落 `clip_images/workbench_clip_*.png` 交 janitor 孤儿清理」——去掉脆弱定时 race（Ctrl+V 异步，负载下可能删早损坏粘贴）。`cargo check` 零新增警告 + clippy 8 基线✓。⚠️ 复测点变化：T2/T6 小图临时文件现落在 `clip_images/`（非系统 temp），janitor 周期清。
- **关联**：DECISIONS §6 延伸「截图落地文件夹 + 探针裁决」;CLAUDE.md 剪贴板节三分叉不变式（已注明探针证据 + janitor 兜底）。

### 2026-06-26 (clip_images 缓存上限 + 孤儿清理：解耦 janitor，续52)
- **背景/根因**：落盘原图（2026-06-23）当初按 Simple **刻意不做自动删除/孤儿 sweep**；历史条数有上限（≤100），但单张原图可达数 MB，长会话 / 长期运行下 `clip_images/` 无界增长——长期多用户分发场景是真实磁盘风险。
- **方案（解耦 janitor，非截断时删图）**：新增自包含后台函数 `sweep_clip_image_cache()`，按需读 `CLIP_CACHE` 快照 + 操作磁盘，**零改现有剪贴板写路径**（避免侵入 `set_clip_cache_max`/`delete`/`clear`/dedup truncate 等高危区、增锁与重入风险）。两步：① 孤儿清理——删文件名未被任何 `orig_path` 引用的文件；② 总量封顶——剩余被引用文件总和 > `CLIP_IMAGE_CACHE_MAX_BYTES`(300MB) 时从最旧（文件名 `{time}` 升序、兜底 mtime）删到 ≤ 上限（被删条目降级缩略图，非数据丢失）。
- **锁纪律**：janitor **绝不取 `CLIPBOARD_LOCK`**；`CLIP_CACHE` 锁仅 snapshot-and-release 收集被引用文件名（`HashSet<String>`，锁块内零 fs），出锁后才 list/delete。全程 best-effort（错误 log+跳过，不 panic/阻塞）。
- **后台线程**：`start_clip_image_janitor()`（setup 内 `start_clipboard_monitor` 后 spawn，仿 `start_index_worker` idiom）；起手 `sleep(CLIP_IMAGE_SWEEP_INITIAL_MS=5s)` 错开 setup 同步 `load_clip_history`（否则空 referenced 集误删全部），之后 `loop { sweep; sleep(CLIP_IMAGE_SWEEP_MS=10min) }`；解析不到目录 → 线程 return（降级 no-op）。
- **变更点**：`src-tauri/src/lib.rs`——新增 3 常量（`CLIP_IMAGE_CACHE_MAX_BYTES`/`CLIP_IMAGE_SWEEP_MS`/`CLIP_IMAGE_SWEEP_INITIAL_MS`）+ `parse_clip_image_time` + `sweep_clip_image_cache` + `start_clip_image_janitor` + setup spawn 一行。**零前端 / 零 `tauri.conf.json` / 未碰任何既有剪贴板写路径与锁调用点**。
- **验证（静态，CC 自检）**：`cargo check --lib` 零警告✓；`cargo clippy --lib` 维持 8 条基线不变（唯一 `sort_by_key` 提示在 `apps.rs:204`，非本次代码）✓；自查 janitor 内零 `CLIPBOARD_LOCK` 引用 + `CLIP_CACHE` 锁块内零 fs（awk 截段 grep 确认）✓；3 常量在 lib.rs 顶部命名✓。
- **GUI 实测通过（2026-06-26）**：T5（临时 cap 20MB + SWEEP 30s）验证周期清理与总量封顶生效——目录回落到 ≤ 20MB；验后常量已改回 300MB / 10min（无 T5-TEMP 残留，cargo check 通过）。
- **关联**：DECISIONS §6 延伸「clip_images 缓存上限 + 孤儿清理：解耦 janitor」；CLAUDE.md 剪贴板节新增不变式。

### 2026-06-26 (A1/A2/A3 实测确认 + 死代码清理，续51)
- **实测确认**：续47（增强搜索键自定义）/ 续48（Tab 主键 + 焦点逃逸修复）/ 续50（拖入悬停高亮）全部 GUI 实测通过（2026-06-26），已在 §0 和对应变更记录标注。
- **死代码清理**（`src/App.tsx`）：`selectedIdx` state、`GRID_COLS` 常量、4 个方向键 handler（`ArrowLeft/Right/Up/Down → setSelectedIdx`）、search onChange 的 `setSelectedIdx(0)` 均已删除。S3a 重设计后左侧面板改为 `launcher` 收藏托盘、`filteredApps` 不再渲染，上述方向键导航操作的是不可见的隐藏列表——属于确认无效的僵尸代码。Enter handler 简化：`filteredApps[selectedIdx]??filteredApps[0]` → `filteredApps[0]`（selectedIdx 恒为 0）；`querySelector(".app-tile.selected")` → `null`（无元素会有该 class）。deps 数组同步移除 `selectedIdx`。
- **不破坏**：Enter 搜索启动功能（search 非空时仍触发）、增强搜索 ↑↓ 导航、Esc 链、热键/show/hide/剪贴板全未动。`filteredApps`/`sortedApps` 数据链保留（供 Enter + Ctrl+K 搜索使用）。
- **验证**：`tsc --noEmit` 零错误✓。
- **文件**：`src/App.tsx`（删 selectedIdx/GRID_COLS/方向键 handler/setSelectedIdx(0)，简化 Enter handler）。

### 2026-06-26 (外部文件拖入悬停双区高亮，续50)
- **功能**：外部文件拖入窗口时，启动器（左）和中转区（中）同时出现蓝色 inset 高亮边框，松手/落地后消失。
- **实现**：Rust `DragEnter`（有 CF_HDROP）emit `"file-drag-enter"`，`DragLeave`/`Drop` emit `"file-drag-leave"`；前端 listen + 100ms 防抖（过滤多 HWND 注册导致的快速 leave-enter）；`fileDragOver` state 驱动 `.file-drag-active` CSS class → `box-shadow inset` 高亮两区。
- **坑记录**：首次用 HTML5 `dragenter` 纯前端方案，实测零触发——`dragDropEnabled:false` 是捆绑开关，同时禁用 WebView2 `AllowExternalDrop`，外部文件的 HTML5 事件根本不产生。改走 Rust OLE 回调 emit 才通。已补注 DECISIONS §14。
- **后续补齐**：`fileDragLeaveTimer` 提升至 useEffect 顶层（与 `cleanup` 同级），cleanup return 补 `clearTimeout`；原 IIFE 内声明已删。un7/un8 unlisten 原已在 cleanup 数组，无遗漏。
- **文件**：`src-tauri/src/dragdrop.rs`（DragEnter/DragLeave/Drop 各加 emit）/ `src/App.tsx`（+fileDragOver state +un7/un8 listener +防抖 +timer cleanup）/ `src/App.css`（`.file-drag-active` 两条规则）/ `DECISIONS.md`（§14 捆绑开关注释 + 悬停高亮实现说明）。

### 2026-06-26 (收录 Tab 为主键 + 修 Tab 焦点逃逸 bug，续48)
- **现象 1（Tab 录不进）根因**：token 表（53 条）无 Tab——前端 `tokenFromCode("Tab")` 返 null + `HOTKEY_MAIN_TOKENS` 不含 "tab"，Rust `key_token` 也无 → 录制走 `flash("不支持的键")`。**修**：前端三处（tokenFromCode/HOTKEY_MAIN_TOKENS/comboLabel）+ Rust `key_token`（`VK_TAB`/`Code::Tab`，import 加 VK_TAB）各加 "tab"（54 条）。裸 `Alt+Tab` 加入两侧黑名单（parse_combo + parseComboStr，同 Alt+Space/Alt+F4）。
- **现象 2（Tab 焦点逃逸）根因**：① 设置打开时 keydown handler 第一段 `if(settingsOpen||pickerOpen)return;` 在任何 Tab 处理**前**早退 → 浏览器默认 Tab 焦点遍历生效，而设置模态**无 focus trap** → 焦点跳到模态背后 overlay 按钮（"切换原界面按钮"）。② 关设置后旧 `if(e.key==="Tab"){preventDefault();...filteredApps 循环...}`——S3a 重设计后启动器面板已不渲染 `filteredApps`，preventDefault 吃掉 Tab 但 selectedIdx 改的是隐藏列表 → "没反应"。
- **修**：删除死的 filteredApps Tab 导航；在 `matchComboEvent` 后、`settingsOpen` 守卫**前**加 `if(e.key==="Tab"){e.preventDefault();return;}`——overlay 可见时统一中和默认 Tab 遍历，焦点不再逃逸；Tab 作为热键已被 matchComboEvent 先行处理，不受影响。
- **副作用（已知）**：设置/picker 面板内 Tab 不能在输入框间跳（需点击）。当前"逃逸到背景"更糟，先求正确；若需面板内 Tab 循环再加 focus trap。
- **不破坏**：录制基础设施/主热键/增强键/show-hide/轮询全未动；Tab 仅在 overlay visible 时被拦（隐藏时不挂 listener，不影响其他应用 Tab）。
- **验证**：`tsc --noEmit` 零错误✓；`cargo clippy --lib` 8 条基线不变✓。**GUI 未实测**（需验证：录 Tab/Ctrl+Tab 成功并生效；设置打开时 Tab 不再切背景按钮；关设置后 Tab 无副作用；Alt+Tab 被拒）。
- **文件**：`src/App.tsx`（tokenFromCode/HOTKEY_MAIN_TOKENS/comboLabel/parseComboStr +tab，keydown Tab 中和 + 删死导航）/ `src-tauri/src/lib.rs`（key_token +VK_TAB/tab，parse_combo blocklist +tab，注释 53→54）/ `MEMORY.md`。

### 2026-06-26 (增强搜索键 Ctrl+K 升级为自定义，续47，纯前端零 Rust 改动)
- **功能**：增强搜索呼出键从硬编码 Ctrl+K 改为可自定义（录制/手输/持久化），与续46 的主呼出热键自定义对齐。
- **性质区分**：增强搜索是**应用内快捷键**——仅 overlay 可见时由前端全局 keydown handler 处理，纯前端、不经 Rust/RegisterHotKey；与主呼出热键（全局、Rust 轮询+注册驱动）根本不同，故自定义实现完全在前端。
- **module 级共用工具**（`App.tsx`，从录制 effect 提升 + 新增）：`tokenFromCode`（code→token）/ `parseComboStr`（解析+校验，禁 Win + 裸 Alt+Space/Alt+F4 + 恰 1 主键，对齐 Rust parse_combo）/ `matchComboEvent`（keydown 精确匹配：ctrl/shift/alt 全等 + 无 meta + 主键一致）/ `comboLabel`（展示文案，含 alt）。
- **state/持久化**：`enhHotkey`（默认 `ctrl+k`）/`enhHotkeyInput`/`enhHotkeyError`；store key `enh-hotkey`，加载时 `parseComboStr` 校验后填入。`recording` 由 `boolean` 改 `null|"main"|"enh"`（录哪个键），录制 useEffect 按 target 写回对应输入框 + 错误 setter。
- **changeEnhHotkey**：纯前端校验（`parseComboStr` 非法 → "无效组合"；等于 `hotkeyCombo` → "与呼出热键冲突"；红字 2.5s 自清）+ 写 store。**不经 Rust**。
- **keydown handler**：硬编码 `(e.ctrlKey||e.metaKey)&&key==="k"` → `matchComboEvent(e, enhHotkey)`；deps 加 `enhHotkey`。位置同旧（在 settingsOpen 守卫前，行为一致）。
- **UI**：设置→快捷键 tab 加「增强搜索」行（input+录制+应用+恢复默认，复用 `.hotkey-input`/`.settings-action`/`.recording`，零新增 CSS）；底栏 `comboLabel(hotkeyCombo)` 切换 + `comboLabel(enhHotkey)` 搜索。
- **不破坏**：主热键 changeHotkey/parse_combo（Rust）未动；录制基础设施复用、未改语义；show/hide/轮询/光 dismiss 全未碰。
- **验证**：`tsc --noEmit` 零错误✓。**GUI 未实测**（需 dev 验证：录制替代键、按新键开关增强搜索、与呼出键冲突拒绝、重启持久化、Ctrl+K 默认仍可用）。
- **文件**：`src/App.tsx`（+module helper +enh state +changeEnhHotkey +录制 target 化 +keydown matchComboEvent +设置「增强搜索」行 +底栏 comboLabel）/ `MEMORY.md`。

### 2026-06-26 (录制式热键 + 修饰键全可选 + 放开 Alt（spike 推翻 §9 死路），续46)
本次三件事，递进完成：

**① 录制式输入（前端）**
- 快捷键 tab「应用」前加「录制」按钮。录制态 useEffect（dep `[recording]`）capture 阶段挂 `window.addEventListener("keydown", onKey, true)`，`preventDefault()+stopPropagation()` 抢在全局冒泡 `onKey`（visible effect，line ~806）前，录制时不触发 Esc 关窗/Ctrl+K/方向键。`tokenFromCode` 映射 `e.code`→token（KeyA→a/Digit1→1/F1-12→f1-12/Space→space/Arrow*→up·down·left·right，对齐 Rust 53 条）；仅修饰键时实时预览 `ctrl+…`，按主键定型写回 `hotkeyInput`（**不自动应用**，再点「应用」走 `changeHotkey`）；Esc 取消录制。CSS `.settings-action.recording` 高亮 + `@keyframes hotkey-rec` 呼吸动画。

**② 修饰键全可选（去「必须含 Ctrl」）**
- `parse_combo`：删掉「必须含 Ctrl」检查；`has_ctrl/has_shift/has_alt` 各自可选、动态构建 mods/vk_list；主键恒在保证 vk_list 永不为空（防轮询 `all()` 恒真卡死）。`Shortcut::new(Some(empty))` 与 `None` 等价、无需分支。⚠️ 纯主键会注册成全局热键抢占该键——用户自负，前端提示警示。

**③ 🔑 放开 Alt（spike 实测推翻 §9「Alt 死路」）**
- **探针（headless，`cargo test alt_spike` 验后已删）**：`RegisterHotKey` 对 Alt+Q / Alt+Space / Ctrl+Q **全部可注册 OK**（连 Alt+Space 都能注册 → 旧说「Alt+Space 谁都抢不到」也不准）。
- **运行时实测（Alt+Q，用户 GUI）**：呼出/关闭无白闪；Esc 能关；light dismiss 正常；**记事本前台按 Alt+Q，菜单栏未激活、焦点正常回归、无系统音**。
- **根因**：`RegisterHotKey` 消费整个 Alt+Q 组合 → 前台应用收不到 Alt 的 `WM_SYSKEYDOWN` → 不触发菜单栏激活；show/hide 由独立物理轮询驱动。旧「Alt 死路」来自早期 JS/rdev 录入态路线、与本架构无关（张冠李戴）。
- **落地**：`parse_combo` 放开 Alt（`has_alt` → `Modifiers::ALT` + `VK_MENU`）；前端录制 handler 改为仅拒 Win；**仅保留小黑名单**：Win 全系 + 裸 `Alt+Space`（`has_alt && !ctrl && !shift && main∈{space,f4}` → Err）。前端格式提示同步更新。

**不破坏**：show 路径三约束/轮询循环/长短按语义/注册原子切换/store 读写/全局 onKey/light dismiss 全未动；轮询读 `HOTKEY_VK_KEYS` 自动支持 Alt（VK_MENU），未改轮询代码。
**验证**：`tsc --noEmit` 零错误✓；`cargo check` 干净 + `cargo clippy` 8 条基线不变✓；GUI 实测 Alt+Q 全过（2026-06-26）。
**教训**：「永久禁用/死胡同」标签会因架构演进失效；存疑开 spike 用数据验，别让旧结论挡路。
**文件**：`src-tauri/src/lib.rs`（parse_combo 重写 + 头注释，临时 alt_spike 测试已删）/ `src/App.tsx`（+recording state/useEffect/录制按钮，handler 放开 Alt，提示语）/ `src/App.css`（+`.settings-action.recording` +`@keyframes hotkey-rec`）/ `DECISIONS.md` §9 续46 / `CLAUDE.md`（热键节 + Alt 死胡同划掉）/ `MEMORY.md`。

### 2026-06-25 (自定义热键 V2-1：表驱动任意 combo parse_combo + V21-TEMP harness，续44)
- **功能**：将 `parse_combo` 从 2 预设白名单改为表驱动任意组合解析器，支持 Ctrl+(Shift+)主键 格式。V21-TEMP harness 文本框用于临时验证。
- **Rust**（`src-tauri/src/lib.rs`）：新增 `key_token(tok)` 函数（53 条 match：a-z→VK_A/Code::KeyA，0-9，f1-f12，space，up/down/left/right）。重写 `parse_combo`：tokenize by '+' → blocklist(win/alt) → 必须含 ctrl → has_shift 检测 → `main_keys` filter → `key_token` 查表 → 构造 VK 列表 + Shortcut。`set_hotkey` register 错误文案 → "组合被占用或系统不可用"。**轮询循环/长短按/read_combo_from_store/setup 全不动**（`parse_combo` 签名不变，兜底 "ctrl+space" 仍可用）。临时单测 `#[cfg(test)] mod hotkey_parse_tests`（11 断言，`cargo test --lib` 全过，验后已删）。
- **前端**（`src/App.tsx`）：新增 `v21TempCombo` state；设置→快捷键 tab segmented 下方加文本框 + 应用按钮（V21-TEMP，`(changeHotkey as (s:string)=>Promise<void>)(...)` 复用 invoke+store+错误提示逻辑）；V1 segmented 保留不删。
- **不破坏**：show 路径三约束/轮询循环/长短按语义/注册层原子切换/store 读写/light dismiss/其他设置 tab——全未动。V1 segmented 仍可用（两个 overlay 并存）。
- **验证**：`cargo check/clippy --lib` 8 条基线不变✓；`tsc --noEmit` 0 错误✓；单测 11 断言全过后已删。**⚠️ 三键 GUI（Ctrl+Shift+X momentary/toggle）未实测**（需用户 `npm run tauri dev` + V21-TEMP harness 输入 ctrl+shift+x 验证）。底栏 kbd 文案仍硬编码（V2-2 待做）。
- **文件**：`src-tauri/src/lib.rs`（+key_token +parse_combo重写 +set_hotkey错误文案）/ `src/App.tsx`（+v21TempCombo +V21-TEMP JSX）/ `DECISIONS.md` §9 V2-1 / `CLAUDE.md` 热键节 / `MEMORY.md`。

### 2026-06-25 (自定义热键 V1：2 预设 Ctrl+Space / Ctrl+F12，运行时原子注册 + store 持久化，续43)
- **功能**：设置→快捷键 tab 新增 segmented control（Ctrl+Space 默认 / Ctrl+F12），切换即时生效、重启保留。把原本硬编码在「轮询层 + 注册层」两处的 Ctrl+Space 统一收口到两个静态，运行时可切换。
- **预备验证（动手前实测，关键）**：① store = `%APPDATA%/Roaming/com.workbench.app/workbench-data.json`，**平凡顶层 KV JSON** → setup 阶段 `std::fs::read_to_string` + `serde_json` **同步读可行**，无需前端 invoke 兜底（启动无空窗）；② `Shortcut` = `global_hotkey::HotKey`，derive `Clone+Copy+PartialEq+Eq+Hash` → 直接存 `Shortcut`、不必降级存 String；③ `VK_F12` 在 `windows::Win32::UI::Input::KeyboardAndMouse`（=123），与 VK_CONTROL/VK_SPACE 同模块。
- **Rust**（`src-tauri/src/lib.rs`）：新增 2 静态 `HOTKEY_VK_KEYS: OnceLock<Mutex<Vec<u16>>>`（轮询用 VK 列表）+ `CURRENT_SHORTCUT: OnceLock<Mutex<Shortcut>>`（反注册旧组合用）；新增 `parse_combo(s)`（白名单 "ctrl+space"/"ctrl+f12" → (VK列表, Shortcut)，未知返 Err）、`read_combo_from_store(app)`（同步读 store JSON，任何失败 →None）、命令 `set_hotkey(combo)`（先 register(new) 成功→unregister(old)→更新 2 静态；任一步失败保留旧组合；**不写 store**，持久化前端负责）。轮询循环**仅改 combo 检测一行**：`is_down(VK_CONTROL.0)&&is_down(VK_SPACE.0)` → 读 `HOTKEY_VK_KEYS` 锁内 `keys.iter().all(|vk| is_down(*vk))`（25ms 循环唯一加锁处，持锁 µs 级立即 drop，与其他锁无交集）。setup：register 前先 `read_combo_from_store` 落地 + init 2 静态，register 改用解析出的 shortcut。`generate_handler!` 追加 `set_hotkey`。
- **前端**（`src/App.tsx` + `src/App.css`）：state `hotkeyCombo`/`hotkeyError`；store 加载块读 `hotkey-combo` 填 state（**不 invoke**，Rust setup 已落地）；`changeHotkey(next)` callback（invoke `set_hotkey` 成功才更 state + 写 store，失败红字提示 3s 自清）；快捷键 tab JSX 占位文字 → segmented + 「恢复默认」按钮 + 错误提示，复用 `.seg/.seg-btn/.seg-active/.settings-action`；CSS 仅加 `.settings-hint-error{color:#ef4444}`。
- **不破坏**：show 路径三约束、长短按判定（HOTKEY_TAP_MAX_MS）、momentary/toggle 语义、按下/松开沿检测、tray_toggle、light dismiss、RegisterHotKey 空 handler、所有锁、其他 settings tab、其他 store key——全未动。`HOTKEY_TAP_MAX_MS`/`HOTKEY_POLL_MS` 常量原值不变。
- **验证**：`cargo check --lib` 0 警告✓；`cargo clippy --lib` 8 警告（基线不变，过程中曾因 `&app.handle()` needless borrow 多 1 条、已修）✓；`tsc --noEmit` 0 错误✓。**GUI T1–T9 实测通过（2026-06-25）**（T1 默认长短按正常 / T2 切 F12 后 Space 失效·F12 生效 / T3 重启立即按 F12 即生效，同步读 store 无空窗 / T4 切回 Space / T5 恢复默认 / T6 切换无抖动·白闪·开即关 / T7 light dismiss / T8 Esc / T9 占用冲突红字提示）。
- **文件**：`src-tauri/src/lib.rs`（+2 静态 +parse_combo +read_combo_from_store +set_hotkey +轮询 1 行 +setup 落地 +handler 注册）/ `src/App.tsx`（+2 state +store 加载 +changeHotkey +tab JSX）/ `src/App.css`（+`.settings-hint-error`）/ `DECISIONS.md` §9 / `CLAUDE.md` 全局热键节 / `MEMORY.md`。

### 2026-06-24 (应用扫描改后台预建 S4c：start_apps_worker + apps-ready，消除首次呼出卡顿，续42)
- **功能/根因**：开始菜单/桌面 .lnk 扫描 + 每个 `SHGetFileInfoW` 提图标实测约 **1.5s**，原绑在前端首次 `visible` 时 invoke `scan_start_menu`，正好砸在首次 Ctrl+Space 呼出那一刻 → 卡。改为后台预建（同 filesearch S4a 架构），呼出时 apps 已就绪。
- **Rust**（`src-tauri/src/lib.rs`）：新增 `start_apps_worker(app)`——setup 阶段 spawn 后台线程，`sleep(1s)` 后调用现有 `apps::scan_start_menu()`（**扫描/图标逻辑一字不动**；其 `APP_CACHE` 顺带缓存；`do_scan` 的 COM init/uninit 在调用线程自包含，后台线程安全）→ `emit("apps-ready", apps)`。setup 内与 `filesearch::start_index_worker` 并列调用。`scan_start_menu`/`refresh_apps` 命令保留（前端兜底）。
- **前端**（`src/App.tsx`）：① `[]`-effect 加 `un6` 监听 `apps-ready` → `setApps`；② 新增 `appsRef`（供 `[visible]` 闭包读最新 apps）；③ 首次 visible 的扫描改**兜底语义**——`!loadedRef.current` 守卫内仅当 `appsRef.current.length===0`（事件错过/未到）才 invoke `scan_start_menu` 兜底（命中 `APP_CACHE` ~120µs 近乎瞬时），否则跳过。
- **不破坏**：`scan_start_menu`/`do_scan`/图标提取一字不动；窗口/焦点/热键/剪贴板/粘贴不碰；`start_apps_worker` 与 filesearch/clipboard/focus worker 并列独立；`sortedApps`/`filteredApps`/增强搜索/普通搜索/`appUsage`/`launchApp` deps 含 apps、自动响应、零改动。
- **验证**：`cargo check` 零警告✓；`cargo clippy` 8 条基线不变✓；`tsc --noEmit` 零错误✓。**临时单测实测**（验证后已删，保留正式日志 `[apps] background scan: N apps in {elapsed}`）：后台扫 **114 apps / 1.47s**、二次缓存命中 **117.5µs**（前端兜底走的就是这条）。⚠️ bin 链接失败仅因运行中实例（PID 锁 exe），非代码问题，全 app 由用户跑。**T1–T6 GUI 实测通过（2026-06-24 用户确认）**：首次呼出无卡顿、增强/普通搜索/picker/排序/动画不受影响、兜底正常。
- **文件**：`src-tauri/src/lib.rs`（+`start_apps_worker` +setup 调用）/ `src/App.tsx`（+un6 +appsRef +visible 兜底语义）/ `DECISIONS.md`（§17 追加）/ `CLAUDE.md`（扫描/索引后台预建约定扩写）/ `MEMORY.md`。

### 2026-06-24 (增强搜索接入文件结果 S4b：分组+分隔线+索引提示+150ms 防抖，续41，纯前端)
- **功能**：Ctrl+K 增强搜索接入 S4a 的文件系统索引。结果分两组——Tier 1（应用 + 中转 file 条目，有查询时 ≤10）在前，`.enh-divider`「文件」分隔线，Tier 2（`search_files` 返回文件 ≤20）在后，合并列表 ≤30。
- **零 Rust 改动**，仅 `src/App.tsx` + `src/App.css`（复用现成 `search_files`/`get_index_status`/`HighlightText`/`open_file`/`fi`）。
- **类型/state**（`App.tsx`）：`EnhResult` 加 `{kind:"fs",path,name,ext,isDir}` 支；`fsResults` + `indexReady` state；`import { Fragment }`。
- **查询/状态**：① 150ms 防抖 useEffect（`enhQuery`/`enhOpen` 变化 → `invoke("search_files",{query,limit:20})`，空查询清空）；② `indexReady` 双来源——事件监听 `un5`（`file-index-ready`，payload>0 即就绪）+ 打开时主动 `get_index_status` 兜底（防错过 emit）。
- **enhResults 重构**：原 useMemo 拆为 `enhTier1`（app+stage，有查询 slice(0,10)、空查询兜底仍 30 常用应用）+ 新 `enhResults`（`[...enhTier1, ...fsTier2]`，fsTier2 = `fsResults.slice(0,20)` map 成 fs 支）。`activateEnh` 加 fs 分支 → `open_file`（不碰粘贴/焦点高危区）。
- **JSX**：渲染用全局连续索引 `i` 比对 `enhSelIdx`；`i===enhTier1.length && enhTier1.length>0` 时此项前插 `.enh-divider`（用 `Fragment` 包裹 divider+result，divider 不占 result 索引 → ↑↓/Enter 跨组连续）；fs 图标 `isDir?📁:fi(ext)`、badge「文件」、`ranges=[]`（Rust 侧子串匹配未回传位置）。索引未就绪+有查询时搜索框下显示「文件索引建立中…」（不阻塞 Tier 1）。`hotkey-hide` 复位加 `setFsResults([])`。
- **CSS**：`.enh-divider`（小写灰字分组标签）+ `.enh-index-hint`（斜体灰字，宽度对齐 `min(640px,80%)` 结果列）。文件结果项复用 `.enh-result`/`.enh-result-badge`。
- **不破坏**：普通搜索三区联动/启动器/中转/剪贴板/设置不受影响；增强搜索 Tier 1 渲染、键盘导航、Esc 退出、Ctrl+K toggle 保持；索引未就绪不阻塞 Tier 1。
- **验证**：`tsc --noEmit` 零错误（静态✓）。**T1–T11 GUI 实测通过（2026-06-25）**（文件结果分组/分隔线/图标/badge、↑↓ 跨组连续、Enter/单击 open_file、文件夹 open_file、未就绪「建立中…」+Tier1 照常、就绪后文件结果出、上限 20/防抖/清空/Esc 退出；含 S4a `[fileindex] ready` 日志验证）。
- **文件**：`src/App.tsx`（+fs 支 +2 state +un5 +防抖/状态 effect +enhResults 拆分 +activateEnh fs +JSX 分组）/ `src/App.css`（+`.enh-divider` +`.enh-index-hint`）/ `DECISIONS.md`（§17 追加前端分组渲染）/ `MEMORY.md`。

### 2026-06-24 (文件系统索引 S4a：filesearch.rs 后台预建内存索引，续40，仅 Rust)
- **功能**：为增强搜索 Tier 2 打底——后台预建一份文件系统内存索引，供后续 Ctrl+K 搜整个文件系统。本步**零前端改动**（前端接入是 S4b）。
- **新模块**（`src-tauri/src/filesearch.rs`，~190 行）：
  - `IndexEntry{path,name,name_lower,ext,is_dir}`（`name_lower` 预存小写避免查询重复 to_lowercase）；`FileSearchResult` 为对外序列化结构。
  - `static FILE_INDEX: OnceLock<Mutex<Vec<IndexEntry>>>`——全新独立锁，与 `CLIPBOARD_LOCK`/`CLIP_CACHE` 无交集。
  - `start_index_worker(app)`：setup 阶段 spawn 独立后台线程，`sleep(3s)` 避开开机高峰 → `build_index` → 原子替换 Vec → `emit("file-index-ready", count)` → `sleep(30min)` 周期重建。
  - `build_index`：`walkdir` 遍历 `scan_dirs()`（Desktop/Downloads/Documents/Pictures/Projects，不存在跳过），`max_depth(8)`，`should_skip_dir` 剪枝 node_modules/.git/target/$recycle.bin/appdata/__pycache__ 及隐藏目录整子树，跳过隐藏文件，硬顶 `MAX_INDEX_ENTRIES=200_000`。**耗时遍历全程不持锁**。
  - `#[tauri::command] search_files(query,limit)`：纯内存子串打分（越靠前+名越短+前缀加分），`take(limit.min(50))`；`get_index_status()` 返回 `{ready,count}`。
- **lib.rs**：顶部 `mod filesearch;`；`generate_handler!` 加 `filesearch::search_files, filesearch::get_index_status`；setup 内 `dragdrop::register_drag_drop` 后加 `filesearch::start_index_worker(app.handle().clone())`。
- **三道不卡前端保险**（DECISIONS §17）：① 索引只在后台线程、永不经命令/invoke；② 查询只读内存、不碰磁盘；③ 双缓冲原子替换、锁只罩替换/读取瞬间临界区。
- **验证**：`cargo check` 零警告✓；`cargo clippy` 8 条基线不变、无一在 filesearch✓；**临时单测实测**（验证后已删，仅保留正式日志 `[fileindex] ready: N entries (elapsed)`）：`build_index` 5 条目 390µs、node_modules 子树与隐藏文件正确跳过、`search_files("report")` 7.4µs 返回且短名前缀优先、limit/空查询守卫正确。⚠️ **bin 链接失败仅因运行中实例（PID 锁住 workbench_app.exe），非代码问题；lib 编译干净**。GUI 层（Ctrl+K 看文件结果）已通过 S4b 实测（2026-06-25）。
- **文件**：`src-tauri/src/filesearch.rs`（新增）/ `src-tauri/src/lib.rs`（+mod +注册 +线程启动）/ `DECISIONS.md`（§17 新增 + 目录）/ `CLAUDE.md`（文件搜索不变量补一句）/ `MEMORY.md`。

### 2026-06-24 (.lnk 拖入启动器：resolve_lnk 提取图标+干净名称存 kind:"app"，续39)
- **功能**：外部拖入 `.lnk` 快捷方式到启动器区时，不再存为 `kind:"file"` 而是调用新命令 `resolve_lnk`，提取图标 + 去掉后缀名称，存为 `kind:"app"` 条目；左键走 `launchApp → ShellExecuteW(.lnk)` 正常启动，与 picker 加入的 app 完全一致。非 .lnk（普通文件/文件夹）走原有 `get_file_info` 路径不变。
- **Rust 新增**（`apps.rs` 末尾，约 20 行）：`LnkInfo { name, path, icon }` struct + `#[tauri::command] pub fn resolve_lnk(path)`：取文件名去 `.lnk` 后缀（大小写不敏感）；调用已有 `extract_icon_base64(&path)`（`SHGetFileInfoW` 自动解析 .lnk 目标图标，无新依赖）。`lib.rs` 在 `generate_handler!` 追加 `apps::resolve_lnk`。
- **前端**（`App.tsx`，仅改 `inLauncher` 分支内部）：在路径 `p` 判断 `.lnk` 后缀，走 `invoke("resolve_lnk")` 或 `invoke("get_file_info")` 两条 if-else 分支；去重改为检查原始路径 `x.path === p`（`invoke` 前即检，避免无效请求）。
- **CSS 零改动**：`kind:"app"` 复用现有 `app-tile-icon img` 渲染路径，icon 为 null 时自动走首字母兜底（已有逻辑）。
- **不碰**：`extract_icon_base64` 函数体、`dragdrop.rs` 注册、`openLauncherItem`、picker、持久化加载、S3b 落点判定逻辑。
- **验证**：`cargo check` 零错误✓；`tsc --noEmit` 零错误✓。**T1–T6 GUI 实测通过（2026-06-25）**（.lnk 图标/名称/启动/持久化/去重；非 .lnk 行为不变；icon=null 首字母兜底正常）。
- **文件**：`src-tauri/src/apps.rs`（+LnkInfo struct +resolve_lnk 命令）/ `src-tauri/src/lib.rs`（+注册）/ `src/App.tsx`（inLauncher 分支改 .lnk 判断）/ `DECISIONS.md` §16 / `MEMORY.md`。

### 2026-06-24 (启动器 S3b：外部文件拖入落点双区判定 + drop-flash 确认动画，续38)
- **功能**：原生拖入（IDropTarget）升级为双区落点判定——松手位置在启动器 `.app-grid` 内→入 `LauncherItem`（file/folder，持久化 store key `launcher-items`），否则→入 StageItem 中转（原有行为兜底，含落在任何区域外）。落地区域 200ms drop-flash 闪烁视觉确认。
- **Rust 改动**（`src-tauri/src/dragdrop.rs`，约 10 行）：
  - 新增 `FilesDroppedPayload { paths: Vec<String>, x: i32, y: i32 }` struct（`#[derive(serde::Serialize, Clone)]`）。
  - `Drop` 方法 `_pt` → `pt`，emit payload 从 `paths` 改为 `FilesDroppedPayload { paths, x: pt.x, y: pt.y }`。
  - `pt`（`POINTL`）是 Windows **屏幕物理像素**坐标；前端需 `÷ window.devicePixelRatio` 转 CSS px。
  - 注册逻辑/OleInitialize/EnumChildWindows **绝对不动**（DECISIONS §14 铁律）。
- **前端改动**（`src/App.tsx`）：
  - 新增 `launcherDropRef`（`useRef<HTMLDivElement|null>(null)`），挂到 `.app-grid` div 的 `ref`。
  - `files-dropped` 监听：payload 从 `string[]` 改为 `{paths,x,y}`；`cssX/cssY = x/y ÷ devicePixelRatio`；`getBoundingClientRect()` 判落点是否在 launcherDropRef 内；`inLauncher` 分支→累加 `LauncherItem`，else 分支→原有 StageItem 逻辑（完整保留）。两分支末尾均保留 `setFocus` 调用。
  - `drop-flash` class 在落地区域 classList 上 add/remove（200ms setTimeout 移除），**不通过 React state**（避免 render）。
- **CSS**（`src/App.css`）：`.drop-area.drop-flash, .app-grid.drop-flash { animation: drop-flash 200ms ease-out; }` + `@keyframes drop-flash`（0% 蓝色 → 100% transparent）。
- **DPI 换算**：200% DPI 下 `devicePixelRatio=2`，物理像素 ÷ 2 = CSS px，与 `getBoundingClientRect()` 量纲一致。
- **DragOver 实时高亮**（代价分析）：需 Rust 每次 DragOver 持续 emit → IPC 高频 → 代价过高，未实现；用落地 drop-flash 确认代替（见 DECISIONS §14 追加）。
- **验证**：`tsc --noEmit` 零错误✓；`cargo check` 零错误✓（先漏 `Clone` derive，已加）。**T1–T8 GUI 全过（2026-06-24 用户实测）**。
- **文件**：`src-tauri/src/dragdrop.rs` / `src/App.tsx` / `src/App.css` / `DECISIONS.md`（§14 追加） / `MEMORY.md`。

### 2026-06-24 (启动器重设计 S3a：自动扫描全量 → 持久化收藏托盘，续37，纯前端，零 Rust 改动)
- **功能**：左侧启动器面板由「自动扫描全量平铺(`filteredApps`)」改为「手动策展的持久化收藏托盘」。条目左键打开/启动、右键移除；末尾恒显「＋ 添加」卡片开 app picker。
- **零 Rust 改动**，仅 `src/App.tsx` + `src/App.css`。
- **新数据类型**（独立于 `StageItem`，**不可合并**——左键动作契约不同：启动器=打开/启动，中转=取走粘贴）：`LauncherItem{id,kind:"app"|"file"|"folder",name,icon?,path,ext?}`；`LAUNCHER_MAX=60`、`launcherId()`。
- **state/持久化**：`launcher` state + `launcherRef`（S3b 拖入落点用，先备好）；store key `launcher-items`（Store useEffect 内 stage 之后加载）；`saveLauncher` 仿 `saveStage`。
- **操作函数**：`openLauncherItem`（app→`launchApp` 复用放大动画+hide；file/folder→`open_file`）、`addAppToLauncher`（按 path 去重）、`removeLauncherItem`、`openLauncherCtxMenu`（file/folder 加「打开所在目录」+「从启动器移除」）。
- **app picker 模态**：`pickerOpen`/`pickerQuery` state + ref；`pickerResults` useMemo（排除已加入 app，空=常用前 50、有查询=`fuzzyScore` 排序）；JSX 复用 `settings-modal`/`enh-result` 样式，搜索 autoFocus、点击添加不关闭（连续添加）、已加入因 filter 自然消失。Esc 链插入 `pickerOpen`（ctxMenu→enhOpen→**pickerOpen**→stageSel→settings→关窗）。
- **扫描链全保留**：`scan_start_menu/apps/sortedApps/filteredApps` 不动，喂 Ctrl+K 增强搜索 + 普通搜索数据链；面板不再渲染 `filteredApps`。
- **⚠️ 设计副作用**（已知、有意）：① 顶栏普通搜索不再过滤左侧应用区（应用搜索改由 Ctrl+K 承担，`filteredStage`/`filteredClip` 中转·剪贴板过滤照常）；② 普通页方向键失去可见目标，保留 handler 不删，Enter 加 `search.trim()` 守卫防空查询误启动隐藏 `filteredApps[0]`；launcher 键盘导航待后续。
- **布局**：`.app-panel` 600→360px、`.app-grid` `repeat(6→4,1fr)`，中转区(flex:1)相应变宽；新增 `.launcher-add`/`.picker-*` 样式（复用 token，零改现有类）。
- **验证**：`tsc --noEmit` 零错误（静态✓）。**T1–T10 GUI 实测通过（2026-06-25）**（picker 添加/去重/连续添加/Esc、app 条目启动动画、右键移除、重启持久化、Ctrl+K 与普通搜索不受影响、空 search Enter 不误启动、布局协调正常）。
- **文件**：`src/App.tsx` / `src/App.css` / `DECISIONS.md` / `CLAUDE.md` / `MEMORY.md`。

### 2026-06-24 (顶栏普通搜索 → 三区联动过滤，续36，纯前端，零 Rust 改动)
- **功能**：顶栏普通搜索框输入时**同时过滤应用 / 中转 / 剪贴板三区**（应用区原本已联动，本步补齐中转 + 剪贴板）。与 Ctrl+K 增强搜索（enhQuery）**完全独立**，两套 query 互不影响。
- **零 Rust 改动**，仅 `src/App.tsx`（CSS 零改动）。
- **新增模块级纯函数**（放 `getFileIcon` 后）：`typeKeywords({type,ext,isImage})` 给条目算"类型词"（图片/视频/音频/压缩/pdf/文档/表格/代码/程序/文本…）；`matchItem(query,name,keywords)` 名称内容子序列模糊优先、叠加类型词子串命中，任一命中即保留。
- **新增 useMemo**：`filteredStage`（按 `search` 过滤 stage）、`filteredClip`（过滤 clipboard）；空查询=全量。JSX 仅把 `.map` 数据源从 `stage`/`clipboard` 换成 `filteredStage`/`filteredClip`，每项渲染/key/handler 全不变。空态：有 search 且空→「无匹配」，无 search→保持原提示。
- **placeholder** 改「搜索应用、中转、剪贴板…」。
- **不破坏**：三区点击/右键/拖拽/中转多选(基于 id)/剪贴板 handler(基于对象+time) 不受过滤影响。
- **bug 修复（用户实测反馈，续36b）**：中转区 Shift 区间选 + **同时有 search 过滤** 时会遗漏锚点起始项——根因 `handleStageClick` shift 分支用 `stage.slice(全量索引)`，而 idx/anchor 均为 `filteredStage` 索引。改为 `filteredStage.slice(...)`（deps `stage`→`filteredStage`）。无 search 时 `filteredStage===stage`，原行为不变。
- **验证**：`tsc --noEmit` 零错误（静态✓）。**T1–T10 GUI 实测通过（2026-06-25）**（各区名称过滤/类型词"图片""txt""pdf"命中/清空恢复/独立空态/过滤态交互不破坏/Ctrl+K 不清 search 全部正常）。
- **文件**：`src/App.tsx` / `DECISIONS.md`（§15 补两套搜索分工）/ `MEMORY.md`。

### 2026-06-24 (增强搜索独立全屏页 Ctrl+K，续35，纯前端，零 Rust 改动)
- **功能**：Ctrl+K 呼出同一 overlay 内的全屏「增强搜索」视图层（**非新窗口**），搜应用 + 中转区 file 条目，↑↓ 选择、Enter 激活。Esc 退回主页面（不关窗），再 Esc 才关窗。
- **零 Rust 改动**，仅 `src/App.tsx` + `src/App.css`。
- **新增类型/state**（`App.tsx`）：`EnhResult`（app / stage 联合）；`enhOpen`/`enhQuery`/`enhSelIdx` state + `enhInputRef` + `enhOpenRef`（供 Esc 闭包读最新）。
- **结果计算** `enhResults`（useMemo）：空查询=`sortedApps.slice(0,30)` 兜底；有查询=`apps` + `stage.filter(file)` 各跑 `fuzzyScore`、合并按 score 降序（app 同分按 `usageScore`）、slice(50)。
- **激活** `activateEnh`：app→`launchApp`（复用放大动画+淡出+hide）；stage file→`hideWorkbench` + `open_file`（fire-and-forget）。**全程不碰粘贴/焦点交还/CLIPBOARD_LOCK 高危区**。
- **键盘**（全局 onKey）：Esc 链插入 enhOpen（ctxMenu→**enhOpen**→stageSel→settings→关窗）；新增 Ctrl+K toggle；`if(enhOpen){↑↓/Enter 接管;return}` 屏蔽 launcher 导航（字母键不拦截）。deps 增 `enhOpen/enhResults/enhSelIdx/activateEnh`。`hotkey-hide` 复位 enh 三 state。
- **JSX**：`.enh-layer` 始终挂载、靠 `.enh-open` class 切显隐（沿用 overlay-visible/hidden 模式避免卸载闪烁），放 `</main>` 后、settings 模态前。复用 `HighlightText`/`fi()`。
- **CSS**（`App.css`）：`.enh-*` 一组，复用现有 token（--bg/--hover/--border/--text/--text3/--fill-2/--accent/--font），160ms 淡入上浮，不改任何现有类。
- **验证**：`tsc --noEmit` 零错误（静态✓）。**T1–T11 GUI 实测通过（2026-06-25）**（Ctrl+K 进入/丝滑切换/自动聚焦/↑↓Enter/中转 badge/高亮/空查询兜底/Esc 两级退出/复位/light dismiss 不串扰全部正常）。
- **文件**：`src/App.tsx` / `src/App.css` / `DECISIONS.md`（§窗口补设计取舍）/ `MEMORY.md`。

### 2026-06-23 (中转区多选 UX 重设计，续34b，纯前端，零 Rust 改动)
- **修复/重设计（基于用户实测反馈）**：
  - Shift 区间选改为「多选模式内 Shift 才区间选」，同时 `e.preventDefault()` 防浏览器文字蓝色选中。
  - 废弃 Ctrl/Shift 修饰键隐式触发多选。改为显式「多选」按钮进入模式（`stageMultiselect` state）：进入后点击=选中/取消；退出后点击=取走（原行为）。
  - 批量操作条从 drop-area 内移到标题行右侧（与「文件中转区」标签同行），不占列表空间。
  - 右键菜单：多选模式且有选中项时显示批量操作（取走/复制/删除/取消选择）；否则仍显示单项操作。
- **新增 state / ref**（`App.tsx`）：`stageMultiselect`（模式开关）、`stageMultiselectRef`（供 Esc 闭包读最新）。
- **Esc 优先级**：ctxMenu → (stageSel 非空 OR 多选模式) 退出多选 → settingsOpen → hide。
- **验证**：`tsc --noEmit` 零错误。GUI T1–T9 需 `npm run tauri dev` 实测。
- **文件**：`src/App.tsx`（+state/ref +handleStageClick 重写 +openStageCtxMenu 重写 +Escape 更新 +hotkey-hide 更新 +JSX 标题行重构）/ `src/App.css`（批量条改标题行样式）。

### 2026-06-23 (中转区多选 + 批量操作，续34，纯前端，零 Rust 改动)
- **功能**：中转区（文件中转）新增 Ctrl/Shift 多选 + 批量取走/复制/删除操作条。
- **零 Rust 改动**，仅 `src/App.tsx` + `src/App.css`。
- **新增 state / ref**（`App.tsx`）：`stageSel: Set<number>`（选中 id）、`batchCopied: boolean`（复制 ✓ 反馈）、`stageSelRef`（供 Esc 闭包读最新，仿 ctxMenuRef 模式）、`stageAnchorRef`（shift 区间锚点）。
- **handleStageClick**：Ctrl/Meta → 切换单项；Shift → 以 `stageAnchorRef` 为锚 slice 区间；plain → `copyAndPaste`（原行为不变）。阶段 map 改 `(s,idx)` 传 index。
- **批量操作条**（`.stage-batch-bar`）：stageSel 非空时 sticky 顶部浮出。左侧「已选 N 项」，右侧：取走全部（disabled 非全 file）/ 复制全部（同上，~1s ✓ 反馈）/ 删除全部 / 取消。批量 file 走 `combined()` = `flatMap(items)` 合并成单 CF_HDROP；混合/文本/图片置灰。
- **Esc 优先级**：ctxMenu > stageSel 清空 > settingsOpen > hide（插入 stageSelRef 检查）。关窗（hotkey-hide）同步清空选择和 anchor。
- **已知限制**：批量取走/复制的同质-file 天花板——系统剪贴板单 payload，多文件可合并 CF_HDROP，文本/图片/混合无法合并，详见 DECISIONS §6 延伸 / CLAUDE.md 剪贴板节。
- **验证**：`tsc --noEmit` 零错误（静态✓）。T1–T9 GUI 测试清单需用户 `npm run tauri dev` 实测。
- **文件**：`src/App.tsx`（+4 state/ref +handleStageClick +Escape 插入 +hotkey-hide 复位 +JSX 批量条 +map idx +stage-item selected）/ `src/App.css`（+`.stage-item.selected` +`.stage-batch-*` 6条）/ `DECISIONS.md` §6 延伸 / `CLAUDE.md` 剪贴板节 / `MEMORY.md`。

### 2026-06-23 (历史剪贴板位图粘贴改为原图——落盘 Simple 方案，续33)
- **功能**：历史图粘贴/复制从 1024px 缩略图升级为原图（写时落盘 → 读时优先原图文件 → 失败降级缩略图）。
- **Rust**（`src-tauri/src/lib.rs`）：
  - 新增常量 `MAX_ORIG_DIM=4096`（超出则等比缩放再存）、静态 `CLIP_IMAGE_DIR: OnceLock<PathBuf>`。
  - 新函数 `save_clip_image_to_disk(img, w, h, time)`：detached thread 调用，不持任何锁；原子写 `.png.tmp → .png`。
  - `start_clipboard_monitor` 图片分支重构：`CLIPBOARD_LOCK` 只罩 `get_image()`，`drop(guard)` 后做 thumb/ahash/b64；大图（`w > MAX_THUMB_DIM || h > MAX_THUMB_DIM`）保留 `full_img`（`resize_exact` 取 `&self` 不消耗原值）；aHash dedup 判新后才 `spawn(save_clip_image_to_disk)`（防孤儿文件）；小图跳过落盘（thumbnail 即原图）。
  - `set_clipboard_image` + `copy_image_to_clipboard` 新增 `orig_path: Option<String>` 参数；文件读在锁外，`CLIPBOARD_LOCK` 只罩 `set_image` 临界区；读失败降级 base64 缩略图。
  - `load_clip_history`：加载时检查 `orig_path` 文件是否存在，不存在则去掉该字段（自愈）。
  - 新命令 `open_clip_image_dir`（`cmd /c start "" <dir>`）、`clear_clip_image_cache`（删 dir 内全部文件）。
  - setup 初始化 `clip_images/` 目录 + `CLIP_IMAGE_DIR` 写入。
- **前端**（`src/App.tsx`）：
  - `ClipItem` / `Pasteable` 加 `orig_path?: string`。
  - `clipboard-update` 监听 + 两处 `get_clipboard_history` 映射均传播 `orig_path`。
  - `copyAndPaste` 的 `set_clipboard_image` + `writeItemToClipboard` 的 `copy_image_to_clipboard` 均传 `origPath: item.orig_path ?? null`。
  - 设置面板剪贴板 tab：新增「图片原图缓存」row + 「打开文件夹」/「清空缓存」按钮 + hint 文字。
- **锁纪律静态核查（三条铁律全通过）**：① PNG 编码/文件 I/O 全在锁外；② 仅 dedup 判新后写盘；③ CLIPBOARD_LOCK 只罩 get_image/set_image 临界区。
- **验证**：`cargo check` 零警告、`tsc --noEmit` 零错误。**GUI 实测通过（用户确认）**：截图→历史卡粘贴全尺寸 ✓；小图（≤1024px 双边，约 ≤1MB）不产生缓存文件（设计如此，base64 即原图，质量无损）✓；清空缓存→降级缩略图 ✓。
- **文件**：`src-tauri/src/lib.rs`（+2 常量 +1 静态 +2 函数 +2 命令 +monitor 重构 +set/copy_image 改签名 +load_clip_history strip +setup init +handler 注册）/ `src/App.tsx`（类型 +orig_path 传播 +invoke 参数 +设置面板 UI +imgCacheCleared ✓ 反馈）/ `src/App.css`（+`.settings-action.copied` 绿色反馈样式）/ `DECISIONS.md` §6 延伸 / `MEMORY.md`。

### 2026-06-22 (剪贴板卡片长按拖拽到中转区，续30，纯前端)
- **功能**：剪贴板历史卡片新增「长按拖拽到中转区」交互，与原有「点击粘贴 / 右键菜单 / 📌 钉入」并存不冲突；顺带修长按文字泛蓝。
- **零 Rust 改动**，仅 `src/App.tsx` + `src/App.css`。
- **方案**：Pointer Events 方案 A（阈值激活）。
  - 常量 `DRAG_THRESHOLD_PX=8`（移动超此距离才激活拖拽）。
  - state `dragState`（item/origin/current/active）+ `dragStateRef`（move/up 闭包读最新）+ `dropAreaRef`（命中检测）+ `suppressClickRef`（激活后抑制随之而来的 onClick 误粘贴）。
  - 三 handler：`handleClipPointerDown`（仅左键、`.clip-actions` 内跳过、setPointerCapture）/ `handleClipPointerMove`（超阈值激活并加 `#overlay.dragging`、跟手 + `.drag-over` 高亮）/ `handleClipPointerUp`（激活且命中 drop-area → `addToStage`，不粘贴；未激活 → 放手交回 onClick 粘贴；cancel 复用此函数）。
  - 跟手克隆 `.clip-drag-ghost` 渲染为 **#overlay 兄弟节点**（避开 backdrop-filter 成为 fixed 包含块的定位陷阱，同 `launch-clone`）。
  - CSS：`#overlay.dragging{user-select:none;cursor:grabbing}` 防泛蓝；`.drop-area.drag-over` 虚线高亮；`.clip-drag-ghost`/`.clip-ghost-img` 克隆样式。
  - classList 手动 toggle 不被 React 覆盖：`#overlay`/`.drop-area` 的 className prop 在拖拽期间不变 → React 不重写 DOM.className。
- **验证**：`tsc --noEmit` 零错误（T9✓）。T1–T8 GUI 交互链路（短按粘贴/长按无副作用/超阈值激活拖拽/拖入入中转/拖外取消/无泛蓝/按钮不误触/📌右键保留）**已人工实测通过**。

### 2026-06-21 (剪贴板历史条数可配置——设置面板四档 + 持久化)
- **功能**：Settings → 剪贴板 → 「历史保存条数」新增 segmented control（10/20/50/100），选中立即生效并重启保留。
- **Rust**（`src-tauri/src/lib.rs`）：
  - `CLIP_CACHE_MAX` 常量改名为 `CLIP_CACHE_MAX_DEFAULT=20`，新增 `CLIP_CACHE_MAX_RUNTIME: AtomicUsize`（初始值同默认）。
  - `start_clipboard_monitor` 与 `load_clip_history` 中的 `truncate` 改为读 `CLIP_CACHE_MAX_RUNTIME.load(Relaxed)`。
  - 新增 `get_clip_cache_max() -> usize`：返回当前运行时上限。
  - 新增 `set_clip_cache_max(n: usize)`：clamp(10,100) → 更新 AtomicUsize → 截断 CLIP_CACHE（仅持 CLIP_CACHE 锁）→ 出锁后 `save_clip_history`（锁规则不变）。
- **前端**（`src/App.tsx`）：
  - 新增 `clipCacheMax` state（默认 20）+ `clipCacheMaxRef`（供 clipboard-update 闭包读最新值）。
  - Store 初始化读 `clip-cache-max`，有值则 invoke `set_clip_cache_max` 同步 Rust 侧。
  - `clipboard-update` listener 的 `slice(0,20)` 改为 `slice(0,clipCacheMaxRef.current)`。
  - 新增 `changeClipCacheMax(n)` callback：更新 state → 持久化 → invoke Rust → 重拉历史同步前端。
  - 设置面板 clipboard tab：「剪贴板历史」行上方加「历史保存条数」seg 控件（复用 `.seg/.seg-btn/.seg-active` 样式）；hint 文字 "20 条" 改为动态 `{clipCacheMax} 条`。
- **验证**：`cargo check` 零新增警告；`tsc --noEmit` 零错误。**GUI 实测通过（用户确认）**：T1 面板显示当前值 ✓、T2 切换到10立即截断 ✓、T3 重启设置保留 ✓、T4 新复制超限时最旧被淘汰 ✓。
- **文件**：`src-tauri/src/lib.rs`（+2 命令 +1 静态变量 +常量改名 +2 处 truncate 替换 +命令注册）/ `src/App.tsx`（+state/ref +store 初始化读取 +clipboard-update slice +changeClipCacheMax +设置面板 UI）/ `CLAUDE.md` 剪贴板节更新 / `MEMORY.md`。

### 2026-06-21 (剪贴板历史持久化，Rust 侧落盘 clip_history.json)
- **功能**：`CLIP_CACHE` 进程退出不再清空；重启后历史完整读回（含图片 base64 缩略图和文件路径条目）。
- **核心实现**（`src-tauri/src/lib.rs`）：
  - `static CLIP_HISTORY_PATH: OnceLock<PathBuf>`：setup 阶段写入一次，load/save 只读，降级时静默 no-op。
  - `load_clip_history()`：setup 中、`start_clipboard_monitor` 之前调用；解析失败则备份 `.corrupt.<ts>` + 空历史启动，不 panic。
  - `save_clip_history(snapshot: Vec<Value>)`：接快照入参，自身不持任何锁；原子写（tmp → rename）；磁盘错误 `eprintln!` 不传播。
  - 三处调用点：① monitor 线程 `cache.truncate` 后 `clone+drop(cache)` 出锁再 save；② `delete_clipboard_item` 出锁后 save；③ `clear_clipboard_history` 出锁后 save 空快照。
- **锁规则（硬约束）**：落盘 I/O 绝不进 `CLIPBOARD_LOCK`；save 调用点必须在 `CLIP_CACHE` 锁与 `CLIPBOARD_LOCK` 双双释放后（防重入死锁）。已写入 CLAUDE.md 铁律。
- **验证**：`cargo check` 零新增警告；`cargo clippy` 8 条基线不变。**GUI 实测通过（用户确认）**：重启后历史完整读回，行为符合预期，无新 bug。
- **文件**：`src-tauri/src/lib.rs`（+2 函数 +1 静态变量 +3 处 save 调用点 +setup 路径初始化）；`DECISIONS.md` §6 延伸；`CLAUDE.md` 剪贴板节补持久化铁律；`MEMORY.md` §0 更新。前端零改动。

### 2026-06-21 (bug 修复：粘贴后剪贴板卡片跳顶——三类型全修)
- **根因**：监听线程的「锁后补检」只验 `SKIP_CLIP_UNTIL_SEQ` 水位，不验 `SKIP_CLIP_EVENTS` 计数。`set_clipboard_image`/`set_clipboard_files` 用的是写前计数（`store(2)`），存在竞态：监听线程已以 SKIP=0 通过锁前检查 → 粘贴命令赢得锁竞争写入新 seq → 监听取锁后补检只测水位（未更新）→ 读到自写内容 → 卡片置顶。
- **修复**（共 3 行，3 处各 +1 行 `suppress_clip_until_now();`）：
  - `paste_clipboard`：写后加（已在前轮修复）
  - `set_clipboard_files`：非桌面 `write_cf_hdrop` 锁块后加
  - `set_clipboard_image`：非桌面 `cb.set_image` 锁块后加
  三路径全部与水位机制对齐；桌面分支（SHFileOperation）不碰系统剪贴板，不加。
- **验证**：`cargo check` 零新增警告。⚠️ GUI 实测（截图/文件连续粘贴、列表顺序是否稳定）待用户验证。
- **文件**：`src-tauri/src/lib.rs`（3 处 +1 行）。未碰锁粒度/焦点/热键/粘贴流程。

### 2026-06-21 (快捷入口 bug 修复：终端无响应 + 慢启动根因)
- **问题**：① 点击「终端」（wt）无任何反应；② `shell:Downloads`/`shell:Desktop`/`ms-settings:` 打开偏慢。
- **根因**：`openShortcut` 调用 `launch_app`（`ShellExecuteW`），而 ShellExecuteW 不搜索 `%LOCALAPPDATA%\Microsoft\WindowsApps`，找不到 `wt.exe`，报错被 `.catch(()=>{})` 吞掉；shell:/ms-settings: 路径经 ShellExecuteW 有 COM 初始化开销。
- **修复**：`openShortcut` 改调 `open_file`（`cmd /c start "" <target>`）——cmd.exe 自带 WindowsApps PATH，支持 wt/shell:/ms-settings:/calc 全部目标；顺带给 `open_file`/`reveal_in_explorer` 加 `CREATE_NO_WINDOW` 防开发模式 cmd 窗闪烁。
- **验证**：`cargo check` 零警告、`tsc --noEmit` 零错误。**GUI 实测通过（用户确认）**：终端/下载/桌面/设置均正常打开。
- **文件**：`src-tauri/src/lib.rs`（+`CommandExt` import / `CREATE_NO_WINDOW` 常量 / `open_file`+`reveal_in_explorer` 加 `.creation_flags`）/ `src/App.tsx`（`openShortcut` 改调 `open_file`）

### 2026-06-21 (快捷入口栏精简 + 截屏，续29)
- **需求**：精简快捷入口（去除文档/控制面板/任务管理器，补设置/截屏），截屏接 Snipping Tool 区域截图模式。
- **前端**（`src/App.tsx`）：
  - 模块级 `SHORTCUTS` const（6 项：文件管理器/下载/桌面/终端/计算器/设置；`shell:Downloads`/`shell:Desktop`/`ms-settings:` 经 ShellExecuteW 可直接处理）
  - `handleScreenshot` callback：直接 `invoke("trigger_screenshot")`，**不调 hideWorkbench()**（Rust 侧自行 hide + emit）
  - shortcut-row JSX：截屏按钮（📸）在最前，其余 `SHORTCUTS.map`
- **Rust**（`src-tauri/src/lib.rs`）：
  - 新命令 `trigger_screenshot`：`window.hide()` + `emit("hotkey-hide")` → `sleep(150ms)` → enigo `Key::Meta+Shift+S`（Press/Release 各键）+ 注册进 `generate_handler!`
  - light dismiss 安全：`hide()` 使 `is_visible()=false`，`start_focus_watch` 下次 50ms 轮询 `armed→false`，无重复 hide
  - enigo 键值：`Key::Meta`/`Key::Shift`/`Key::S` 均在 enigo 0.2.1 `keycodes.rs` 有确认，映射 VK 码（非 Unicode 文本路径）
- **验证**：`tsc --noEmit` 零错误；`cargo check` 零警告/错误。⚠️ GUI 实测（截屏流程/设置打开/下载+桌面路径）待用户验证。
- **文件**：`src/App.tsx` / `src-tauri/src/lib.rs`

### 2026-06-21 (右键菜单扩展：剪贴板历史卡片，续28)
- **功能**：`clip-block` 加 `onContextMenu`，调 `openClipCtxMenu(e, c)` 构造菜单。file 类型：打开所在目录 / 复制到剪贴板 / 钉到中转区 / 删除该条目；text/image：复制到剪贴板 / 钉到中转区 / 删除该条目。
- **复用**：`openCtxMenu` 通用工具（边界/关闭/z-index）+ 现有出口函数（`copyToClipboard`/`addToStage`/`deleteClipItem`/`reveal_in_explorer`），零 Rust 改动，零新 CSS。
- **路径防御**：`c.items?.[0]?.path` 可选链，仅 file 类型且 items 非空时才添加「打开所在目录」。
- **验证**：`tsc --noEmit` 零错误。⚠️ 三类型菜单条目正确性 + GUI 观感需用户实测。
- **文件**：`src/App.tsx`（+`openClipCtxMenu` callback + `clip-block` onContextMenu）

### 2026-06-21 (右键菜单：中转区文件条目 + 全局屏蔽系统菜单)
- **功能**：中转区条目右键弹出自定义浮层菜单（`position:fixed`，高 z-index）。file 类型：打开所在目录 / 复制到剪贴板 / 删除该项目；text/image：复制到剪贴板 / 删除该项目。其他区域全局屏蔽系统右键菜单（`onContextMenu={e=>e.preventDefault()}` 挂 `#overlay`）。
- **新 Rust 命令** `reveal_in_explorer(path)`：`cmd /c explorer.exe /select,"<path>"` — 在资源管理器中高亮选中目标文件。
- **前端扩展点**：`openCtxMenu(e, items)` 通用助手（边界检测防出屏）；各区域可独立构造 `items` 调用它实现右键菜单。
- **Esc 优先级**：context menu 开时 Esc 先关菜单（`ctxMenuRef` 同步当前 state，供 keydown 闭包无需入 deps）；菜单外 mousedown 自动关闭。
- **验证**：`tsc --noEmit` 零错误；`cargo check` 零警告/错误。⚠️ 视觉效果需 `npm run tauri dev` 实测（中转区文件条目右键 + 打开所在目录 + 复制 + 删除）。
- **文件**：`src-tauri/src/lib.rs`（+`reveal_in_explorer` 命令+注册）/ `src/App.tsx`（CtxMenu 类型+state+ref+useEffect+openCtxMenu+openStageCtxMenu+JSX）/ `src/App.css`（`.ctx-menu` + `.ctx-menu-item` 样式）

### 2026-06-21 (UI bug 修复：中转区条目溢出覆盖快捷入口)
- **根因**：`center-panel` 有 `overflow-y:auto`（可滚动容器），`drop-area` 有 `flex:1` 但无 `overflow` 约束；`stage-list` 内容超出 `drop-area` 分配高度时视觉溢出到下方 `shortcut-row`，产生重合/遮挡。
- **修复**（`src/App.css` 两行）：`center-panel` 改 `overflow:hidden`（固定高度，不整栏滚）；`drop-area` 加 `overflow-y:auto`（内容超出时内部独立滚动，快捷入口始终可见）。
- **验证**：纯 CSS 改动，零 JS 变动，`tsc --noEmit` 无需重跑（无 TS 变动）。⚠️ 视觉效果需 `npm run tauri dev` 实测（多条目中转区 + 快捷入口可见性）。

### 2026-06-21 (续27：原生拖入 drag-in 落地——先误判死胡同、spike 推翻、再实现，GUI 实测通过)
- **弯路（已纠正，留教训）**：先用「先呼出再拖」（错误变量）+ 临时 on-screen 探针测，得「红色禁止+零事件」→ 误判全屏覆盖层收不到 OLE 拖放、登记为死胡同、删了 `handleDrop`、写了 §14「废弃」。根因没查清就下了硬限制结论。
- **spike 推翻**：换正确流程「先抓住文件再呼出」+ 自注册最小 IDropTarget（`dragDropEnabled:false` 让 wry 不抢 target 槽）→ DragEnter/Drop **触发**于最深 `Chrome_RenderWidgetHostHWND`、拿到真实 CF_HDROP 路径。原失败真因＝错误变量 + wry 占槽（`AllowExternalDrop` 默认 false 拒收）。
- **Step 0 微测（定耐久策略）**：只注册祖先 `WRY_WEBVIEW`→DragEnter 零触发，证 OLE **不沿父链 walk-up**。故注册「顶层+全部子孙窗」。
- **实现**：新增 `src-tauri/src/dragdrop.rs`（windows crate `#[implement]` IDropTarget）：`OleInitialize`+`EnumChildWindows`+`RegisterDragDrop`（setup 一次）；DragEnter/Over 按 CF_HDROP 设光标；Drop 取路径 `emit("files-dropped")` 即返回（不碰剪贴板/不 hide）。前端 listen→`get_file_info`→file StageItem→入中转（复用续26 去重/置顶/持久化）+ 拖入后 `setFocus` 让 Esc 可用（无白闪）。`Cargo.toml` 加 windows features（Ole/SystemServices/Com_StructuredStorage/Graphics_Gdi/implement）+ `windows-core` 直接依赖（`#[implement]` 宏需）；`tauri.conf.json` `dragDropEnabled:false`（永久）。
- **关键回退**：曾加「每次 show 经 `run_on_main_thread` 幂等重注册」扛 webview 重建——**实测重注册产出的 target 收不到回调、破坏正常拖入**（单变量隔离：停掉即恢复），已删。代价：渲染进程重建后失效到重启（罕见，T9 已知限制）。
- **验证**：`cargo clippy` 零新增警告（基线8）、`tsc --noEmit` 零错误。**GUI 实测（用户）T1–T8 全过**：单/多文件、文件夹、混合、连续拖入（Drop 日志佐证 `Drop 4/3/2 path(s)`）、取走/Esc/light dismiss 回归。T9（渲染重建）= 已知限制未测。
- **文档**：DECISIONS §14 改写为「可行」（机制+confidence+原失败根因+教训）；CLAUDE.md💀死胡同 改为「重注册回退」条 + 标注拖入可行别误删。
- **拖出（drag-out）未做**：需 `DoDragDrop` 拖放源 FFI，更难、优先级低。
- 文件：`src-tauri/src/dragdrop.rs`(新) / `lib.rs`(mod+setup 调用) / `Cargo.toml` / `tauri.conf.json` / `src/App.tsx` / `CLAUDE.md` / `DECISIONS.md`。未碰焦点交还/热键/剪贴板锁/粘贴 dance。

### 2026-06-20 (续26：文件中转区升级为「混合条目」+ 剪贴板互导 — 阶段1，纯前端，GUI 实测通过)
- **前瞻商讨结论（用户拍板）**：① 存储=**混合条目模型**（文件存路径引用、文本/图片存内容），非真容器；② 传输通道先做简单的（剪贴板互导 + 取走粘贴），**拖拽留阶段2实测后再上**；③ 中转站与剪贴板历史**两个独立面板、互相导**（剪贴板=自动滚动传送带，中转=手动持久托盘）
- **数据模型**：新增 `StageItem`（与 `ClipItem` 同构 type/content/items/count + `id` + file 显示辅助 name/ext/isDir/size）→ 直接复用现成 `copyAndPaste`/`writeItemToClipboard` 出口。`copyAndPaste` 参数泛化为 `Pasteable` 结构类型（ClipItem 与 StageItem 都满足）
- **持久化迁移**：store key `file-list`(`string[]` 路径) → `stage-items`(异构数组)。加载优先读 `stage-items`，无则回退 `file-list` 经 `get_file_info` 迁成 file 条目（旧数据不丢；`file-list` 残留无害，load 优先新 key）
- **互导**：剪贴板卡片加 📌「钉到中转」按钮（`addToStage`，同类型同内容去重、置顶）；中转条目单击=取走（`copyAndPaste` 写回剪贴板+焦点交还+Ctrl+V，复用启动/粘贴的淡出动画）、复制按钮=只写剪贴板（`copyStageToClipboard`，独立 ✓ 反馈 `copiedStageId`）、file 额外「打开」按钮、删除
- **抽取去重**：`writeItemToClipboard(Pasteable)` 模块级助手，剪贴板 `copyToClipboard` 与中转 `copyStageToClipboard` 共用；删 `file-row` 死 CSS，加 `.stage-*` 样式
- **零 Rust 改动**：copy/paste 三类型命令全现成，不碰窗口/焦点/热键/剪贴板锁高危区
- **文件**：`src/App.tsx`（StageItem/Pasteable/STAGE_MAX + 转换助手 + stage state/操作 + 中转区&剪贴板 JSX）/ `src/App.css`（`.stage-*` + `.clip-pin-btn`）
- **验证**：`tsc --noEmit` 零错误、`vite build` 通过。**GUI 实测通过**（用户确认）：① 文字/图片/文件钉入中转、重复钉不重复；② 单击取走粘贴 + 复制按钮 ✓ 反馈；③ 重启 app 后 2 条（文字+图片缩略图）正常读回——并经 store 文件核对 `stage-items` 落盘正确、无残留 `file-list`（本机无遗留数据，迁移兜底未触发，非 bug）。⚠️ 现有拖入 `handleDrop` 读 `dataTransfer.path` 在 Tauri v2 可能失效，归阶段2诊断

### 2026-06-20 (续20：剪贴板卡片加「复制到剪贴板」按钮 — 只复制不粘贴)
- **需求**：卡片原只有删除按钮。增加「复制到剪贴板」——用户没有"立刻自动粘贴"需求时，只把历史项放进当前系统剪贴板，自行 Ctrl+V 到想去的地方（补现有整卡自动粘贴"猜目标窗口"最脆的那块）。overlay **保持打开**（可连续复制多条，Ctrl+V 出最后一条）。
- **防循环（关键设计）**：写剪贴板会触发后台监听把内容回流历史面板（文本/图片 dedup 后 `insert(0)` → 跳顶刷新时间；文件不去重 → 多出重复）。需抑制。现有计数式 `SKIP_CLIP_EVENTS` 在"保持打开连续复制"下不可靠（续2 记的残留坑：写回只 1 次 seq 跳变时 `store(2)` 残留 +1 吃掉下一次真实复制）。
- **解法：seq 水位**（新增 `SKIP_CLIP_UNTIL_SEQ: AtomicU32`）。copy_* 写后记当前 `GetClipboardSequenceNumber()` 为水位；监听加判断 `seq ≤ 水位 → 跳过`。按 seq 而非计数 → 与跳变次数/轮询时序无关，连续复制不残留、不吞后续真实复制。**additive**：现有计数机制 + 两条 paste 路径原样不动，只往监听加一条判断。
- **Rust**（`lib.rs`）：①`SKIP_CLIP_UNTIL_SEQ` + `suppress_clip_until_now()`；②监听加水位 skip；③抽 `write_cf_hdrop(paths)` 共用助手，`set_clipboard_files` 改调它（计数 `store(2)` 时机不变）；④3 新命令 `copy_text/image/files_to_clipboard`（只写、不 hide、不查前台、无桌面分支、无 Ctrl+V，写后 `suppress_clip_until_now`）+ 注册。图片写 1024px 缩略图（继承现有限制）。
- **前端**（`App.tsx`/`App.css`）：`copyToClipboard(item)` 按类型 invoke、不 hide；卡片右下角 hover 区改 `clip-actions` 容器放 复制+删除 两钮（都 stopPropagation，整卡 onClick 仍=自动粘贴）；`copiedTime` state 驱动复制钮 ~1s 变绿 ✓ 反馈。
- **验证**：`cargo clippy` 8 条历史警告、零新增；`tsc --noEmit` 零错误。✅ 文本/文件/图片复制 + 防回流 + 不吞后续，GUI 实测通过。
- 文件：`src-tauri/src/lib.rs` / `src/App.tsx` / `src/App.css`。未碰焦点/热键/粘贴流程。

### 2026-06-20 (续20-fix：图片复制 1418 并发崩 + 剪贴板互斥锁；图片粘贴目标限制澄清)
- **GUI 实测暴露真 bug**：截图「复制」失败（无 ✓、Ctrl+V 无内容）。诊断日志定位：`set_image 失败: SetClipboardData ... os error 1418（线程没有打开的剪贴板）`。**根因=并发**：`set_image` 内部先 `EmptyClipboard`（让 seq 变）→ 后台监听被自己这次写触发、抢先 `OpenClipboard` 去读 → copy 的 `SetClipboardData` 撞"剪贴板没打开"。图片必中（`set_image` 多步、窗口长），文本/文件写得快侥幸躲过。自动粘贴没事是因为它写前先 `SKIP_CLIP_EVENTS.store(2)` 让监听跳过不读。
- **修复=剪贴板互斥锁** `CLIPBOARD_LOCK: Mutex<()>`：监听的「读」(`build_clip_entry`)与 copy_* 的「写」串行，谁都不在对方持锁时 `OpenClipboard`。监听**拿锁后重读 seq + 复核水位**（copy 可能在等锁期间刚写完抬高水位）→ 防把自写 thumbnail 当新内容回读。paste 路径不入锁（靠 `SKIP_CLIP_EVENTS` 武装让监听不读），行为不变。改后 `set_image OK`、图片能粘进输入框/Word/画图。
- **图片粘贴目标限制（非 bug，已澄清）**：copy_image 放的是**位图(CF_DIB)**——只能粘进"接受图片"的目标（输入框/聊天/Word/画图）。**资源管理器文件夹、桌面只收 CF_HDROP 文件、不收位图粘贴**，故往那里 Ctrl+V 无反应，是 Windows 固有行为。自动粘贴能往桌面落图是因为它知道目标=桌面、走 `SHFileOperation` 把图存成 PNG 文件；"只复制"不知目标，只能放最通用位图。若要"复制图后能粘进文件夹/桌面成文件"需另做（见 §八）。
- 诊断日志已清。文件：`src-tauri/src/lib.rs`（+`CLIPBOARD_LOCK`，监听读加锁，copy_* 写加锁）。

### 2026-06-20 (续20-fix2：核查并统一 CLIPBOARD_LOCK 覆盖面 — paste 路径补锁)
- **背景**：续20-fix 只锁了 copy 路径；paste 三命令写剪贴板时同样在监听轮询下、1418 争用理论上存在，之前没崩只因写前 `hide()+sleep(150ms)` 错开时序——**运气非保证**。本轮先诊断后改。
- **持锁覆盖表（改前）**：监听读 ✅、copy_text/image/files ✅；**未持锁** = `paste_clipboard`(set_text)、`set_clipboard_image`(set_image 写 + 桌面分支 get_image 读)、`set_clipboard_files`(write_cf_hdrop)。桌面分支 `desktop_copy_files`(SHFileOperation) 不碰剪贴板、N/A。
- **改动**：给上述 4 处补 `CLIPBOARD_LOCK`，scope **仅罩 OpenClipboard…CloseClipboard 临界区**——经静态核对，无一跨 `sleep`/`hide`/焦点交还/`enigo` Ctrl+V（焦点交还+Ctrl+V 全在锁外）。`write_cf_hdrop` 共用 → 锁加**调用方**不进函数（防 copy 重入死锁）。桌面 SHFileOperation 不加锁。锁序无环（监听先放锁再取 CLIP_CACHE）。**改后全部剪贴板读写串行**，1418 在 copy+paste 两侧根治。
- **铁律**：CLAUDE.md 剪贴板节 +「所有剪贴板读写必须走 CLIPBOARD_LOCK、锁粒度仅限临界区」+ 症状表「写剪贴板报 1418」行；DECISIONS §6 补根因 + 锁粒度 + 监听 retry-sleep 例外。
- **验证**：`cargo clippy` 8 条历史警告、零新增、零 error；4 处锁 scope 逐个静态确认未跨 sleep/hide/焦点/Ctrl+V。⚠️ 1418 是 live app 后台线程时序竞态，**无头环境无法确定性复现**；本轮为**代码审查 + 编译 + 锁 scope 静态确认**，实际并发安全需 GUI 实测（连点多张图片卡片 copy + 背景同时有新复制触发监听）。
- 文件：`src-tauri/src/lib.rs`（paste 3 命令 + set_image 桌面读补锁）/ `CLAUDE.md` / `DECISIONS.md`。未碰焦点/热键/粘贴 dance 流程。
- **复核（续20-fix2 续）**：`set_clipboard_image` 桌面分支 get_image 读锁性质 = **A 类**——`arboard::Clipboard::new().get_image()` 走 Win32 `OpenClipboard` 读 live 系统剪贴板（base64 空=读当前图），与监听争同一句柄，加锁正确、保留（非读 CLIP_CACHE）。`cargo check` 零警告。

### 2026-06-20 (续19：set_shadow(false) 残留底部遮任务栏 — clamp 修正)
- **新问题**：续14 用 `set_shadow(false)` 去阴影后，WebView 子窗（`WRY_WEBVIEW`）填满外框（含隐形边框），底边落在 `outer.bottom`，比工作区底（任务栏顶）低约 7px → 深色 overlay 盖住任务栏顶部一条。
- **诊断（live app 写盘）**：`make_fullscreen` 末尾临时 `diag_geom` 把 work_area / outer(GetWindowRect) / WRY_WEBVIEW 屏幕矩形写 `%TEMP%\workbench_geom.txt`。实测 200% DPI：work_area bottom=1904（任务栏顶），修正后 outer & WRY_WEBVIEW bottom 均=1904，**精确贴齐**（无遮挡、无缝）。
- **修复**：新增 `clamp_window_bottom(window, work_bottom)`——`set_shadow(false)` 后量 `GetWindowRect`，`overlap = wr.bottom - work_bottom > 0` 则等量缩减 inner 高度（`set_size`，保持顶边，从底部收）。无越界则不动。运行时动态测量，无硬编码。
- **清理**：临时 `diag_geom` 已删（诊断完成）；保留 `clamp_window_bottom` 真修复 + 一条 `[fullscreen]` 日志（与既有 fullscreen 日志风格一致）。
- 验证：clippy 无新增警告（剩余 8 条为 base64/sort_by_key/FFI 命名等历史 lint，本次未碰）；live app 诊断数据确认 bottom=1904 对齐。注：geometry 已由 live app 运行时验证，但"肉眼看是否严丝合缝"未由本会话再跑 GUI。
- 文件：`src-tauri/src/lib.rs`（+`clamp_window_bottom`，`make_fullscreen` 末尾调用）；DECISIONS §5 延伸补记。

### 2026-06-20 (续18：应用排序加 last_used 时间衰减 — 近期常用)
- **解决续16 遗留的纯 count 局限**（远古高频 app 永占顶）。模型：**频率为主 × 近期乘数**——`usageScore = count × 0.5^(距上次使用 / 半衰期)`，半衰期常量 `USAGE_HALFLIFE_S = 30 天`（要调近期敏感度改它）。用户在 频率为主/近期为主(EMA) 两模型 + 7/30/90 天里选了 频率为主 + 30 天。
- **数据迁移**（`App.tsx`）：`app-frequency` 由 `Record<string,number>` → `Record<string,{count,last_used}>`（last_used=Unix 秒）。加载时兼容旧格式：遇 number 迁成 `{count:n, last_used:当前时间}`，不丢历史排序。
- **改动点**：`usageScore` 组件外助手；`appFreq`→`appUsage` state 重命名；`recordUse` 同时自增 count + 写 last_used；`sortedApps` 与 `filteredApps` 同分兜底改用 `usageScore`（memo 内取 `nowS`）。
- 纯前端、零 Rust 改动。`tsc --noEmit` 零错误。实测排序正常、旧数据迁移不丢。注：30 天半衰期下衰减是长期行为，短时肉眼无差异（预期）。
- 文件：`src/App.tsx`（+`AppUsage` +`USAGE_HALFLIFE_S` +`usageScore` + 迁移/记录/排序改造）

### 2026-06-20 (续17：应用搜索升级 — 模糊匹配 + 相关度排序 + 命中高亮 + Tab 导航)
- **从 includes 子串升级为子序列打分器**（`App.tsx` 组件外 `fuzzyScore`）：统一解决模糊（非连续、容错，`vscde`→VS Code）+ 缩写（词首加分使 `vsc`→Visual Studio Code 自然涌现）。打分维度：完全子串最高分(+前缀)、词首/连续/靠前加分。返回 `score` + `ranges`(命中区间)。
- **filteredApps 重构**：单 memo 统一输出 `{app, ranges}[]`（合并 spec 的 filteredApps/displayApps 两套结构，避免渲染侧双类型）。有查询：name 主、path basename 降权(×0.6)取较高分，按 相关度→频率→字母 排序，阈值 score>0 淘汰，上限 200。空查询：频率序、ranges 空。
- **命中高亮**：`HighlightText` 组件按 ranges 加粗匹配字符，色 `var(--accent,#60a5fa)`。注：贪心子序列，高亮取首个匹配位（`vsc` 高亮 viSual 的 s 非 studio），匹配/排名正确，仅高亮非最优对齐——按 spec 不上更重对齐算法。
- **键盘导航**：新增 Tab=下一个 / Shift+Tab=上一个（取模循环，区别于方向键的 clamp）；`preventDefault` 防 Tab 移焦出搜索框。Enter 取 `filteredApps[idx].app`。
- 纯前端、零 Rust 改动。`tsc --noEmit` 零错误。实测 vsc/ps/chrome/vscde/空查询/Enter/方向键/Tab 全通过。
- 文件：`src/App.tsx`（+`fuzzyScore` +`HighlightText` +filteredApps 重构 +Tab 键）

### 2026-06-20 (续16：应用使用频率排序 — 响应式)
- **背景**：需求是"常用 app 自动浮前"。诊断发现该功能**已基本存在**——`appFreq`(path-keyed count) + `recordUse(path)` + 持久化到 `workbench-data.json/app-frequency`，`launchApp` 已在调用。唯一缺陷：排序只在首次扫描那一次发生（`loadedRef` 守卫挡重扫），`filteredApps` 又不依赖 `appFreq` → 刚用过的 app 下次打开不浮上来。
- **实现**（仅 `src/App.tsx` 两处）：① 删掉扫描时的一次性 `list.sort`；② 新增 `sortedApps`（`useMemo` 依赖 `[apps, appFreq]`，频率降序、同频按 `name.localeCompare` 兜底），`filteredApps` 改基于 `sortedApps`。**零 Rust 改动、不新建 store、沿用已积累计数。**
- **偏离参考 spec**：spec 建议新建 Rust 命令 `record_app_launch`/`get_app_usage` + 新 store `app_data.json`(name-keyed) + last_used。判定为**重复造并行系统**（与现有 path-keyed 并存两套真相、name 作 key 不如 path 唯一、last_used 排序未用属死数据、丢失旧计数），故弃用，改为复用现有按 path 的系统。用户已确认此方向。
- **实测**：启动靠后 app 3 次 → 浮到最前；重启后排序保留；搜索过滤基于排序列表。`tsc --noEmit` 零错误，无 Rust 改动。

### 2026-06-19 (续15：light dismiss — 点外部应用自动隐藏)
- **需求**：overlay 显示时用户操作别的应用（点任务栏/点别处窗口/Alt+Tab）应自动隐藏，免再按快捷键（Win11 flyout 行为）。因 alwaysOnTop+全屏，没自动隐藏时别的应用拿到焦点也被盖住看不见——可用性前提。
- **实现**（`src-tauri/src/lib.rs`）：新增 `start_focus_watch` 后台线程，`FOCUS_POLL_MS=50ms` 轮询 `GetForegroundWindow`；前台切到别的真实窗口（`fg!=0 && fg!=本窗口`）→ `hide()+emit("hotkey-hide")`。
- **arm-after-focus 状态机**（防呼出瞬间误关）：不可见→disarm；前台==本窗口→arm；已 arm 且前台变了→关。set_focus 未落地前不会误关，彻底失败则永不乱关（降级）。
- **选型**：轮询前台而非 `WindowEvent::Focused` 事件（事件在 set_focus dance 里抖动）；不让前端 blur 管 hide（铁律）。HWND 只比较 `.0 as isize` 指针整数，避开 windows-core 版本 trait 冲突，无需重引 `raw-window-handle`。
- **实测**：场景 1（点任务栏）/2（Alt+Tab）生效；3（点窗口内部）/4（反复呼出）/5（长按 momentary）/6（点项粘贴）均无误关。`cargo check` 零警告。
- **文档**：DECISIONS §12 新增；CLAUDE.md 全局热键节补 light dismiss 条。
- 文件：`src-tauri/src/lib.rs`（+`FOCUS_POLL_MS` 常量 +`start_focus_watch` +setup 调用）

### 2026-06-19 (续14：去阴影 + 底部蓝缝 — 真实根因，supersedes 续12/13)
- **真相**：续12 的 `disable_shadow`（`DWMWA_NCRENDERING_POLICY=DISABLED`）才是蓝缝元凶——禁用透明 wry 窗的非客户区渲染会在底边自画一条实色蓝边。续13 的 accent 假设、Plan B 全部证伪并已撤回。
- **正确修复**：去阴影改用 Tauri 官方 `window.set_shadow(false)`（`make_fullscreen` 末尾）。一行：阴影消、蓝缝无、透明完好、全屏正常。**禁用 `NCRENDERING_POLICY=DISABLED` 去阴影。**
- **决定性诊断**：单变量关掉 `disable_shadow` → 缝消失+阴影回归 → 锁定自己加的改动即元凶。教训：改动后冒出的新问题先怀疑那个改动本身（绕了 8 条死路才回头查）。完整死路清单见 DECISIONS §5 延伸。
- **清理**：删 `disable_shadow`/`fix_webview_gap`/`align_bottom_to_workarea`/`diag_*` 全部诊断与中间实现；撤 Plan B（`make_fullscreen` 高度回到工作区 `h`、`App.css` 回 `bottom:0`、`App.tsx` 删 `--work-area-h`）；移除 `raw-window-handle` 依赖 + `Win32_Graphics_Dwm`/`Win32_Graphics_Gdi` feature。`cargo check` 零警告。
- 文件：`src-tauri/src/lib.rs` / `src-tauri/Cargo.toml` / `src/App.tsx` / `src/App.css` / `DECISIONS.md` / `CLAUDE.md`

### ~~2026-06-19 (续13：Plan B 窗口延伸到全屏高)~~ —— 已废弃，见续14（accent 假设错误，已整体撤回）

### ~~2026-06-19 (续12：disable_shadow 去阴影)~~ —— 已废弃，见续14（NCRENDERING_POLICY=DISABLED 即蓝缝元凶，已删，改用 set_shadow(false)）

### 2026-06-18 (续11：长按热键转正 — GetAsyncKeyState 键态轮询)
- **历史死胡同破解**：长按 Ctrl+Space（按住显示/松开关闭）之前 rdev/WH_KEYBOARD_LL/RegisterHotKey 时长判定全失败，根因是"按键经 hook/消息队列、被焦点抢占或 500-800ms 抖动"。换信号源——`GetAsyncKeyState` 读物理键电平（不经队列、与焦点无关）——做成了
- **验证流程**：隔离 spike（env 门控 `73046e3` → 默认激活 `708939d` → 混合语义 `8dfea37`）→ 真机实测松开沿零丢失/MSB 无抖动/tap≤153ms vs hold≥583ms 清晰可分 → 转正
- **转正实现**（`src-tauri/src/lib.rs`）：
  - `start_hotkey_monitor`（后台线程 25ms 轮询 `GetAsyncKeyState(VK_CONTROL/VK_SPACE)` MSB 边沿检测）驱动 show/hide
  - 混合语义：长按>`HOTKEY_TAP_MAX_MS`(250ms)=momentary（按下开/松开关）；短按=toggle（按下沿开/松开不关/下次短按才关，用 `visible_at_press` 区分开关态）
  - RegisterHotKey 降级为**空 handler 仅消费 Ctrl+Space**（防漏键给前台 IME/补全）；删除旧 toggle handler + `LAST_PRESS_MS`/`HOTKEY_DEBOUNCE_MS`/`AtomicI64`/`ShortcutState`
  - 新增常量 `HOTKEY_POLL_MS`/`HOTKEY_TAP_MAX_MS`（顶部命名常量，调灵敏度改这两个）
- **文档**：CLAUDE.md 全局热键节 + 死胡同节重写；DECISIONS §1/§2 改写并并入 spike 实测数据；临时 `SPIKE-keystate.md` 已删除
- `cargo check` 零警告。show/hide 复用 §8 路径配方，未改焦点交还/粘贴流程

### 2026-06-20 (续25：短按 toggle 关闭也走快速淡出 — 已实现又回退，留作死胡同教训)
- **做了什么**：曾在 `start_hotkey_monitor` 加 `dismiss_fade`（emit `hotkey-dismiss`→前端淡出→后台线程延迟 200ms 再 `hide()`）+ `HIDE_GEN` 代际守卫防重开竞态，让短按 toggle 关闭也淡出
- **为何回退（用户实测）**：连续短按有概率「热键失灵 / 开关不灵敏」。**根因是架构性冲突**：toggle 的开/关判定靠按下沿采样 `window.is_visible()`；但淡出延迟 hide 让窗口**多可见 200ms**，淡出期间 `is_visible()` 仍为 true → 连续短按时本想「开」的那次被误判成「关」、又排一个延迟 hide，`visible_at_press` 与用户意图错位。要修得在热键循环再加 `CLOSING` 状态机区分「真开/淡出中」——往最高危且无法 GUI 自测的路径继续堆并发状态，违反铁律「死胡同信号果断回退、不打补丁硬撑」
- **教训（已写入 CLAUDE.md 铁律）**：淡出只适用于**前端点击驱动**的关闭（启动/粘贴，JS 掌控时序）；**键态轮询驱动**的热键关闭别加淡出（破坏 is_visible 即时采样）
- **回退范围**：`lib.rs`（删 `dismiss_fade`/`HIDE_GEN`/`DISMISS_FADE_MS`，toggle 关闭恢复 `hide()`，show 去掉 bump）；`App.tsx`（删 `hotkey-dismiss` 监听 + cleanup，`hotkey-show` 恢复）；CLAUDE.md 热键铁律恢复原文 + 加死胡同警示。**续24 的启动/粘贴淡出与 `dismissing` 状态保留不动**
- 回退后 `tsc` + `cargo check` 通过，无残留引用

### 2026-06-20 (续24：剪贴板粘贴消失动画统一为启动式快速淡出 — 已实测通过)
- **需求**：用户更喜欢应用启动那种「快速淡出露桌面」，要求剪贴板点击粘贴的消失动画全部替换为同款
- **根因**：启动 = 先淡出 200ms 再 Rust hide；剪贴板粘贴命令一进来就 `window.hide()` 瞬隐（无淡出）→ 观感不一致
- **改法（纯前端，不改粘贴语义）**：把「淡出」从启动专属抽成共享 `dismissing` 状态（CSS `.overlay-simple.launching`→`.dismissing`，启动与粘贴共用）。`copyAndPaste` 改为：先 `setDismissing(true)` 播 200ms 淡出 → 再 invoke 三类粘贴命令（命令内部 hide+交还焦点+Ctrl+V 流程**完全不变**）。启动 `launchApp` 同步加 `setDismissing(true)`
- **复位**：粘贴命令不发 `hotkey-hide`，故 setTimeout 内 `finally` 手动复位 `dismissing`/`launchingRef`（窗口已隐藏，不可见）；启动仍靠 `hotkey-hide` 监听复位（监听也补了 `setDismissing(false)`）
- **新增守卫**：延迟 200ms 引入「点完按 Esc 反悔」窗口 → setTimeout 内 `if(!launchingRef.current)return` 放弃粘贴；`launchingRef` 现为启动+粘贴共用防连点锁
- **顺带**：图片粘贴去掉冗余的二次 `hideWorkbench()`（`set_clipboard_image` 内部已 hide），与文本/文件路径一致
- 文件：`src/App.tsx`（`dismissing` state + `launchApp`/`copyAndPaste`/`hotkey-hide` 改）、`src/App.css`（类重命名）。`tsc`+`vite build` 通过；⚠️ 观感与「Esc 反悔不粘贴」**未真跑 GUI**，需 `npm run tauri dev` 实测
- 未碰 Rust 粘贴命令/焦点交还/热键/窗口几何

### 2026-06-20 (续23：应用启动「放大暂留」动画 — GUI 实测通过)
- **已落地**：路线 B 克隆浮层 + 克制档 scale1.4/200ms。`tsc --noEmit` + `vite build` 通过；**用户 GUI 实测：效果符合预期，未发现 bug**
- **实现位置**：`src/App.tsx`——`LAUNCH_ANIM_MS=200`/`LaunchAnim` 类型（组件外）；`launchAnim` state + `launchingRef`（防连点）；`launchApp(app, iconEl?)` 改写（量 rect→立即 invoke launch_app→setLaunchAnim→延迟 hide；reduced-motion 或无 iconEl 走即时 hide 兜底）；`hotkey-hide` 监听复位；点击/Enter 两处传图标元素；return 包 fragment、`#overlay` 兄弟渲染 `.launch-clone`。`src/App.css`——`.overlay-simple.launching{opacity:0;transition:200ms}` + `.launch-clone` + `@keyframes launch-pop`
- ⚠️ **CSS 200ms 与 JS `LAUNCH_ANIM_MS` 两处需同步**（CSS 不能引 JS 常量）；改时长要同时改
- **目标**：点击应用后，图标做短暂放大+淡出（Mac 启动台式），覆盖层整体淡出露桌面，暗示刚启动了什么
- **路线（已选 B）**：克隆图标到顶层 `position:fixed` 浮层做动画——避开 `.app-grid`(overflow-y:auto)/`.app-panel`/`.main-area`(overflow:hidden) 的裁剪。路线 A「就地 transform」被否（靠边图标会被裁切打折）
- **参数（已选克制档）**：`scale 1.0→1.4`，时长 `LAUNCH_ANIM_MS=200`（命名常量，可调）
- **实现要点（纯前端，不动 Rust/tauri.conf/show 路径/焦点交还/热键）**：
  - state `launchingPath` + 克隆数据（图标 src + `getBoundingClientRect()` 屏幕 rect）
  - `launchApp` 改：先量 rect → **立即** invoke `launch_app`（app 照常秒开，不拖慢）→ 渲染顶层克隆 + keyframes(scale+淡出) + `.main-area/.top-bar/.bottom-bar` 整体淡出 → `setTimeout(hideWorkbench, 200)`
  - 复位：`hotkey-hide` 监听里清 `launchingPath`/克隆（窗口已隐藏后复位 → 下次呼出干净、无白闪/残留）
  - 防护：`launchingPath` 非空忽略连点；`prefers-reduced-motion` 跳动画直接 hide；Enter 启动复用同逻辑
- **铁律核对**：不违反「绝不让前端管 hide」——可见性真相仍归 Rust，仅把已有 `hideWorkbench()` invoke **刻意延迟 200ms** 播动画；区别于铁律所指的「IPC/blur 意外延迟」。建码时注释写清
- **待实现时观察的风险**：启动 app 若 200ms 内抢前台 → `start_focus_watch` 提前 hide 截断动画（非 bug，效果略短）
- **改动文件（实现时）**：`src/App.tsx`（state+常量+`launchApp` 改写+克隆浮层+`hotkey-hide` 复位+tile 挂 `data-path`）/ `src/App.css`（keyframes+克隆/淡出样式）

### 2026-06-20 (续22：悬停提示 — 应用「单击打开」/ 剪贴板卡片「单击左键粘贴」)
- 应用卡片 `app-tile` 加原生 `title="单击打开"`（原先无提示）；剪贴板卡片 `clip-block` 文案 `点击粘贴/点击粘贴文件/点击复制` → `单击左键粘贴/单击左键粘贴文件/单击左键复制`（image 实为写入剪贴板不自动粘贴，文案保留「复制」不假装）
- 用原生 `title` 属性（与剪贴板卡片既有做法一致，零风险，未碰窗口/焦点）。⚠️ 原生 tooltip 有 ~0.5–1s 延迟 + OS 样式；若要即时/贴主题的自定义气泡需另做组件
- 文件：`src/App.tsx`（两处 JSX `title`）。`tsc --noEmit` 零错误，GUI 观感未真跑

### 2026-06-20 (续21：设置面板改左右分栏 — 条目导航 + 详情)
- **布局重构**：原单列分段（外观/通用/关于）→ 左侧条目导航 + 右侧详情面板。条目由模块级常量 `SETTINGS_TABS`（id/icon/label）驱动，`settingsTab` state 控制选中（默认 `general`），后续扩条目只改这个数组 + 加一段面板 JSX
- **条目（4 项，可扩展）**：① 常规 = 背景主题 ② 剪贴板 = 历史条数 + 清空 + 说明 ③ 快捷键 = 当前键位一览（暂只读，标注后续可配置）④ 关于 = 版本 + 简介。功能逻辑（changeTheme/clearClipboard）原样复用，未改行为
- **CSS**：`.settings-modal` 改 flex 列 + 固定高 460px；新增 `.settings-layout/.settings-nav/.settings-nav-item/.settings-panel/.settings-panel-title/.settings-hint`；删除废弃 `.settings-body/.settings-section-label`
- 文件：`src/App.tsx`（+`SETTINGS_TABS`/`SettingsTab` 类型 + `settingsTab` state + 模态 JSX 重写）/ `src/App.css`（模态两栏样式）
- **验证**：`tsc --noEmit` 零错误。⚠️ 视觉/交互**未真跑 GUI**（无头环境），需 `npm run tauri dev` 实测条目切换观感
- 未触碰窗口/焦点/热键/剪贴板/粘贴流程

### 2026-06-18 (续10：设置面板 + 背景主题深色/浅色/系统)
- **新功能**：顶栏右侧齿轮图标 → 居中模态设置面板（Esc / 点遮罩关闭，设置打开时屏蔽应用导航键）
- **背景主题**：深色 / 浅色 / 系统默认。CSS 把散落的白色系 `rgba(255,255,255,*)` 表面填充收敛为变量 `--fill-1/--fill-2`，新增 `[data-theme="light"]` 覆盖配色变量（置于 `:root` 之后取胜）；前端 `theme` state 解析为 `data-theme` 属性挂到 `<html>`，"系统"用 `matchMedia('(prefers-color-scheme: dark)')` 跟随 OS 并实时响应切换；持久化到 store key `theme`
- **设置项**：① 背景主题 segmented 控件 ② 清空剪贴板历史（新增 Rust 命令 `clear_clipboard_history` 清空 CLIP_CACHE + 前端 state）③ 关于/版本（v0.1.0 + 热键提示）
- 未纳入（本轮用户未选）：开机自启开关、清空文件中转区
- 文件：`src-tauri/src/lib.rs`（+`clear_clipboard_history` 命令及注册）/ `src/App.tsx`（theme/settingsOpen state + 主题 effect + changeTheme/clearClipboard + 齿轮按钮 + 模态 JSX + Esc 分流）/ `src/App.css`（`--fill-*` 变量 + light 主题块 + 设置/模态样式）
- **验证**：`tsc --noEmit` 零错误、`cargo check` 零警告。⚠️ 主题视觉效果与模态交互**未真跑 GUI**（无头环境无法驱动）；逻辑与编译已确认，需 `npm run tauri dev` 实测浅色配色观感 + 主题切换 + 清空按钮
- 未触碰窗口/焦点/热键/粘贴流程

### 2026-06-18 (续9：去除图标快捷方式箭头 overlay — 已验证)
- **失败尝试**：`SHGFI_ICONLOCATION + ExtractIconExW`——66% 应用的 `szDisplayName` 为空（数据：`nosrc=124/188`），大量走 fallback，基本无效
- **正确方案**：`SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SYSICONINDEX` 取系统图像列表句柄 himl，再 `ImageList_GetIcon(himl, shfi.iIcon, ILD_NORMAL)` 取 base icon。系统图像列表存无 overlay 的原始图标，overlay 是 Shell 绘制时叠加的，`ILD_NORMAL(0)` 不含 overlay mask
- **实测数据**：改后 `clean=188 fallback=0`（100% 覆盖），用户确认箭头消失
- 文件：`src-tauri/src/apps.rs`（comctl32 FFI `ImageList_GetIcon` + 重写 `extract_icon_base64`）

### 2026-06-18 (续8：应用面板扩容 + 显示上限)
- app-panel 宽 320→600px，grid 4列→6列，GRID_COLS=6
- filteredApps slice 24→200，188 个应用全部可滚动浏览
- center-panel min-width 0→200px（避免被挤没）
- 清除所有诊断日志（`ICON_LOG_ONCE`/`HICON_DIAG_DONE` 及对应 println!）
- 文件：`src/App.tsx` / `src/App.css` / `src-tauri/src/apps.rs`

### 2026-06-18 (续7：图标全黑/首字母根因修复)
- **根因**：`hicon_to_png` 第一次调用 `GetDIBits(cLines=0, lpvBits=NULL)` 是"查询尺寸"模式，此模式返回值**永远是 0**（表示复制了 0 行，不代表失败）。旧代码检查 `ret == 0` 就直接 return None，导致所有图标被丢弃
- **修复**：去掉第一次 GetDIBits 的 `|| ret == 0` 判断，只保留 `width <= 0 || height <= 0`
- 诊断路径：日志显示 `ret=1 hIcon=38209677`（SHGetFileInfoW 成功）但 `0 with icons`，定位到 hicon_to_png 内部
- 文件：`src-tauri/src/apps.rs`；`cargo check` 零警告

### 2026-06-18 (续6：应用扫描重写 — 图标/数量/过滤/去重)
- **根因**：`parselnk.relative_path()` 返回相对路径 → `ExtractIconExW` 找不到文件 → 图标全 None；`take(30)` 限制导致应用极少；无过滤逻辑
- **修复**：
  - 图标：改用 `SHGetFileInfoW(lnk路径, SHGFI_ICON|SHGFI_LARGEICON)`，Shell API 自动解析 .lnk 目标，无需手动 resolve
  - 启动：改用 `ShellExecuteW`（替代 `Command::new`），直接支持 .lnk + .exe + 系统命令
  - 扫描：去掉 30 条限制，上限 400；新增当前用户桌面+公共桌面扫描源
  - 过滤：`SKIP_KEYWORDS` 常量（uninstall/help/readme/release notes 等 14 个关键词）
  - 去重：按名称小写 HashSet，All Users 优先（先扫）
  - hicon_to_png：`biHeight` 改负数（top-down），避免图像上下翻转
  - 移除 `parselnk = "0.1"` 依赖（不再使用）
- 文件：`src-tauri/src/apps.rs`（完全重写）/ `Cargo.toml`（删 parselnk）；`cargo check` 零警告

### 2026-06-18 (续5：应用启动器改图标宫格)
- **重构**：应用启动器从竖列（24px 图标+单行名）改为 4 列宫格（48px 图标+2 行名称居中）
- **CSS**：删旧 `.app-list/.app-row/.app-icon-sm/.app-name-text`，加 `.app-grid/.app-tile/.app-tile-icon/.app-tile-label`；grid 用 `repeat(4,1fr)+gap:4px`
- **键盘导航**：ArrowUp/Down 改为跨行（步长 GRID_COLS=4），加 ArrowLeft/Right 横向导航
- **交互**：单击打开+消失（`launchApp` 不变），悬停/selected 高亮不变
- 文件：`src/App.tsx` / `src/App.css`；`tsc --noEmit` 零错误；GUI 需真跑确认图标渲染效果

### 2026-06-18 (续4：剪贴板条目删除)
- **功能**：剪贴板历史区每个条目悬停时右上角显示 `×` 按钮，点击删除该条目（前端 state + Rust 后台缓存同步移除）
- **实现**：Rust 新增 `delete_clipboard_item(time: i64)` 命令，按 `time` 字段从 `CLIP_CACHE` 中 `retain` 过滤；前端 `deleteClipItem` 先乐观更新 state，再异步调用命令；CSS 新增 `clip-del-btn` 绝对定位，复用 `rm-btn` 悬停显示模式
- 文件：`src-tauri/src/lib.rs`（新增命令+注册）/ `src/App.tsx`（deleteClipItem + 按钮）/ `src/App.css`（clip-del-btn 样式）
- `cargo check` 零警告，`tsc --noEmit` 零错误；GUI 链路未真跑

### 2026-06-18 (续3：快速连复制采样塌缩)
- **Bug**：连续快速复制两个文件，少一个进历史。根因 ≠ 续2 的锁定问题——是**轮询采样塌缩**：两次复制落在同一 800ms 窗口内，醒来只读到后者，前者内容已被覆盖、不可恢复
- **修复（用户选"提速轮询"）**：`CLIP_POLL_MS` 800→150ms。改一个常量、零新架构。手动连复制（两次通常 >300ms）基本不丢；seq 检查 µs 级，提频近乎零成本
- **残留**：<150ms 的脚本级超快连发仍可能塌缩。彻底根治需事件驱动（`AddClipboardFormatListener`+`WM_CLIPBOARDUPDATE`），代价是 message-only 窗口+线程消息循环（DECISIONS §1 风险区），用户暂选不上
- 文件：`src-tauri/src/lib.rs`（仅常量）；根因记于 `DECISIONS.md §6`。⚠️ `CLIP_POLL_MS` 别再调大

### 2026-06-18 (续2：快速复制丢条目修复)
- **Bug**：快速复制时偶发"复制后剪贴板不显示该条目"。根因——`start_clipboard_monitor` 在检测到 seq 变化后立刻推进 `last_seq`，再读内容；源程序短暂锁剪贴板导致读取 `continue`，但 seq 已消费，下轮不再重试 → 条目永久丢失
- **修复**：抽 `build_clip_entry() -> Result<Option,()>` 三态；`Ok(Some)`=读到→推进+缓存、`Ok(None)`=可访问但空→推进、`Err(())`=被占用→本轮重试 `CLIP_READ_RETRIES`(4) 次×`CLIP_READ_RETRY_MS`(60ms)，仍失败则**不推进 last_seq**、下个轮询周期重试。写回跳过(SKIP)路径照常推进
- 文件：`src-tauri/src/lib.rs`；根因记于 `DECISIONS.md §6`
- **未真跑验证**（时序竞态只在 live app 后台线程发生，无法在无头环境确定性复现）；逻辑推演 + cargo check 零警告。可复现验证：连续快速复制多条看是否全进历史
- **相关未修**：`SKIP_CLIP_EVENTS` 计数若写回实际只触发 1 次 seq 变化、残留的 +1 可能吃掉紧随其后的一次真实复制（粘贴后立刻复制的边缘场景，与本次快速复制不同源）——暂记录，未处理

### 2026-06-18 (续：重构清理)
- **死代码/死依赖**：删除孤儿文件 `hotkey.rs`（已废弃的 WH_KEYBOARD_LL 钩子方案，无 `mod` 声明从不编译）+ 移除其唯一引用的 `once_cell` 依赖；删除前端零调用的死命令 `read_clipboard`/`read_clipboard_text`（轮询早已迁至 Rust 后台）
- **编译警告**：FFI 镜像结构体（`SHFILEOPSTRUCTW_RAW`/`ICONINFO`/`BITMAPINFOHEADER`）加 `#[allow(non_snake_case)]`，消除 23 条警告
- **去重**：抽 `image_to_cache_entry` helper，消除后台监听里重复两次的图片处理块；魔法数字提为常量（`CLIP_POLL_MS`/`CLIP_CACHE_MAX`/`MAX_THUMB_DIM`/`AHASH_*`/`HOTKEY_DEBOUNCE_MS`）
- **前端**：底栏热键提示 `Alt+F1`→`Ctrl+Space`（显示 Bug）；删 10 处 `[frontend]` 调试日志 + 残留 `visibleRef` + 诊断 useEffect
- **文档**：§六 删除不存在的 `notify_hidden` 命令及已删的 read_clipboard 两条；§八 删去已修复的"Esc 偶尔不生效"
- 未触碰焦点交还/Ctrl+V 粘贴流程。`cargo check` 零警告、`tsc --noEmit` 通过

### 2026-06-18
- **桌面粘贴冲突框修复**：`desktop_copy_files` 的 `fFlags` 原为 `0x40|0x0040`（注释写错，实只生效 `FOF_ALLOWUNDO`），导致桌面同名/源==目标时弹冲突框只能取消。改为 `FOF_RENAMEONCOLLISION|FOF_NOCONFIRMATION|FOF_NOCONFIRMMKDIR|FOF_NOERRORUI`（=`0x0618`，windows crate `FILEOP_FLAGS` 常量 `.0 as u16`）。`RENAMEONCOLLISION` 为承重 flag（自动改名对齐 Explorer "X (2)"）；加 `NOERRORUI` 后补 `ret`/`fAnyOperationsAborted` 日志防静默失败
- **自测**（P/Invoke SHFileOperationW，同 `fFlags=0x0618`、同裸指针双 null 缓冲）：T1 源==目标→"X - 副本.png" 无弹窗；T2 别处同名→改名共存（原+副本）；T3 连续 3 次→(2)/(3)/(4)；T5 多文件冲突→各自改名。全部 ret=0/aborted=0/零对话框。T4 图片桌面落地走单文件同路径，机制一致。GUI 点击/热键链路未改，无法在此环境模拟，仅验证 flag 语义
- 仅改 `set_clipboard_files` → `desktop_copy_files` 的 flag，未动焦点交还/Ctrl+V/文本/文件夹分支

### 2026-06-17 (续4)
- **图片桌面粘贴**：`set_clipboard_image` 补桌面检测——先 hide+sleep，检查 `GetForegroundWindow` class；WorkerW/Progman 走「PNG→临时文件→SHFileOperation→删临时文件」，非桌面保持原有剪贴板写入+Ctrl+V 流程。逻辑与 `set_clipboard_files` 完全对齐。`base64` 空（当前图）时从 arboard 读 RGBA 再编码 PNG；非空（历史图）直接解码 base64

### 2026-06-17 (续3)
- **呼出白闪修复**：`set_focus()` 触发 `WM_ACTIVATE` 导致 WebView2 激活重绘，短暂白帧。修复：emit `hotkey-show` 提前到 `window.show()` 前（前端预渲染深色 CSS），`set_focus()` 移至后台线程延迟 50ms 执行（附可见性守卫），两处 show 路径（hotkey handler + tray_toggle）同步修改

### 2026-06-17 (续2)
- **Esc 焦点回归修复（补丁）**：热键 show 路径补 `window.set_focus()`（与 `tray_toggle` 对齐，原先缺失导致热键呼出后 Esc 的 keydown 无法到达 JS）。Esc handler 改为 `setVisible(false)` + `hideWorkbench()`（即时 CSS 反馈 + Rust hide）

### 2026-06-17 (续)
- **Esc 幽灵界面修复**：Esc handler 改接 `hideWorkbench()`（invoke `hide_window`），`hide_window` 命令补 `emit("hotkey-hide")` 同步前端状态，删除诊断遗留的 `debug_window_state`

### 2026-06-17
- **图片去重（aHash）**：`compute_ahash` 8×8 灰度指纹（缩放滤镜用 `FilterType::Nearest`，单次 <1.5ms），后台缓存按「汉明距离≤5 + 尺寸±2px」判重，避免同一截图反复刷历史。entry 新增 `w/h/ahash` 字段
- **清理**：删除上次调试遗留的 `[skip]`/`[dedup]` 诊断日志、aHash 计时探针，以及桌面调研死代码（`dump_desktop_window_tree`/`find_desktop_listview`/`dump_clipboard_formats`/`enum_*`，均未被调用）
- **整体落盘**：本次连同此前未提交的「截图去重(图片优先)」「桌面 SHFileOperation 兜底」一并提交（文档 §10/§11/续/续2 此前已写但代码未 commit）。`Cargo.toml` 加 `Win32_System_Com`（`desktop_copy_files` 的 `CoTaskMemFree` 所需）
- `cargo check` 通过，无新增 dead_code/unused 警告

### 2026-06-16 (续2)
- **桌面文件粘贴兜底**：WorkerW/Progman 不接受 CF_HDROP → `desktop_copy_files` 用 SHFileOperation(FO_COPY)+SHGetKnownFolderPath(FOLDERID_Desktop) 落地
- 焦点交还铁律正式例外：桌面场景走 SHFileOperation，文件夹/CabinetWClass 仍走 Ctrl+V
- 三文档同步：DECISIONS §11、CLAUDE.md 焦点节、MEMORY.md

### 2026-06-16 (续)
- **截图去重修复**：检测优先级 文件→图片→文本 改为 图片→文件→文本。Win+Shift+S 同时写 CF_HDROP+CF_BITMAP/DIB/DIBV5，图片优先避免截图被误判为文件
- `has_clipboard_image()` 判定 BITMAP||DIB||DIBV5（非仅 CF_BITMAP）
- 三文档同步：CLAUDE.md 检测顺序 / DECISIONS.md §10 证据 / MEMORY.md

### 2026-06-16
- **文档三件套**：CLAUDE.md（铁律+协作约定）+ DECISIONS.md（10节架构决策+踩坑根因）+ MEMORY.md（现状快照）
- **CF_HDROP 文件剪贴板**：后台监听检测文件复制、DROPFILES 结构体构造写入（fWide=TRUE）、前端 file 类型渲染、多文件支持
- **修复**：fWide=FALSE 导致文件粘贴失败；跨类型去重误删（文件条目错误清除文本条目）；前端 items/count 字段丢失（两处 ClipItem 构造不完整）
- **图片粘贴延迟优化**：去除 get_image+set_image 冗余读写循环（~500ms→~50ms），历史图 base64 解码写回
- **sleep 优化**：焦点交还等待 250ms→150ms
- Git: f281f11 → a7c13b6

### 2026-06-15
- **剪贴板后台监听架构**：start_clipboard_monitor 独立线程（800ms 轮询 GetClipboardSequenceNumber），CLIP_CACHE 内存缓存，clipboard-update 事件实时推送
- **图片自动粘贴**：set_clipboard_image 焦点交还 + enigo Ctrl+V（与文本粘贴统一流程）
- **大图缩放**：>1024px 用 FilterType::Triangle 缩至 1024px，避免 IPC 传输数十MB
- **死循环防御**：SKIP_CLIP_EVENTS 计数器（AtomicI32），arboard 的 get+set 可能触发 2 次 seq 变化
- **粘贴方案最终确定**：SetForegroundWindow + enigo Key::V → 100% 成功率（6 轮方案演进）
- **Ctrl+Space 热键**定稿（Alt+F1→Ctrl+F1→Ctrl+Space）
- Git: d11bcf2 → 38df8b9 → c04585c

### 2026-06-14
- **全屏缝隙修复**：SPI_GETWORKAREA 获取工作区 + outer→inner 动态偏移补偿（200% DPI 下 13×7px 隐形边框）
- **transparent 实验**：false→true 消除 GPU 合成延迟（hide/show ~200ms→即时），CSS rgba(0.97) 补偿透度
- **50ms 防抖**：过滤 Windows key repeat 重复 Pressed 事件
- **interval 泄漏修复**：setInterval cleanup 从 IIFE 内提升到 useEffect 顶层 return
- **前端简化**：Framer Motion 动画 → opacity:0/1 条件渲染（组件不卸载）
- **长短按判定彻底放弃**：RegisterHotKey Pressed/Released 有 500-800ms 软件延迟，阈值 200/300/500ms 全失败
- **热键演进**：rdev→WH_KEYBOARD_LL→tauri-plugin-global-shortcut（RegisterHotKey）
- **项目初始化**：Tauri 2.0 + React 18 + TypeScript + Vite + Tailwind CSS，全屏窗口，系统托盘
- Git: 77de932 → 9b745de → 3508350
