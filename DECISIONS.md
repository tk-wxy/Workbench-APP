# Workbench App — 架构决策与踩坑根因

> 本文件记录"为什么这样做"和"哪些路走不通"。需要硬规则（怎么做、别碰什么）看 `CLAUDE.md` 的【铁律】；本文件是其背后的证据与根因。

## 目录（按主题）
- **热键**：§1 RegisterHotKey vs 自建钩子 · §2 放弃长短按 · §9 修饰键选择
- **窗口 / 焦点 / 渲染**：§4 透明 vs 不透明 · §5 全屏缝隙(outer≠inner) · §8 前端状态 + Esc 幽灵界面 + 呼出白闪
- **剪贴板 / 粘贴**：§3 粘贴可靠性 6 轮演进 · §6 后台缓存架构 · §7 CF_HDROP/DROPFILES · §10 检测优先级(截图去重) · §11 桌面 SHFileOperation 兜底 + fFlags
- **其他**：§12 Git 版本历史（关键节点）

---

## 1. 全局热键：RegisterHotKey vs 自建钩子 vs 键态轮询

**最终方案（2026-06-18 演进）**：**`GetAsyncKeyState` 物理键态轮询**驱动 show/hide（`start_hotkey_monitor`，25ms 读 MSB）；`RegisterHotKey`（`tauri-plugin-global-shortcut`）降级为**仅消费 Ctrl+Space**（空 handler，防漏键给前台），不再承担 show/hide。Ctrl+Space。

> 早期（2026-06-14 ~ 06-15）为纯 toggle、由 RegisterHotKey 的 Pressed 事件驱动 + 50ms 防抖过滤 key repeat。06-18 实现"长按 momentary + 短按 toggle"时，证明 RegisterHotKey 事件不堪用（§2），改走键态轮询。

### 踩坑路径

| 尝试 | 技术 | 失败原因 |
|------|------|----------|
| 1 | `rdev::listen` | WebView2 获得焦点后 KeyRelease 丢失，走普通消息队列 |
| 2 | `windows-sys` + `WH_KEYBOARD_LL` | 消息队列未初始化（缺 `PeekMessageW`），回调永不触发 |
| 3 | 修复后 WH_KEYBOARD_LL | `KBDLLHOOKSTRUCT.vkCode` 报告 `0xA4`(VK_LMENU)，代码检查 `0x12`(VK_MENU) |
| 4 | 修复虚键码后 | Windows key repeat 不断重置 timestamp，长按误判 |
| 5 | `KEY_IS_DOWN` 防 repeat | 代码复杂度失控，Tauri 进程内独立线程消息循环稳定性不确定 |

**结论**：OS 级钩子的正确性依赖极精确的 Win32 消息循环编排，一行错步步错。插件封装好的 API 比自己写的可靠一个数量级。

> 该方案的遗留实现 `src-tauri/src/hotkey.rs`（自建 `WH_KEYBOARD_LL` 钩子）已于 2026-06-18 删除——它从未被 `mod` 声明、不参与编译，留着只会误导。本节保留作为踩坑记录。

---

## 2. 长短按判定：从"彻底放弃"到"换信号源做成"

**最终方案（2026-06-18）**：用 `GetAsyncKeyState` 轮询物理键电平做长短按区分，**成了**。
- 长按（`held > HOTKEY_TAP_MAX_MS=250ms`）= momentary：按下开、松开关。
- 短按（`held ≤ 250ms`）= toggle：按下沿开、松开不关；下一次短按才关（用"按下瞬间窗口是否已可见"区分开/关态）。

**当年为何放弃（仍成立的死路）**：`RegisterHotKey` 的 `Pressed`/`Released` 经 Windows 消息队列异步投递，两台真机实测 500-800ms 抖动；用两个异步事件的时间差判物理按键时长，本质不可靠。阈值 200/300/500ms 全失败——**问题在信号源，不在阈值**。

**这次为何成（关键洞察）**：根因是"信号源是事件"，不是"长短按思路不可行"。换一条**从未试过**的信号源——`GetAsyncKeyState` 读物理键电平（MSB=当前是否按下），它不经消息队列、不依赖焦点、不受 key repeat 影响。

