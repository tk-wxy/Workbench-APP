# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-11（续101 剪贴板历史纳入增强搜索 + 续102 降全屏模糊解呼出/淡出掉帧；已确认测试通过并提交，见 §0/§0A）
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

- **当前稳定功能**：热键呼出（长按 momentary + 短按 toggle，键态轮询驱动，组合可自定义/录制式）+ Esc 关闭 + light dismiss；三类型剪贴板历史/粘贴/复制/持久化 + 图片原图缓存 janitor；中转区多选/框选/批量 file/拖入/拖出，条目**可选持久化**（设置→中转站「持久化」，默认关闭=拖出成功后自动消失）+ **单条「固定」豁免**（卡片右上点点，续99），**容量可调**（设置→中转站「上限条数」20/50/100/200，默认 20）；中转卡片**图片文件显示缩略图**（Rust 侧生成小图，续99b）；启动器收藏托盘（含拖拽排序）；增强搜索 + 文件索引（内置/可选 Everything 双引擎）；设置面板（常规/启动台/中转站/剪贴板/搜索/快捷键/关于）；**界面语言中/英文切换**（设置→常规，含托盘菜单同步）。
- **续101/续102（已提交 `919eba8`+版本 `cec4855`，用户已确认测试通过，合并一次提交）**：①**续101 剪贴板历史纳入增强搜索**——`EnhResult` 加 `clip` 类型，聚合进 Tier1（「文件」分隔线之上），徽标「剪贴板」、按类型图标、命中高亮；匹配=文本按内容/文件按名模糊 + 类型词兜底（「图片」「txt」）；激活（Enter/单击/右键「取走粘贴」）复用 `copyAndPaste`（写回剪贴板+焦点交还+Ctrl+V，经 `copyAndPasteRef` 转接避 TDZ）；增强搜索输入框占位改「搜索应用、中转、剪贴板…」。②**续102 呼出/淡出掉帧优化（纯 CSS）**——`.overlay-simple`/`.enh-layer` 的 `backdrop-filter` 由 `blur(24px)`→`blur(12px)`。根因：`--bg` 0.97 不透明、静止时模糊仅 ~3% 可见，却在全屏实时桌面 @200%DPI 每帧重算（淡出 opacity 动画 + 呼出首帧合成）→ 掉帧主因；降半径后滤镜成本约减半、静止观感几乎无差。版本号 0.4.4→0.4.5（PATCH）。详见 §0A。
- **续100（已提交 `c3b2795`+版本 `e3e2cbe`，用户已确认测试通过）**：中转站「原文件失踪」处理，含一个崩溃 bug 修复。**崩溃根因**：拖动源文件已删除的中转条目到 cmd → 死路径进 CF_HDROP → OLE 在目标侧与本进程双双闪退。**三层修复**：①Rust `build_formats` 过滤不存在路径（根治，死路径永不进 CF_HDROP；全部失空则命中 `run_drag_out` 已有 `formats.is_empty()` 守卫干净中止、清 `STAGE_REORDER_ACTIVE` 不打断续88 握手；兜住 batch 部分失踪）；②前端拖出/取走提前拦截失踪项；③新增 `check_stage_paths` 命令，每次呼出后台批量 `exists()` 扫（<1ms，**不实时监听**——分散父目录 watcher 代价高/网络盘不支持）。**失踪处理复用「拖出移除」同一豁免规则**：`!persist && !pinned` 直接移除并落盘（用户要的「源文件没了直接消失」）；固定/持久化则保留 + ⚠️ 灰化，隐藏复制/打开等对死文件无效操作、只留删除；设置→中转站「清理失踪」手动清保留项。版本号 0.4.3→0.4.4（PATCH）。详见 §0A。
- **续99（已提交，用户已确认测试通过）**：中转区界面优化 4 项 + 缩略图内存优化。①封面图标放大（icon-wrap 30→40px 等）；②图片文件显示真缩略图；③标题行变矮（`.stage-section-header` padding 12/6→6/4，启动器+中转站共用）；④右上点点从纯类型色标升级为**每条目「固定」开关**（点亮=📌 常驻，拖出成功也不自动移除；全局持久化开启时整体隐藏）。**续99b（同批，解性能）**：缩略图首版用 asset 协议直读原图→WebView 常驻全分辨率解码位图（一张 4000×3000≈48MB）→图多即卡顿+内存暴涨；改由 Rust `get_stage_thumbnail` 解码缩到 160px 返回小 base64（原图瞬时释放），撤掉 asset 协议。版本号 0.3.9→0.4.0（MINOR）。详见 §0A。
- **续99c/99d（已提交，用户已确认测试通过）**：①**99c 缩略图落盘缓存**（重启秒开）——`get_stage_thumbnail` 先查 `app_data/stage_thumbs/{crc32(path)}_{mtime}.png`，命中直接读小 PNG（零解码原图），未命中才解码缩图并写盘；后台 janitor 50MB 封顶（`apps.rs`/`lib.rs`）。②**99d 去中转区落地闪烁**——用户报"拖新图落地、缩略图替换占位图标那一刻中转区闪蓝"；**染色测试**（把 drop-flash/file-drag-active/drag-over 三处染不同色）定位到闪的是 🔴 `drop-flash`（落地确认动画，与缩略图生成窗口时间重合，非缩略图 bug）；从 CSS + JS 两层摘掉**中转区** `drop-flash`（`.drop-area.drop-flash` 选择器删除 + `files-dropped` 里加类两行删除），启动台 `.app-grid.drop-flash` 保留，悬停高亮 `file-drag-active` 未碰。版本号 0.4.0→0.4.1（PATCH）。详见 §0A。
- **续99e（已提交，用户已确认测试通过）**：中转区**列表视图**补齐图片缩略图 + 固定开关（此前只有方格视图有，而 `stageLayout` 默认 `"list"`→列表用户看不到 99 的成果，属覆盖盲区）。纯前端渲染层：列表项图片文件优先显示 `stageThumbs[path]`（复用同一缓存，缩略图生成与视图无关，早已就绪）；新增 `.stage-pin-btn`（未固定 hover 淡显、已固定常驻 accent 📌、全局持久化开启时隐藏，与方格 dot 同语义）。版本号 0.4.1→0.4.2（PATCH）。详见 §0A。
- **续99f（已提交，用户已确认测试通过）**：设置→中转站新增「缩略图缓存」行（打开文件夹 + 清空缓存 + ✓ 反馈），与剪贴板「图片原图缓存」行结构对齐。Rust 加 `open_stage_thumb_dir`/`clear_stage_thumb_cache`（`apps.rs`，复用 `launch_app` 的 `ShellExecuteW`，无新依赖）+ lib.rs 注册；i18n 补中英。清空只删磁盘、不动内存缓存/原文件。版本号 0.4.2→0.4.3（PATCH）。详见 §0A。
- **续98（已提交 `0115f9f`+版本 `e9aac82`，用户已确认测试通过）**：设置→中转站新增「底部快捷入口」显示/隐藏开关（`showShortcuts` state + store key `show-shortcuts`，纯前端持久化）——关闭后中转区下方 `.shortcut-row` 不渲染、空间由 `.drop-area(flex:1)` 归还给中转区；附带中转卡片封面 58→62px（标签区/悬浮操作栏等量收窄，总高 94px 不变，不破坏续94 行节奏）。版本号 0.3.8→0.3.9（PATCH）。详见 §0A。
- **续97（已提交 `772b2ce`，用户已确认测试通过）**：中转区**多选**拖出「区内小幅拖动后立刻松手却误删选中项」修复（**首版方案已回退**）。根因：落点落回**自身 overlay IDropTarget**，它对含 CF_HDROP 的拖入回传 copy → `drag-out-done` 误判成功投放而删（单项因先走区内重排、落回区内不起 OLE 故无症）。**首版**试图「多选也先进 pending 态、等离开 `.drop-area` 才起 OLE」——用户实测**多选拖到外部无法落地**（延迟起 OLE 破坏原生拖出），已完整回退。**改采落点结果侧修复**（不碰拖出起手时机）：`files-dropped` 内部落点置 `droppedOnSelfRef`，`drag-out-done` 命中则保留条目直接返回；依赖 `dragdrop.rs` Drop「emit files-dropped ⟺ 回传 copy」耦合 + 事件送达有序。纯前端，未碰 Rust/窗口/焦点/剪贴板。详见 §0A / CLAUDE 反查表。
- **续96（已提交 `772b2ce`，用户已确认测试通过）**：前端可维护性重构 + 2 处小 bug 修复（应用户"前端优化"请求）。①剪贴板列表 `key={i}`→`key={c.time}`（prepend 列表用 index key 会让 React 错位复用，导致刚复制卡片的拖拽态/✓ 反馈串到别的卡）；②`.stage-card-actions` 悬浮操作栏暗色硬编码 `rgba(30,30,30,.9)` 在浅色主题突兀、按钮白字不可见——加 `[data-theme="light"]` 上书；③抽出 `src/lib/format.ts`（fmtSize/ago/extIcon/dirOf/IMG_EXTS）、`src/lib/fuzzy.ts`（fuzzyScore/typeKeywords/matchItem/MatchResult）、`src/icons.tsx`（IconCheck/Copy/Trash/Open/Pin/Search，替换 App.tsx 里重复 4~6 次的内联 SVG）——App.tsx 从 2141 行减到 ~2000 行，纯移动无行为变更。设置齿轮/文件夹 SVG（各 1 处）留在 App.tsx。**未碰窗口/焦点/热键/剪贴板最高危区**。验证：`npx tsc --noEmit` + `npm run build` 均零错误（41 modules）。剩余优化候选见文末「前端优化清单」。
- **续95（已提交，用户已确认测试通过）**：两个独立 bug 修复——①中转区图片/截图点击后粘不进 cmd/Windows Terminal：控制台只认 CF_TEXT、不识别位图，是控制台能力边界非可修 bug，`set_clipboard_image` 新增第③分支退化为粘贴该图片落盘路径的文本（三分叉→四分叉）；②剪贴板历史里的截图/图片条目拖不进中转区：`.clip-image` 的 `<img>` 漏了 `draggable={false}`/`-webkit-user-drag:none`，WebView2 原生图片拖拽抢走指针序列，导致自定义拖拽逻辑从未激活（文本/文件条目无 `<img>` 不受影响），补齐后与 `stage-card`/`app-tile` 等既有图片元素一致。版本号 0.3.6→0.3.7（PATCH）。
- **续94（已提交，用户已确认测试通过）**：中转站方格卡片 80px→72px（gap 8→6，行容量 9→10）+ 启动台名字区固定两行高（`.app-tile-label-wrap` flex 居中，不再随名字行数浮动）+ 中转站列表视图条目固定 44px 高——三处共同目标是让启动台/中转站两栏"行节奏"（卡高+行距）严格相等（100px，列表为其 1/2=50px），修复逐行滚动累积错位（非首行对不齐）。期间加过 `scroll-snap` 试图缓解可滚动区域边缘卡片截断，用户测试后要求撤销，已完整回退。版本号 0.3.5→0.3.6（PATCH）。
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

