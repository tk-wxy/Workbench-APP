# Workbench App

Windows 全屏"第二桌面"工具：热键 toggle 呼出覆盖全屏的功能界面（应用启动器 / 文件中转 / 剪贴板历史），用完优雅消失，原桌面不受影响。理念 ≈ "功能增强版的开始菜单"。

> **每次会话开始**：① 看 `MEMORY.md §0`（当前进度 / 下一步 / 待决策）；② 动窗口·焦点·热键·剪贴板代码前，先读完下面的【铁律】；③ 需要"为什么这样做"的根因去 `DECISIONS.md`。本文件只放结论与硬规则。

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
- `src-tauri/src/lib.rs` — 主逻辑（窗口、热键、剪贴板、Tauri 命令）
- `src-tauri/src/apps.rs` — 应用扫描 / `ExtractIconEx` 图标提取
- `src/App.tsx` — 前端
- `src-tauri/tauri.conf.json` — 窗口配置
- `DECISIONS.md` — 完整架构决策与踩坑根因（需要"为什么"时读它，本文件只放结论）
- `MEMORY.md` — 滚动会话小结，**当前进度 / 待办 / 下一步以它为准**

---

## 铁律（违反必引发连锁 bug，动手前先读完本节）

### 窗口 / 焦点（最高危区）
- **一次只改一个焦点 / 激活 / 窗口相关的变量**。捆绑改动必出连锁 bug。
- **`tauri.conf.json` 锁定项**：`transparent:true`（改 false → 全屏 + blur 的 GPU 合成开销 → hide/show 延迟 + 空白页闪烁）和 `focus:false`（抢焦点会破坏热键）**都不能改**；其余基线 `decorations:false / alwaysOnTop:true / skipTaskbar:true / visible:false`。
- 可见性的**唯一真相是 `window.is_visible()`（Rust）**。Rust 直接 `show()/hide()`，`emit` 只用于同步前端状态。**绝不让前端管 hide**（会引入 IPC 往返延迟，表现为"空白页后延迟关闭"）。
- **呼出(show)路径的三条耦合约束，别"顺手简化"**（横跨"幽灵界面 / Esc 失灵 / 白闪"三次修复才凑齐，两处 show 路径——hotkey handler + tray_toggle——必须一致）：
  ① `emit("hotkey-show")` 必须**在 `window.show()` 之前**（前端先渲染深色 CSS，否则白闪）；
  ② `set_focus()` **必须有**（否则键盘焦点不在窗口，Esc 的 keydown 到不了 JS → Esc 没反应）；
  ③ `set_focus()` 必须**延迟执行**（50ms 后台线程 + 可见性守卫；立刻调会触发 `WM_ACTIVATE` 重绘 → 白闪）。
- 关闭/粘贴的**焦点交还流程**（文本 / 图片 / 文件夹粘贴复用，**别改流程**；例外：桌面 WorkerW/Progman 走 SHFileOperation 落地）：
  `window.hide()` → `sleep(150ms)` → `GetForegroundWindow` → `SetForegroundWindow` → `enigo` 发 `Ctrl+V`。
- "前台窗口"与"键盘输入焦点"是两个概念——推回焦点的死路见下方【💀 死胡同】。

### 全局热键
- **show/hide 的唯一驱动 = 物理键态轮询**（`start_hotkey_monitor`，后台线程 25ms 读 `GetAsyncKeyState(VK_CONTROL/VK_SPACE)` 的 MSB）。**不要回退到用 `RegisterHotKey` 的 Pressed/Released 事件做 show/hide**——那条路有 500-800ms 抖动（见【💀 死胡同】）。
- `RegisterHotKey`（`tauri-plugin-global-shortcut`）**仅保留用来"消费" Ctrl+Space**（handler 故意为空），防止该键漏给前台应用（IME 切换 / 编辑器补全）。**别在这个空 handler 里加 show/hide 逻辑**。
- **混合语义**（`lib.rs` 顶部常量 `HOTKEY_TAP_MAX_MS=250ms` 分界）：长按 = momentary（按下开、松开关）；短按 = toggle（按下沿开、松开不关，下次短按才关）。要调灵敏度改 `HOTKEY_TAP_MAX_MS`，调采样率改 `HOTKEY_POLL_MS`。
- 按下沿开窗复用 show 路径三约束（emit→show→延迟 set_focus）；松开/短按关窗走纯 `hide()+emit("hotkey-hide")`。修饰键避坑见【💀 死胡同】。
  - ⚠️ **别再给热键关闭加「淡出再 hide」**：试过（续25），延迟 hide 让窗口多可见 200ms，破坏 toggle 按下沿对 `is_visible()` 的即时采样 → 连续短按时第 N 次「开」被误判成「关」→ 热键失灵/不灵敏。已回退。淡出仅用于前端点击驱动的关闭（启动/粘贴），不用于键态轮询驱动的热键关闭。
