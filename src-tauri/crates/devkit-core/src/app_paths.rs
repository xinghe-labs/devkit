//! 应用相关路径（镜像 `src/main/utils/app-paths.ts`）。
//!
//! 路径分两类，这个区分很重要：
//!  · **应用数据**（配置、日志、激活记录、备份、预设）→ `%APPDATA%\devkit\`，
//!    都很小，跟着应用走。
//!  · **批量产物**（版本目录、切换链接、下载缓存）→ `get_data_root()` 下面。
//!    实测能到几 GB，所以必须有办法挪到别的盘。
//!
//! 纯逻辑模块不依赖 Tauri —— `app-paths ↔ settings` 的循环依赖在 TS 里就是用
//! setter 解开的，这里同样用 override（`set_data_root_override`）。

use std::path::PathBuf;
use std::sync::OnceLock;

static DATA_ROOT_OVERRIDE: OnceLock<Option<String>> = OnceLock::new();

/// 测试专用：依赖 DEVKIT_APP_DATA / DEVKIT_DATA_ROOT 环境变量的测试共用这把锁，
/// 避免 set_var/remove_var 在并行测试间互相污染（曾导致测试状态写进真实 %APPDATA%）。
#[cfg(test)]
pub static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 允许主进程在读完配置后覆盖数据根目录（R6 settings 全量接入时调用）。
pub fn set_data_root_override(dir: Option<String>) {
    let value = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    let _ = DATA_ROOT_OVERRIDE.set(value);
}

fn data_root_override() -> Option<String> {
    DATA_ROOT_OVERRIDE.get().cloned().flatten()
}

/// `%APPDATA%\devkit`（应用数据根）。`DEVKIT_APP_DATA` 仅供测试注入。
pub fn get_user_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DEVKIT_APP_DATA") {
        return PathBuf::from(dir);
    }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("devkit")
}

/// 批量产物的根目录。
/// 优先级：环境变量 `DEVKIT_DATA_ROOT` → 主进程设置 → `%USERPROFILE%\.devkit`
pub fn get_data_root() -> PathBuf {
    if let Ok(root) = std::env::var("DEVKIT_DATA_ROOT") {
        let trimmed = root.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Some(overridden) = data_root_override() {
        return PathBuf::from(overridden);
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".devkit")
}

/// 给界面显示用：这个根目录是从哪来的。
pub fn describe_data_root() -> (PathBuf, &'static str) {
    if let Ok(root) = std::env::var("DEVKIT_DATA_ROOT") {
        let trimmed = root.trim().to_string();
        if !trimmed.is_empty() {
            return (PathBuf::from(trimmed), "env");
        }
    }
    if let Some(overridden) = data_root_override() {
        return (PathBuf::from(overridden), "config");
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    (PathBuf::from(home).join(".devkit"), "default")
}

/// `DEVKIT_HOME` 变量指向的目录（TS getDevkitHome）。
///
/// 注意这是**固定** `%USERPROFILE%\.devkit`（homedir），跟 `get_data_root()` 的
/// 三级优先级无关 —— TS 里也是这么写的（`join(homedir(), '.devkit')`）。
pub fn get_devkit_home() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".devkit")
}

pub fn get_config_file() -> PathBuf {
    get_user_data_dir().join("config.json")
}

pub fn get_log_dir() -> PathBuf {
    get_user_data_dir().join("logs")
}

/// 未完成安装计划的持久化位置（FR-17 重启续跑）。
pub fn get_pending_plan_file() -> PathBuf {
    get_user_data_dir().join("pending.json")
}

/// 用户级版本目录：<dataRoot>\versions\<tool>\<version>\
pub fn get_versions_root() -> PathBuf {
    get_data_root().join("versions")
}

/// 下载缓存目录（`.part` 断点文件也在这里）。
pub fn get_download_dir() -> PathBuf {
    ensure_dir(get_data_root().join("downloads"))
}

