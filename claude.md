# Workbench App

Windows 全屏"第二桌面"工具：热键 toggle 呼出覆盖全屏的功能界面（应用启动器 / 文件中转 / 剪贴板历史），用完优雅消失，原桌面不受影响。理念 ≈ "功能增强版的开始菜单"。

> **每次会话开始（渐进式读取，按需不贪多）**：
> ① 读 `MEMORY.md §0`（当前进度/待办/下一步）；§0A 详记只在与当前任务相关时读。
> ② 动窗口·焦点·热键·剪贴板代码前，先读完下面的【铁律】。
> ③ 需要"为什么"时先看 `DECISIONS.md` 顶部目录的一行摘要，只读相关 §，不整读。
> ④ `HISTORY.md` 是历史归档，**默认不读**；考古时用 Grep 按「续N」/关键词定位。
> 本文件只放结论与硬规则，根因一律在 DECISIONS.md。

## Agent 入口约定
- 本文件是**唯一** agent 规则入口，任何 AI 编码助手（Claude Code / Antigravity / Codex 等）均以本文件为准。`AGENTS.md` 仅作路由指针（引导 agent 预读本文件），**不含独立规则，不要在其中添加规则**。
- Windows PowerShell 读取中文文档时显式 UTF-8（例如 `Get-Content -Encoding utf8`），避免乱码导致误判。
- 默认先诊断再修改：先读相关代码 / 日志 / 决策记录，确认根因后再动手；窗口、焦点、热键、剪贴板属于最高危区，必须按下方铁律逐条对照。
- 可验证的改动要自己跑验证；GUI 无法真实驱动时必须明说，并至少跑可复现的核心逻辑或静态检查。
- 完成开发任务前必须更新 `MEMORY.md`，规则见文末【强制记忆更新与文档维护】。
- Git 提交按用户意图执行：用户要求提交时，每到稳定点及时 commit；用户未要求时，完成验证后汇报建议提交点，不擅自制造提交历史。版本号提交见下方【版本号规则】——它是这条铁律的一个例外授权，别把该例外泛化到其他提交场景。

