# Workbench — 项目记忆（memory）

> **最后更新**：2026-07-10（续96 前端重构+2 fix / 续97 多选拖出误删修复，均已确认测试通过并提交 `772b2ce`+版本 `99376a3`，见 §0）
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

### 续97（2026-07-10，src/App.tsx，用户已确认测试通过并提交）——中转区多选拖出「什么也不做却误删」修复（首版 pending 方案已回退）
- **现象**（用户报）：中转站多选若干条目后，在区内小幅拖动再立刻松手（并未拖到任何外部目标），被选中项也被删除；单个条目拖动无此问题。持久化关闭时的预期是「成功拖到外部落地后才消失」。
- **根因**：多选/搜索态超阈值即 `beginNativeDragOut` 起 native OLE（`DoDragDrop`）。区内快速松手时落点落在**自身 overlay 的 IDropTarget**（`dragdrop.rs`）——它对含 CF_HDROP 的拖入 `accept` 并回传 `DROPEFFECT_COPY`（`set_effect`），Rust emit `drag-out-done="copy"` → un9 判 `dropped=true` 非持久化 → 删条目。**单项无此症**：单项先进 `reorder`（纯 JS FLIP），只有光标离开 `.drop-area` 才升级 native，小幅拖动+松手只是重排提交、永不 OLE。
- **首版方案（已回退）**：给多选/搜索态加 `pending` 态、与单项一样等光标离开 `.drop-area` 才 `beginNativeDragOut`。用户实测：**多选拖到外部无法落地**（原拖出功能失效），单项仍正常——**延迟起 OLE 破坏了多选原生拖出的成功投放**（单项 reorder→native 之所以行得通有其自身链路，多选照搬失败，根因未深究，因方向本身错——不应改拖出起手时机）。已完整回退全部 pending 改动（类型/init/move/up 复原）。
- **改采方案（落点结果侧，不碰拖出起手时机）**：新增 `droppedOnSelfRef`。① `beginNativeDragOut` 起手清 false；② `files-dropped` 内部落点分支（`internalDrag && !inLauncher`，即落回自身 overlay 非启动台）置 true；③ `drag-out-done`(un9) 开头若命中则复位标志 + 清 `draggedIds` + **直接返回不删不清选区**。
- **成立依据**：`dragdrop.rs` Drop 中 `accept = !paths.is_empty()`，`emit("files-dropped")` 与 `set_effect(copy)` **同一 `accept` 门控**——故「落回自身且回传 copy」⟺「files-dropped 必被 emit」，标志一定被置上；且 files-dropped 在 DoDragDrop 阻塞期内 emit（早于其返回后 emit 的 drag-out-done），前端按序处理、标志同步先置（handler 首个 await 前）。真正拖到外部落地：落点非本窗口→无 files-dropped 自标记→照常删。附带修复 keepOpen 模式「多选拖回区内也被误删」的同源变体。
- **验证**：`npx tsc --noEmit` + `npm run build` 均零错误；拖拽无法模拟输入，用户 GUI 实测确认：①多选区内小幅拖动+松手不删/不掉选区；②多选拖到外部文件夹**恢复正常落地并消失**（首版回归点）均通过。CLAUDE.md 反查表行已改写为落点侧方案。
- **提交**：`772b2ce`（refactor 续96+续97 代码合并提交）+ `99376a3`（chore 版本号 0.3.7→0.3.8，PATCH）。
- **文件**：`src/App.tsx`（`droppedOnSelfRef` + `beginNativeDragOut`/`files-dropped`/`drag-out-done` 三处）。

### 续96（2026-07-10，src/App.tsx + src/App.css + 新增 src/lib/format.ts·src/lib/fuzzy.ts·src/icons.tsx，用户已确认测试通过并提交）——前端可维护性重构 + 2 处小 bug 修复
- **触发**：用户问「前端/界面有什么值得优化」，静态审查后按「先修 2 个实害 → 再抽纯函数+SVG」的优先级推进（未动最高危区）。
- **bug①（实害）**：剪贴板历史列表 `filteredClip.map((c,i)=><div key={i}>`（`App.tsx`）。新复制项 **prepend 到头部**，用 index 做 key 会让 React 错位复用 DOM——每个 clip-block 挂着 pointer 拖拽 handler + `copiedTime` ✓ 反馈 + 图片 src，可能导致复制后拖拽态/✓ 串到相邻卡。改 `key={c.time}`（`time` 本就是删除/✓ 判定的 identity，唯一）。
- **bug②（主题漏配）**：`.stage-card-actions`（方格卡片悬浮操作栏）底色硬编码 `rgba(30,30,30,0.90)`，`.stage-card-act-btn` 白字——浅色主题下黑帯突兀 + 图标不可见。加 `[data-theme="light"]` 上书：操作栏改 `rgba(245,245,247,.94)`、按钮 `rgba(0,0,0,.08)` + `color:var(--text)`（SVG 走 currentColor 自动变深）。
- **重构③（抽文件降 monolith）**：App.tsx 曾 2141 行单文件单组件。抽出——
  - `src/lib/format.ts`：`IMG_EXTS`/`fmtSize`/`ago`（带 TFunc）/`extIcon`/`dirOf`，React 无依赖纯函数。
  - `src/lib/fuzzy.ts`：`MatchResult`/`fuzzyScore`/`typeKeywords`/`matchItem`，模糊搜索纯函数。
  - `src/icons.tsx`：`IconCheck/IconCopy/IconTrash/IconOpen/IconPin/IconSearch`——替换 App.tsx 里各重复 4~6 次的内联 12/16/18px SVG（copy/check 三元、trash ×3、search ×3 等）；全部 `stroke="currentColor"` 保持原色继承。设置齿轮 + 文件夹 SVG（各 1 处、个例）保留在 App.tsx（剩 2 个 `<svg>`）。
  - App.tsx 减到 ~2000 行；`getFileIcon`（依赖 ClipItem 类型）、`HighlightText`（JSX 小组件）留在 App。`MatchResult` 在 App 未再直接用，已从 import 去掉（避 `noUnusedLocals`）。