/// 切换链接根目录：<dataRoot>\current\（每工具一个 junction，不需要管理员）
pub fn get_current_root() -> PathBuf {
    get_data_root().join("current")
}

/// 更新包下载目录：<dataRoot>\updates\
pub fn get_update_dir() -> PathBuf {
    ensure_dir(get_data_root().join("updates"))
}

/// 预留给未来的 shim 目录：<dataRoot>\bin
pub fn get_shim_dir() -> PathBuf {
    get_data_root().join("bin")
}

/// 激活记录（FR-11 回滚依据）：%APPDATA%\devkit\activated.json
pub fn get_activation_file() -> PathBuf {
    get_user_data_dir().join("activated.json")
}

/// 用户清单覆盖目录（FR-15 热更新，决策 D10）。
pub fn get_user_manifest_dir() -> PathBuf {
    get_user_data_dir().join("manifest")
}

/// 用户自建预设目录：%APPDATA%\devkit\presets\
pub fn get_preset_dir() -> PathBuf {
    ensure_dir(get_user_data_dir().join("presets"))
}

/// 离线包目录：%APPDATA%\devkit\offline\
pub fn get_offline_dir() -> PathBuf {
    ensure_dir(get_user_data_dir().join("offline"))
}

/// 配置/备份目录（FR-6 写环境变量前备份原值用）。
pub fn get_backup_dir() -> PathBuf {
    ensure_dir(get_user_data_dir().join("backup"))
}

/// mkdir -p 语义；失败时返回原路径（调用方写文件时会再拿到具体错误）。
fn ensure_dir(path: PathBuf) -> PathBuf {
    let _ = std::fs::create_dir_all(&path);
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_is_devkit_subdir() {
        let _guard = crate::app_paths::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = std::env::var("DEVKIT_APP_DATA").ok();
        std::env::remove_var("DEVKIT_APP_DATA");
        let dir = get_user_data_dir();
        assert!(dir.ends_with("devkit"));
        assert_eq!(get_config_file(), dir.join("config.json"));
        assert_eq!(get_log_dir(), dir.join("logs"));
        assert_eq!(get_activation_file(), dir.join("activated.json"));
        assert_eq!(get_backup_dir(), dir.join("backup"));
        assert_eq!(get_user_manifest_dir(), dir.join("manifest"));
        assert_eq!(get_pending_plan_file(), dir.join("pending.json"));
        match original {
            Some(value) => std::env::set_var("DEVKIT_APP_DATA", value),
            None => std::env::remove_var("DEVKIT_APP_DATA"),
        }
    }

    #[test]
    fn data_root_priority_env_over_config_over_default() {
        let _guard = ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 保存原值，结束后恢复 —— 同进程还有其它测试依赖这个环境变量
        let original = std::env::var("DEVKIT_DATA_ROOT").ok();
        std::env::remove_var("DEVKIT_DATA_ROOT");

        // 默认：USERPROFILE\.devkit
        let (default_root, source) = describe_data_root();
        assert_eq!(source, "default");
        assert!(default_root.ends_with(".devkit"));

        // 环境变量优先
        std::env::set_var("DEVKIT_DATA_ROOT", "D:\\env-root");
        let (env_root, source) = describe_data_root();
        assert_eq!(source, "env");
        assert_eq!(env_root, PathBuf::from("D:\\env-root"));

        // 恢复（OnceLock 的 override 分支无法在共享进程的测试里安全验证，
        // set 后无法撤销；该分支由应用层集成覆盖）
        match original {
            Some(value) => std::env::set_var("DEVKIT_DATA_ROOT", value),
            None => std::env::remove_var("DEVKIT_DATA_ROOT"),
        }
    }

    #[test]
    fn devkit_home_is_profile_dot_devkit() {
        assert!(get_devkit_home().ends_with(".devkit"));
        assert!(get_devkit_home().starts_with(std::env::var("USERPROFILE").unwrap_or_default()));
    }
}
