//! devkit-app 库层：路径解析、AppState 与 command 实现。
//!
//! R0 三条命令（ping / get_app_info / signal_ready）+ R3 只读命令面
//! （list_manifests / run_detection / get_locale / set_locale / tail_log / open_log_dir）。
//! AppInfo 字段语义见 MIGRATION-RUST.md 附录 F.4；数据文件位置见附录 G。

use std::path::PathBuf;

use devkit_types::locale::Locale;
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

/// R6 settings 全量接入时启用（env → config.json dataRoot → 默认 三级优先级）。
#[allow(dead_code)]
fn data_root() -> PathBuf {
    if let Ok(root) = std::env::var("DEVKIT_DATA_ROOT") {
        return PathBuf::from(root);
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".devkit")
}

/// 应用数据目录（config.json / logs / presets / manifest 覆盖）。
///
/// **对齐 TS Electron `app.getPath('userData')` = `%APPDATA%\devkit`**（附录 G 数据兼容：
/// config.json、pending.json、presets、日志都必须与 TS 版同路径），而不是 Tauri 默认的
/// `%APPDATA%\<identifier>`。`DEVKIT_APP_DATA` 环境变量仅供测试注入。
pub fn app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DEVKIT_APP_DATA") {
        return PathBuf::from(dir);
    }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("devkit")
}

/// config.json 位置：`%APPDATA%\devkit\config.json`（附录 G）。
pub fn config_file() -> PathBuf {
    app_data_dir().join("config.json")
}

/// 日志目录：`%APPDATA%\devkit\logs`（附录 C.2）。
pub fn log_dir() -> PathBuf {
    app_data_dir().join("logs")
}

/// 用户清单覆盖目录：`%APPDATA%\devkit\manifest`（FR-15 热更新，决策 D10）。
pub fn user_manifest_dir() -> PathBuf {
    app_data_dir().join("manifest")
}

/// 内置清单目录。
///
/// - `DEVKIT_MANIFEST_DIR` 覆盖（测试/便携模式）
/// - 打包后：exe 同级 `resources/manifest`（R6 定打包方案，先按外置目录解析）
/// - 开发期：exe（target/debug）上溯两级 → 仓库根 `resources/manifest`
pub fn manifest_builtin_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DEVKIT_MANIFEST_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(mut dir) = exe.parent() {
            // 开发期：target/debug 与 target/debug/deps 都要能上溯到仓库根；
            // 打包后优先命中 exe 同级 resources/manifest。最多上溯 6 级。
            for _ in 0..6 {
                let candidate = dir.join("resources").join("manifest");
                if candidate.join("tools").is_dir() {
                    return candidate;
                }
                match dir.parent() {
                    Some(parent) => dir = parent,
                    None => break,
                }
            }
        }
    }
    PathBuf::from("resources/manifest")
}

/// 系统界面语言（TS `app.getLocale()` 的替代；注册表
/// `HKCU\Control Panel\International\LocaleName`，读不到返回 None → 默认 zh-CN）。
pub fn ui_locale() -> Option<Locale> {
    let name = windows_registry::CURRENT_USER
        .open(r"Control Panel\International")
        .and_then(|k| k.get_string("LocaleName"))
        .ok()?;
    Some(devkit_types::locale::normalize_locale(Some(&name)))
}

pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        locale: devkit_core::settings::get_locale(&config_file(), ui_locale()),
        platform: "windows".into(),
        arch: std::env::consts::ARCH.into(),
        is_packaged: !cfg!(debug_assertions),
        manifest_dir: manifest_builtin_dir().to_string_lossy().into(),
        log_dir: log_dir().to_string_lossy().into(),
        log_file: devkit_core::logging::global().current_file(),
        // 键名保留、值如实（决策 D16）
        electron_version: format!("tauri {}", tauri::VERSION),
        node_version: env!("DEVKIT_RUSTC_VERSION").into(),
        chrome_version: webview2_runtime_version(),
    }
}

/// `tail_log` 的 asBoundedInt 规整（附录 A #6）：缺省 500，1~3000 之外报错。
pub fn bounded_log_count(count: Option<f64>) -> Result<usize, String> {
    const FALLBACK: usize = 500;
    const MIN: f64 = 1.0;
    const MAX: f64 = 3000.0;
    let Some(value) = count else {
        return Ok(FALLBACK);
    };
    if !value.is_finite() {
        return Err("count 必须是数字".to_string());
    }
    let rounded = value.trunc();
    if !(MIN..=MAX).contains(&rounded) {
        return Err(format!("count 必须在 {MIN}~{MAX} 之间"));
    }
    Ok(rounded as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_log_count_matches_ts() {
        // 缺省 500（TS asBoundedInt(count,'count',500,1,3000)）
        assert_eq!(bounded_log_count(None).unwrap(), 500);
        assert_eq!(bounded_log_count(Some(1.0)).unwrap(), 1);
        assert_eq!(bounded_log_count(Some(3000.0)).unwrap(), 3000);
        // 非整数截断
        assert_eq!(bounded_log_count(Some(9.7)).unwrap(), 9);
        // 越界/非数字报错（Promise rejection）
        assert!(bounded_log_count(Some(0.0)).is_err());
        assert!(bounded_log_count(Some(3001.0)).is_err());
        assert!(bounded_log_count(Some(f64::NAN)).is_err());
    }

    #[test]
    fn app_data_dir_is_devkit_subdir_of_appdata() {
        // 附录 G：与 TS Electron userData 同路径（%APPDATA%\devkit），不是 identifier 目录
        std::env::remove_var("DEVKIT_APP_DATA");
        let dir = app_data_dir();
        if let Ok(appdata) = std::env::var("APPDATA") {
            assert!(dir.starts_with(appdata));
        }
        assert!(dir.ends_with("devkit"));
        assert_eq!(config_file(), dir.join("config.json"));
        assert_eq!(log_dir(), dir.join("logs"));
        assert_eq!(user_manifest_dir(), dir.join("manifest"));
    }

    #[test]
    fn ui_locale_never_panics() {
        let _ = ui_locale(); // 注册表读不到就 None，不 panic
    }
}