**Spike 实测数据（2026-06-18，真机）**：
- 松开沿：每个 DOWN 恰好跟随 1 个 UP，**零丢失**（rdev 在 WebView2 抢焦点后丢 KeyRelease 的反面）。
- 时长：TAP held=52/153/52ms vs HOLD held=583~1165ms，拉开数百 ms，250ms 阈值安全。
- 抖动：一次物理按住 = 1 DOWN+1 UP，**MSB 无抖动**（vs RegisterHotKey 的 500-800ms）。
- 泄漏：纯轮询不消费按键 → 故保留 RegisterHotKey 空 handler 仅作"消费"屏蔽（见 §1）。

**轮询代价**：25ms × 2 次 `GetAsyncKeyState`（µs 级 syscall）+ 常驻线程，开销可忽略。

> 验证用的隔离 spike（env 门控 → 默认激活 → 混合语义三次迭代）见 git 历史 `73046e3`/`708939d`/`8dfea37`；转正后临时记录 `SPIKE-keystate.md` 已删除，结论并入本节。

---

## 3. 粘贴可靠性：6 轮方案演进（从 33% 到 100%）

**最终方案**：`arboard.set_text` → `window.hide` → `sleep(150ms)` → `GetForegroundWindow` → `SetForegroundWindow` → `enigo Ctrl+V`。

| 轮次 | 方案 | 成功率 | 原因 |
|------|------|--------|------|
| 1 | `enigo Key::Unicode('v')` + `Click` | 33% | `SendInput` 对 Unicode 键投递不稳定 |
| 2 | `enigo Key::V` + `Press/Release` | 50%（交替） | 交替说明 `SendInput` 可靠性问题，非代码逻辑 |
| 3 | `SendMessageW(WM_PASTE)` | 0% | `windows` 0.58 的 `Param<T>` 泛型与剪贴板 API 类型不兼容 |
| 4 | sleep 500ms + 键间隔 20ms | 25% | 单纯延时不能解决 `SendInput` 底层问题 |
| 5 | `SetForegroundWindow` + sleep + enigo | **100%** | 关键——`SetForegroundWindow` 强制刷新焦点队列 |
| 6 | `WS_EX_NOACTIVATE` + 无 hide | 0% | 架构死胡同：点击时 WebView2 内部 `SetFocus` 抢占键盘路由，外部进程无权推回 |

**焦点交还机制**（统一复用于文本/图片/文件粘贴）：
```
window.hide() → sleep(150ms) → GetForegroundWindow → SetForegroundWindow → enigo Ctrl+V
```

---

## 4. 窗口透明 vs 不透明：GPU 合成路径选择

**最终方案**：`transparent: true`，用 CSS `rgba(13,13,15,0.97)` + `backdrop-filter: blur(24px)` 模拟不透明效果。

**根因**：`transparent: false` + 全屏(3.7M px) + `backdrop-filter: blur` 走重量级 GPU 合成路径。每次 `window.hide()/show()` 需重新分配表面/重绘背景，延迟 ~200ms，表现为"空白页后延迟关闭"。

**为什么 blur 本身不慢**：在 `transparent: true` 下，窗口走 DWM 层合成，`hide()/show()` 只是 visibility flag 切换，零开销。blur 的 GPU 计算在合成层完成，与显隐无关。

---

## 5. 全屏缝隙：outer_size ≠ inner_size

**根因**：`decorations: false` 的无边框窗口仍存在 `outer_size - inner_size` 的固定内边距。200% DPI 下实测为 26×15px，`window.set_position(0,0)` 让 outer 对齐屏幕但 inner 被推偏。

**修复**：
1. 用 Windows `SPI_GETWORKAREA` 获取工作区（排除任务栏）
2. `set_size` 后读 `outer/inner` 差值 → 位置补偿 `(-offset_x, -offset_y)` → inner 对齐屏幕原点
3. offset 完全运行时动态计算，无硬编码像素值

**延伸：去阴影 + 底部蓝缝（2026-06-19，真实根因）**

需求：① 消除窗口投在任务栏上的阴影；② 消除窗口底边与任务栏间一条 ~1-2px 浅蓝细缝。

