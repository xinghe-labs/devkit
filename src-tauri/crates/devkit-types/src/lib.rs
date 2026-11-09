//! devkit-types：主进程与渲染进程共享契约的 Rust serde 镜像。
//!
//! 对应 TS 侧 `src/shared/types.ts` + `src/shared/api.ts`（类型部分）。
//! 这里只放「契约」：纯数据类型 + 纯函数工具，无副作用。
//! serde 约定（与 MIGRATION-RUST.md 附录 B 一致）：
//! - 结构体字段统一 `#[serde(rename_all = "camelCase")]`
//! - 可选字段（TS 可选属性与 `T | null`）一律 `Option<T>` +
//!   `#[serde(default, skip_serializing_if = "Option::is_none")]`
//!   —— 回写时缺省键不落盘，两侧契约测试用「null 归一化为缺失」后比对。
//! - 枚举统一 kebab-case 命名，与 TS 字面量逐字一致。

pub mod activation;
pub mod detection;
pub mod doctor;
pub mod download_name;
pub mod ipc;
pub mod locale;
pub mod manifest;
pub mod plan;
pub mod preflight;
pub mod profile;
pub mod settings;
pub mod system;
pub mod timeutil;
pub mod update;
pub mod version;

pub use activation::{
    ActivateRequest, ActivateResult, ActivationRecord, ActivationSnapshot, InstalledTool,
    UninstallRequest, UninstallResult,
};
pub use detection::{
    DetectCommandSpec, DetectRequest, DetectSpec, DetectionResult, DetectionStatus,
    RegistryDetectRule,
};
pub use ipc::{IPC_CHANNELS, IPC_METHOD_COUNT, IPC_PUSH_CHANNELS, IPC_PUSH_COUNT};
pub use locale::{localized_text, normalize_locale, Locale, LocalizedText};
pub use manifest::{
    ActivateSpec, InstallSpec, InstallType, LicenseTier, ManifestLoadError, ManifestLoadResult,
    ManifestSource, ManifestStatus, MirrorSpec, SourceSpec, ToolCategory, ToolLicense,
    ToolManifest, ToolVersionSpec, UninstallSpec,
};
pub use plan::{
    DownloadAttempt, InstallPlan, InstallProgressDetail, InstallProgressEvent, MirrorPreference,
    PendingPlanLoad, PlanBuildError, PlanItem, PlanItemState, PlanOptions, PlanPreparation,
    PlanSelection, PlanSummary, PreflightCheck, PreflightLevel, PreflightResult, SchemaVersion,
    StartInstallResult,
};
pub use profile::{
    ApplyProfileOptions, ApplyProfileResult, DetectedToolEntry, EnvProfile, EnvProfileMachine,
    EnvProfileMirrorEntry, ExportProfileRequest, ExportProfileResult, ImportProfileResult,
    InstalledToolEntry, ProfileDiff, ProfileDiffEntry, ProfileSummary, ProfileToolState,
};
pub use settings::{MirrorApplyResult, MirrorSetting, MirrorTarget, UserConfigView};
pub use system::{
    MachinePathMode, SystemConfigId, SystemConfigItem, SystemConfigRequest, SystemConfigResult,
    SystemConfigRevertRequest,
};
pub use timeutil::iso8601_now;
pub use update::{
    DownloadUpdateResult, HotUpdateResultView, LogEntry, LogLevel, OfflinePackRequest,
    OfflinePackResult, RejectedHotUpdateEntry, SkippedOfflineItem, UpdateInfo, UpdatedToolEntry,
    VscodeCategory, VscodeExtension, VscodeInstallFailure, VscodeInstallResult, VscodeStatus,
};

use serde::{Deserialize, Serialize};

/// 应用与运行环境信息（IPC `app:info` 返回值）。
/// TS 侧 `AppInfo`（11 字段）；R0 起即在本 crate，收拢到 `app_info` 模块语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub locale: Locale,
    pub platform: String,
    pub arch: String,
    pub is_packaged: bool,
    pub manifest_dir: String,
    pub log_dir: String,
    pub log_file: String,
    pub electron_version: String,
    pub node_version: String,
    pub chrome_version: String,
}

/// 预设方案（FR-3）：一组勾选结果，可导出导入复现。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: LocalizedText,
    pub description: LocalizedText,
    pub builtin: bool,
    pub tools: Vec<PlanSelection>,
}