- **Light dismiss（点外部应用自动隐藏）= 第二条 hide 驱动**（`start_focus_watch`，后台线程 50ms 轮询 `GetForegroundWindow`）。同样**轮询前台、不用 `WindowEvent::Focused` 事件**（事件在 show 的 set_focus dance 里会抖动误触发）。必须走 **arm-after-focus 状态机**（前台==本窗口才布防，之后前台变了才关）——否则呼出瞬间 set_focus 未落地会"开即关"。隐藏复用纯 `hide()+emit` 路径。**别让前端 `blur` 管 hide**（违反上面"绝不让前端管 hide"）。详见 DECISIONS §12。

### 剪贴板
> 下列可调数值（轮询 150ms / 缓存 20 条 / 缩略图 1024px / aHash 阈值）均为 `lib.rs` 顶部命名常量（`CLIP_POLL_MS` / `CLIP_CACHE_MAX` / `MAX_THUMB_DIM` / `AHASH_*`）。**要调就改常量，别在散落处硬编码。**
> ⚠️ `CLIP_POLL_MS` 别再调大：轮询式监听下，两次复制落在同一采样窗口会"塌缩"丢中间项（详见 DECISIONS §6）；要彻底根治需改事件驱动（`AddClipboardFormatListener`）。
- 后台线程 `start_clipboard_monitor` 独立于窗口 visible 常驻运行，轮询 `sleep(CLIP_POLL_MS)`。
- 用 `GetClipboardSequenceNumber()` 判断是否变化，**不每次读全量数据**。
- 检测顺序 `图片 → CF_HDROP(文件) → 文本`（截图同时有 CF_HDROP+位图，图片优先）；`CLIP_CACHE` 最多 20 条。
- 图片：>1024px 用 `image` crate `FilterType::Triangle` 缩到 1024px 缩略图再编码。**轮询不读图，只在内容变化时处理一次**。
- **所有剪贴板读写必须走 `CLIPBOARD_LOCK` 串行化**（监听读 + 全部写入者：copy/paste × 文本/图片/文件，含 `set_clipboard_image` 桌面分支读当前图的 `get_image`）。根因：监听线程占着 `OpenClipboard` 句柄时，写入者的 `SetClipboardData`/`EmptyClipboard` 抢不到 → `os error 1418`（线程没有打开的剪贴板）。锁粒度**仅限 `OpenClipboard…CloseClipboard` 临界区**（arboard 的 set/get 调用本身、或裸 FFI `write_cf_hdrop`）——写入者**绝不跨 `hide()`/`sleep()`/焦点交还/`enigo` Ctrl+V 持锁**（会阻塞监听线程、emit 往返时可能死锁）。桌面分支 `SHFileOperation`/`desktop_copy_files` 落地文件、**不碰系统剪贴板，不加锁**。`write_cf_hdrop` 被 paste 与 copy 共用 → 锁加在**调用方**、**别进 `write_cf_hdrop`**（否则 copy 重入死锁）。锁序：监听**先放 `CLIPBOARD_LOCK` 再取 `CLIP_CACHE`**，写入者只取 `CLIPBOARD_LOCK`，无环。**新增任何剪贴板读写路径必须取此锁。**（唯一例外：监听读在剪贴板被外部占用时，持锁跨有界 retry-sleep `CLIP_READ_RETRIES×CLIP_READ_RETRY_MS`——此时外部正占着剪贴板、写入者本就进不来，无额外损害；见 DECISIONS §6。）
- 死循环防御：写回剪贴板前 `SKIP_CLIP_EVENTS.store(2)`（用计数器非布尔——arboard 的 get+set 可能触发 2 次 seq 变化），后台 `swap` 递减跳过。`CLIPBOARD_LOCK` 与 `SKIP_CLIP_EVENTS`/seq 水位是两层正交防护：前者防**并发抢句柄(1418)**，后者防**自写回流历史面板**。
- 写文件用 `CF_HDROP` raw FFI（`SetClipboardData` / `DROPFILES`）：**`fWide` 必须 = 1**（UTF-16 路径）。别用 `[0u8;16]` 清零，会导致 fWide=FALSE 解析失败。
- 去重**只在同类型内进行**（跨类型去重会误删）：文件按 `items[0].path`，文本/图片按 `content`，不同类型永久保留。

