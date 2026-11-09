// Tauri 壳：R0 最小骨架（MIGRATION-RUST.md 附录 E.5）。
// 只注册已实现的 command；未实现的通道在 renderer 适配层抛"未接入"。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devkit_types::AppInfo;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    devkit_app::app_info()
}

/// renderer 挂载完成回执（对齐现状三端链路自检）。
#[tauri::command]
fn signal_ready() -> bool {
    println!("[devkit] renderer ready");
    true
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, get_app_info, signal_ready])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R0 骨架自检：ping 通（MIGRATION-RUST.md 附录 E.5）
    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    /// R0 骨架自检：AppInfo 字段语义（附录 F.4，决策 D16）
    #[test]
    fn get_app_info_fields() {
        let info = get_app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.platform, "windows");
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert!(!info.electron_version.is_empty());
        assert!(!info.node_version.is_empty());
        // chromeVersion 读不到时如实返回 "unknown"，不 panic（附录 F.4）
        assert!(!info.chrome_version.is_empty());
    }

    /// R0 骨架自检：renderer 挂载回执（附录 F.3）
    #[test]
    fn signal_ready_returns_true() {
        assert!(signal_ready());
    }
}
