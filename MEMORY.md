# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-08（续88 五轮：补"按热键升级为原生拖出"触发器，修复"拖动中按热键关界面成功但松手无文件落地"，见 §0）
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

- **当前稳定功能**：热键呼出（长按 momentary + 短按 toggle，键态轮询驱动，组合可自定义/录制式）+ Esc 关闭 + light dismiss；三类型剪贴板历史/粘贴/复制/持久化 + 图片原图缓存 janitor；中转区多选/框选/批量 file/拖入/拖出，条目**可选持久化**（设置→中转站「持久化」，默认关闭=拖出成功后自动消失）；启动器收藏托盘（含拖拽排序）；增强搜索 + 文件索引（内置/可选 Everything 双引擎）；设置面板（常规/启动台/中转站/剪贴板/搜索/快捷键/关于）；**界面语言中/英文切换**（设置→常规，含托盘菜单同步）。
- **⚠️ 中转区「区内拖动排位」（续88）功能接近完成，五轮修复"按热键升级为原生拖出并投放"，代码在工作树未提交，等本轮 GUI 复测**——见下条。
- **最高危提醒**：窗口/焦点/热键/剪贴板改动前必须重读 `CLAUDE.md` 铁律。尤其：别改 `tauri.conf.json` 的 `transparent:true`/`focus:false`；别让前端管 hide；别回退 RegisterHotKey 事件驱动 show/hide；新增剪贴板读写必须过 `CLIPBOARD_LOCK`。
- **最近状态（续88 五轮，本次会话）——补"按热键升级为原生拖出"触发器**：GUI 实测确认四轮的②（热键关界面）已生效，但暴露①真面目=**"拖动中按热键关界面成功、但松手后无文件落地"**。根因：用户转移手势是"拖起→按热键隐藏→拖到目标松手"，全程不越 drop-area 边界；而续88 只在"越界"时才把纯 JS 区内重排升级为原生 DoDragDrop——按热键那刻还没有任何原生拖，直接 hide 就把手势取消了（且隐藏后 DoDragDrop 的 SetCapture 必失败，隐藏必须晚于起手）。修复：把"按热键"也作为升级触发器——monitor 在 `stage_reorder_active()` 期间改为 emit `stage-drag-hotkey`（不 hide 不让路），前端据此 `cancelStageReorder()`+`beginNativeDragOut([id], forceHide=true)`；`start_drag_out`/`do_drag_on_main` 加 `force_hide` 参数（无视 keepOpen 强制隐藏收场，且**先起手 DoDragDrop 再隐藏**）；`STAGE_REORDER_ACTIVE`→`DRAG_IN_PROGRESS` 无缝交接（`cancelStageReorder` 只清 JS 现场、do_drag_on_main 先置 DRAG_IN_PROGRESS 再清 STAGE_REORDER，防交接空窗被提前 hide）。三处 build 零错误，GUI 待复测。详见 §0A 续88 五轮 / DECISIONS §18。
- **上一状态（续87）——修复系统托盘两个图标问题**：`tauri.conf.json` 的 `app.trayIcon` 配置项与 `lib.rs` 手写的 `TrayIconBuilder`（含菜单/点击事件）同时存在，Tauri 启动时各自创建一个托盘图标——配置项那个无菜单无事件绑定（即用户看到的"蓝色不可操作"那个）。修复：删掉 `tauri.conf.json` 里的 `trayIcon` 块，只保留代码手写版。用户已确认符合预期。详见 §0A 续87。
- **上一状态（续86）——中转站新增「持久化」开关 + 修正 move/copy 移除判定，GUI 二轮复测待用户**：`stagePersist` 开关门控 `drag-out-done` 监听器里的自动移除逻辑；首轮 GUI 反馈 text/image 拖出成功后仍留在中转区（根因：旧逻辑仅 `effect==="move"` 才移除，而 image/text/跨盘 file 拖出多数回传 `copy`），已修正为 move/copy 均视为成功移出。详见 §0A 续86。
- **待办（续75 GUI 反馈遗留，启动台拖拽打磨）**：
  - ⓪a 舍去抓手光标——grab/grabbing 实测卡顿，回退光标改动（`.app-tile` cursor 恢复默认、`.launcher-reordering` 去 grabbing）。
  - ⓪b 被拖项目跟随观感——源 `opacity:0` 后拖动中项目"消失"；先在真实拖拽下加日志确认 ghost 是否跟手到位，再决定强化跟随还是让源半可见。