### 窗口尺寸
- 用**工作区（work area）尺寸**而非物理全屏，保留任务栏。
- 200% DPI 下 `outer_size` 比设置值大 ~26×15px（Windows 给无边框窗口的隐形边框），用"位置补偿对齐屏幕原点"**动态计算**修正，**不要硬编码**。
- `set_shadow(false)` 后透明窗 `WRY_WEBVIEW` 子窗填满外框（含隐形边框），底边落在 `outer.bottom` 会越过任务栏顶遮一条 → `make_fullscreen` 末尾 `clamp_window_bottom` 量 `GetWindowRect`、越界则等量缩 inner 高度贴齐工作区底（动态测量、无硬编码）。详见 DECISIONS §5 延伸。

### 💀 死胡同（已验证失败，别再试，别浪费时间）
- **`WS_EX_NOACTIVATE` 推回键盘焦点**：WebView2 内部 `SetFocus` 抢占键盘路由，外部进程无权推回。
- **自建 OS 级钩子 `rdev` / `WH_KEYBOARD_LL`**：消息循环编排极易错、多轮踩坑失败——用 `tauri-plugin-global-shortcut`。（遗留实现 `hotkey.rs` 已删）
- **用 `RegisterHotKey` 的 Pressed/Released 事件判按键时长**：其事件经消息队列异步投递、有 500–800ms 抖动，阈值 200/300/500ms 全失败。⚠️ 注意区分：长短按本身**已实现**，但靠的是 `GetAsyncKeyState` 轮询物理电平（DECISIONS §2），**不是** RegisterHotKey 事件——别再回头试事件时长判定。
- **修饰键 `Alt`（裸 Alt 触发菜单栏）/ `Alt+Space`（被系统窗口菜单占用）/ `Fn`（硬件键，OS 收不到）**：改用非 Alt 修饰键（`Ctrl+空格` / `Ctrl+反引号`）。
- **拖入 target「每次 show 经 `run_on_main_thread` 幂等重注册」**：实测重注册虽报成功、产出的 IDropTarget 却收不到回调、破坏正常拖入（单变量隔离确认）。拖入注册**只在 setup 做一次**。详见 DECISIONS §14。（注：原生拖入本身**可行、已实现**，别误删——曾被错误登记为死胡同后已推翻。）

### 🔍 出问题时反查（症状 → 先查哪条铁律）
| 症状 | 大概率违反 |
|------|-----------|
| 空白页后延迟关闭 | 前端管了 hide / `transparent:false` |
| 呼出白闪 | `set_focus` 太早 / `hotkey-show` 没提前于 `show()` |
| Esc 没反应 | show 路径缺 `set_focus()` |
| 焦点回不来、粘贴失败 | 碰了 `WS_EX_NOACTIVATE` 死胡同 |
| 文件粘贴被 Explorer 拒绝 | `DROPFILES.fWide ≠ 1` |
| 截图不显示缩略图 | 检测顺序没把图片排在 CF_HDROP 之前 |
| 历史项被误删 | 做了跨类型去重（应只在同类型内去重）|
| 复制/粘贴写剪贴板报 os error 1418 | 写入段没取 `CLIPBOARD_LOCK`，与监听读并发抢 OpenClipboard 句柄 |
| 桌面粘贴弹冲突框 / 取消 | `SHFileOperation` 缺 `FOF_RENAMEONCOLLISION` |
| 窗口底部细蓝缝 / 透明窗边异常 | `NCRENDERING_POLICY=DISABLED` 破坏透明边自画的；去阴影改用 `set_shadow(false)`；见 DECISIONS §5 延伸 |
| WebView 盖住任务栏顶部一条 | `set_shadow(false)` 后 WebView 填满外框、底边越过任务栏顶；需 `clamp_window_bottom` 缩高贴齐；见 DECISIONS §5 延伸 |

---

## 协作约定（给 AI 编码助手）
- 改完代码要**自己真跑、看日志、用数据说话**，不要只说"请测试"就交差。
- **真跑不了 GUI 时别假装**：热键 / 桌面点击这类无头环境无法驱动的链路，至少**针对性验证可复现的核心逻辑**（例：本会话用 P/Invoke 直接验证 `SHFileOperation` 的 flag 语义），并在结论里**诚实标注哪些是模拟验证、哪些没真跑**。
- **诊断优先于修改**：先加日志 / 输出分析确认根因，再动手改。
- "理论上更优雅" ≠ "实际更好"：已验证的笨方法优于未验证的聪明方法。
- 出现"焦点回不来"这类**架构性死胡同信号时，果断回退**，不要打补丁硬撑。
- 每到一个稳定点立即 `git commit`。

## 强制记忆更新 (Post-Task)
在你完成了用户下达的开发需求，准备结束本次任务之前，你必须**主动修改并更新** `MEMORY.md` 文件。
- 更新内容需包含：本次新增/修改的核心文件路径、逻辑变更的极简概括、以及发现的已知 Bug 或下一步建议。
- **严禁**在 `MEMORY.md` 中粘贴大量代码，仅保留结构索引和文字说明。