### 续101 + 续102（2026-07-11，src/App.tsx + App.css + i18n.ts，用户已确认测试通过并合并一次提交）——剪贴板进增强搜索 + 降全屏模糊解掉帧
- **续101 剪贴板历史纳入增强搜索**（用户「剪贴板内容进入增强搜索」+「Tab 进入后输入框文案也改」）：
  - `EnhResult` 新增 `| { kind:"clip"; item:ClipItem; name; ranges }`。`enhTier1` 加 `clipHits`：名称=文本内容(slice 80)/图片标签/文件名，`fuzzyScore` 打分；名称未命中时 `typeKeywords` 子串兜底给基础分 5（无 ranges）。并入 `[...appHits,...stageHits,...clipHits]` 排序、slice(0,10)。deps 加 `clipboard`、`t`。
  - **激活** `activateEnh` 加 `clip` 分支 → `copyAndPasteRef.current?.(r.item)`：`copyAndPaste` 定义在 `activateEnh` 之后，直接引用会 **TDZ 崩**（useCallback deps 在 render 期求值），故新增 `copyAndPasteRef`，在 `copyAndPaste` 定义后赋值、activateEnh 经 ref 调用。
  - 渲染：`key`/`icon`(📝/🖼️/文件图标)/`badge`(「剪贴板」) 三处 ternary 加 clip 分支；`label`/`ranges` 已天然兼容。右键菜单 `openEnhCtxMenu`：`else`→`else if(stage)`，clip 落到「只默认项」，默认项 label 对 clip 显「取走粘贴」。
  - 增强搜索输入框占位 `搜索应用、中转文件…`→`搜索应用、中转、剪贴板…`（复用顶栏已有 i18n）。i18n 补「取走粘贴」。
