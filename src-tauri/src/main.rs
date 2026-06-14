// 在 release 构建中隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbench_app_lib::run()
}
