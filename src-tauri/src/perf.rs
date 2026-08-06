//! 性能测量桩（增强搜索性能专项）。
//!
//! Rust 侧分段计时的统一开关 + 前端 perfTrace 汇总行的落盘通道：
//! 前端 `wb.perf=1` 的 p50/p95/max 汇总经 `perf_report` 落到 stderr，
//! 与 Rust 侧 `[perf]` 分段（`WORKBENCH_PERF=1`）在同一日志流里对齐。

use std::sync::OnceLock;

/// `WORKBENCH_PERF=1` 时启用 Rust 侧分段计时（沿用 `WORKBENCH_SCAN_DRIVES` 的 env 门控惯例）。
/// 默认关闭：不输出任何日志，分段处只剩一次原子读。
pub fn perf_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("WORKBENCH_PERF").is_ok_and(|v| v == "1"))
}

/// 前端 perfTrace 的汇总行原样落 stderr（前端不打 wb.perf 就不会有调用，故这里不再二次门控）。
#[tauri::command]
pub fn perf_report(lines: Vec<String>) {
    for line in lines {
        eprintln!("[perf-fe] {line}");
    }
}

/// 前端门控的环境开关来源：release 构建无 devtools、设不了 localStorage，
/// 所以 `WORKBENCH_PERF=1` 必须同时能打开前端分段（启动时由 perfTrace 查询一次）。
#[tauri::command]
pub fn perf_env_on() -> bool {
    perf_on()
}