- **续102 呼出/淡出掉帧优化（纯 CSS，用户报「呼出/关闭动画掉帧」）**：
  - **诊断**：整层唯一动画=启动/粘贴的 200ms「淡出露桌面」（`.overlay-simple.dismissing` opacity transition）；Esc/热键关闭与呼出均即时无 CSS 动画。掉帧根因=`.overlay-simple` 的 `backdrop-filter:blur(24px) saturate(1.4)` 作用在**全屏实时桌面** @200%DPI（48px 物理核×640万像素），backdrop 采样活桌面**无法层缓存**，淡出 opacity 每帧逼迫重算整块滤镜。
  - **关键发现**：`--bg=rgba(13,13,15,0.97)` **97% 不透明** → 静止时那层昂贵模糊仅 ~3% 可见（代价 100%、静止收益 3%），仅淡出中途 alpha 下降时才显形。
  - **改动**：`.overlay-simple` + `.enh-layer` 的 blur `24px→12px`（含 `-webkit-` 前缀）。滤镜成本约减半、静止观感几乎无差；呼出首帧合成 + 淡出动画同受益。**未碰** `transparent:true`/`focus:false`/show 三约束/Rust 管 hide 等最高危路径。
  - 备选未采纳：B「淡出期间 `backdrop-filter:none`」（最丝滑、损中途桃面感）、C「彻底去模糊」——用户选 A（降半径）。若仍不够顺可再上 B。
