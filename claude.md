# Workbench App

Windows 全屏"第二桌面"工具：热键 toggle 呼出覆盖全屏的功能界面（应用启动器 / 文件中转 / 剪贴板历史），用完优雅消失，原桌面不受影响。理念 ≈ "功能增强版的开始菜单"。

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
- `docs/DECISIONS.md` — 完整架构决策与踩坑根因（需要"为什么"时读它，本文件只放结论）
- `docs/MEMORY.md` — 滚动会话小结，**当前进度 / 待办 / 下一步以它为准**

---

## 铁律（违反必引发连锁 bug，动手前先读完本节）

### 窗口 / 焦点（最高危区）
- **一次只改一个焦点 / 激活 / 窗口相关的变量**。捆绑改动必出连锁 bug。
- `tauri.conf.json` 中 `transparent: true` **必须保持**。改成 false 会触发全屏 + blur 的 GPU 合成开销，导致 hide/show 延迟 + 空白页闪烁。
- 窗口配置基线（在 tauri.conf.json）：`decorations:false, alwaysOnTop:true, skipTaskbar:true, visible:false, focus:false`。**`focus:false` 不能改**——抢焦点会破坏热键。
- 可见性的**唯一真相是 `window.is_visible()`（Rust）**。Rust 直接 `show()/hide()`，`emit` 只用于同步前端状态。**绝不让前端管 hide**（会引入 IPC 往返延迟，表现为"空白页后延迟关闭"）。
- 焦点交还机制（文本 / 图片 / 文件粘贴统一复用，**别改流程**）：
  `window.hide()` → `sleep(150ms)` → `GetForegroundWindow` → `SetForegroundWindow` → `enigo` 发 `Ctrl+V`。
- "前台窗口"与"键盘输入焦点"是两个概念。**不要再试 `WS_EX_NOACTIVATE` 推回焦点的方案——已验证失败**（WebView2 内部 `SetFocus` 会抢占路由，外部进程无权推回）。

### 全局热键
- 用 `tauri-plugin-global-shortcut`（底层 `RegisterHotKey`）。**不要自己写 `rdev` / `WH_KEYBOARD_LL` 等 OS 级钩子**——均已踩坑失败。
- **纯 toggle 模式，不做长短按判定**。`RegisterHotKey` 的 Pressed/Released 有 500–800ms 软件延迟，无法判物理按键时长，调阈值无效——别再尝试。
- 修饰键：不用 `Alt`（裸 Alt 触发菜单栏）、不用 `Alt+Space`（被系统窗口菜单占用）、不用 `Fn`（硬件键，OS 收不到）。用非 Alt 修饰键（如 `Ctrl+空格` / `Ctrl+反引号`）。
- 加 ~50ms 防抖，过滤 Windows key repeat 的重复 Pressed 事件。

### 剪贴板
- 后台线程 `start_clipboard_monitor` 独立于窗口 visible 常驻运行，轮询 `sleep(800ms)`。
- 用 `GetClipboardSequenceNumber()` 判断是否变化，**不每次读全量数据**。
- 检测顺序 `CF_HDROP(文件) → 图片 → 文本`，三者互斥；`CLIP_CACHE` 最多 20 条。
- 图片：>1024px 用 `image` crate `FilterType::Triangle` 缩到 1024px 缩略图再编码。**轮询不读图，只在内容变化时处理一次**。
- 死循环防御：写回剪贴板前 `SKIP_CLIP_EVENTS.store(2)`（用计数器非布尔——arboard 的 get+set 可能触发 2 次 seq 变化），后台 `swap` 递减跳过。
- 写文件用 `CF_HDROP` raw FFI（`SetClipboardData` / `DROPFILES`）：**`fWide` 必须 = 1**（UTF-16 路径）。别用 `[0u8;16]` 清零，会导致 fWide=FALSE 解析失败。
- 去重**只在同类型内进行**（跨类型去重会误删）：文件按 `items[0].path`，文本/图片按 `content`，不同类型永久保留。

### 窗口尺寸
- 用**工作区（work area）尺寸**而非物理全屏，保留任务栏。
- 200% DPI 下 `outer_size` 比设置值大 ~26×15px（Windows 给无边框窗口的隐形边框），用"位置补偿对齐屏幕原点"**动态计算**修正，**不要硬编码**。

---

## 协作约定（给 AI 编码助手）
- 改完代码要**自己真跑、看日志、用数据说话**，不要只说"请测试"就交差。
- **诊断优先于修改**：先加日志 / 输出分析确认根因，再动手改。
- "理论上更优雅" ≠ "实际更好"：已验证的笨方法优于未验证的聪明方法。
- 出现"焦点回不来"这类**架构性死胡同信号时，果断回退**，不要打补丁硬撑。
- 每到一个稳定点立即 `git commit`。

## 强制记忆更新 (Post-Task)
在你完成了用户下达的开发需求，准备结束本次任务之前，你必须**主动修改并更新** `MEMORY.md` 文件。
- 更新内容需包含：本次新增/修改的核心文件路径、逻辑变更的极简概括、以及发现的已知 Bug 或下一步建议。
- **严禁**在 `MEMORY.md` 中粘贴大量代码，仅保留结构索引和文字说明。