//! IPC 通道白名单（镜像 `src/shared/ipc.ts`）。
//!
//! 主进程只注册这里列出的通道，预加载只暴露这里列出的通道 —— 两侧共用同一份
//! 常量，避免出现"渲染进程调了一个主进程没实现的通道"这种运行时才发现的问题。
//!
//! 一致性由契约测试锁定：`fixtures/ipc-channels.json` 同时约束 TS 侧
//! `IPC` 常量与本模块的 `IPC_CHANNELS` 数组，两侧任一侧漂移即测试失败。

/// 通道名与用途注释成对出现，保持与 ipc.ts 相同的顺序与分组。
pub const APP_INFO: &str = "app:info";
pub const MANIFEST_LIST: &str = "manifest:list";
pub const DETECT_RUN: &str = "detect:run";
pub const LOCALE_GET: &str = "locale:get";
pub const LOCALE_SET: &str = "locale:set";
pub const LOG_TAIL: &str = "log:tail";
pub const LOG_OPEN_DIR: &str = "log:open-dir";
pub const RENDERER_READY: &str = "app:renderer-ready";
pub const INSTALL_PREPARE: &str = "install:prepare";
pub const INSTALL_START: &str = "install:start";
pub const INSTALL_CANCEL: &str = "install:cancel";
pub const INSTALL_PENDING: &str = "install:pending";
pub const INSTALL_DISCARD_PENDING: &str = "install:discard-pending";
pub const INSTALL_RESUME: &str = "install:resume";
pub const INSTALL_EXPORT_REPORT: &str = "install:export-report";
pub const PRESET_LIST: &str = "preset:list";
pub const PRESET_SAVE: &str = "preset:save";
pub const PRESET_DELETE: &str = "preset:delete";
pub const PRESET_IMPORT: &str = "preset:import";
pub const ACTIVATE_SNAPSHOT: &str = "activate:snapshot";
pub const ACTIVATE_APPLY: &str = "activate:apply";
pub const ACTIVATE_REMOVE: &str = "activate:remove";
pub const INSTALLED_LIST: &str = "installed:list";
pub const UNINSTALL_RUN: &str = "uninstall:run";
pub const SETTINGS_GET: &str = "settings:get";
pub const SETTINGS_SAVE: &str = "settings:save";
pub const MIRRORS_APPLY: &str = "mirrors:apply";
pub const APP_OPEN_EXTERNAL: &str = "app:open-external";
pub const VSCODE_STATUS: &str = "vscode:status";
pub const VSCODE_LIST: &str = "vscode:list";
pub const VSCODE_INSTALL: &str = "vscode:install";
pub const UPDATE_CHECK: &str = "update:check";
pub const UPDATE_DOWNLOAD: &str = "update:download";
pub const UPDATE_INSTALL: &str = "update:install";
pub const PROFILE_EXPORT: &str = "profile:export";
pub const PROFILE_IMPORT: &str = "profile:import";
pub const PROFILE_APPLY: &str = "profile:apply";
pub const DOCTOR_RUN: &str = "doctor:run";
pub const DOCTOR_FIX: &str = "doctor:fix";
pub const SYSTEM_STATUS: &str = "system:status";
pub const SYSTEM_APPLY: &str = "system:apply";
pub const SYSTEM_REVERT: &str = "system:revert";
pub const MANIFEST_HOT_UPDATE: &str = "manifest:hot-update";
pub const MANIFEST_CLEAR_OVERRIDE: &str = "manifest:clear-override";
pub const OFFLINE_PACK: &str = "offline:pack";
pub const OFFLINE_IMPORT: &str = "offline:import";

/// 主进程 → 渲染进程 推送日志
pub const LOG_LINE: &str = "log:line";
/// 主进程 → 渲染进程 推送安装进度
pub const INSTALL_PROGRESS: &str = "install:progress";

/// invoke 通道数（46）：CI 契约测试与 `ipc_parity` 测试共同锁定。
pub const IPC_METHOD_COUNT: usize = 46;

/// 推送通道数（2）。
pub const IPC_PUSH_COUNT: usize = 2;

/// 全部 invoke 通道（顺序与 ipc.ts 一致；总数必须等于 `IPC_METHOD_COUNT`）。
pub const IPC_CHANNELS: [&str; IPC_METHOD_COUNT] = [
    APP_INFO,
    MANIFEST_LIST,
    DETECT_RUN,
    LOCALE_GET,
    LOCALE_SET,
    LOG_TAIL,
    LOG_OPEN_DIR,
    RENDERER_READY,
    INSTALL_PREPARE,
    INSTALL_START,
    INSTALL_CANCEL,
    INSTALL_PENDING,
    INSTALL_DISCARD_PENDING,
    INSTALL_RESUME,
    INSTALL_EXPORT_REPORT,
    PRESET_LIST,
    PRESET_SAVE,
    PRESET_DELETE,
    PRESET_IMPORT,
    ACTIVATE_SNAPSHOT,
    ACTIVATE_APPLY,
    ACTIVATE_REMOVE,
    INSTALLED_LIST,
    UNINSTALL_RUN,
    SETTINGS_GET,
    SETTINGS_SAVE,
    MIRRORS_APPLY,
    APP_OPEN_EXTERNAL,
    VSCODE_STATUS,
    VSCODE_LIST,
    VSCODE_INSTALL,
    UPDATE_CHECK,
    UPDATE_DOWNLOAD,
    UPDATE_INSTALL,
    PROFILE_EXPORT,
    PROFILE_IMPORT,
    PROFILE_APPLY,
    DOCTOR_RUN,
    DOCTOR_FIX,
    SYSTEM_STATUS,
    SYSTEM_APPLY,
    SYSTEM_REVERT,
    MANIFEST_HOT_UPDATE,
    MANIFEST_CLEAR_OVERRIDE,
    OFFLINE_PACK,
    OFFLINE_IMPORT,
];

/// 只能由主进程主动推送、渲染进程只能监听的通道。
pub const IPC_PUSH_CHANNELS: [&str; IPC_PUSH_COUNT] = [LOG_LINE, INSTALL_PROGRESS];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn channel_count_matches_declared_counts() {
        assert_eq!(IPC_CHANNELS.len(), IPC_METHOD_COUNT);
        assert_eq!(IPC_PUSH_CHANNELS.len(), IPC_PUSH_COUNT);
    }

    #[test]
    fn channels_are_unique() {
        let set: HashSet<_> = IPC_CHANNELS.into_iter().collect();
        assert_eq!(set.len(), IPC_METHOD_COUNT, "通道名存在重复");
    }

    #[test]
    fn push_channels_are_not_invoke_channels() {
        for channel in IPC_PUSH_CHANNELS {
            assert!(
                !IPC_CHANNELS.contains(&channel),
                "推送通道 {channel} 不应同时出现在 invoke 白名单"
            );
        }
    }
}
