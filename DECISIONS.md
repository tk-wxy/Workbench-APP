# Workbench App — 架构决策与踩坑根因

> 本文件记录"为什么这样做"和"哪些路走不通"。需要硬规则（怎么做、别碰什么）看 `CLAUDE.md` 的【铁律】；本文件是其背后的证据与根因。

## 目录（按主题）
- **热键**：§1 RegisterHotKey vs 自建钩子 · §2 放弃长短按 · §9 修饰键选择
- **窗口 / 焦点 / 渲染**：§4 透明 vs 不透明 · §5 全屏缝隙(outer≠inner) · §8 前端状态 + Esc 幽灵界面 + 呼出白闪 · §14 原生拖入(drag-in)废弃
- **剪贴板 / 粘贴**：§3 粘贴可靠性 6 轮演进 · §6 后台缓存架构 · §7 CF_HDROP/DROPFILES · §10 检测优先级(截图去重) · §11 桌面 SHFileOperation 兜底 + fFlags
- **搜索 / 启动器 UI**：§15 增强搜索(Ctrl+K)视图层 + 两套搜索分工 · §16 启动器=持久化收藏托盘(vs 自动扫描全量) · §17 文件搜索=自建内存索引+后台预建(vs Windows Search/Everything)
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

**历史持久化（2026-06-21，方向 A：Rust 侧落盘）**：

- **为何选方向 A 而非前端 plugin-store**：`CLIP_CACHE` 是 Rust-owned state，删除/清空均在 Rust 侧发生。若由前端持久化，删除/清空操作同步 store 需要额外 IPC 往返，且两侧数据会产生版本分歧（Rust 内存 vs store 文件谁为准）。Rust 侧直接在三处修改点出锁后立刻落盘，唯一真相来自 `CLIP_CACHE`，无同步问题。

- **落盘格式**：`{"version":1,"items":[...]}`，compact JSON，写文件 `%APPDATA%\workbench-app\...\clip_history.json`（路径由 `app.path().app_data_dir()` 运行时获取，setup 阶段写入 `CLIP_HISTORY_PATH` OnceLock 一次）。

- **原子写**：写 `.json.tmp` → `std::fs::rename` 覆盖正式文件，防写到一半进程崩溃留下损坏文件。

- **容错**：解析失败或 version 未知 → 原文件改名备份 `clip_history.json.corrupt.<unix_ts>`，以空历史启动，不 panic。路径初始化失败或 OnceLock 未 set → `load`/`save` 静默 no-op，app 正常运行但持久化关闭。任何磁盘错误仅 `eprintln!`，不传播。

- **`save_clip_history` 的锁规则**：接快照入参，自身不持任何锁。三处调用点均保证 `CLIP_CACHE` 锁与 `CLIPBOARD_LOCK` 双双出锁后再调——`start_clipboard_monitor` 里在 `cache.truncate` 后 `clone` 快照、显式 `drop(cache)` 出锁再调；`delete_clipboard_item`/`clear_clipboard_history` 用 `{ ... }` 作用域让锁在调 save 之前析构。此规则与 `write_cf_hdrop` 锁加调用方（不进函数）的重入死锁教训同源——`std::Mutex` 不可重入，快照+出锁+再 save 是唯一安全模式。

- **与采样塌缩的轻微交互**（未处理，已知局限）：两次复制塌缩为一条（见上文"采样塌缩"），save 会忠实地把这一条写进磁盘——丢掉的条目在内存和磁盘上都不存在，持久化不增加也不消除塌缩的影响，二者正交。

**中转区批量取走/复制的系统剪贴板单-payload 天花板（2026-06-23，纯前端多选）**：

- **根因**：系统剪贴板是单一 slot，一次 `SetClipboardData` 只能放一种 payload。多个文件可合并为一个 `CF_HDROP`（`DROPFILES` 头 + 多路径）一次放入、一次粘贴；但文本/图片/混合条目无法合并成一份标准格式——把两段文本拼在一起语义破坏；把文本+图片放进同一剪贴板需要双格式（CF_UNICODETEXT + CF_DIB），现有 `copy_files_to_clipboard`/`paste_clipboard` 命令不支持此路径。
- **决策**：批量「取走全部」和「复制全部」按钮**仅当所选条目全部是 `type==="file"` 时启用**（`allFiles` 判断）；混合/文本/图片选中时置灰，tooltip 说明原因。批量「删除全部」无剪贴板依赖，永远可用。纯 file 批量路径复用现成 `copy_files_to_clipboard(paths: string[])` + `set_clipboard_files`，通过 `combined()` 将多条 file 条目的 `items` 合并成一个 CF_HDROP，零 Rust 新增命令。
- **不变量**：此限制与 CF_HDROP 架构（§7）同源；任何新增批量剪贴板功能都必须经过「能否合并成单一 payload」这道门槛。