**两者实为同一个错误的因果链**：最初用 `DwmSetWindowAttribute(DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED)` 去阴影——阴影是没了，但**禁用非客户区渲染会在透明 wry 窗的底边逼出一条实色蓝边**（透明窗靠 DWM 玻璃/`DwmExtendFrameIntoClientArea` 实现，关掉 NC 渲染破坏了它）。蓝缝是我们**自己用错 API 画出来的**，不是漏出任何东西。

**正确修复**：去阴影改用 Tauri 官方 `window.set_shadow(false)`（走正规 DWM margins 路径，不碰透明边）。一行搞定：阴影消、蓝缝无、透明完好、全屏正常。**别再用 `NCRENDERING_POLICY=DISABLED` 去阴影。**

**再延伸：set_shadow(false) 后 WebView 底边遮任务栏（2026-06-20，续19）**

`set_shadow(false)` 去阴影后留下一个几何残留：透明无边框窗的 `WRY_WEBVIEW` 子窗填满**外框**（含 outer−inner 的隐形边框），底边落在 `outer.bottom` 而非 `inner.bottom`。200% DPI 实测 outer 比工作区底（任务栏顶=1904）低约 7px → 深色 overlay 盖住任务栏顶部一条（不是缝，是 overlap）。

**修复**：`clamp_window_bottom(window, work_bottom)`——`set_shadow(false)` 调用后量 `GetWindowRect`，若 `overlap = wr.bottom - work_bottom > 0`，用 `set_size` 等量缩减 inner 高度（保持顶边、从底部往上收）；无越界不动。运行时动态测量，无硬编码像素。诊断（临时 `diag_geom` 写 `%TEMP%\workbench_geom.txt`，事后已删）确认修正后 outer 与 WRY_WEBVIEW 的 bottom 均=1904，精确贴齐任务栏顶——既不遮挡也无缝。HWND 取法同续12 附录（裸指针重建本 crate windows 0.58 的 HWND，避版本冲突）。

**❌ 排查中验证失败的死路（按序，别重走）**：
1. `DWMWA_BORDER_COLOR = COLOR_NONE` / `WINDOW_CORNER_PREFERENCE = DONOTROUND` — 无效（不是 DWM 窗口边框）。
2. 改 / 关「任务栏显示强调色」— 蓝缝不变（不是任务栏 accent 线）。
3. height+2 几何延伸（Plan B）— 蓝缝随窗口下移压住任务栏，没消（缝贴着窗口，不是外部固定物）。
4. `tauri.conf.json` `backgroundColor=[0,255,0,255]` — 缝不变绿（注意：透明窗会忽略它，**此测试是假阴性**，不能据此排除原生背景）。
5. `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_NONE` — API ok 但无效（不是 Mica/Acrylic 材质）。
6. `SetWindowPos` 拉高 `WRY_WEBVIEW` 子窗填缝 — 被 `window.show()` 触发的 `WM_SIZE` 重置回原大小，打不赢 wry。
7. 父 HWND 设绿色类背景画刷（`SetClassLongPtrW`+`GCLP_HBRBACKGROUND`）— 缝不变绿（缝不在客户区，在非客户层；也可能透明窗不走类画刷擦除）。
8. `DWMWA_EXTENDED_FRAME_BOUNDS` 下移整窗对齐工作区底 — 缝随窗口下移、压住任务栏（同 height+2，确认缝贴着窗口内容移动）。

**决定性诊断**：单变量关掉 `disable_shadow`（保留其余不动）→ 蓝缝消失、阴影回归 → 锁定 `disable_shadow` 即元凶。教训：**改完一个东西后出的新问题，优先怀疑那个改动本身，别假设是独立的外部因素**（这次绕了 8 条死路才回头查自己加的 `disable_shadow`）。

**附**（已随本次清理移除）：曾因 `window.hwnd()` 的 HWND 来自 Tauri 内部 windows-core 0.61、与本 crate windows 0.58 的 `Param<HWND>` 不兼容，改用过 `raw_window_handle` 取原始指针重建 HWND。现 DWM 调用全删，`raw-window-handle` 依赖与 `Win32_Graphics_Dwm` feature 一并移除。

---

## 6. 剪贴板架构：实时编码 → 后台缓存

**变更**：窗口弹出时从"实时读剪贴板+编码"改为"读内存缓存"。

