// Tauri 壳：R0 骨架 + R3 只读命令面（MIGRATION-RUST.md 附录 E.5 / 附录 A #1-#8）。
// 只注册已实现的 command；未实现的通道在 renderer 适配层抛"未接入"。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devkit_types::detection::{DetectRequest, DetectionResult};
use devkit_types::locale::Locale;
use devkit_types::manifest::ManifestLoadResult;
use devkit_types::update::LogEntry;
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

/// 附录 A #2：内置清单 + 用户热更新覆盖（决策 D10）。
#[tauri::command]
fn list_manifests() -> ManifestLoadResult {
    devkit_manifest::load_manifests(
        &devkit_app::manifest_builtin_dir(),
        Some(&devkit_app::user_manifest_dir()),
        false,
    )
}

/// 附录 A #3：检测（空/缺省 toolIds = 全量）。
#[tauri::command]
async fn run_detection(request: Option<DetectRequest>) -> Result<Vec<DetectionResult>, String> {
    let manifests = list_manifests();
    let tool_ids = request.and_then(|req| req.tool_ids).unwrap_or_default();
    let targets: Vec<_> = if tool_ids.is_empty() {
        manifests.tools
    } else {
        manifests
            .tools
            .into_iter()
            .filter(|tool| tool_ids.contains(&tool.id))
            .collect()
    };

    devkit_core::logging::global().info("detect", &format!("开始检测 {} 个工具", targets.len()));

    // 注册表扫描失败 → 退化为仅命令与文件检测（TS 同语义）
    let programs = match devkit_sys::registry::get_installed_programs() {
        Ok(programs) => programs,
        Err(error) => {
            devkit_core::logging::global().warn(
                "detect",
                &format!("注册表扫描失败，退化为仅用命令与文件检测：{error}"),
            );
            Vec::new()
        }
    };

    Ok(devkit_core::detect::detect_all(
        &targets,
        &programs,
        devkit_core::detect::DetectAllOptions { concurrency: None },
        None,
    )
    .await)
}

/// 附录 A #4/#5：语言读取与切换（config.json 持久化）。
fn locale_tag(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhCn => "zh-CN",
        Locale::EnUs => "en-US",
    }
}

#[tauri::command]
fn get_locale() -> Locale {
    devkit_core::settings::get_locale(&devkit_app::config_file(), devkit_app::ui_locale())
}

#[tauri::command]
fn set_locale(value: Option<String>) -> Locale {
    let locale = devkit_core::settings::set_locale(
        &devkit_app::config_file(),
        value.as_deref(),
        devkit_app::ui_locale(),
    );
    devkit_core::logging::global().info(
        "settings",
        &format!("界面语言切换为 {}", locale_tag(locale)),
    );
    locale
}

/// 附录 A #6：读内存环形缓冲（附录 C.2；不读文件）。
#[tauri::command]
fn tail_log(count: Option<f64>) -> Result<Vec<LogEntry>, String> {
    let count = devkit_app::bounded_log_count(count)?;
    Ok(devkit_core::logging::global().tail(count))
}

/// 附录 A #7：打开日志目录（资源管理器）。
#[tauri::command]
fn open_log_dir() -> bool {
    let dir = devkit_app::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    std::process::Command::new("explorer")
        .arg(dir.as_os_str())
        .spawn()
        .is_ok()
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // 启动时注入日志目录（不依赖 Tauri，附录 C.2）
            let file = devkit_core::logging::global().init(&devkit_app::log_dir());
            devkit_core::logging::global().info("app", &format!("devkit 启动，日志文件：{file}"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_app_info,
            signal_ready,
            list_manifests,
            run_detection,
            get_locale,
            set_locale,
            tail_log,
            open_log_dir
        ])
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

    /// R3：list_manifests 走内置资源（dev 期 ../../resources/manifest）
    #[test]
    fn list_manifests_loads_builtin() {
        let result = list_manifests();
        assert!(!result.tools.is_empty(), "内置清单应加载出工具");
        assert!(
            result.tools.iter().any(|tool| tool.id == "nodejs"),
            "内置清单里应有 nodejs"
        );
    }

    /// R3：run_detection 指定 toolIds 过滤
    #[tokio::test]
    async fn run_detection_filters_by_ids() {
        let results = run_detection(Some(DetectRequest {
            tool_ids: Some(vec!["nodejs".to_string()]),
        }))
        .await
        .expect("检测不应失败");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_id, "nodejs");
        // 本机装没装都是合法结论，但不能是 error
        assert_ne!(
            results[0].status,
            devkit_types::detection::DetectionStatus::Error
        );
        // 空数组 = 全量
        let all = run_detection(Some(DetectRequest {
            tool_ids: Some(Vec::new()),
        }))
        .await
        .expect("全量检测不应失败");
        assert!(all.len() > 5, "内置清单不止 5 个工具");
    }

    /// R3：语言读写（注入临时 DEVKIT_APP_DATA）
    #[test]
    fn locale_roundtrip_via_config_file() {
        let tmp = std::env::temp_dir().join("devkit-app-locale-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("DEVKIT_APP_DATA", &tmp);
        assert_eq!(set_locale(Some("en-US".to_string())), Locale::EnUs);
        assert_eq!(get_locale(), Locale::EnUs);
        assert_eq!(
            set_locale(Some("nope".to_string())),
            Locale::ZhCn,
            "未知语言回默认"
        );
        std::env::remove_var("DEVKIT_APP_DATA");
    }

    /// R3：tail_log 越界报错（附录 A #6 备注）
    #[test]
    fn tail_log_rejects_out_of_range() {
        assert!(tail_log(Some(0.0)).is_err());
        assert!(tail_log(Some(9999.0)).is_err());
        let _ = tail_log(None).unwrap(); // 缺省 500
    }
}