**落盘原图（2026-06-23）**：历史图粘贴的缩略图问题修复。

- **根因**：`image_to_cache_entry` 采集时只存 1024px 缩略图，原图字节直接 drop；历史图粘贴只能拿到缩略图（当前图因重读系统剪贴板仍是原图）。

- **方案选择（Simple）**：原图 PNG 落盘到 `{data_dir}/clip_images/{time}.png`，用户可见、自行管理（不做自动删除/孤儿 sweep）。理由：自动删除逻辑需要同步 4 个缓存变更点（truncate/delete/clear/set_max），增量复杂度高；Simple 代价是长期积累磁盘占用，但有「清空缓存」按钮兜底，用户可自理。

- **detached 写盘**：原图 PNG 编码 + 写文件在 `std::thread::spawn` 内异步执行，监听循环立刻返回继续轮询。理由：同步写盘给图片复制后那个轮询周期凭空增加数百 ms，加宽 §6 采样塌缩窗口（`CLIPBOARD_LOCK` 只防 1418，不防监听循环延迟，二者正交）。

- **小图不落盘**：源图 `w ≤ MAX_THUMB_DIM && h ≤ MAX_THUMB_DIM` 时未发生缩放，`content`（base64）本身即无损原图，`orig_path` 置 None，不写文件不占缓存夹。

- **dedup 防孤儿**：在 CLIP_CACHE 锁内 aHash 判重后，**仅「判新」才 spawn 写盘**；被 dedup 丢弃的 incoming 的 `large_img_opt` 直接 drop，零孤儿文件。

- **锁纪律**：
  - PNG 编码 / 文件读 / 写 / 删全部在 `CLIPBOARD_LOCK` 与 `CLIP_CACHE` 锁外（与 `save_clip_history` 同源规则）。
  - `CLIPBOARD_LOCK` 仅罩 `get_image`（监听）与 `set_image`（paste/copy）临界区；`thumb`/`ahash`/编码移出了原来的锁内位置。
  - `set_clipboard_image` / `copy_image_to_clipboard` 的 `fs::read(orig_path)` 在 `CLIPBOARD_LOCK.lock()` 之前（文件 I/O 在锁外）。

- **两道降级兜底**：① `paste fallback`：`fs::read` 失败或 `orig_path=None` 时自动降级 base64 缩略图，对用户透明；② `load strip`：重启时 `load_clip_history` 检查 `orig_path` 文件是否存在，缺失则去掉该字段（清空缓存后的自愈机制）。

- **DECISIONS §6 变更点**：`start_clipboard_monitor` 图片分支重构——`CLIPBOARD_LOCK` 只罩 `get_image`；`thumb`/`ahash` 在锁外；dedup 后 `spawn(save_clip_image_to_disk)`。新增 `MAX_ORIG_DIM=4096`、`CLIP_IMAGE_DIR`、`save_clip_image_to_disk`、`open_clip_image_dir`、`clear_clip_image_cache`。前端 `ClipItem` 加 `orig_path?`，两处 invoke 传 `origPath`，设置面板加「打开文件夹」/「清空缓存」按钮。

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

### V1 自定义热键 = 2 预设方案（2026-06-25，续43）

**结论**：仅提供 2 个预设组合（Ctrl+Space 默认 / Ctrl+F12），segmented control 切换，**不做按键录入态**。

**为什么不做录入态（三条死路）**：
- WebView2 里捕获 `Alt` 系组合会触发 Windows 菜单栏激活（§9 表，与 Alt 修饰键同根）；
- 部分组合（含 IME/系统占用）的 `keydown` 被 WebView2 内部拦截、JS 根本收不到，录不到真实键；
- 录制期间旧组合仍处于 `RegisterHotKey` 注册态，按下会触发 show/hide 干扰录制本身。
预设白名单（`parse_combo`）规避全部三条，对普通用户也更友好。