- **验证**：`npx tsc --noEmit` + `npm run build` 均零错误；用户 GUI 实测两项均通过。版本号 0.4.4→0.4.5（PATCH）。

### 续100（2026-07-11，src-tauri/src/{apps,dragout,lib}.rs + src/App.tsx + App.css + i18n.ts，用户已确认测试通过并提交）——中转站原文件失踪处理 + 拖出崩溃修复
- **触发**：用户问「中转站项目的源文件被删了该何去何从」；实测发现拖失踪项到 cmd → cmd 与本软件**双双闪退**（知名 bug）。
- **崩溃根因**：`dragout.rs::build_formats` 对 `file` 条目**无条件**把路径塞进 CF_HDROP，从不查存在性；死路径进 OLE `IDataObject` → 拖到 cmd 松手时目标侧 + 本进程 `DoDragDrop` 双双在死路径上崩。
- **三层修复**：
  - ①**Rust `build_formats` 过滤不存在路径（根治）**：死路径永不进 CF_HDROP。全部过滤空 → 命中 `run_drag_out` 早已存在的 `formats.is_empty()` 守卫**干净中止**（return 前清 `STAGE_REORDER_ACTIVE`，此刻 `DRAG_IN_PROGRESS` 未置位、不打断续88 握手交接——这是特意选的安全落点）。**顺带兜住 batch 条目部分文件被删**（只保留仍在的路径）。
  - ②**前端提前拦截**：`handleStagePointerMove` 决策处把失踪 id 滤出拖出集（全失踪则复位手势不起 OLE；处理了多选混合、按下项正好是失踪格的边角——剩余单项非按下项时走原生而非重排）；`handleStageClick` 失踪项单击 no-op。
  - ③**新增 `check_stage_paths(paths)->Vec<String>` 命令**（`apps.rs`，返回不存在子集，纯 `exists()` stat、不碰锁）+ `lib.rs` 注册。前端 `scanStageMissing` 每次 `hotkey-show` + 启动加载后调；**不用实时文件监听**（分散父目录 watcher 代价高、网络盘不支持、与 ~30MB 目标冲突；懒扫 200 条 <1ms 零常驻）。