**旧问题**：弹出时 `read_clipboard` 读取大图 → `image` crate 编码 PNG(~3s) → Base64(~1s) → IPC 传输 → 前端渲染。全屏截图时有数秒延迟。

**新方案**：
- 后台线程每 `CLIP_POLL_MS` 轮询 `GetClipboardSequenceNumber`（µs 级）
- 变化时：读→缩放(>1024px→1024px Triangle)→编码→存 `CLIP_CACHE`→emit 推送
- 弹出时：直接读缓存，毫秒级

**采样塌缩 / 轮询间隔（快速连续复制丢条目，2026-06-18）**：轮询是"每隔一段去看一眼"，若两次复制（A→B）落在同一采样窗口内，醒来时只读到当前的 B，A 的内容已被覆盖、从剪贴板消失、**事后不可恢复** → "复制两个少一个"。这是轮询式监听的固有局限（与去重无关——不同内容不会被去重）。缓解：`CLIP_POLL_MS` 由 800ms 压到 150ms，把塌缩窗口缩到手动连复制（两次通常 >300ms）抓得住的程度；seq 检查是 µs 级，提频近乎零成本，故**别再把它调大**。残留：<150ms 的脚本级超快连发仍可能塌缩——要彻底根治需改**事件驱动**（`AddClipboardFormatListener` + `WM_CLIPBOARDUPDATE`，每次变化即时读取），代价是引入 message-only 窗口 + 线程消息循环（§1 标注过的风险区，但剪贴板监听比键盘钩子简单得多，是标准做法），暂未采用。

**死循环防御**：`set_image/set_clipboard_files` 写回剪贴板会触发 seq 变化 → 后台检测到 → 跳过。用 `AtomicI32` 计数器（非布尔——arboard 的 get+set 可能触发 2 次 seq 变化）。

**自写跳过：计数 vs seq 水位（2026-06-20，续20「只复制」按钮）**：计数式 `SKIP_CLIP_EVENTS.store(N)` 有个时序坑——监听 150ms 轮询每个 tick 只看"seq 变没变"，**一个轮询窗口内 seq 跳几次都只消费 1 个 skip**。写剪贴板的多次跳变都在微秒内、落同一窗口 → `store(2)` 实际只被消费 1 次、**残留 +1**，去吃掉下一次真实复制（续2 已记）。平时窗口随粘贴即隐、影响小；但「只复制」要求 overlay 保持打开、连续复制多条，残留会反复出现、更易暴露。故新增 **seq 水位** `SKIP_CLIP_UNTIL_SEQ`（`AtomicU32`）：copy_* 写后记当前 `GetClipboardSequenceNumber()`，监听判 `seq ≤ 水位 → 跳过`。seq 单调递增 → 自写必 ≤ 水位被跳、真实复制必 > 水位被收，**与跳变次数/轮询时序无关**，连续复制不残留、不吞后续。选 **additive**（新增水位判断，旧计数 + 两条 paste 路径不动）而非替换，最小化对已测试 paste 的扰动；代价是两套 skip 并存（轻微，二者只是喂同一处跳过决策，非两份数据真相）。微秒级竞态（写完到记水位间若插入真实复制会被一并跳过）概率极低、非致命，接受。

**并发崩 os error 1418 + 剪贴板互斥锁（2026-06-20，续20-fix GUI 实测暴露）**：仅靠水位还不够——图片「复制」实测 `set_image 失败: SetClipboardData ... 1418（线程没有打开的剪贴板）`。根因是**监听读与 copy 写并发抢剪贴板**：`set_image` 内部先 `EmptyClipboard`（让 seq 变）→ 后台监听被这次自写触发、抢先 `OpenClipboard` 去读 → copy 随后的 `SetClipboardData` 撞"本线程没打开剪贴板"。图片必中（`set_image` 多步、open 窗口长），文本/文件写得快侥幸躲过。**为何 paste 没事**：`set_clipboard_*` 写前先 `SKIP_CLIP_EVENTS.store(2)`，监听被自写唤醒时走计数跳过分支、根本不去读 → 不抢；copy 的水位是写后才设、太晚拦不住这次读。**修复=`CLIPBOARD_LOCK: Mutex<()>`** 串行化：监听的 `build_clip_entry` 读 与 copy_* 的写共用此锁。监听**拿锁后重读 seq 并复核水位**（copy 可能在监听等锁期间刚写完抬高水位）→ 既防 1418，又防把 copy 的自写 thumbnail 当新内容回读成重复项。paste 路径不入锁（靠 `SKIP_CLIP_EVENTS` 让监听不读），行为零改动。锁序无环：监听先放 `CLIPBOARD_LOCK` 再取 `CLIP_CACHE`，copy 只取 `CLIPBOARD_LOCK`，无嵌套。