**两层硬编码的统一收口**：Ctrl+Space 原本硬编码在 ① 轮询层（`is_down(VK_CONTROL.0)&&is_down(VK_SPACE.0)`）② 注册层（setup `register`）。V1 收口到两个静态——`HOTKEY_VK_KEYS`（轮询读的 VK 列表）+ `CURRENT_SHORTCUT`（注册层切换时反注册旧组合用）。轮询循环只改 combo 检测一行为 `keys.iter().all(is_down)`，长短按/momentary/toggle 语义一字未动。

**原子切换顺序**（`set_hotkey` 命令）：先 `register(new)` 成功 → 再 `unregister(old)` → 再原子更新 `HOTKEY_VK_KEYS`/`CURRENT_SHORTCUT`。任一步失败（典型：new 被其他应用占用）则直接返 Err、旧组合从未动、继续工作。unregister(old) 失败仅忽略（极罕见，残留旧空 handler 无害）。

**持久化与运行时分离**：`set_hotkey` 只切运行时注册、**不写 store**（同 `set_clip_cache_max` 惯例）；store 写由前端 `changeHotkey` 负责。**启动一致性**靠 setup **同步读 store**（`read_combo_from_store` 直接 `read_to_string`+`serde_json` 读平凡 KV JSON，早于前端、无空窗按错键）——预备验证确认 store 是平凡顶层 KV，此路可行，故未退化到「前端 `[]`-effect invoke 兜底（~500ms 空窗）」。

**V2 注意**：加更多预设若涉及**三键**（如 Ctrl+Shift+Space）必须先 spike 验证 §2 的 `GetAsyncKeyState` 严格全键 `all(is_down)` 长短按语义在三键下的真实表现（修饰键先松/后松、采样窗口边界），不可想当然套用二键结论。Alt 系 / Alt+Space / Fn 永久禁用（§9 表 + CLAUDE.md 死胡同）。

### V2-1 表驱动任意组合机器（2026-06-25，续44）

**变更**：`parse_combo` 从 2 预设白名单改为表驱动任意组合解析器（`key_token` 53 条）。

**解析规则**（`lib.rs`，`parse_combo` + `key_token`）：
1. blocklist：含 win/super/meta/windows → Err；含 alt/option → Err（WebView2 菜单栏激活，§9 表，永久禁用）
2. 必须含 ctrl/control；否则 Err
3. 可选 shift；其余 token 恰为 1 个主键（多/少 Err）
4. 主键走 `key_token` 表（a-z / 0-9 / f1-f12 / space / up/down/left/right）；未命中 → "不支持的键：{tok}"
5. VK 列表 = [VK_CONTROL] + (VK_SHIFT 若有 Shift) + main_vk；Shortcut = Modifiers::CONTROL (| SHIFT) + Code

**单测结果**（`cargo test --lib hotkey_parse_tests`，验证后已删）：11 个断言全 ok。

**三键长短按 spike B 分析（GUI 未验证）**：
- 轮询检测 `keys.iter().all(is_down)`——3 键与 2 键逻辑完全相同，`all()` 对任一键松开即返 false。
- 按下边沿（false→true）：三键全按下时 `combo=true`，状态机记录 `down_at`，按下沿开窗——与 2 键无异。
- 松开边沿：任一键（含修饰键 Shift）松开即 `combo=false`，触发松开沿逻辑（momentary/toggle）。
- 潜在风险：Shift 先松、Ctrl 后松的场景——松开 Shift 即触发松开沿，主键 + Ctrl 仍按下不影响采样（`all` 已 false）。长短按分界由按下到首次 `combo=false` 的时间差决定，语义清晰。
- **结论（理论）**：三键无连锁 bug；但 GUI 实测是确认修饰键先松的体感（用户需 V21-TEMP harness 实测 Ctrl+Shift+X 的 momentary/toggle 分界）。

**未完成（V2-2）**：① 设置 segmented 改文本输入区（删 V21-TEMP harness、删 segmented、加 input+验证提示）；② 底栏 kbd 文案改动态展示 `hotkeyCombo`（当前仍硬编码 "Ctrl+Space"）；③ `set_hotkey` 成功后前端 `setHotkeyCombo` 需接受任意字符串（类型签名由 union→string）。

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

