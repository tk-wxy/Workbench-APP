# Workbench — 项目记忆（memory）

> **最后更新**：2026-06-26（续48：收录 Tab 为主键 + 修 Tab 焦点逃逸 bug）
>
> **关联文档**：规则铁律看 `CLAUDE.md`；决策根因看 `DECISIONS.md`；本文件 = 项目现状快照 + 变更记录。
>
> **维护方式**：
> - 标〔快照〕的小节 = 覆盖更新，反映当前真实状态
> - 标〔追加〕的小节 = 只往后加
> - 每次结构性改动完成后：① 更新对应〔快照〕 ② 追加「变更记录」 ③ 改顶部日期

---

## 0. 当前状态 / 下一步 〔快照〕

- **当前稳定**：Ctrl+Space 热键（长按 momentary + 短按 toggle，键态轮询驱动）+ Esc 关闭 + light dismiss（点外部应用自动隐藏）+ 三类型剪贴板（文本/图片/文件）粘贴（含桌面落地）+ 后台监听 + 全屏无缝 + 呼出白闪修复 + 剪贴板条目删除 + 设置面板（**左侧条目导航 + 右侧详情**：常规/剪贴板/快捷键/关于）+ 去阴影（`set_shadow(false)`）+ 底部蓝缝消除 + 底部贴齐任务栏顶（`clamp_window_bottom` 修 set_shadow 后 WebView 遮任务栏）+ 剪贴板卡片「只复制到剪贴板」按钮（不粘贴、seq 水位防回流）+ **剪贴板历史持久化**（落盘 `clip_history.json`，重启后历史完整读回）+ **剪贴板历史条数可配置**（设置面板四档 10/20/50/100，默认 20，持久化重启保留）+ **开机自启可配置**（设置 → 常规 → 开启/关闭，`tauri-plugin-autostart` 写注册表）+ **历史图片粘贴原图**（落盘 `clip_images/{time}.png`，detached write，小图跳过，设置面板「打开文件夹/清空缓存」）+ **中转区多选 + 批量操作**（Ctrl/Shift 多选，批量取走/复制/删除，仅 file 同质可批量上剪贴板）+ **增强搜索独立页**（Ctrl+K 呼出同 overlay 内视图层，搜应用 + 中转 file 条目，↑↓ + Enter 激活，纯前端）+ **顶栏普通搜索四区联动**（输入即同时过滤启动台/中转/剪贴板，名称内容优先 + 类型词叠加，与 Ctrl+K 独立）+ **启动器收藏托盘**（手动策展持久化，app picker，.lnk 拖入提取图标存 kind:"app"，S3a/S3b/S3c GUI 实测通过 2026-06-25）+ **增强搜索接入文件系统**（Ctrl+K 分两组 Tier1+Tier2，文件结果分隔线+防抖+未就绪提示，filesearch.rs 后台索引，S4a/S4b/S4c GUI 实测通过 2026-06-25）+ **自定义热键 V2**（V2-1：`parse_combo` 表驱动任意组合，53 条主键，三键 GUI 实测通过；V2-2：正式文本输入 UI + Enter 触发 + 格式提示 + 底栏动态 kbd + `changeHotkey` 类型放宽为 string + 清理 PROBE/V21-TEMP，**全部 GUI 实测通过（2026-06-25）**）
- **已完成（全部 GUI 实测通过）**：启动器重设计——S3a✓（持久化收藏托盘 + app picker）+ S3b✓（拖入落点双区判定）+ S3c✓（.lnk 拖入提取图标+名称→ kind:"app"）；增强搜索 Tier 2——S4a✓（filesearch.rs 文件系统后台索引）+ S4b✓（前端 Ctrl+K 接入文件结果，分组+分隔线+防抖）+ S4c✓（应用扫描改后台预建，消除首次呼出卡顿）。**所有功能 2026-06-25 GUI 实测通过。**
- **新增（续48，前端 + Rust）**：**收录 Tab 为主键 + 修 Tab 焦点逃逸 bug**。① **Tab 可录用**——原 token 表无 Tab（53 条），现前端 `tokenFromCode`/`HOTKEY_MAIN_TOKENS`/`comboLabel` + Rust `key_token`（`VK_TAB`/`Code::Tab`）各加一条（54 条）；裸 `Alt+Tab`（OS 窗口切换）进黑名单（同 Alt+Space/Alt+F4）。② **焦点逃逸 bug**——根因：设置打开时 `if(settingsOpen||pickerOpen)return;` 在 Tab 处理前早退 → 浏览器默认 Tab 遍历生效 + 模态无 focus trap → 焦点跳到背景按钮；关设置后旧 `Tab→filteredApps 导航`（S3a 后已不渲染）preventDefault 吃键无可见效果 → "没反应"。修复：删死的 filteredApps Tab 导航，改为 overlay 可见时统一 `if(e.key==="Tab"){preventDefault();return;}`（放在 settingsOpen 守卫**前**、matchComboEvent **后**）——焦点不再逃逸；Tab 作热键仍由 matchComboEvent 先处理。⚠️ 副作用：设置面板内 Tab 不能在输入框间跳（需点击；如要面板内循环再加 focus trap）。**tsc 零错误 + clippy 8 基线✓；GUI 未实测**（需验证：录 Tab/Ctrl+Tab、设置内 Tab 不逃逸、关设置 Tab 无副作用）。文件：`src/App.tsx` / `src-tauri/src/lib.rs`。
- **新增（续47，纯前端，零 Rust 改动）**：**增强搜索键（Ctrl+K）也可自定义**——原硬编码 `(e.ctrlKey||e.metaKey)&&key==="k"` 改为读 `enhHotkey` state（默认 `ctrl+k`，store key `enh-hotkey` 持久化）。增强搜索是**应用内快捷键**（仅 overlay 可见时生效、纯前端、不经 Rust/RegisterHotKey），与主呼出热键性质不同。复用录制基础设施：`recording` state 由 boolean 改为 `null|"main"|"enh"` 标记录哪个键，录制 useEffect 按 target 写回对应输入框。新增模块级共用工具 `tokenFromCode`（从录制 effect 提升）/ `parseComboStr`（解析+校验，规则同 Rust：禁 Win + 裸 Alt+Space/Alt+F4 + 恰 1 主键）/ `matchComboEvent`（keydown 精确匹配：修饰键全等 + 主键一致 + 无 Win）/ `comboLabel`（展示文案）。`changeEnhHotkey` 纯前端校验（非法/与呼出热键冲突→红字 2.5s）+ 持久化。设置→快捷键 tab 加「增强搜索」行（录制+应用+恢复默认，复用 `.hotkey-input`/`.settings-action`）；底栏改用 `comboLabel` 渲染主键 + 增强键。**tsc 零错误✓；GUI 未实测**（需 `npm run tauri dev` 验证：录制 Ctrl+K 替代键、按新键开关增强搜索、冲突拒绝、重启持久化）。文件：`src/App.tsx`（+4 module helper +3 state +changeEnhHotkey +录制 target 化 +keydown matchComboEvent +设置行 +底栏）。
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
- **下一步（候选，无阻塞）**：① 启动器键盘导航（←→↑↓ + Enter）；② 文件结果右键「打开所在目录」(`reveal_in_explorer`) + 高亮区间回传（Rust 回传命中 ranges）；③ 索引目录可配置（设置面板扩项）；④ 增强搜索 Tier 2 剩余（剪贴板条目纳入）；⑤ file/folder 收藏的非拖入入口（如文件选择对话框）；⑥ **拖出（drag-out）未做**（需 `DoDragDrop`/`IDataObject` FFI，优先级低）；⑦ T9 渲染进程重建后拖入失效（已知罕见限制，低优先级）
- **新增（2026-06-25，纯前端，零 Rust 改动）**：**顶栏 search 联动启动台过滤**——`filteredLauncher` useMemo（`search` 非空时 `launcher.filter(it => matchItem(q, it.name, []))`，空时直接返回 launcher）；JSX 数据源 `launcher.map` → `filteredLauncher.map`；空态 hint 区分「无收藏：拖入或点添加」vs「有收藏但无匹配：无匹配」。「＋ 添加」卡片不参与过滤（始终在 launcher-add 独立渲染）。**tsc 零错误✓；GUI 实测通过（2026-06-25）**
- **阻塞 / 待决策**：← 无

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
  lib.rs           # 主逻辑：窗口全屏、热键 handler、剪贴板后台线程、Tauri 命令（~620行）
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