- **失踪处理策略（复用「拖出移除」同一豁免规则，用户拍板）**：`scanStageMissing` 拿到失踪集后——`!persist && !pinned` 的条目**直接移除并落盘**（函数式 `setStage` + `storeRef` 落盘，避开 `saveStage` 闭包过期）；**固定/持久化则保留**并进 `missingPaths`。`missingIds` 派生（条目全部文件都失踪才算，batch 部分尚在不误标）→ 两视图灰化 + ⚠️ 角标 + **隐藏复制/打开等对死文件无效操作、只留删除**（解决用户吐槽的「操作还在」不一致）。设置→中转站「清理失踪」（`cleanupMissingStage`）手动清保留项，无视固定豁免。
- **为何不「一律直接删」**：唯一代价是固定/持久化项在 U盘/网络盘/OneDrive 临时掉线时被误杀，而这类项恰是用户明确要留的；用既有 `!persist && !pinned` 规则区分，零新概念。保留 ⚠️ 项三条出路：盘恢复→下次扫描自动消、取消固定→下次扫描清、手动删/清理失踪。
- **验证**：`tsc` + `cargo check` + `npm run build` 均零错误；用户 GUI 实测 1–4（崩溃回归 / 失踪不可取走 / 正常项回归 / 多选混合只落地正常项）+ 自动移除策略均通过。
- **提示后人**：中转 file 条目拖出/取走前，凡走 CF_HDROP 的路径都要保证路径存在——死路径进 OLE 会崩目标+本进程。前端拦 + Rust `build_formats` 兜底双保险，别只依赖一层。

### 续99（2026-07-10，src/App.tsx + src/App.css + src-tauri/src/apps.rs + lib.rs，用户已确认测试通过并提交）——中转卡片界面优化 4 项 + 图片缩略图内存优化（99b）
- **触发**：用户「界面优化」请求——封面图标大些 / 图片显示缩略图 / 标题行减高 / 讨论右上点点用途。
- **①封面图标放大**（`App.css`）：`.stage-card-icon-wrap` 30→40px（圆角 7→9），app 图标 28→34、文件夹 SVG 26→32、emoji 22→28、image 兜底 emoji 28→32。
- **②图片文件缩略图**：见 99b（先 asset 协议、后改 Rust）。
- **③标题行变矮**（`App.css`）：`.stage-section-header` padding `12px 16px 6px`→`6px 16px 4px`，启动器 + 中转站共用此类，两栏一起矮 ~8px。
- **④点点=每条目「固定」开关**（按用户方案）：`StageItem` 加 `pinned?:boolean`（落盘 stage-items）。未固定显类型色点（可点、hover 有提示环），点击 `toggleStagePin` 切换、已固定显 📌（`IconPin`）常驻；**全局持久化开启时整个点点隐藏**（冗余）。固定条目在拖出移除两处（drag-out-done 单条文本 461 / 批量 472）豁免——`!stagePersist && !pinned` 才移除；批量改为过滤掉 pinned 的 id。点击取走（copyAndPaste）本就不删条目，故固定只影响拖出移除。dot 是 `<button>`，pointerdown/click 均 stopPropagation（不误触拖动/取走）。三处 thumb（image/text/file）共用一个 `dotEl`。
- **99b（同批，解性能）**：用户实测「图多变卡、内存高」。根因：`convertFileSrc` 让 `<img>` 加载**原图全分辨率**，WebView 常驻整张解码位图（4000×3000≈48MB/张）。改法：新增 Rust `#[command] get_stage_thumbnail(path)`（`apps.rs`，复用 `image` crate + `base64_encode`）——读文件→`load_from_memory`→`thumbnail(160,160)`→PNG→`data:` base64；解码是调用内瞬时开销、返回即释放。前端 `stageThumbs` 记录 path→dataURL（会话内内存缓存、不落盘）+ `stageThumbPendingRef` 去重（每 path 只发一次、失败不重试回退 emoji），effect 依赖 `stage` 懒加载。**撤掉 asset 协议**（`tauri.conf.json` 恢复原样，消除该安全面）。lib.rs `generate_handler` 注册命令。
- **验证**：`npx tsc --noEmit` + `cargo check` 均通过；用户 GUI 实测确认「非常流畅」、内存回落。
- **文件**：`src/App.tsx`（pinned/toggleStagePin/dotEl/移除逻辑/stageThumbs+effect/render）、`src/App.css`（icon-wrap/dot/cover 绝对定位/header padding）、`src-tauri/src/apps.rs`（get_stage_thumbnail）、`src-tauri/src/lib.rs`（注册）。
- **提示后人**：图片缩略图**别回退 asset 协议直读原图**——WebView 会常驻全分辨率位图致内存暴涨，必须 Rust 侧缩图。`THUMB_MAX`/`STAGE_THUMB_MAX_DIM=160` 常量。