---

## 14. 原生拖入（drag-in）：可行——dragDropEnabled:false + 自注册 IDropTarget（2026-06-21）

**需求**：文件中转区支持「从资源管理器拖文件进来」——流程「源处按住拖动 → Ctrl+Space 呼出 → 拖入中转区松手」。

**结论：可行，已实现。** 拖入（drag-in）落地为中转区正式功能；拖出（drag-out）未做（见末尾）。

> ⚠️ 本节曾错误地把拖入登记为「死胡同/废弃」（2026-06-20）。那个结论是**错误变量**测出来的，已被后续 spike 推翻。下面记录正确机制、真实失败根因、以及这条教训。

**confidence 分类**：
- **已实测确认（高）**：`dragDropEnabled:false` + 在「顶层+全部子孙窗」自注册 IDropTarget → mid-drag 端到端通；DragEnter/Drop 触发于最深的 `Chrome_RenderWidgetHostHWND`、CF_HDROP 真实路径正确；单/多文件、文件夹、混合、连续拖入、取走/Esc/light dismiss 回归全过（T1–T8，2026-06-21 GUI 实测 + Drop 日志佐证 `Drop N path(s)`）。
- **推断未实测（中）**：渲染进程崩溃/重建后拖入失效（render host 句柄变了、setup 那次注册作废）——本应用极难触发，未验证（T9 标注为已知限制）。

**正确机制**：
1. **`tauri.conf.json` `dragDropEnabled:false`**（永久）：让 wry 不抢 OLE drop target 槽、不拦 HTML5，把槽留给我们自注册。（HTML5 拖放本未用，无损失。）
2. **自注册 IDropTarget**（`src-tauri/src/dragdrop.rs`，windows crate `#[implement]`）：`OleInitialize`（RegisterDragDrop 要求之，仅 `CoInitializeEx` 会 `CO_E_NOTINITIALIZED`）→ `EnumChildWindows` 枚举窗口树 → `RegisterDragDrop` 到顶层 + 全部子孙窗。**DragEnter/DragOver** 查 CF_HDROP 设 `DROPEFFECT_COPY`/`NONE`（光标反馈）；**Drop** 用 `DragQueryFileW` 取路径 → `emit("files-dropped", { paths, x: pt.x, y: pt.y })` 后立即返回（handler 极简，不碰剪贴板/不 hide/不阻塞）。`pt`（`POINTL`）为屏幕物理像素。
3. **落点双区判定**（S3b，前端，续38）：listen `files-dropped`，payload `{paths,x,y}`；`cssX/cssY = x/y ÷ window.devicePixelRatio`；`getBoundingClientRect()` 判是否在 `launcherDropRef`（`.app-grid`）内：`inLauncher`→入 `LauncherItem`（file/folder，持久化 `launcher-items`）；否则→原有 StageItem 路径（完整保留）。两分支末尾均保留 `setFocus`。落地区域 200ms `drop-flash` CSS 动画确认。
   - **DragOver 实时高亮未做**：需 Rust DragOver 持续 emit 坐标，IPC 高频代价过高（每 wry 帧 ~16ms 一次 emit → 前端每帧响应），用落地闪烁代替。如后续确有需求，可在 DragEnter emit 一次「drag-enter」事件触发区域高亮（一次性，代价低）——当前未做，留后续。

**耐久性（关键设计，Step 0 微测定）**：OLE **不沿父链 walk-up**——只注册祖先 `WRY_WEBVIEW` 时 DragEnter 零触发；drop 只投递给光标正下方最深窗口。故注册「顶层+全部子孙窗」。**只在 setup 注册一次**：曾试「每次 show 经 `run_on_main_thread` 幂等重注册」扛 webview 重建，实测**重注册虽报成功、产出的 target 却收不到回调、破坏正常拖入**（单变量隔离：停掉重注册即恢复）——已回退，接受「渲染进程重建后失效到重启」的罕见代价。

**原失败根因（为何曾误判死胡同）**：
- **错误变量**：当时测「先呼出再拖」——全屏覆盖层盖住源应用、够不到文件，误以为是拖放本身不行。真实流程是「先抓住文件再呼出」。
- **wry 占槽**：`dragDropEnabled` 默认 `true` 时 wry/WebView2 占了 `Chrome_RenderWidgetHostHWND` 的 drop target 槽并拒收外部拖放（`AllowExternalDrop` 默认 false）→ 红色禁止 + 零事件。关掉它把槽让出来即通。

