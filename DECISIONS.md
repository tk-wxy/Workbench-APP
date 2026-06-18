# Workbench App — 架构决策与踩坑根因

> 本文件记录"为什么这样做"和"哪些路走不通"。需要硬规则（怎么做、别碰什么）看 `CLAUDE.md` 的【铁律】；本文件是其背后的证据与根因。

## 目录（按主题）
- **热键**：§1 RegisterHotKey vs 自建钩子 · §2 放弃长短按 · §9 修饰键选择
- **窗口 / 焦点 / 渲染**：§4 透明 vs 不透明 · §5 全屏缝隙(outer≠inner) · §8 前端状态 + Esc 幽灵界面 + 呼出白闪
- **剪贴板 / 粘贴**：§3 粘贴可靠性 6 轮演进 · §6 后台缓存架构 · §7 CF_HDROP/DROPFILES · §10 检测优先级(截图去重) · §11 桌面 SHFileOperation 兜底 + fFlags
- **其他**：§12 Git 版本历史（关键节点）

---

## 1. 全局热键：RegisterHotKey vs 自建钩子

**最终方案**：`tauri-plugin-global-shortcut`（底层 `RegisterHotKey`），纯 toggle 模式，Ctrl+Space。

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

## 2. 长短按判定：为何彻底放弃

**最终方案**：不做长短按，纯 toggle。

**根因**：`RegisterHotKey` 的 `Pressed` 和 `Released` 事件通过 Windows 消息队列异步投递。两台真实机器上实测延迟在 500-800ms。用两个异步事件的时间差判定物理按键时长，从根本上不可靠。

**尝试的阈值**：200ms / 300ms / 500ms — 全部失败。调整数值无效，信号源本质有不可控延迟抖动。

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

---

## 6. 剪贴板架构：实时编码 → 后台缓存

**变更**：窗口弹出时从"实时读剪贴板+编码"改为"读内存缓存"。

**旧问题**：弹出时 `read_clipboard` 读取大图 → `image` crate 编码 PNG(~3s) → Base64(~1s) → IPC 传输 → 前端渲染。全屏截图时有数秒延迟。

**新方案**：
- 后台线程每 800ms 轮询 `GetClipboardSequenceNumber`（µs 级）
- 变化时：读→缩放(>1024px→1024px Triangle)→编码→存 `CLIP_CACHE`→emit 推送
- 弹出时：直接读缓存，毫秒级

**死循环防御**：`set_image/set_clipboard_files` 写回剪贴板会触发 seq 变化 → 后台检测到 → 跳过。用 `AtomicI32` 计数器（非布尔——arboard 的 get+set 可能触发 2 次 seq 变化）。

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

## 12. Git 版本历史（关键节点）

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