**统一覆盖面：paste 路径也补锁（2026-06-20，续20-fix2 核查）**：续20-fix 只锁了 copy 路径，paste 三命令（`paste_clipboard`/`set_clipboard_image`/`set_clipboard_files`）的写入段当时没锁——之前没崩只是因为它们写前有 `hide()+sleep(150ms)` 把时序与监听轮询错开，是**运气不是保证**（同样的 1418 争用理论上存在）。核查后给四处未持锁的剪贴板段补锁：paste 文本 `set_text`、set_image 非桌面写、set_image 桌面分支读当前图的 `get_image`、set_files 的 `write_cf_hdrop`。**锁粒度铁律——只罩 `OpenClipboard…CloseClipboard` 临界区**：写入者绝不跨 `hide`/`sleep`/焦点交还/`enigo` Ctrl+V 持锁（否则监听被整个 paste dance 阻塞、emit 往返可能死锁）；桌面分支 `SHFileOperation`/`desktop_copy_files` 不碰系统剪贴板、不加锁；`write_cf_hdrop` 被 paste 与 copy 共用 → 锁加**调用方**、不进函数（否则 copy 已持锁再进会**重入死锁**——`Mutex` 不可重入）。至此**全部剪贴板读写都串行**，1418 在 copy 与 paste 两侧均根治。`CLIPBOARD_LOCK`（防并发抢句柄 1418）与 `SKIP_CLIP_EVENTS`/seq 水位（防自写回流历史）是**两层正交防护**，各管各的。

> 一个不变量的边界：监听读为了让"水位复核 + 读取"对 copy 写保持原子，持锁跨**有界 retry-sleep**（`CLIP_READ_RETRIES×CLIP_READ_RETRY_MS`，仅在剪贴板被外部占用、`build_clip_entry` 返回 `Err` 时发生）。这是"锁只罩临界区"的唯一例外，安全：retry 期间外部正占着剪贴板，任何写入者本就 `OpenClipboard` 不进、拿不拿锁都得等，无额外损害（且无死锁，写入者只是 `Mutex` 上阻塞而非失败）。未把监听读重构成逐 attempt 加锁——避免动监听热路径引入新 bug，收益（让"绝不跨 sleep"对监听也字面成立）不抵风险。

**seq 推进时机（快速复制丢条目修复，2026-06-18, `build_clip_entry` 三态）**：原代码在检测到 seq 变化后**立刻** `last_seq = seq`，再去读内容；而快速复制时源程序（Explorer/浏览器）会短暂锁住剪贴板，`OpenClipboard`/arboard 瞬时失败 → 读取分支 `continue`。但 seq 已被消费，下个轮询 `seq == last_seq` 不再重试 → 复制的条目**永久不进历史**（症状：复制过快时偶发"复制后不显示"）。修复原则：**只有成功读到内容（或确认剪贴板可访问但确无可缓存内容）才推进 `last_seq`；读取因占用失败时不推进，留待重试**。`build_clip_entry()` 返回三态——`Ok(Some)` 读到→推进+缓存、`Ok(None)` 可访问但空→推进（避免对不支持格式无限重试）、`Err(())` 被占用→本轮快速重试 `CLIP_READ_RETRIES` 次（间隔 `CLIP_READ_RETRY_MS`），仍失败则不推进、下个轮询周期再试。

---

## 7. CF_HDROP 文件粘贴：DROPFILES 结构体

**技术选择**：raw FFI 而非 `arboard`（arboard 不支持 CF_HDROP 格式）或 `windows` crate（0.58 的 `Param<T>` 泛型与剪贴板 API 不兼容）。

**关键 Bug**：`fWide` 字段设为 0（ANSI）但路径是 UTF-16，导致 Explorer 解析失败。