- **下一步候选（无阻塞）**：① 启动器键盘导航；② 文件结果右键「打开所在目录」+ 命中高亮回传；③ 索引目录可配置；④ 增强搜索纳入剪贴板条目；⑤ file/folder 收藏的非拖入入口；⑥ 拖出边角补测（text→记事本等；核心路径已实测通过，低风险）；⑦ Gemini/contenteditable 文本拖入硬边界（用户计划未来攻克，方向需绕开「dragover 不落 caret」根因，见 HISTORY 续73 记录）。
- **阻塞 / 待决策**：中转区「区内拖动排位」（续88）等本轮 GUI 复测——重点验证"拖起条目→按热键隐藏→拖到外部松手→文件落地"整条转移链是否闭合（devtools console 看 `[stage-drag] hotkey during reorder → 升级…` + `[dragout] DoDragDrop begin … force_hide=true` + `drag-out-done effect=…`）。

## 0A. 最近状态细节 〔滚动窗口 ≤3 会话；更早的详记在 HISTORY.md〕

### 续88（2026-07-08，App.tsx + App.css + dragout.rs + lib.rs，三轮 GUI 反馈后**暂停归档**，未完成）——中转区拖动排位（Phase 2 补完）
- **需求**：中转区参照启动台（§16）补上拖动排位功能——续84 时明确留了这个缺口（"区内重排暂 no-op（Phase 2）"）。
- **核心设计**：按下拖动超阈值（`DRAG_OUT_THRESHOLD_PX`=12px）后不再一律立即触发原生 `start_drag_out`，先判定：多选拖多项 或 搜索过滤态（`filteredStage` 索引对不上 `stage`）→ 维持原行为直出；否则单项 → 进入纯前端「区内重排」（`stageReorderRef` 持有 FLIP 快照 + DOM clone ghost，算法与启动台 `handleLauncherPointerDown` 同构，直接复用 `calcInsert`/`applyShift` 逻辑）。光标只要还在 `.drop-area` 边界内（留 `STAGE_REORDER_ESCAPE_PX`=6px 余量防抖动）就纯前端重排；一旦越界，立即清场（无落定动画）并调用与直出分支同一个 `beginNativeDragOut([itemId])` 升级为真实 OLE 拖出——两条路径复用同一段 Rust 调用代码。
- **状态机**：`dragOutRef` 加 `mode:"idle"|"reorder"|"native"` 字段路由；重排本身状态（tiles/rects/ghost/insertIdx）单独放 `stageReorderRef`，两个 ref 职责正交。
- **范围取舍**：不支持多选群体重排（与"多选=准备批量拖出"的既有直觉冲突，且实现复杂度高很多）——多选/搜索过滤态一律走原生拖出，行为与加入本功能前一致。
- **CSS**：新增 `.stage-card/.stage-item` 的 `.stage-dragging-src`/`.stage-shift`/`.stage-drag-ghost`/`.stage-reordering`，镜像启动台同名 class（`.app-tile.launcher-*`）。
- **一轮 GUI 反馈（用户）**：拖动项目有放大动画（ghost pop-in）但卡在原处不跟手。**根因**：`handleStagePointerMove` 顶部门槛 `if (!dr.pressing || itemId === null) return;` 里的 `dr.pressing` 本是"一次性阈值判定"标志——进入 reorder/native 分支时会被置 `false`；但激活后的**所有后续 move 事件**都会先撞上这行顶部门槛而直接 return，`updateStageReorder` 从未被再次调用。**修正**：门槛判据改为只查 `itemId===null || dr.mode==="native"`。
- **二轮 GUI 反馈（用户）**：①拖文件到外部目标失败（等同没发生过）；②重开界面后有张卡片一直悬浮卡死、点不动。用户自己的判断"拖动时开关页面导致失去对鼠标控制"精确命中根因。**根因**：`lib.rs` 的 `start_focus_watch`（light-dismiss，50ms 轮询前台窗口）**完全不知道"区内重排"这个新阶段的存在**——重排期间窗口全程可见、`dragout::DRAG_IN_PROGRESS` 尚未置位（那个标志只在真正调用 `start_drag_out` 后、`do_drag_on_main` 起手时才置位），若此时用户的拖动手势恰好导致前台窗口瞬间切走（哪怕只是一瞬），light-dismiss 会立刻 `hide()`——**在我们升级到原生拖出之前就把窗口关了**：`start_drag_out` 从未被调用（"拖到外部目标"这个动作根本没发生，①因此失败），且 JS 侧从未收到"窗口被关"的通知（浏览器把 pointer capture 静默撤销、不发 `pointerup`），`ghost`/让路 transform 永久卡死在 DOM 里（drag-layer 是持久节点、React 不会重新挂载，②因此卡死）。这正是 CLAUDE.md 铁律"新增窗口隐藏机制都要查是否需要让路"——本次实现漏查了 light-dismiss 这一条。
- **修正**：①`dragout.rs` 新增 `STAGE_REORDER_ACTIVE` + `stage_reorder_active()` + `set_stage_reorder_active` 命令，`lib.rs` 的 `start_focus_watch` 与 `start_hotkey_monitor` 均在 `dragout::drag_in_progress() || dragout::stage_reorder_active()` 时让路（同 `DRAG_IN_PROGRESS` 惯例）；前端 `startStageReorder`/`cancelStageReorder`/`commitStageReorder` 对应调用该命令同步。②双重前端安全网（不管根因是否堵严实，兜底都该在）：`onLostPointerCapture`（capture 被外部原因静默撤销时兜底清场）+ `hotkey-hide` 监听器里补一句"若有活跃重排则强制 cancel"。
- **验证**：`cargo check --lib`、`npx tsc --noEmit`、`npx vite build` 均零错误。
- **三轮 GUI 反馈（用户，2026-07-08）**：区内重排本身已经跑通（不再卡死、能跟手拖动），但①原生拖出仍异常、②拖动文件时"界面关闭快捷键"失效。
- **四轮修复（本次会话，2026-07-08，采纳三轮的静态推断）**：
  - **②根因确认并修复**：二轮修复把 `dragout::stage_reorder_active()` 错误地**同时**加进了 `start_hotkey_monitor` 让路判断（lib.rs ~407）。对原生拖出阶段是对的（`do_drag_on_main` keepOpen 分支有 Rust 自轮询线程顶替 hotkey monitor，见 dragout.rs ~528），但纯 JS 区内重排阶段**无替代者**，让路 = 拖动期间热键关界面整段失效。改回 `if dragout::drag_in_progress() { ...continue; }`（去掉 `|| stage_reorder_active()`）；`start_focus_watch` 保持 `|| stage_reorder_active()`（它让路安全且必需，是二轮真正要修的对象）。
  - **关键区分（教训）**："是否让路"标志不能在 hotkey monitor / light-dismiss 之间无差别复用同一判断——light-dismiss 让路只是暂停"自动隐藏"一个动作、无需替代者；hotkey monitor 让路的前提是**有别的机制顶替其核心职责**（检测按键 show/hide）。给新阶段接让路判断时须逐个让路方核对"这个阶段里它需不需要让、能不能被替代"。
  - **诊断日志**：App.tsx 的 `startStageReorder`/`beginNativeDragOut`/`cancelStageReorder`/`handleStageLostPointerCapture`/`drag-out-done` 监听器加 `console.log("[stage-drag] …")`，供①下一轮 GUI 取证。
  - **①现状**：最可能是②的连锁（重排期间热键被吞、用户按热键脱困未遂扰乱手势），②修后应连带缓解；若日志显示①独立（`[stage-drag] → native drag-out` 有打印但 drag-out-done effect=none），下一步查 reorder→native 交接的 `STAGE_REORDER_ACTIVE=false`→`DRAG_IN_PROGRESS=true` 空窗是否被 light-dismiss 钻空提前 hide（`cancelStageReorder` 先清标志再异步 `start_drag_out`，理论有 gap，但 button-held 拖动前台通常仍是本窗口、未必致命）。
  - **验证**：`cargo check --lib` / `npx tsc --noEmit` / `npx vite build` 三处零错误；GUI 待用户实测（不模拟输入）。