**教训**：曾把「没查清的现象」当成「硬限制」写进死胡同（红色禁止 + 零事件 → 直接判窗口收不到拖放）。正确做法是**自注册一个 IDropTarget 主动验证 hit-test 到底发生没有**（spike 一拖即推翻原结论）。呼应本文档既有原则：诊断要查到根因，未证实的不当定论。

**拖出（drag-out）未做**：从 WebView 拖文件出去到 Explorer 需原生 `DoDragDrop`/`IDataObject` 拖放源 FFI（WebView2 不原生支持），比拖入更难；且优先级低（「单击取走→Ctrl+V」已覆盖取走）。暂不做，非死胡同、是未实现。

**死胡同登记**：CLAUDE.md【💀 死胡同】已补一条。后续若仍想要「主动加文件/文件夹」，走原生文件选择器（`tauri-plugin-dialog`，未装），不要回头试拖拽。

---

## 15. 增强搜索（Ctrl+K）：同 overlay 内的「视图层」，不是新窗口（2026-06-24）

**取舍**：增强搜索做成**同一个全屏 overlay 内的一个视图层**（`.enh-layer`，靠 `.enh-open` class 切显隐），而非 Tauri 新窗口。

- **为什么不开新窗口**：本项目窗口/焦点/热键是最高危区（见 CLAUDE.md 铁律）——`transparent:true`/`focus:false`/键态轮询/light dismiss/set_focus dance 全是为「单一全屏 overlay」精心调过的。再开一个窗口要重走一遍焦点交还与可见性真相同步，性价比极低且极易引连锁 bug。把它当 overlay 内的一层，**完全复用现成 show/hide 机制**，零 Rust 改动。
- **激活只走 launch/open，绕开粘贴高危区**：结果激活=应用 `launchApp`（开了即 hide，复用放大动画）或中转 file `open_file`（fire-and-forget）。**绝不触碰**「写回剪贴板 → 焦点交还 → Ctrl+V」那条链路，也不取 `CLIPBOARD_LOCK`。整个功能待在高危区之外，因此能纯前端落地。
- **结果范围（Tier 1）**：应用 + 中转区 `type==="file"` 条目。剪贴板条目、文件系统实时搜索留 Tier 2（需新数据源/可能 Rust 改动）。
- **键盘门控**：全局 onKey 在 `enhOpen` 时由第 4 段 `↑↓/Enter` 接管并 `return`，屏蔽下面的 launcher 方向键，避免两套导航串扰；Esc 优先级链插入 enhOpen（先退视图层、再退主页面）。

**两套搜索分工（2026-06-24 续36 补）**：① 顶栏普通搜索（`search` state）= **页面内三区就地过滤**——输入即同时筛应用/中转/剪贴板各自列表（名称/内容子序列模糊优先 + `typeKeywords` 类型词子串叠加，任一命中即保留），不改布局、不离开主页面。② Ctrl+K 增强搜索（`enhQuery`）= **独立全屏结果页**，把应用 + 中转 file 跨区合并成单一排序结果列表、键盘驱动直达激活。两者 query 互相独立（Ctrl+K 进出不清 `search`），定位不同：普通搜索是"在原位看哪些还在"，增强搜索是"跨区找一个直接打开"。

---

## 16. 启动器：持久化收藏托盘 vs 自动扫描全量平铺（2026-06-24 S3a）

**取舍**：左侧启动器面板从「自动扫描 Start Menu 全量 .lnk 平铺(`filteredApps`)」改为「用户**手动策展的持久化收藏托盘**」（store key `launcher-items`）。理由：全量平铺信息密度低、要的 app 淹没在几百个里；收藏托盘 = 把高频 app/file/folder 钉成一个稳定宫格，像"功能增强版开始菜单"的常用区。