**DROPFILES 布局**（20 字节头 + UTF-16 路径）：
```
Bytes 0-3:   pFiles = 20
Bytes 4-7:   pt.x = 0
Bytes 8-11:  pt.y = 0
Bytes 12-15: fNC = FALSE
Bytes 16-19: fWide = TRUE  ← 必须为 1
Bytes 20+:   UTF-16 路径（\0 分隔，双 \0 结尾）
```

---

## 8. 前端状态管理：从动画状态机到简化版

**变更历程**：
- 初版：Framer Motion `AnimatePresence` + CSS phase 动画 → 快速 toggle 时动画冲突
- 改版：`visible ? <UI/> : null` 条件渲染 → 组件卸载重建导致闪烁
- 最终：`opacity:0/1` + `pointer-events:none/auto` → 组件不卸载，WebView2 纹理不释放

**interval 泄漏根因**：剪贴板轮询的 `setInterval` cleanup 在 IIFE 内部返回，React `useEffect` 不可见。修复：提升到 `useEffect` 顶层 `return`。

**双重 SHOW 事件**：`hotkey-show` 在同帧内被 emit 两次（间隔 <1ms），导致 `useEffect([visible])` 重复执行。原因未根除但影响已被现有架构吸收（`useEffect` 第二次执行是幂等的）。

**Esc 幽灵界面修复（2026-06-17, `3784f6d`/`14583c0`）**：原 Esc handler 只调 `setVisible(false)`（纯 CSS opacity/pointer-events 切换），从未调 `window.hide()`，Rust 侧 `is_visible()` 始终 true。CSS `pointer-events:none` 不可靠地等同于 OS-level click-through，偶发拦截点击。修复方案：① Rust `hide_window` 命令在 `window.hide()` 后补 `emit("hotkey-hide")` 通知前端同步 visible 状态；② Esc handler 改为 `setVisible(false)` + `hideWorkbench()`（前者即时 CSS 反馈，后者接 Rust `window.hide()`）；③ 热键 show 路径补 `window.set_focus()`（与 `tray_toggle` 对齐）——热键呼出后窗口无键盘焦点导致 Esc 的 keydown 事件无法到达 JS 监听器。Esc 路径不含焦点交还/Ctrl+V，不会误触发粘贴。

**呼出白闪修复（2026-06-17, `347a562`，接上）**：上一步给 show 路径补 `set_focus()` 后，呼出瞬间变成"先白一下再显示"。根因：`set_focus()` 触发 `WM_ACTIVATE`/`WM_NCACTIVATE`，WebView2 据此做激活重绘；而窗口未设 `backgroundColor`、WebView2 默认白底，此刻深色 CSS 还没上屏 → 白帧。修复（两条缺一不可）：① 把 `emit("hotkey-show")` 提到 `window.show()` **之前**——前端先把深色 overlay 渲染好，show 出来已是深色；② `set_focus()` 移到 50ms 后台线程延迟执行（附 `is_visible()` 守卫），错开激活重绘时机。两处 show 路径（hotkey handler + `tray_toggle`）必须同步改。

> 这一连串 show 路径修复（幽灵界面 → Esc 失灵 → 白闪）凝结成 `CLAUDE.md`【铁律】窗口/焦点节的"呼出(show)路径三条耦合约束"——改 show 路径前务必先读那三条。

---

## 9. 修饰键选择

| 组合 | 问题 | 结论 |
|------|------|------|
| Alt+F1 | Alt 触发 Windows 菜单栏激活 | 禁用 |
| Alt+Space | 被系统窗口菜单占用 | 禁用 |
| Ctrl+F1 | 可用但不顺手 | 过渡方案 |
| Ctrl+Space | 可能和输入法切换冲突 | **当前方案**（实测可工作） |

---

## 10. 检测优先级：图片 > 文件 > 文本（截图去重）

**决策**：将 `CF_HDROP → 图片 → 文本` 改为 `图片 → CF_HDROP → 文本`。

