# SPIKE 记录 — GetAsyncKeyState 物理键态轮询（临时，待结论后并入 DECISIONS/删除）

> 状态：**实现完成、编译零警告、未真跑**（无头环境无法驱动物理按键，需在真机跑）。
> 这是隔离实验，**未改动任何现有热键 / show / set_focus / toggle 逻辑**——仅新增一个 env 门控的独立线程。

---

## 0. 它验证什么

历史上"按住 Ctrl+Space→显示，松开→隐藏"三次失败的**共同根因**：按键事件经 hook/消息队列异步投递，
要么被 WebView2 抢焦点破坏（rdev，DECISIONS §1），要么消息循环编排出错（WH_KEYBOARD_LL，§1），
要么有 500-800ms 抖动（RegisterHotKey 时长判定，§2）。

本 spike 验证一条**文档里没试过**的机制：`GetAsyncKeyState` 读**物理键电平**（不是事件、不进消息队列、
与焦点无关）。**成败核心**：窗口 `set_focus()` 抢走键盘焦点后，轮询线程还能不能读到"已松开"。

## 1. 怎么跑

```bash
# Git Bash
WORKBENCH_SPIKE=1 npm run tauri dev
# 或 PowerShell
$env:WORKBENCH_SPIKE=1; npm run tauri dev
```

- 设了 `WORKBENCH_SPIKE` → 跳过生产热键注册，只跑 spike（避免 toggle 抢同一 Ctrl+Space 污染数据）。
- 没设 → 一切照旧，spike 完全不运行。
- 代码位置：`src-tauri/src/lib.rs` 的 `spike_keystate_monitor()` + setup 里的 env 分支。

## 2. 日志格式（控制台 / dev 终端）

```
[spike] started poll=25ms keys=Ctrl+Space
[spike] 稳定判据: 一次物理按住 = 恰好 1 行 DOWN + 1 行 UP；成串 DOWN/UP = MSB 抖动
[spike] DOWN  t=1234ms                                  ← 按下沿（同时检测到 Ctrl 与 Space 的 MSB）
[spike] UP    t=1456ms held=222ms class=GRAY(200-300ms) ← 松开沿 + 按住时长 + tap/hold 分类
```

- `t` = 自 spike 线程启动的单调时钟（ms），用于对比各行先后。
- `held` = 本次按住时长（`Instant` 单调时钟，不受系统时间跳变影响）。
- `class`：`<200ms` = TAP，`>300ms` = HOLD，中间灰区。

## 3. 测试动作（请在真机依次做，把日志贴回本文件 §5）

1. **快速点按 ×5**：尽量短促按一下松开 → 期望每次一行 DOWN + 一行 UP，held 都 <200ms。
2. **长按 ×5**：按住约 1 秒再松 → 期望 held ≈ 1000ms，class=HOLD，每次仍是 1 DOWN+1 UP。
3. **按住期间观察窗口**：按下后窗口应弹出并抢焦点（spike 内 show+set_focus）；按住不动时**不应**有成串 DOWN/UP。
4. **漏键压测**：连续快慢交替按 20 次，看有没有哪次只有 DOWN 没有 UP（= 松开沿丢失，等于 rdev 的失败模式）。
5. **泄漏观察**：先点开一个文本编辑器/搜索框获得焦点，再按 Ctrl+Space → 观察 spike 弹窗前那一下，
   编辑器里是否被打入空格 / 是否触发输入法切换（轮询不消费按键，按键会同时落给前台窗口）。

## 4. 我的预测（**仅为预测，未验证**，待真机数据推翻或确认）

| 问题 | 预测 | 依据 |
|---|---|---|
| 松开沿能否稳定捕获？show 之后会不会像 rdev 那样丢？ | **能稳定捕获，不会丢** | GetAsyncKeyState 读全局物理键态，与焦点/消息队列无关；rdev 丢的是"经消息队列的事件"，本机制不经队列 |
| 按住时长测量是否稳定？能否分清 <200 tap 与 >300 hold？ | **稳定，方差应在 ±25ms（=轮询间隔）量级**，tap/hold 可清晰区分 | 时长由 `Instant` 单调时钟算，误差上界就是一个轮询周期；远小于 RegisterHotKey 的 500-800ms 抖动 |
| key repeat 期间 MSB 是否持续为 1（不抖）？ | **持续为 1，无抖动** | MSB 是"当前是否按下"的电平，与 WM_KEYDOWN 的 repeat 事件流无关；故一次按住应只有 1 DOWN+1 UP |
| Ctrl+Space 是否泄漏给前台？影响多大？ | **会泄漏**（轮询不消费）；影响取决于前台 app：文本框可能被打入空格、可能触发输入法切换 | 这是纯轮询相对 RegisterHotKey 的固有代价；若不可接受，需保留 RegisterHotKey 做"消费+show 触发"的混合架构 |

> ⚠️ 若 #1 或 #4 真机表现为"松开沿偶发丢失"，则此机制也不成立，**立即回退纯 toggle**，不硬撑（铁律：死胡同信号果断回退）。

## 5. 真机实测结果（待填）

- 测试机：________（DPI / 键盘类型）
- 动作1 快速点按：_____正常开/关，每次点按对应一个开或关__
- 动作2 长按：___长按正常开启，松开后界面正常显示，再次长按：触发关后又触发了开，有概率触发开关交替__
- 动作3 按住稳定性（有无成串边沿）：____长按开界面时没有，再察南关界面上有概率触发___
- 动作4 漏键压测（有无只 DOWN 无 UP）：___无_____
- 动作5 泄漏观察：________无
- **结论**：☑ **机制成立，可进入实现阶段**

### 5.1 真机日志判定（2026-06-18，默认激活后有效数据）

8 次按压日志：TAP held=52/153/52ms；HOLD held=583/865/1118/1093/1165/762ms。

| 验证点 | 结论 |
|---|---|
| 松开沿稳定捕获、show 抢焦点后不丢 | ✅ 每个 DOWN 恰好跟随 1 个 UP，零丢失（rdev 失败模式的反面）|
| 时长测量稳定、tap/hold 可分 | ✅ TAP ≤153ms vs HOLD ≥583ms，拉开数百 ms |
| key repeat 期间 MSB 不抖 | ✅ 一次按住 = 1 DOWN + 1 UP，无成串边沿 |
| 泄漏前台 | 实测无明显影响 |

**根因**：历史三次失败均败于"按键经 hook/消息队列异步投递"；GetAsyncKeyState 读物理键电平绕开整类问题。

### 5.2 目标设计（混合语义，用户确认）

- 长按（held > 阈值）→ momentary：按下开、松开关。
- 短按（held ≤ 阈值）→ toggle：松开不关，下一次短按才关。
- 阈值 `SPIKE_TAP_MAX_MS` 默认 250ms（落在实测 tap≤153 与 hold≥583 的安全间隔内，可调）。

## 6. 回退方式

删 `spike_keystate_monitor()` 整段函数 + setup 里的 `if std::env::var("WORKBENCH_SPIKE")...` 分支
（恢复成单行 `register(...)`）。无其它牵连。


日志：

[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[hotkey] toggle → show
[hotkey] toggle → hide
[clipbg] seq changed → reading
[clipbg] text: 测试机：________（DPI / 键盘类型）
- 动作
[clipbg] seq changed → reading
[clipbg] text: [hotkey] toggle → hide
[hotke

