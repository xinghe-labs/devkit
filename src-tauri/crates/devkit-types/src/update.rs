//! VS Code 插件（FR-7）与更新（FR-13）、离线包（FR-12）、日志（镜像 `src/shared/types.ts`）。

use crate::locale::LocalizedText;
use serde::{Deserialize, Serialize};

/* ---------------- VS Code 插件（FR-7） ---------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VscodeCategory {
    Ai,
    Frontend,
    Java,
    Python,
    Go,
    Rust,
    Cpp,
    General,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeExtension {
    pub id: String,
    pub category: VscodeCategory,
    pub name: LocalizedText,
    pub description: LocalizedText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeStatus {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_path: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeInstallResult {
    pub ok: bool,
    pub installed: Vec<String>,
    pub failed: Vec<VscodeInstallFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeInstallFailure {
    pub id: String,
    pub error: String,
}

/* ---------------- 更新检查与半自动升级（FR-13） ---------------- */

/// 更新包下载结果（FR-13）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUpdateResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub bytes: u64,
    /// 实际校验结果；索引里没给哈希时为 null
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 更新检查结果（FR-13）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// 期望的 SHA-256（来自更新索引；没有就为 null，下载时不强校验但会告警）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 清单热更新结果（FR-15）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotUpdateResultView {
    pub ok: bool,
    pub fetched: u32,
    pub applied: u32,
    pub rejected: Vec<RejectedHotUpdateEntry>,
    pub updated: Vec<UpdatedToolEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedHotUpdateEntry {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedToolEntry {
    pub id: String,
    pub versions: Vec<String>,
}

/* ---------------- 离线包（FR-12） ---------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePackRequest {
    pub tool_ids: Vec<String>,
    /// 目标目录，用户通过保存对话框选
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePackResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_dir: Option<String>,
    pub file_count: u32,
    pub total_bytes: u64,
    /// 因为许可证分级被排除的项（L2/L3 不得再分发，SPEC §8）。
    /// 必须让用户看到"为什么少了几个"，而不是悄悄少打包。
    pub skipped: Vec<SkippedOfflineItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedOfflineItem {
    pub id: String,
    pub tier: crate::manifest::LicenseTier,
    pub reason: String,
}

/* ---------------- 日志 ---------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// ISO 时间戳
    pub ts: String,
    pub level: LogLevel,
    /// 产生日志的模块，例如 "manifest" / "detect"
    pub scope: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vscode_category_kebab_names() {
        assert_eq!(serde_json::to_value(VscodeCategory::Cpp).unwrap(), "cpp");
        assert_eq!(serde_json::to_value(VscodeCategory::Ai).unwrap(), "ai");
    }

    #[test]
    fn log_level_kebab_names() {
        assert_eq!(serde_json::to_value(LogLevel::Warn).unwrap(), "warn");
        assert_eq!(serde_json::to_value(LogLevel::Debug).unwrap(), "debug");
    }

    #[test]
    fn update_info_accepts_null_fields() {
        let json = serde_json::json!({
            "hasUpdate": false,
            "currentVersion": "0.6.2",
            "latestVersion": null,
            "downloadUrl": null,
            "downloadSha256": null,
            "sizeBytes": null,
            "notes": null,
            "error": null
        });
        let info: UpdateInfo = serde_json::from_value(json).unwrap();
        assert!(!info.has_update);
        assert_eq!(info.latest_version, None);
    }
}