**证据**：Win+Shift+S 截图实测（200% DPI, Win11）dump：
```
HDROP=true  BITMAP=true  DIB=true  DIBV5=true  UNICODE=false
```
截图将临时文件路径 `{GUID}.png`（CF_HDROP）与位图数据（CF_BITMAP/DIB/DIBV5）同时写入剪贴板。旧顺序先命中 CF_HDROP → 生成文件条目 → 图片检测被跳过 → 面板不显示截图缩略图。

**实现**：`has_clipboard_image()` 检查 BITMAP/DIB/DIBV5 任一为 true → 走图片分支 → 缓存缩略图。

---

## 11. 桌面文件粘贴：WorkerW 不接受 CF_HDROP → SHFileOperation 兜底

**证据**：EnumWindows 枚举 Win11 桌面窗口树——3 个 WorkerW + 1 个 Progman，均无子窗口。DWM 合成层 WorkerW 不托管 SysListView32，无法通过焦点交还+Ctrl+V 接收 CF_HDROP。

**决策**：桌面场景（目标窗口 class == "WorkerW"/"Progman"）改为 SHFileOperation(FO_COPY) 直接落地文件到桌面，跳过 Ctrl+V。获取桌面路径用 SHGetKnownFolderPath(FOLDERID_Desktop)（非硬编码 %USERPROFILE%\Desktop）。文件夹/其他目标仍走原有焦点交还+Ctrl+V 流程。

**影响范围（扩展至图片，2026-06-17）**：`set_clipboard_image` 同样补入桌面检测——先 hide+sleep，再查 foreground class；WorkerW/Progman 时将图片解码为 PNG 写入 `%TEMP%\workbench_<ts>.png`，`desktop_copy_files` 落地后删除临时文件。`base64` 为空（当前剪贴板图）时从 arboard 读 RGBA 再编码；非空（历史缩略图）直接解码 base64。Ctrl+V 流程保持，不走桌面分支。

### fFlags 选择（2026-06-18）

**问题**：原 `fFlags` 写成 `0x40/*FOF_NOCONFIRMMKDIR*/|0x0040/*FOF_ALLOWUNDO*/`，注释错误——`0x40` 实为 `FOF_ALLOWUNDO`（真正的 `FOF_NOCONFIRMMKDIR` 是 `0x0200`），两项同值 `|` 后只剩 `FOF_ALLOWUNDO`。结果：① 源文件本就在桌面（源==目标）时弹"源文件名和目标文件名相同"只能取消；② 别处同名文件弹三选一冲突框。而 Explorer 原生 Ctrl+V 会自动改名为 "X (2).ext"。

**决策**：`fFlags = FOF_RENAMEONCOLLISION | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI`（= `0x0618`），用 `windows 0.58` 的 `FILEOP_FLAGS` 常量 `|` 组合（`.0 as u16`，因该 newtype 包 u32 而 Win32 `fFlags` 实为 WORD）。

- **`FOF_RENAMEONCOLLISION` 是承重 flag**：它才是让同名自动改名（对齐 Explorer "X (2).ext"）的关键。**不能只用 `FOF_NOCONFIRMATION`**——`NOCONFIRMATION` 只是"不弹确认框"，其语义是默认"覆盖/跳过"而非"改名"，单用会静默覆盖或跳过同名文件（丢数据），必须配 `RENAMEONCOLLISION` 才得到改名行为。
- `FOF_NOCONFIRMATION` / `FOF_NOCONFIRMMKDIR`：抑制其余确认框，全静默。
- `FOF_NOERRORUI`：抑制错误弹窗（避免桌面粘贴时弹系统错误框打断）——代价是失败会静默，故调用后**必须把 `ret` 与 `fAnyOperationsAborted` 打日志**便于诊断。

**验证**（P/Invoke `SHFileOperationW`，与代码同值 `fFlags=0x0618`、同裸指针双 null 缓冲）：T1 源==目标→生成 "X - 副本.png" 无弹窗（Win11 不拦源==目标，无需 fallback）；T2 别处同名→改名共存；T3 连续 3 次→(2)/(3)/(4)；T5 多文件冲突→各自改名。均 ret=0、aborted=0、零对话框。

---

## 12. Light dismiss：点击外部应用自动隐藏（2026-06-19）

**需求**：作为辅助工具，overlay 显示时用户一旦操作别的应用（点任务栏图标 / 点别处窗口 / Alt+Tab），应自动隐藏，无需再按快捷键——即 Win11 flyout（通知/日历卡片等）的「点外部即退」行为。

