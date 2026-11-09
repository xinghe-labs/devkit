//! devkit-app 库层：AppState 与 command 实现。
//!
//! R0 仅三条命令（ping / get_app_info / signal_ready）；R5 收口全部 46 条。
//! AppInfo 字段语义见 MIGRATION-RUST.md 附录 F.4。

use devkit_types::AppInfo;

/// WebView2 运行时版本：注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv` 值。
/// 读不到（未装 WebView2）返回 "unknown"——不应 panic。
fn webview2_runtime_version() -> String {
    const CLIENTS_KEY: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    windows_registry::LOCAL_MACHINE
        .open(CLIENTS_KEY)
        .and_then(|k| k.get_string("pv"))
        .unwrap_or_else(|_| "unknown".into())
}

/// 数据根目录：`DEVKIT_DATA_ROOT` 环境变量 → `%USERPROFILE%\.devkit`
/// （完整三级优先级 env → config.json → default 见附录 G；R1 接 settings 后补齐）。
fn data_root() -> std::path::PathBuf {
    if let Ok(root) = std::env::var("DEVKIT_DATA_ROOT") {
        return std::path::PathBuf::from(root);
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home).join(".devkit")
}

/// TODO(R1)：manifestDir 取用户 override 目录或内置资源（决策 D10）；locale 从 settings 读。
/// TODO(R2+)：log_dir/log_file 由 devkit-core::logging 落地后如实返回（附录 C.2）。
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        // TODO(R3)：从 UserConfig 读 locale（settings 读取在 devkit-core::settings）；R1 固定默认值
        locale: devkit_types::Locale::ZhCn,
        platform: "windows".into(),
        arch: std::env::consts::ARCH.into(),
        is_packaged: !cfg!(debug_assertions),
        manifest_dir: data_root().join("manifest").to_string_lossy().into(),
        log_dir: data_root().join("logs").to_string_lossy().into(),
        log_file: String::new(),
        // 键名保留、值如实（决策 D16）
        electron_version: format!("tauri {}", tauri::VERSION),
        node_version: env!("DEVKIT_RUSTC_VERSION").into(),
        chrome_version: webview2_runtime_version(),
    }
}
