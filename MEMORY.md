# Workbench — 项目记忆（memory）

> **最后更新**：2026-06-20
>
> **关联文档**：规则铁律看 `CLAUDE.md`；决策根因看 `DECISIONS.md`；本文件 = 项目现状快照 + 变更记录。
>
> **维护方式**：
> - 标〔快照〕的小节 = 覆盖更新，反映当前真实状态
> - 标〔追加〕的小节 = 只往后加
> - 每次结构性改动完成后：① 更新对应〔快照〕 ② 追加「变更记录」 ③ 改顶部日期

---

## 0. 当前状态 / 下一步 〔快照〕

- **当前稳定**：Ctrl+Space 热键（长按 momentary + 短按 toggle，键态轮询驱动）+ Esc 关闭 + light dismiss（点外部应用自动隐藏）+ 三类型剪贴板（文本/图片/文件）粘贴（含桌面落地）+ 后台监听 + 全屏无缝 + 呼出白闪修复 + 剪贴板条目删除 + 设置面板（主题/清空剪贴板/关于）+ 去阴影（`set_shadow(false)`）+ 底部蓝缝消除 + 底部贴齐任务栏顶（`clamp_window_bottom` 修 set_shadow 后 WebView 遮任务栏）+ 剪贴板卡片「只复制到剪贴板」按钮（不粘贴、seq 水位防回流）
- **进行中**：← 无
- **下一步**：文件中转区独立于剪贴板文件历史；设置面板可继续扩项（开机自启开关等）；长按阈值/采样率体感微调（`HOTKEY_TAP_MAX_MS`/`HOTKEY_POLL_MS`）；搜索高亮"最优对齐"（当前贪心子序列，高亮非词首）
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
  apps.rs          # 应用扫描：Start Menu .lnk 解析、ExtractIconEx 图标提取、get_file_info
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
- ✅ 文件中转区（拖入暂存/元信息显示/拖出/持久化到 store）
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
| `set_clipboard_image` | 图片粘贴：历史图写回剪贴板 + 焦点交还 + Ctrl+V |
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
| `copy_image_to_clipboard` | 只复制图片（缩略图）到当前剪贴板（同上）|
| `copy_files_to_clipboard` | 只复制文件 CF_HDROP 到当前剪贴板（同上）|

**事件**（Rust `emit` → 前端监听）：
| 事件 | 用途 |
|------|------|
| `hotkey-show` / `hotkey-hide` | 热键 toggle 同步前端 visible 状态 |
| `clipboard-update` | 后台监听检测到新剪贴板内容，实时推送 |

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
- **剪贴板图片**：历史图片粘贴的是缩略图(1024px)非原图（`set_clipboard_image` 从系统剪贴板重读原图，当前图有效，历史图只有缩略图）
- **「只复制」图片粘不进文件夹/桌面**：copy_image 放位图(CF_DIB)，只粘进图片类目标（输入框/Word/画图）；文件夹/桌面只收 CF_HDROP 文件。**已决定保持位图**（用户 2026-06-20 确认，不做双格式/临时 PNG 方案，别当 TODO 去"修"）。若日后真要支持：copy_image 同时落临时 PNG + 写 CF_HDROP（双格式上剪贴板）
- **多显示器**：当前仅适配主显示器工作区

---

## 九、变更记录 〔追加〕

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
