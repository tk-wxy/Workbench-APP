use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    PM_NOREMOVE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU;

/// 缓存的 AppHandle
static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

/// Alt 键当前是否按住（仅记录状态，不直接触发事件）
static ALT_DOWN: AtomicBool = AtomicBool::new(false);

/// 钩子句柄（HHOOK 不可 Send/Sync，用 AtomicIsize 绕过 static 限制）
static HOOK_RAW: AtomicIsize = AtomicIsize::new(0);

/// WH_KEYBOARD_LL 回调 —— Alt+Space 组合键触发
unsafe extern "system" fn keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code == HC_ACTION as i32 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        // 临时调试：打印所有按键事件
        println!("[hotkey] key event: vk={:#04x} msg={}", kb.vkCode, w_param.0);
        let vk = kb.vkCode;
        let is_alt = vk == 0xA4u32 || vk == 0xA5u32; // VK_LMENU / VK_RMENU
        let is_f1 = vk == 0x70u32; // VK_F1

        match w_param.0 as u32 {
            x if x == WM_KEYDOWN || x == WM_SYSKEYDOWN => {
                // Alt 按下：只记录状态
                if is_alt {
                    ALT_DOWN.store(true, Ordering::SeqCst);
                    println!("[hotkey] Alt DOWN");
                }
                // F1 按下 + Alt 按着 = 呼出
                if is_f1 && ALT_DOWN.load(Ordering::SeqCst) {
                    println!("[hotkey] Alt+F1 → show");
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = app.emit("hotkey-show", ());
                    }
                }
            }
            x if x == WM_KEYUP || x == WM_SYSKEYUP => {
                // Alt 松开：只重置状态
                if is_alt {
                    ALT_DOWN.store(false, Ordering::SeqCst);
                    println!("[hotkey] Alt UP");
                }
                // F1 松开 → 隐藏窗口
                if is_f1 {
                    println!("[hotkey] F1 UP → hide");
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = app.emit("hotkey-hide", ());
                    }
                }
            }
            _ => {}
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

/// 安装 WH_KEYBOARD_LL 钩子并启动完整消息循环线程
pub fn start_hook(app_handle: AppHandle) {
    APP_HANDLE.set(app_handle).ok();

    std::thread::spawn(|| unsafe {
        // 第一步：用 PeekMessageW 初始化线程消息队列
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);

        // 第二步：安装低级键盘钩子
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_proc),
            None,
            0,
        )
        .expect("Failed to install keyboard hook");

        HOOK_RAW.store(hook.0 as isize, Ordering::SeqCst);
        println!("[hotkey] Hook installed successfully");

        // 第三步：完整消息循环 —— 三件套缺一不可
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // 退出前卸载钩子
        let raw = HOOK_RAW.load(Ordering::SeqCst);
        if raw != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(raw as *mut _));
        }
    });
}