#### 续99c/99d（2026-07-10 同批延续，用户已确认测试通过并提交）——缩略图落盘缓存 + 去中转区落地闪烁
- **99c 缩略图落盘缓存（重启秒开，`apps.rs`+`lib.rs`）**：`get_stage_thumbnail` 先查磁盘缓存 `app_data/stage_thumbs/{crc32(b"THMB",path)}_{mtime}.png`——命中直接读小 PNG base64（**零解码原图**），未命中才解码缩图并写盘（best-effort）。mtime 进缓存键 → 源图被改自动失效。`init_thumb_cache(data_dir)` 在 setup（clipboard::init 后）建目录 + 起后台 janitor：总量 `STAGE_THUMB_CACHE_MAX_BYTES=50MB` 封顶、超出按 mtime 升序删最旧（无 Rust 侧「被引用集」，纯容量+时间淘汰，被删下次按需重建）；起手延迟 8s 错开、之后 30min/轮。前端零改动（照旧 invoke，命中缓存即快）。
- **99d 去中转区落地闪烁（闪蓝 bug，`App.tsx`+`App.css`）**：用户报"拖新图落地、占位图标→缩略图替换那一刻中转区闪蓝"。**排错走了弯路**（先怀疑缩略图 img 命中触发 OLE 重入、加 pointer-events/-webkit-user-drag、删 drop-flash——均无效或方向错，用户明确要求"根除别妥协、先撤无效改动"）。**决定性诊断=染色测试**：把三处能让中转区变蓝的 CSS（`drop-flash` 落地闪烁 / `file-drag-active` 悬停高亮 / `drag-over` 内部拖拽）各染不同色，用户复现报「🔴红」→ 锁定是 **`drop-flash`**（落地确认动画，200ms；99c 磁盘缓存让缩略图生成变快、正好和这 200ms 窗口重合，故错看成"替换缩略图那一下"，与缩略图无因果）。**根治**：从 CSS 层删 `.drop-area.drop-flash` 选择器（即使 JS 加类也无规则可播）+ 从 JS 层删 `files-dropped` 里给中转区加类两行。启动台 `.app-grid.drop-flash` 保留，悬停高亮 `file-drag-active` 未碰（用户要保留落点提示）。
- **教训（写给后人）**：多处同色视觉 bug 定位，**染色测试**（每个嫌疑源染不同色、看实际显示什么色）比反复读代码猜快得多、且确定；用户"背景蓝无边框"这类精确指纹能先缩小到具体 CSS 规则（`drop-flash` 是唯一"只有背景无边框"的）。别在没定位到真凶前反复打补丁。
- **验证**：`npx tsc --noEmit` + `cargo check` 均通过；用户 GUI 实测确认闪蓝消失、悬停提示与启动台落地闪保留。版本号 0.4.0→0.4.1（PATCH）。

#### 续99e（2026-07-10 同批延续，用户已确认测试通过并提交）——列表视图补齐缩略图 + 固定开关
- **触发**：审查发现 99/99b/99c/99d 的缩略图 + 固定点点**只加在方格视图（grid）**，而 `stageLayout` 默认值是 `"list"`——没手动切方格的用户完全看不到这些成果，属功能覆盖盲区。
- **改动（纯前端渲染层，`App.tsx`+`App.css`，复用现成状态）**：①列表项（`.stage-item`）图片文件渲染优先用 `stageThumbs[path]`（缩略图 effect 依赖 `stage`、与视图无关，早已为所有图片文件生成，故只加渲染分支、无逻辑改动）；②新增 `.stage-pin-btn`（放 `.stage-actions` 前）——未固定时行 hover 淡显（opacity 0.5）、已固定常驻 accent 📌、全局持久化开启（`!stagePersist` 门控）时隐藏，`onPointerDown/onClick` 均 stopPropagation 防误触拖动/取走，与方格 `dotEl` 同语义。
- **验证**：`npx tsc --noEmit` 通过；用户 GUI 实测确认列表视图缩略图显示、固定钮工作、拖动/多选未受影响。版本号 0.4.1→0.4.2（PATCH）。