- ✅ 全局热键呼出/隐藏（Ctrl+Space）：键态轮询驱动，**长按 momentary（按住显示/松开关闭）+ 短按 toggle**
- ✅ 全屏窗口 + 毛玻璃背景（`transparent:true` + `backdrop-filter: blur`）
- ✅ 全屏缝隙修复（SPI_GETWORKAREA + 动态 offset 补偿）
- ✅ 系统托盘常驻 + 开机自启
- ✅ 应用启动器（扫描 Start Menu / 图标提取 / 点击启动 / **使用排序：频率为主×近期乘数（`count×0.5^(age/30天)` 时间衰减），响应式** / **模糊搜索：子序列打分(模糊+缩写) + 相关度排序 + 命中高亮** / 键盘导航 ←→↑↓ + Tab 循环 + Enter）
- ✅ 剪贴板文本（复制/粘贴，auto Ctrl+V 到焦点窗口）
- ✅ 剪贴板图片（后台缩略图缓存/历史切换粘贴/原图 Ctrl+V/aHash 去重）
- ✅ 剪贴板文件（CF_HDROP 格式检测/写入/粘贴，单文件+多文件）
- ✅ 文件中转区（**混合条目**：文件/文本/图片；剪贴板📌钉入 + 单击取走粘贴/复制/打开/删除；持久化 `stage-items`，旧 `file-list` 迁移。拖入待阶段2实测）
- ✅ 快捷入口（常用 Windows 位置快速打开）
- ✅ 剪贴板卡片「只复制到剪贴板」按钮（不粘贴/不隐藏 overlay，自行 Ctrl+V；seq 水位 `SKIP_CLIP_UNTIL_SEQ` 防自写回流历史；复制钮 ~1s ✓ 反馈）
- ✅ Esc 关闭（已修复幽灵界面：改接 Rust `window.hide()` + `emit hotkey-hide` 状态同步）
- ✅ 呼出白闪（已修复：emit hotkey-show 提前到 show 前预渲染，set_focus 延迟 50ms 线程执行）
- ✅ 设置面板（顶栏齿轮 → 居中模态）：背景主题（深色/浅色/系统默认，CSS 变量 + data-theme 切换）+ 清空剪贴板历史 + 关于/版本
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
| `search_files` | 文件系统搜索：纯内存子串打分查询后台索引（µs 级，限 50 条）|
| `get_index_status` | 返回文件索引状态 `{ready,count}`（前端显示「建立中…」用）|
| `resolve_lnk` | 解析 .lnk 快捷方式：提取图标 + 去后缀名称（拖入启动器存 kind:"app"）|
| `set_hotkey` | 运行时切换呼出热键：白名单 parse_combo → register(new) 成功 → unregister(old) → 更新 HOTKEY_VK_KEYS/CURRENT_SHORTCUT；失败保留旧组合并 Err；不写 store（持久化前端负责）|

**事件**（Rust `emit` → 前端监听）：
| 事件 | 用途 |
|------|------|
| `hotkey-show` / `hotkey-hide` | 热键 toggle 同步前端 visible 状态 |
| `clipboard-update` | 后台监听检测到新剪贴板内容，实时推送 |
| `file-index-ready` | 文件索引后台线程每次建/重建完成推送条目数（前端增强搜索据此置 indexReady）|
| `apps-ready` | 应用扫描后台线程（start_apps_worker）扫完一次性推送 apps 列表（消除首次呼出卡顿）|
| `files-dropped` | 原生拖入：`{paths,x,y}` 物理像素，前端判落点入启动器/中转 |

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

## 九、变更记录 〔追加〕

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