- **五轮修复（本次会话，2026-07-08，GUI 实测后）**：四轮的②确实生效，但暴露①真面目=**"拖动中按热键关界面成功、但松手后无文件落地，中转转移失效"**。
  - **根因坐实**：用户转移手势="拖起→按热键隐藏 overlay→拖到目标松手投放"，**全程不越出 drop-area 边界**；续88 只在"越界"时才把纯 JS 区内重排升级为原生 `DoDragDrop`。按热键那刻还处在纯 JS 重排（ghost 只是 DOM 元素、无原生 OLE 拖），四轮把 monitor 改成正常 toggle 后按热键→`hide()`→丢 pointer capture→`onLostPointerCapture`→`cancelStageReorder` 手势取消，从未起手 DoDragDrop。核心矛盾：转移到外部必须先隐藏才看得见目标，但隐藏后 `DoDragDrop` 的 SetCapture 必失败（续71 已录）——隐藏必须**晚于**起手。
  - **修复**（把"按热键"也作为升级为原生拖出的触发器，与"越界"并列）：① `lib.rs` monitor 在 `stage_reorder_active()` 期间**不 hide 不让路**、改按下沿 emit `stage-drag-hotkey`；② `App.tsx` 新增该事件监听→`cancelStageReorder()`+`beginNativeDragOut([id], forceHide=true)`；③ `start_drag_out`/`do_drag_on_main` 加 `force_hide` 参数（无视 keepOpen 强制隐藏收场，先起手 DoDragDrop 再隐藏）；④ **无缝交接**：`cancelStageReorder` 改为只清 JS 现场、**不动 STAGE_REORDER_ACTIVE**，由 `do_drag_on_main` 先置 `DRAG_IN_PROGRESS=true` 再清 `STAGE_REORDER_ACTIVE`（任一时刻至少一真、无空窗被提前 hide）；升级中止路径在 `run_drag_out` 补清标志防悬置；非升级终止（commit/lost-capture/hotkey-hide 安全网）由调用点显式清。
  - **教训**：区分"重排 vs 转移"的触发器必须匹配用户真实手势（原设计只认"越界"，漏了"热键隐藏后投放"）；任何"先隐藏窗口"的路径都必须先确认原生拖已起手。
  - **验证**：三处 build 零错误；GUI 待复测（区内落定 / 热键升级转移 / 越界升级转移 / auto-close×keepOpen）。