#### 续99f（2026-07-10 同批延续，用户已确认测试通过并提交）——缩略图缓存手动打开/清空入口
- **背景**：99c 的 `stage_thumbs/` 只有 50MB 后台 janitor 封顶，缺手动维护入口（剪贴板 `clip_images/` 早有「打开文件夹/清空缓存」）。
- **改动**：①Rust `apps.rs` 加 `open_stage_thumb_dir`（`ShellExecuteW` open 目录，复用 `launch_app` 现成 FFI、无新 import）+ `clear_stage_thumb_cache`（read_dir + remove_file 删目录内文件），镜像 clipboard 的 `open_clip_image_dir`/`clear_clip_image_cache`；②`lib.rs` generate_handler 注册两命令；③前端设置→中转站底部加「缩略图缓存」row（打开文件夹 + 清空缓存，`thumbCacheCleared` 状态做 ✓ 反馈），结构照抄剪贴板「图片原图缓存」row；④`i18n.ts` 补「缩略图缓存」+ 说明 hint 中英（「打开文件夹/清空缓存/✓ 已清空」复用现成条目）。
- **语义**：清空只删磁盘缓存文件，前端 `stageThumbs` 内存缓存与 `stageThumbPendingRef` 不动（当前会话已显示缩略图不受影响）、原图文件不碰；下次重启按需重建。与 clip 的 clear 语义一致。
- **验证**：`npx tsc --noEmit` + `cargo check` 均通过；用户 GUI 实测确认打开文件夹/清空/英文文案均正常。版本号 0.4.2→0.4.3（PATCH）。

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
  App.tsx          # 主组件：三栏布局 + 剪贴板面板 + 热键事件监听（~2000行，仍是单组件）
  App.css          # Win11 暗色主题 + 毛玻璃 + 全屏布局
  lib/format.ts    # 纯函数：fmtSize/ago/extIcon/dirOf/IMG_EXTS（续96 抽出）
  lib/fuzzy.ts     # 纯函数：fuzzyScore/typeKeywords/matchItem/MatchResult（续96 抽出）
  icons.tsx        # 复用 SVG 图标组件：IconCheck/Copy/Trash/Open/Pin/Search（续96 抽出）
  i18n.ts          # 中/英文案与 makeT
  main.tsx         # React DOM 入口
  index.css        # Tailwind CSS v4 入口
  vite-env.d.ts    # Vite 类型声明
```

关键依赖：`react@18`、`@tauri-apps/api@2`、`@tauri-apps/plugin-store`、`framer-motion`（已安装未使用，CSS 动画已替代）

**前端优化清单（续96 静态审查产出，已做打√，余为候选）**：
- √ 剪贴板列表 index key → `key={c.time}`（prepend 列表错位复用修复）
- √ `.stage-card-actions` 浅色主题上书（暗色硬编码漏配修复）
- √ 纯函数（format/fuzzy）+ 复用 SVG（icons）抽出文件
- ▢ App.tsx 仍 2000 行单组件——可继续拆表现层组件（SettingsModal / EnhSearchLayer / AppPickerModal / ClipList），show/hide/焦点结线须留 App 侧
- ▢ 巨型 store 加载 useEffect（`App.tsx` ~1 行 2000 字符）违「短行原则」，可展开多行（含 invoke set_hotkey 等，属轻度敏感，改前先读）
- ▢ grid/list 中转条目 label/icon 算法重复，可提 `stageLabel(s)`/`stageIcon(s)`
- ▢ 剪贴板/中转列表无键盘导航（仅启动器网格 + 增强搜索有）
- ▢ 全局 `outline:none` 致设置内按钮键盘焦点不可见 → 加 `:focus-visible`
- ▢ 图标按钮多缺 `aria-label`（仅 title），无障碍偏弱（个人工具，低优先）

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