- **验证**：`npx tsc --noEmit` 零错误；`npm run build` 通过（version-check 一致 + 41 modules transformed，较重构前 +3 文件）。纯移动/替换无行为变更；拖拽/主题交互链路无法模拟输入，用户 `npm run tauri dev` GUI 确认通过。
- **提交**：与续97 合并为 `772b2ce`（refactor 前端重构+3 修复）+ `99376a3`（chore 版本号 0.3.7→0.3.8，PATCH）。因 App.tsx 同时含续96/续97 改动、无法按文件切分，两会话代码合并为一个 commit。

### 续95（2026-07-09，src-tauri/src/clipboard.rs + src/App.tsx + src/App.css，用户已确认测试通过并提交）——cmd 图片粘贴路径回退 + 剪贴板截图拖拽修复
- **bug①：中转区图片/截图点击后粘不进 cmd/Windows Terminal**。排查 `set_clipboard_image`（`clipboard.rs:710`）确认：目标窗口走三分叉里的分支③（其余 app，写 CF_DIB 位图），而控制台（conhost/Windows Terminal）粘贴只解析 CF_TEXT，位图对它没有任何可解释含义——脱离本应用手动复制图片到 cmd 按 Ctrl+V 同样无反应，是控制台能力边界不是本应用 bug。
  - **方案**（用户选择"实现路径回退"而非"仅说明限制"）：新增判断 `class1=="ConsoleWindowClass"||"CASCADIA_HOSTING_WINDOW_CLASS"` 的分支，退化为把该图片落盘路径（大图复用已有 `orig_path`，小图现解码落一份 PNG 到 `clip_images/`）当**文本**写回剪贴板 + Ctrl+V，给出可用结果而非静默无反应。原三分叉→四分叉，`CLAUDE.md` 对应铁律描述与反查表已同步更新。
- **bug②：剪贴板历史里的截图/图片条目拖不进中转区**（其他类型条目可以正常拖）。根因：`.clip-image`（`App.tsx:1792`）的 `<img>` 漏了 `draggable={false}`，CSS 也没有 `-webkit-user-drag:none`——WebView2 原生图片拖拽会抢走指针序列，导致 `handleClipPointerDown/Move/Up` 这套自定义"按下→移动超阈值→落中转区"拖拽逻辑从未激活；文本/文件条目渲染的是纯文本/图标 span，无 `<img>` 元素，故不受影响。这正是 `CLAUDE.md` 死胡同表已记录过的坑（WebView2 原生 `<img>` 拖拽抢手势），本次是漏了 `.clip-image` 这一处没打补丁。补齐 `draggable={false}` + CSS `-webkit-user-drag:none;user-select:none`，与 `stage-card`/`app-tile` 等既有图片元素做法一致。
- **验证**：`cargo check --lib`（bug①）、`npx tsc --noEmit`（bug②）均零警告零错误；两个 bug 均为真实交互链路（cmd 粘贴 / 跨面板拖拽），无法模拟输入验证，用户分别在 `npm run tauri dev` 中 GUI 实测确认通过。
- **提交**：`ff0bea6`（fix cmd 路径回退）+ `eeff496`（fix 截图拖拽）+ `687fffc`（chore 版本号 0.3.6→0.3.7，PATCH）。
- **文件**：`src-tauri/src/clipboard.rs`（`set_clipboard_image` 新增控制台分支）、`src/App.tsx`（`.clip-image` 加 `draggable={false}`）、`src/App.css`（`.clip-image` 加 `-webkit-user-drag:none;user-select:none`）、`CLAUDE.md`（四分叉描述 + 反查表新增一行）。

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