- **`LauncherItem` 独立于 `StageItem`，不可合并**：两者形似（都带 path/name），但**左键动作契约根本不同**——启动器条目左键 = 打开/启动（app→`launch_app`，file/folder→`open_file`，由"区"决定动作），**不走**「写回剪贴板 → 焦点交还 → Ctrl+V」那条粘贴链、不取 `CLIPBOARD_LOCK`；中转 `StageItem` 左键 = 取走粘贴（走粘贴链）。动作语义不同 → 类型不同，强行合并会让"这条左键到底干啥"取决于隐式上下文，是 bug 温床。这条已升格为 CLAUDE.md 协作约定不变量。
- **自动扫描链全保留、只是不再全量平铺到面板**：`scan_start_menu/apps/sortedApps/filteredApps` 一字不动——它们仍是 Ctrl+K 增强搜索、顶栏普通搜索、以及 app picker 候选的**数据源**。改的只是"主面板渲染什么"（`launcher` 而非 `filteredApps`）。
- **已知副作用（有意接受）**：① 顶栏普通搜索不再过滤左侧应用区（应用区现在是收藏托盘，与 `search` 无关）——应用搜索的职责整体交给 Ctrl+K；中转/剪贴板过滤照常。② 普通页方向键(`selectedIdx`/`filteredApps`)失去可见目标，保留 handler 不删（增强搜索/picker 打开时本就被拦截），Enter 分支加 `search.trim()` 守卫，防空查询下误启动隐藏的 `filteredApps[0]`。launcher 自身的键盘导航留后续（条目少、鼠标为主）。
- **app picker 复用 settings-modal + enh-result 样式**：零自创交互范式；搜索去重（排除已加入）、点击添加不关闭（连续添加）、已加入项 filter 后自然消失。Esc 优先级链插入 `pickerOpen`（ctxMenu→enhOpen→pickerOpen→stageSel→settings→关窗）。
- **S3b 落点判定**：Drop emit `{paths,x,y}`（物理像素），前端 `÷ devicePixelRatio` 换算 CSS px + `getBoundingClientRect()` 判区；启动器 `.app-grid` → `LauncherItem`，其余兜底 → `StageItem`；落地 200ms `drop-flash` 动画确认。DragOver 实时高亮未做（高频 IPC 代价过高，用落地闪烁替代）。
- **.lnk 拖入走 `resolve_lnk`（S3c，续39）**：`.lnk` 快捷方式拖入启动器时，调用 `resolve_lnk`（`apps.rs`）复用 `extract_icon_base64`（`SHGetFileInfoW` 自动解析 .lnk 图标）+ 去后缀名称，存为 `kind:"app"`，左键走 `ShellExecuteW(.lnk)` 直接执行（不 `parselnk` 解析目标 exe——避开 parselnk 历史坑，且 ShellExecuteW 本就能运行 .lnk）。非 .lnk 走原有 `get_file_info → file/folder` 路径。

---

## 17. 文件搜索：路线 C 自建内存索引 + 后台预建（2026-06-24 S4a）

**目标**：增强搜索（Ctrl+K）Tier 2 要能搜整个文件系统（不止已收藏/中转的条目）。难点在 Windows 上「搜文件」既要快、又不能卡呼出。

**路线对比（为何选自建内存索引）**：
- **A. Windows Search COM（`ISearchManager`/OLE DB `SystemIndex`）**：依赖系统索引服务，用户若关了索引或目录不在索引范围就查不到；COM 初始化 + SQL 查询有不可控延迟与失败面；跨进程、要处理 STA/线程模型。重而不可控，弃。
- **B. Everything SDK（`Everything.dll` IPC）**：最快最全，但**要求用户另装 Everything + 服务常驻**，违背本工具「~5MB 单体、零外部依赖」定位。弃。
- **C. 自建内存索引 + 后台预建（选用）**：`walkdir`（已是依赖，零新增 crate）后台遍历几个用户常用目录，建一份内存 `Vec<IndexEntry>`，查询纯内存子串打分。可控、零外部依赖、查询 µs 级。代价是索引有最长 30min 的陈旧窗口、且只覆盖白名单目录——对"找常用文件直达打开"的场景完全够用。

