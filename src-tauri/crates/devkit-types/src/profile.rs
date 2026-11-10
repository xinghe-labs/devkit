//! 环境档案 / 换机迁移（镜像 `src/shared/types.ts` FR-22 部分）。

use crate::detection::DetectionStatus;
use crate::locale::LocalizedText;
use crate::plan::PlanSelection;
use serde::{Deserialize, Serialize};

/// 环境档案：把"这台机器上的开发环境长什么样"收成一份可带走的 JSON。
///
/// **不含任何密钥**：环境变量走白名单（只收 JAVA_HOME 这类路径变量），
/// 不读 .npmrc 的 auth token、不碰 SSH 私钥、不碰 git credential。
/// git 身份默认不带（那算个人信息），要带得显式勾选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProfile {
    pub schema_version: crate::plan::SchemaVersion,
    pub created_at: String,
    pub devkit_version: String,
    /// 来源机器信息（不含用户名）
    pub machine: EnvProfileMachine,
    pub detected: Vec<DetectedToolEntry>,
    pub installed: Vec<InstalledToolEntry>,
    /// 用户 PATH 里的自定义条目（已排除系统自带与 devkit 管理的）
    pub user_path_extra: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub mirrors: Vec<EnvProfileMirrorEntry>,
    pub git: EnvProfileGit,
    pub vscode_extensions: Vec<String>,
    /// 目标机器上要装什么；可以直接喂给现有的安装流程
    pub selections: Vec<PlanSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProfileMachine {
    pub platform: String,
    pub arch: String,
    pub os_release: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedToolEntry {
    pub tool_id: String,
    pub status: DetectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledToolEntry {
    pub tool_id: String,
    pub version: String,
    pub activated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProfileMirrorEntry {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProfileGit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileToolState {
    Missing,
    VersionDiffers,
    AlreadyPresent,
    InstalledByDevkit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDiffEntry {
    pub tool_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<LocalizedText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wanted_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    pub state: ProfileToolState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub to_install: u32,
    pub already_present: u32,
    pub path_entries: u32,
    pub env_vars: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDiff {
    pub tools: Vec<ProfileDiffEntry>,
    pub missing_path_entries: Vec<String>,
    pub env_to_restore: std::collections::HashMap<String, String>,
    pub vscode_extensions: Vec<String>,
    pub summary: ProfileSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProfileOptions {
    pub restore_user_path: bool,
    pub restore_env: bool,
    pub restore_mirrors: bool,
    pub restore_git: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProfileResult {
    pub ok: bool,
    pub changed: Vec<String>,
    /// 需要安装的工具（交给现有安装流程，不在这里装）
    pub selections: Vec<PlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProfileRequest {
    pub include_git_identity: bool,
    /// 直写路径（脚本化迁移用）：传了就跳过保存对话框，但必须是绝对路径（TS 同语义）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProfileResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<EnvProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProfileResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<EnvProfile>,
    /// 档案里有什么（给用户先看清再决定）
    pub description: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<ProfileDiff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_profile_accepts_unknown_fields_for_forward_compat() {
        // 附录 B.1 规则 6：deny_unknown_fields 仅清单路径；
        // 档案路径必须接受未知字段（旧版 app 读新版档案不应崩溃）
        let mut json = serde_json::json!({
            "schemaVersion": 1,
            "createdAt": "2025-01-01T00:00:00.000Z",
            "devkitVersion": "0.6.2",
            "machine": { "platform": "win32", "arch": "x64", "osRelease": "Windows 11" },
            "detected": [],
            "installed": [],
            "userPathExtra": [],
            "env": {},
            "mirrors": [],
            "git": { "userName": null, "userEmail": null },
            "vscodeExtensions": [],
            "selections": []
        });
        json["sneaky"] = serde_json::json!(true);
        let profile =
            serde_json::from_value::<EnvProfile>(json).expect("档案路径必须向前兼容，接受未知字段");
        assert_eq!(profile.devkit_version, "0.6.2");
    }

    #[test]
    fn profile_tool_state_kebab_names() {
        assert_eq!(
            serde_json::to_value(ProfileToolState::InstalledByDevkit).unwrap(),
            "installed-by-devkit"
        );
        assert_eq!(
            serde_json::from_value::<ProfileToolState>(serde_json::json!("version-differs"))
                .unwrap(),
            ProfileToolState::VersionDiffers
        );
    }
}