**必要性**：窗口 `alwaysOnTop:true` + 全屏，没有自动隐藏时点别的应用，那个应用虽拿到焦点却仍被全屏 overlay 盖住、根本看不见。所以这不是锦上添花，是可用性前提。

**机制**：Rust 后台线程 `start_focus_watch` 轮询 `GetForegroundWindow()`（`FOCUS_POLL_MS=50ms`），前台切到别的窗口就 `hide()`。
- **为什么轮询而非 `WindowEvent::Focused(false)`**：与 §1/§2 同理，本项目对窗口/焦点信号一贯用物理轮询、不信事件。show 路径的 `set_focus` 是 50ms 延迟异步的，focus 事件在这套 dance 里会抖动误触发；`focus:false` + WebView2 焦点怪癖也不可靠。`GetForegroundWindow` 是即时真值、µs 级、不经消息队列。
- **为什么不让前端 `blur` 管**：违反铁律「绝不让前端管 hide」（IPC 往返延迟）。隐藏决策与调用必须在 Rust。

**arm-after-focus 状态机（防呼出瞬间误关，关键）**：
- 窗口不可见 → `disarm`
- 前台 == 本窗口 → `arm`（确认真正拿到焦点）
- 已 `arm` 且 前台 != 本窗口（且前台 ≠ NULL）→ 用户切走了 → `hide()` + `emit("hotkey-hide")` + `disarm`

直接"前台不是我就关"会在呼出瞬间误关：`emit→show→(50ms)set_focus`，set_focus 落地前前台还是上一个应用 → 立刻判定"不是我"→ 窗口闪一下就关。arm-after-focus 只在确认拿到焦点后才布防：set_focus 未落地不会误关；set_focus 彻底失败则永不 arm、永不乱关（优雅降级，用户仍可 Esc/快捷键）。`fg != 0` 守卫防应用切换瞬间的空前台误关。

**HWND 比较避坑**：取本窗口 HWND 用 `window.hwnd()`（Tauri 内部 windows-core 0.61 类型），与 `GetForegroundWindow()`（本 crate windows 0.58 类型）**只比较 `.0 as isize` 指针整数**，不互传——避免 §5 附录那种 `Param<HWND>` trait 版本冲突。

**隐藏复用**纯 `hide()+emit` 路径，不碰焦点交还/粘贴流程。与粘贴/托盘的交互均 gate 在 `is_visible()` 上，幂等无冲突。实测场景 1/2（点任务栏、Alt+Tab）生效，3（点窗口内部）、4（反复呼出）、5（长按）、6（点项粘贴）均无误关。

---

## 13. Git 版本历史（关键节点）

（仅列关键节点，非完整历史；最新在上。完整记录见 `MEMORY.md` §九变更记录）
```
bff986f  文档：优化铁律（show 路径 + 死胡同清单 + 症状速查表）
9fc89a7  重构：删 hotkey.rs/once_cell/死命令 + 静音23警告 + 整合重复（+f65f2c3 修底栏热键）
264b8fa  修复：桌面粘贴冲突框 + 同名自动改名（FOF_RENAMEONCOLLISION）
fefb623  新增：图片粘贴桌面（SHFileOperation 落地）
347a562  修复：呼出白闪（emit 提前预渲染 + set_focus 延迟）
14583c0  修复：Esc 无响应（热键 show 补 set_focus）
3784f6d  修复：Esc 幽灵界面（接 Rust window.hide + emit hotkey-hide 同步）
22334d6  剪贴板图片 aHash 去重 + 整体落盘
f281f11  文档三件套初始化（CLAUDE/DECISIONS/MEMORY）
a7c13b6  新增：剪贴板文件历史（CF_HDROP检测+写入+粘贴）
d11bcf2  图片粘贴修复：去除冗余读写循环
38df8b9  剪贴板后台监听 + 图片缩放 + 图片自动粘贴
c04585c  稳定版：Ctrl+Space 热键 + 粘贴 100% 成功
77de932  修复：工作区定位 + outer→inner 偏移补偿
9b745de  修复：transparent=true + 50ms防抖 + interval泄漏
3508350  基线：纯 toggle 模式
```