**不卡前端的三道保险**（命脉，违反任一条都会把耗时遍历泄漏到 UI 线程）：
1. **永不经命令**：索引只在 `start_index_worker` 内 `std::thread::spawn` 的独立后台线程跑，永不经 Tauri 命令 / invoke / 阻塞 IPC。setup 阶段 spawn，先 `sleep(3s)` 避开开机高峰再首次建索引——不等窗口、不等呼出。
2. **查询只读内存**：`search_files` / `get_index_status` 只读内存 Vec、绝不碰磁盘（实测查询 µs 级，远 <5ms 目标）。
3. **双缓冲原子替换 + 瞬间临界区锁**：新索引在后台 `build_index` 里建好（耗时部分**不持锁**），建完一次性 `*guard = new_index` 替换旧 Vec。`FILE_INDEX` 锁只罩「替换 Vec」与「查询读 Vec」两个瞬间临界区。查询永远命中一份完整索引，绝不读到建一半的状态。

- **锁完全独立于剪贴板**：`FILE_INDEX` 是全新独立 `Mutex<Vec<IndexEntry>>`，与 `CLIPBOARD_LOCK` / `CLIP_CACHE` 无任何交集，无锁序问题。
- **遍历边界**：白名单目录 `Desktop/Downloads/Documents/Pictures/Projects`（不存在则跳过）；`max_depth(8)` 防极深树；`should_skip_dir` 剪枝 `node_modules/.git/target/$recycle.bin/appdata/__pycache__` 及隐藏目录整子树；隐藏文件跳过；硬顶 `MAX_INDEX_ENTRIES=200_000`；`REBUILD_INTERVAL_SECS=30min` 周期重建。
- **打分**：`name_lower` 预存小写避免查询时重复 `to_lowercase`；子串命中 + 越靠前 + 名越短 + 前缀加分，`sort_by` 降序后 `take(limit.min(50))`。简化版（非子序列模糊），与前端 `fuzzyScore` 思路一致但更轻——后台索引量大，子串足够且快。
- **应用扫描同样后台预建（S4c，续42）**：扫开始菜单/桌面几百个 .lnk + 每个 `SHGetFileInfoW` 提图标实测约 **1.5s**——原本绑在「前端首次 `visible` 时 invoke `scan_start_menu`」，正好砸在首次呼出那一刻 → 卡。改为 setup 阶段 `start_apps_worker` 后台线程（仿 `start_index_worker`，延迟 1s 避开启动高峰）调用现有 `scan_start_menu`（**扫描/图标逻辑一字不动**，其 `APP_CACHE` 顺带缓存）→ `emit("apps-ready", apps)` 一次性推前端。前端 `[]`-注册 `apps-ready` 监听填充 `apps`；首次 `visible` 改为**兜底语义**——仅当 `apps` 仍空（事件错过/未到）才 invoke `scan_start_menu`（命中 `APP_CACHE`、实测 **~120µs** 近乎瞬时），否则跳过。`sortedApps`/搜索链 deps 含 `apps`、自动响应，零改动。**与文件索引同一架构原则**：扫描这类耗时预备工作一律挪到后台线程预建、前端只监听就绪事件，绝不在呼出路径同步执行。
- **前端分组渲染（S4b，续41）**：Ctrl+K 增强搜索结果分两组——Tier 1（应用/中转，有查询时 ≤10）在前，一条 `.enh-divider`「文件」分隔线，Tier 2（`search_files` 文件结果 ≤20）在后，合并列表 ≤30。文件查询 **150ms 防抖**（每次 `search_files` 是 Rust 命令往返，避免逐键 invoke）。索引未就绪（`!indexReady`）且有查询时显示「文件索引建立中…」一行小字，**不阻塞 Tier 1 显示**（应用/中转照常出）。`indexReady` 双来源：监听 `file-index-ready` 事件 + 打开时主动 `get_index_status` 兜底（防错过 emit）。↑↓/Enter 跨 Tier1+Tier2 整个列表连续导航（分隔线只是视觉、不占 result 索引——用 `Fragment` 把 divider 与结果项并列渲染）。文件结果激活走 `open_file`（不碰粘贴/焦点交还/`CLIPBOARD_LOCK`）。
- **验证**：临时单测（`build_index` + `search_files` 对临时目录树）实测——遍历 5 条目 390µs、跳过 node_modules 子树与隐藏文件正确、查询 `report` 7.4µs 返回且短名前缀优先排序正确、limit/空查询守卫正确；验证后已删临时单测，保留正式日志 `[fileindex] ready: N entries (elapsed)`。GUI 层（Ctrl+K 看到文件结果）属 S4b 未验。