## 版本号规则（SemVer `MAJOR.MINOR.PATCH`，续85 起生效）
> 与 `MEMORY.md`/`HISTORY.md` 的「续N」会话计数是**两套独立编号**，互不对应：续N 每次开发会话都会涨，版本号只在真正达到 MINOR/PATCH 门槛时才涨——不要假设两者同步递增。
- 三段含义：**MAJOR**=架构级里程碑（极少变）；**MINOR**=较大功能新增 / 较大范围重构或修复；**PATCH**=小功能、小修复、文档等日常改动。大小由 agent 完成任务后自行判断，判断依据在对应 commit message 里简要说明；单次改动里混有多个不同量级的变更时，按其中量级最大的那个定档（如同时有一个 MINOR 功能和一个 PATCH 修复，按 MINOR 算）。
- **版本号文件三处必须同步**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`。前端展示版本号唯一来源是 `package.json`，经 `vite.config.ts` 的 `define: __APP_VERSION__` 注入，`App.tsx` 用 `__APP_VERSION__`——**别再硬编码版本字符串**。三处是否同步有自动校验：`npm run build`（含 `npm run version:check` 单独跑）会先跑 `scripts/check-version-sync.mjs`，三处版本号不一致直接报错中止，不会静默出不一致的构建。
- **自动 bump + 提交的授权范围（例外于上面的"未要求不擅自提交"铁律，仅限版本号提交）**：用户确认某次改动已验证 / 测试通过之后，agent 可自行判断 MINOR/PATCH 幅度、bump 三处版本文件、提交为**紧跟在该功能/修复提交之后的一个独立 commit**（不强制合并进同一个 commit，参考 `9f5a01f`→`3123a6d` 的先例），**不用再单独询问"要不要顺便改版本号"**。
- **MAJOR 是例外中的例外**：永远先征得用户明确同意再改第一位数字，不得自主判断。
- Tag：默认不自动打 `git tag`；用户要求才打（同现有 git 铁律）。

## 技术栈
- Tauri 2.0（Rust 后端）+ React 18 + TypeScript + Vite + Tailwind CSS
- 目标：包体 ~5MB，内存 ~30MB
- 开发机：Win11，3200×2000，200% DPI 缩放。**很多坐标/尺寸类 bug 与高 DPI 有关，涉及窗口几何的改动务必考虑缩放系数。**

## 常用命令
```bash
npm install
npm run tauri dev      # 开发运行
npm run tauri build    # 打包
```
（脚本名以实际 package.json 为准，不一致时先查再用。）

## 项目结构
- `src-tauri/src/lib.rs` — 主逻辑（窗口全屏、热键监听/焦点 light dismiss、托盘、Tauri setup/命令注册）
- `src-tauri/src/clipboard.rs` — 剪贴板子系统（历史/粘贴/复制/janitor/监听；`clipboard::init` 封装 setup 时序）
- `src-tauri/src/apps.rs` — 应用扫描 / 图标提取（`ExtractIconEx`/`SHGetFileInfoW`）
- `src-tauri/src/dragdrop.rs` — 中转区拖入（target 侧；setup 一次性自注册 IDropTarget，详见 DECISIONS §14）
- `src-tauri/src/dragout.rs` — 中转区拖出（source 侧，与拖入正交；`DoDragDrop` 必须**主线程**跑 + hide-after，三条死胡同见 DECISIONS §18。**通用硬规则：凡用裸 Win32 改窗口可见性，事后必须用 Tauri 同操作把 tao 缓存同步回去**）。「拖出后自动关闭」两模式：`开启`=拖动即隐藏去外部；`关闭`=拖动保持界面、区内落点交自窗口 IDropTarget、去外部靠拖动中按热键手动隐藏（续84，详见 DECISIONS §18）。`start_drag_out` 带 `force_hide` 参数：区内重排中按热键升级来的拖出无视该设置强制隐藏收场（续88）
- `src-tauri/src/filesearch.rs` / `everything.rs` — 文件索引（后台预建）/ 可选 Everything 引擎（详见 DECISIONS §17）
- `src/App.tsx` — 前端
- `src-tauri/tauri.conf.json` — 窗口配置
- `DECISIONS.md` — 架构决策与踩坑根因（目录带一行摘要，按需选读）
- `MEMORY.md` — 现状快照 + 最近会话详记，**当前进度/待办/下一步以它为准**；`HISTORY.md` — 历史归档（默认不读）

---

## 铁律（违反必引发连锁 bug，动手前先读完本节）

### 窗口 / 焦点（最高危区）
- **一次只改一个焦点 / 激活 / 窗口相关的变量**。捆绑改动必出连锁 bug。
- **`tauri.conf.json` 锁定项**：`transparent:true`（改 false → 全屏+blur 走重量级 GPU 合成 → hide/show 延迟 + 空白页闪烁）和 `focus:false`（抢焦点会破坏热键）**都不能改**；其余基线 `decorations:false / alwaysOnTop:true / skipTaskbar:true / visible:false`。
- 可见性的**唯一真相是 `window.is_visible()`（Rust）**。Rust 直接 `show()/hide()`，`emit` 只用于同步前端状态。**绝不让前端管 hide**（IPC 往返延迟 → "空白页后延迟关闭"）。
- **呼出(show)路径的三条耦合约束，别"顺手简化"**（两处 show 路径——hotkey handler + tray_toggle——必须一致；由来见 DECISIONS §8）：
  ① `emit("hotkey-show")` 必须**在 `window.show()` 之前**（前端先渲染深色 CSS，否则白闪）；
  ② `set_focus()` **必须有**（否则键盘焦点不在窗口，Esc 的 keydown 到不了 JS → Esc 没反应）；
  ③ `set_focus()` 必须**延迟执行**（50ms 后台线程 + 可见性守卫；立刻调会触发 `WM_ACTIVATE` 重绘 → 白闪）。
- 关闭/粘贴的**焦点交还流程**（文本 / 图片 / 文件粘贴复用，**别改流程**；例外：桌面 WorkerW/Progman 走 SHFileOperation 落地）：
  `window.hide()` → `wait_foreground_handback`（守卫轮询到前台「既非本窗口也非 NULL」再留落定余量，超时保底继续；参数为 `clipboard.rs` 顶部 `FOCUS_HANDBACK_*` 常量）→ `GetForegroundWindow` → `SetForegroundWindow` → `enigo` 发 `Ctrl+V`。
  等待段曾是盲等 `sleep(150ms)`——**已废弃别回退**（`hide()` 是异步派发，负载高时 Ctrl+V 注入进已隐藏的自家窗口 → 偶发粘贴失败；根因见 DECISIONS §3 续80 延伸）。
- "前台窗口"与"键盘输入焦点"是两个概念——推回焦点的死路见下方【💀 死胡同】。

### 全局热键
- **show/hide 的唯一驱动 = 物理键态轮询**（`start_hotkey_monitor`，后台线程 25ms 读 `GetAsyncKeyState` 的 MSB）。**不要回退到用 `RegisterHotKey` 的 Pressed/Released 事件做 show/hide**——500-800ms 抖动（见【💀 死胡同】）。
- `RegisterHotKey`（`tauri-plugin-global-shortcut`）**仅保留用来"消费"当前组合**（handler 故意为空），防止该键漏给前台应用（IME 切换 / 编辑器补全）。**别在这个空 handler 里加 show/hide 逻辑**。
- **混合语义**：长按 = momentary（按下开、松开关）；短按 = toggle（按下沿开、下次短按才关）。调灵敏度改 `HOTKEY_TAP_MAX_MS`（=250ms 分界），调采样率改 `HOTKEY_POLL_MS`（均为 `lib.rs` 顶部常量）。
- **自定义热键**（演进见 DECISIONS §9）：轮询读静态 `HOTKEY_VK_KEYS`，注册层用 `CURRENT_SHORTCUT`；setup **同步读 store** 落地（失败兜底 Ctrl+Space，无启动空窗）。`set_hotkey` 命令做**原子注册切换**（先 register(new) 成功 → unregister(old) → 更新两静态；失败保留旧组合回滚）；**持久化由前端 store 负责，命令不写 store**。`parse_combo` 表驱动（非白名单）：blocklist **仅** win/super/meta + 裸 alt+space/alt+f4（OS 占用）；修饰键 Ctrl/Shift/Alt 均可选（含全无 = 纯主键，**会全局抢占该键**，前端已警示）；恰 1 个主键（`key_token` 表）。⚠️ **Alt 组合可用**（续46 spike 推翻旧「Alt 死路」：RegisterHotKey 消费整个组合、前台收不到 Alt → 不触发菜单栏）。录制式输入：capture 阶段抢先监听 keydown 写回文本框，再点「应用」生效；轮询循环只改 combo 检测一行、长短按判定不动。
- 按下沿开窗复用 show 路径三约束（emit→show→延迟 set_focus）；松开/短按关窗走纯 `hide()+emit("hotkey-hide")`。
  - ⚠️ **别再给热键关闭加「淡出再 hide」**（续25 试过已回退）：延迟 hide 破坏 toggle 按下沿对 `is_visible()` 的即时采样 → 连续短按误判、热键失灵。淡出仅用于前端点击驱动的关闭（启动/粘贴）。
- **Light dismiss（点外部应用自动隐藏）= 第二条 hide 驱动**（`start_focus_watch`，后台线程 50ms 轮询 `GetForegroundWindow`）。同样**轮询前台、不用 `WindowEvent::Focused` 事件**（事件在 set_focus dance 里抖动误触发）。必须走 **arm-after-focus 状态机**（前台==本窗口才布防）——否则呼出瞬间 set_focus 未落地会"开即关"。隐藏复用纯 `hide()+emit` 路径。**别让前端 `blur` 管 hide**。详见 DECISIONS §12。
- **拖动期间窗口可见性由 dragout 独占**（`DRAG_IN_PROGRESS`，续84）：拖出生命周期内热键 monitor 让路（只跟踪键态、不 toggle），否则并发操作窗口→白闪。新增窗口隐藏机制都要查是否需让路——**包括 `DRAG_IN_PROGRESS` 置位之前的阶段**：续88 中转区「区内重排」在窗口仍可见、`DRAG_IN_PROGRESS` 尚未置位时就已经是"用户正占用鼠标做拖动"的状态，light-dismiss（`start_focus_watch`）起初没查这个新阶段，会在升级为原生拖出前提前 `hide()`、打断整个手势（拖出失败 + ghost 卡死）——加 `dragout::stage_reorder_active()`，**仅 `start_focus_watch`（light-dismiss）** 查 `drag_in_progress() || stage_reorder_active()`。⚠️ **`start_hotkey_monitor` 在 `stage_reorder_active()` 期间既不让路、也不直接 hide，而是按下沿 emit `stage-drag-hotkey`**（续88 修正）：原生拖出阶段有替代者接管热键（keepOpen 自轮询线程 / 自动隐藏不需要热键），但纯 JS「区内重排」阶段无替代者——① 若让路 = 热键整段失效；② 若直接 hide = **在 DoDragDrop 起手前隐藏窗口 → SetCapture 失败 → 松手无文件落地**。故第三条路：emit 事件让前端把区内重排**升级为原生拖出**（`beginNativeDragOut(ids, forceHide=true)` → `start_drag_out(force_hide)`：窗口仍可见时先起手 `DoDragDrop`、再由 dragout 自身隐藏 overlay）。**升级交接铁律**：`STAGE_REORDER_ACTIVE` 必须**保持为真直到 `do_drag_on_main` 先置 `DRAG_IN_PROGRESS=true` 再清它**（两标志无缝交接、任一时刻至少一真，中间无空窗被 monitor/light-dismiss 钻空提前 hide）——故 `cancelStageReorder` **只清 JS 现场、不碰该标志**，升级路径交给 Rust 清、非升级终止（commit / lost-capture）由调用点显式清。详见 DECISIONS §18 续84 / 续88。

### 剪贴板
> 可调数值（轮询间隔 / 缩略图尺寸 / aHash 阈值等）均为 `clipboard.rs` 顶部命名常量（`CLIP_POLL_MS` / `MAX_THUMB_DIM` / `AHASH_*` …）。**要调就改常量，别在散落处硬编码。**
> 缓存条数：默认 `CLIP_CACHE_MAX_DEFAULT=20`，运行时由 `CLIP_CACHE_MAX_RUNTIME` 控制（设置面板四档 10/20/50/100，持久化 store）。**别直接改 DEFAULT 调条数。**
> ⚠️ `CLIP_POLL_MS` 别再调大：两次复制落同一采样窗口会"塌缩"丢中间项（DECISIONS §6）；彻底根治需改事件驱动（`AddClipboardFormatListener`）。
- 后台线程 `start_clipboard_monitor` 独立于窗口 visible 常驻轮询；用 `GetClipboardSequenceNumber()` 判变化，**不每次读全量**；**轮询不读图，只在内容变化时处理一次**（>1024px 缩到缩略图再编码）。
- 检测顺序 `图片 → CF_HDROP(文件) → 文本`（截图同时有 CF_HDROP+位图，图片优先）。
- **所有剪贴板读写必须走 `CLIPBOARD_LOCK` 串行化**（监听读 + 全部写入者：copy/paste × 文本/图片/文件，含桌面分支读当前图的 `get_image`）。根因：并发抢 `OpenClipboard` 句柄 → `os error 1418`。锁粒度**仅限 `OpenClipboard…CloseClipboard` 临界区**——写入者**绝不跨 `hide()`/`sleep()`/焦点交还/`enigo` Ctrl+V 持锁**（阻塞监听、emit 往返可能死锁）。桌面分支 `SHFileOperation`/`desktop_copy_files` 不碰系统剪贴板、不加锁。`write_cf_hdrop` 被 paste 与 copy 共用 → **锁加调用方、别进函数**（否则 copy 重入死锁）。锁序：监听先放 `CLIPBOARD_LOCK` 再取 `CLIP_CACHE`，写入者只取 `CLIPBOARD_LOCK`，无环。**新增任何剪贴板读写路径必须取此锁。**（唯一例外：监听读在剪贴板被外部占用时持锁跨有界 retry-sleep——此时写入者本就进不来，无额外损害；见 DECISIONS §6。）
- 死循环防御：写回剪贴板前 `SKIP_CLIP_EVENTS.store(2)`（计数器非布尔——get+set 可能触发 2 次 seq 变化）。`CLIPBOARD_LOCK` 防**并发抢句柄(1418)**、`SKIP_CLIP_EVENTS`/seq 水位防**自写回流历史面板**，两层正交防护各管各的。
- 写文件用 `CF_HDROP` raw FFI（`SetClipboardData`/`DROPFILES`）：**`fWide` 必须 = 1**（UTF-16 路径），清零会导致 Explorer 解析失败。
- **图片粘贴按目标窗口类四分叉**（`set_clipboard_image`，按前台窗口 class 分流；探针取证见 DECISIONS §6 延伸）：① **桌面**(`WorkerW`/`Progman`)→ SHFileOperation 落地真 PNG；② **资源管理器文件夹**(`CabinetWClass`/`ExploreWClass`)→ CF_HDROP 落地真 PNG（**文件夹只收文件、不收位图**，已探针证实；大图复用已落盘 `clip_images/{time}.png` **零解码**，小图写 `clip_images/workbench_clip_*.png` 由 janitor 孤儿清理兜底）；③ **控制台**(`ConsoleWindowClass`/`CASCADIA_HOSTING_WINDOW_CLASS`，即 cmd/Windows Terminal)→ **退化为粘贴该图片落盘路径的文本**（控制台只认 CF_TEXT、不识别位图，属于目标程序能力边界，非本应用可修的 bug；续94）；④ **其余 app**(Paint/聊天框等)→ `set_image` 位图。**只有分支④才解码全分辨率 RGBA**（①②③均不解码/仅走文本，卡顿源仅④）。②③分支均复用文件粘贴 idiom：锁加调用方、写前 `store(2)`、焦点交还流程不变。
- 去重**只在同类型内进行**（跨类型去重会误删）：文件按 `items[0].path`，文本/图片按 `content`，不同类型永久保留。
- **批量上剪贴板仅限「全选 file」**：多 file 条目可合并成一个 CF_HDROP 一次写入；文本/图片/混合无法合成单一 payload（CF_HDROP §7 架构限制），前端相应置灰。任何新增批量剪贴板功能必须过「能否合并成单一 payload」这道门槛（详见 DECISIONS §6 延伸）。
- **历史持久化落盘 I/O 绝不进 `CLIPBOARD_LOCK`**（磁盘 I/O 与剪贴板锁正交）。`save_clip_history` 接**快照入参**、自身不持任何锁——调用方必须先释放 `CLIP_CACHE` 锁与 `CLIPBOARD_LOCK` 再调（防重入死锁）。固定模式：`{ 锁 CLIP_CACHE → mutate → let snap = cache.clone(); }` 出锁 → `save_clip_history(snap)`。
- **`clip_images/` 原图缓存由解耦 janitor 管上限**（`sweep_clip_image_cache` + 后台线程周期执行）：孤儿清理 + 总量封顶两步。**绝不进 `CLIPBOARD_LOCK`**；`CLIP_CACHE` 锁**仅 snapshot-and-release 收集被引用文件名**（锁块内零 fs）。**绝不在 `set_clip_cache_max`/`delete`/`clear`/dedup truncate 等写路径插删图逻辑**（侵入高危区、增锁与重入风险）——自动管理一律走 janitor。启动时序：首次 sweep 必须在 `load_clip_history` 之后（否则空集合误删全部），靠线程起手 sleep 错开。上限/周期为命名常量。详见 DECISIONS §6 延伸。

### 窗口尺寸
- 用**工作区（work area）尺寸**而非物理全屏，保留任务栏。
- 200% DPI 下 `outer_size` 比设置值大 ~26×15px（无边框窗口的隐形边框），用"位置补偿对齐屏幕原点"**动态计算**修正，**不要硬编码**。
- `set_shadow(false)` 后 WebView 填满外框、底边越过任务栏顶遮一条 → `make_fullscreen` 末尾 `clamp_window_bottom` 动态量 `GetWindowRect`、越界则等量缩 inner 高度贴齐（无硬编码）。详见 DECISIONS §5 延伸。

### 扫描/索引一律后台预建（`filesearch.rs` 文件索引 · `start_apps_worker` 应用扫描）
- **耗时预备工作（应用扫描、文件索引）一律独立后台线程预建、前端只监听就绪事件**（`apps-ready` / `file-index-ready`），**绝不在呼出路径同步执行**（应用扫描曾砸在首次呼出 → 卡 ~1.5s）。前端 invoke 命令仅作兜底（命中缓存近乎瞬时）。
- **索引建立只在独立后台线程**（`start_index_worker` 内 `std::thread::spawn`），**永不经 Tauri 命令 / invoke / 阻塞 IPC/UI**；setup 阶段 spawn、先延迟再首次建索引，不等窗口/呼出。
- **查询命令（`search_files`/`get_index_status`）只读内存、永不碰磁盘**（µs 级）。**双缓冲原子替换**：耗时遍历**绝不持锁**，建完一次性换 Vec；`FILE_INDEX` 锁只罩「替换 Vec」「读 Vec」两个瞬间临界区。
- `FILE_INDEX` 是**全新独立 Mutex**，与 `CLIPBOARD_LOCK`/`CLIP_CACHE` 无任何交集、无锁序问题。调遍历目录/深度/重建周期改 `filesearch.rs` 顶部命名常量。详见 DECISIONS §17。

### 💀 死胡同（已验证失败，别再试，别浪费时间）
- **`WS_EX_NOACTIVATE` 推回键盘焦点**：WebView2 内部 `SetFocus` 抢占键盘路由，外部进程无权推回。
- **自建 OS 级钩子 `rdev` / `WH_KEYBOARD_LL`**：消息循环编排极易错、多轮踩坑失败——用 `tauri-plugin-global-shortcut`。（遗留实现 `hotkey.rs` 已删）
- **用 `RegisterHotKey` 的 Pressed/Released 事件判按键时长**：事件经消息队列异步投递、500-800ms 抖动，阈值全失败。⚠️ 长短按本身**已实现**，靠的是 `GetAsyncKeyState` 轮询物理电平（DECISIONS §2）——别再回头试事件时长判定。
- ~~**修饰键 `Alt`（裸 Alt 触发菜单栏）**~~：**已推翻（续46 spike 实测）**——Alt 组合可用，RegisterHotKey 消费整个组合、前台收不到 Alt；旧结论来自早期 JS/rdev 录入态路线（详见 DECISIONS §9 续46）。仍禁：`Fn`（硬件键）/ 裸 `Alt+Space`（系统窗口菜单）/ 裸 `Alt+F4`（关窗）——语义被 OS 占用。
- **拖入 target「每次 show 幂等重注册」**：重注册虽报成功、产出的 IDropTarget 收不到回调、破坏正常拖入（单变量隔离确认）。拖入注册**只在 setup 做一次**。详见 DECISIONS §14。（注：原生拖入本身**可行、已实现**，别误删——曾被错误登记为死胡同后已推翻。）

### 🔍 出问题时反查（症状 → 先查哪条铁律）
| 症状 | 大概率违反 |
|------|-----------|
| 空白页后延迟关闭 | 前端管了 hide / `transparent:false` |
| 呼出白闪 | `set_focus` 太早 / `hotkey-show` 没提前于 `show()` |
| Esc 没反应 | show 路径缺 `set_focus()` |
| 焦点回不来、粘贴失败 | 碰了 `WS_EX_NOACTIVATE` 死胡同 |
| 点击粘贴偶发失败、手动 Ctrl+V 却能粘 | 焦点交还回退成了盲等 sleep / 看 `handback` 日志的 timeout 与 fg class（DECISIONS §3 续80）|
| 文件粘贴被 Explorer 拒绝 | `DROPFILES.fWide ≠ 1` |
| 截图不显示缩略图 | 检测顺序没把图片排在 CF_HDROP 之前 |
| 图片/截图点击后粘不进 cmd/Windows Terminal | 控制台只认 CF_TEXT、不识别位图，非 bug；已退化为粘贴该图片落盘路径（文本），见四分叉③（续94）|
| 历史项被误删 | 做了跨类型去重（应只在同类型内去重）|
| 复制/粘贴写剪贴板报 os error 1418 | 写入段没取 `CLIPBOARD_LOCK`，与监听读并发抢 OpenClipboard 句柄 |
| 桌面粘贴弹冲突框 / 取消 | `SHFileOperation` 缺 `FOF_RENAMEONCOLLISION` |
| 窗口底部细蓝缝 / 透明窗边异常 | 用了 `NCRENDERING_POLICY=DISABLED` 去阴影；改用 `set_shadow(false)`；见 DECISIONS §5 延伸 |
| WebView 盖住任务栏顶部一条 | `set_shadow(false)` 后底边越界；需 `clamp_window_bottom` 缩高贴齐；见 DECISIONS §5 延伸 |
| 拖出后窗口呼不出 / 卡死须重启 | 裸 `ShowWindow` 没同步 tao 缓存 → 下次 `window.show()` 被 diff 成 no-op；收尾改走 Tauri `hide()`；见 DECISIONS §18 续71b |
| 拖出到 cmd/终端后目标失焦、像卡死 2-3s（点一下才活） | 落点 console 不自我激活、本隐藏窗口仍持前台；drop 成功后 `activate_drop_target` 交还前台（前台锁挡住则 AttachThreadInput 强制）；见 DECISIONS §18 续82 |
| 「保持界面」模式拖动中按热键手动隐藏、松手落地时白闪一下 | 热键 monitor 在拖动期间抢操作窗口可见性；须 `DRAG_IN_PROGRESS` 时让 monitor 让路（窗口可见性拖动中由 dragout 独占）；见 DECISIONS §18 续84 |
| 拖出落地成 `download.png`（64×64） | WebView2 原生 `<img>` 拖拽抢手势（且无 `[dragout]` 日志）；需 `draggable=false`/`onDragStart preventDefault`/`-webkit-user-drag:none`；见 DECISIONS §18 续71b |
| 拖动排位/区内重排途中窗口意外消失、卡片永久悬浮点不动 | light-dismiss（`start_focus_watch`）不知道这个新阶段、在窗口仍可见时因前台瞬时切走提前 `hide()`，打断手势；新阶段必须让 `stage_reorder_active()` 参与 **`start_focus_watch`** 的让路判断；见 DECISIONS §18 续88 |
| 中转区拖动排位途中按热键关不掉界面（区内重排阶段热键失灵） | `stage_reorder_active()` 被错误加进 `start_hotkey_monitor` 让路判断——纯 JS 重排阶段没有替代者接管热键，让路 = 热键整段失效；改为该阶段 emit `stage-drag-hotkey`；见 DECISIONS §18 续88 |
| 中转区拖动中按热键关界面成功、但松手后无文件落地（拖排序破坏拖转移） | 区内重排是纯 JS ghost、无原生 OLE 拖；直接 hide 后 DoDragDrop 无从起手。须 emit `stage-drag-hotkey`→前端 `beginNativeDragOut(ids,forceHide=true)` 在窗口仍可见时起手 DoDragDrop、再由 dragout 隐藏；且 `STAGE_REORDER_ACTIVE`→`DRAG_IN_PROGRESS` 无缝交接防交接空窗被提前 hide；见 DECISIONS §18 续88 |

---

## 协作约定（给 AI 编码助手）
- 改完代码要**自己真跑、看日志、用数据说话**，不要只说"请测试"就交差。
- **真跑不了 GUI 时别假装**：热键 / 桌面点击这类无头环境无法驱动的链路，至少**针对性验证可复现的核心逻辑**（例：用 P/Invoke 直接验证 `SHFileOperation` 的 flag 语义），并在结论里**诚实标注哪些是模拟验证、哪些没真跑**。
- **诊断优先于修改**：先加日志 / 输出分析确认根因，再动手改。
- "理论上更优雅" ≠ "实际更好"：已验证的笨方法优于未验证的聪明方法。
- 出现"焦点回不来"这类**架构性死胡同信号时，果断回退**，不要打补丁硬撑。
- **`LauncherItem`（启动器收藏）与 `StageItem`（中转条目）不可合并**：二者形似但**左键动作契约不同**——启动器=打开/启动（不走粘贴链/不取 `CLIPBOARD_LOCK`），中转=取走粘贴（走粘贴链）。**动作由"区"决定**，别因字段相似而合并类型或复用左键 handler（详见 DECISIONS §16）。
- Git 提交按本文件顶部「Agent 入口约定」执行；不要在用户未要求提交时擅自制造提交历史。

## 强制记忆更新与文档维护 (Post-Task)
完成用户下达的开发需求、准备结束任务之前，必须**主动更新** `MEMORY.md`：
- **§0** 覆盖更新短快照：本次改了什么、核心文件路径、已知 bug、下一步建议；本会话详记写入 **§0A**（多行短 bullet 格式）。
- **§0A 滚动窗口 ≤3 个会话**：写入新详记时，把最老一条**整段迁入** `HISTORY.md`「一、会话详记归档」顶部，MEMORY.md 不留副本；变更记录同样只进 HISTORY.md。
- **单一真相源**：每个事实只落一处——硬规则→本文件铁律；根因/决策→`DECISIONS.md`（新增 § 时在其目录补一行摘要）；当前状态→`MEMORY.md`；历史→`HISTORY.md`（git log 已有的不重复记）。其他位置只放一行指针，**别把同一段叙述抄多份**。
- **短行原则**：新记录写多行短 bullet，禁止数千字符的单行（毁掉 Read offset / Grep 局部读取）。
- **严禁**在 MEMORY.md 中粘贴大量代码，仅保留结构索引和文字说明。