- **文件**：`src/App.tsx` / `src/App.css` / `src-tauri/src/dragout.rs` / `src-tauri/src/lib.rs`。文档同步：claude.md 铁律（热键让路→emit 升级 + 无缝交接）+ 反查表 2 行 + dragout.rs 结构行 `force_hide` + DECISIONS §18 续88「四轮/五轮修复」。

### 续87（2026-07-08，仅 tauri.conf.json，用户已确认符合预期）——修复系统托盘出现两个图标
- **症状**：运行后系统托盘出现两个图标，绿色可操作、蓝色点了没反应。
- **根因**：`tauri.conf.json` 里配了 `app.trayIcon`（`iconPath`+`iconAsTemplate:true`），Tauri 启动时会据此**自动创建一个默认托盘图标**；`lib.rs:561` 的 setup 里又手写了一个 `TrayIconBuilder`（带菜单/`on_menu_event`）。两者互相独立、同时存在→两个图标。配置项那个没绑任何菜单/事件，就是那个"蓝色不可操作"的。
- **修复**：删掉 `tauri.conf.json` 的 `trayIcon` 配置块，只保留代码手写版（唯一有菜单和事件处理的那个）。
- **验证**：JSON 校验通过；用户实测确认只剩一个可操作图标。
- **文件**：`src-tauri/tauri.conf.json`。

### 续86（2026-07-08，纯前端 App.tsx，GUI 首轮反馈已修复，二轮待复测）——新增中转站「持久化」开关 + 修正 move/copy 移除判定
- **需求**：中转区当前拖出成功后条目会自动消失（符合中转语义）；新增设置开关，开启后除非用户手动删除，条目移出/拖出后不再自动消失；关闭（默认）保持现状——确认成功移出后才消失。
- **前置排查**：确认现有"消失"只发生在拖出（`drag-out-done` 事件里 `event.payload==="move"` 分支 + 单 text 非 move 的 copyAndPaste 回退分支），点击"取走"/批量"取走"从不移除条目（只粘贴，早已如此，非本次改动范围）。
- **实现（纯前端，无需 Rust 同步，因为移除逻辑本就在 `App.tsx` 的 JS 事件监听里）**：新增 `stagePersist` state + `stagePersistRef`（供事件监听闭包读最新值）+ `changeStagePersist`（`store.set("stage-persist",v)`，无 invoke）；启动时从 store 读取回填。设置面板「中转站」tab 新增开启/关闭行（`seg-btn`，复用 `dragoutAutoClose` 同款样式，On/Off 直写而非查字典——沿用续85 撞 key 教训）。
- **GUI 首轮反馈（用户）**：test 未通过——text/image 条目移出后仍留在中转区。**根因**：`drag-out-done` 沿用续71 老逻辑「仅 `effect==="move"` 才移除、`copy` 保留」，但文件跨盘拖出、image/text 拖到绝大多数非 Explorer 目标 OS 回传的几乎都是 `copy`（`move` 只在同盘 Explorer 间搬移等少数场景出现）——旧逻辑下这些条目哪怕投放成功也从不消失，与本次「移出即消失」的直觉不符。
- **修正**：移除判据从 `event.payload==="move"` 放宽为 `event.payload==="move"||"copy"`（新变量 `dropped`，取消/`"none"` 除外）——**任何成功投放**都算移出，是否真移除仍受 `stagePersistRef` 门控（「确保成功移出再消失」语义不变，只是"成功"的定义从"仅 move"扩到"move 或 copy"）。顺手修正单 text 回退分支的取消场景误触发（原条件在 `"none"` 时也会误进分支多按一次粘贴）。副作用：内部拖入启动台等区内落点场景现在也会因此让条目移出中转区（此前 copy 效果不移除、条目会同时留在中转区和启动台）——判定为合理一致行为。
- **验证**：`npx tsc --noEmit` 零错误。**GUI 二轮复测待用户**（无法模拟真实拖拽手势，见〔铁律〕不模拟输入约定）：需覆盖 move/copy 两种效果 × `stagePersist` 开/关两态 × text/image/file 三类型。
- **文件**：`src/App.tsx`。文档同步：DECISIONS §18 续86（标注旧「effect 语义」表废弃）。

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
