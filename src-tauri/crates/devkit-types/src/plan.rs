//! 安装计划相关类型（镜像 `src/shared/types.ts` 安装计划部分，SPEC §7.4）。

use crate::manifest::{InstallScope, LicenseTier};
use serde::{Deserialize, Serialize};

/// 镜像偏好。决定下载时哪个源排第一，其余按清单顺序排在其后
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorPreference {
    Official,
    Huaweicloud,
    Aliyun,
    Tuna,
    Ustc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanItemState {
    Pending,
    Downloading,
    Verifying,
    Installing,
    Checking,
    Success,
    Failed,
    Skipped,
    Cancelled,
}

/// 下载尝试记录（含失败的源与原因）。
/// 调研里"失败不可诊断"是核心抱怨之一：用户要能一眼看到
/// "试过哪几个源、每个源为什么失败、重试了几次"，而不是只看到一句"下载失败"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAttempt {
    pub source: String,
    pub url: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub version: String,
    pub tier: LicenseTier,
    pub install_scope: InstallScope,
    pub requires_admin: bool,
    pub requires_reboot: bool,
    pub depends_on: Vec<String>,
    pub state: PlanItemState,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 成功后的说明，例如"已安装，跳过"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// 实际安装目录，自检与卸载要用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    /// 下载产物路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_attempts: Option<Vec<DownloadAttempt>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptions {
    pub concurrency: u32,
    pub mirror_preference: MirrorPreference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    pub create_restore_point: bool,
    /// 只演练：不执行安装器、不激活，只把命令行算出来（虚拟机验收前的干跑）
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
    pub cancelled: u32,
}

/// InstallPlan.schemaVersion 的字面量 1（Schema/契约固定为 1）。
/// TS 侧是数字字面量 `schemaVersion: 1`，所以 Serialize/Deserialize 都按数字处理，
/// 不能用 `rename = "1"`（那会变成字符串 "1"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaVersion {
    One,
}

impl SchemaVersion {
    /// 固定字面量值
    pub const VALUE: u64 = 1;
}

impl Serialize for SchemaVersion {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(SchemaVersion::VALUE)
    }
}

impl<'de> Deserialize<'de> for SchemaVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct VersionVisitor;
        impl serde::de::Visitor<'_> for VersionVisitor {
            type Value = SchemaVersion;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("schemaVersion 必须是数字 1")
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                if value == SchemaVersion::VALUE {
                    Ok(SchemaVersion::One)
                } else {
                    Err(E::invalid_value(
                        serde::de::Unexpected::Unsigned(value),
                        &"1",
                    ))
                }
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value == "1" {
                    Ok(SchemaVersion::One)
                } else {
                    Err(E::invalid_value(serde::de::Unexpected::Str(value), &"1"))
                }
            }
        }
        deserializer.deserialize_any(VersionVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub schema_version: SchemaVersion,
    pub plan_id: String,
    pub created_at: String,
    pub devkit_version: String,
    pub manifest_revision: String,
    pub options: PlanOptions,
    pub items: Vec<PlanItem>,
    pub summary: PlanSummary,
}

/// 用户在选择页的勾选结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSelection {
    pub tool_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBuildError {
    pub tool_id: String,
    pub reason: String,
}

/// 预检等级（FR-18）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreflightLevel {
    Ok,
    Warn,
    Error,
}

/// 预检结果（FR-18）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    pub id: String,
    pub level: PreflightLevel,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    /// 无 error 级问题则为 true
    pub ok: bool,
    pub checks: Vec<PreflightCheck>,
    pub total_download_bytes: u64,
    pub requires_admin: bool,
}

/// install:prepare 的返回：计划 + 预检 + 构建期发现的问题
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreparation {
    pub plan: InstallPlan,
    pub preflight: PreflightResult,
    pub problems: Vec<PlanBuildError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 主进程 → 渲染进程 推送的进度
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressEvent {
    pub plan: InstallPlan,
    /// 正在处理的项目 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<InstallProgressDetail>,
}

/// pending.json 的读取结果（FR-17）。
///
/// TS 侧是 `{ status: 'none' } | { status: 'ok'; plan } | { status: 'invalid'; reason }`
/// 的 discriminated union；serde 用内部 tag `status` 对齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PendingPlanLoad {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "ok")]
    Ok { plan: InstallPlan },
    #[serde(rename = "invalid")]
    Invalid { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInstallResult {
    pub started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_plan_load_roundtrip_all_variants() {
        let none: PendingPlanLoad =
            serde_json::from_value(serde_json::json!({ "status": "none" })).unwrap();
        assert_eq!(none, PendingPlanLoad::None);
        assert_eq!(
            serde_json::to_value(&PendingPlanLoad::None).unwrap(),
            serde_json::json!({ "status": "none" })
        );

        let invalid: PendingPlanLoad = serde_json::from_value(serde_json::json!({
            "status": "invalid",
            "reason": "schema 校验失败"
        }))
        .unwrap();
        assert_eq!(
            invalid,
            PendingPlanLoad::Invalid {
                reason: "schema 校验失败".to_string()
            }
        );
    }

    #[test]
    fn install_plan_accepts_literal_schema_version() {
        let json = serde_json::json!({
            "schemaVersion": 1,
            "planId": "plan-001",
            "createdAt": "2025-01-01T00:00:00.000Z",
            "devkitVersion": "0.6.2",
            "manifestRevision": "builtin",
            "options": {
                "concurrency": 2,
                "mirrorPreference": "official",
                "createRestorePoint": false,
                "dryRun": true
            },
            "items": [],
            "summary": { "total": 0, "success": 0, "failed": 0, "skipped": 0, "cancelled": 0 }
        });
        let plan: InstallPlan = serde_json::from_value(json).unwrap();
        assert_eq!(plan.schema_version, SchemaVersion::One);
        assert_eq!(plan.options.mirror_preference, MirrorPreference::Official);

        // schemaVersion 只接受 1
        let mut bad = serde_json::json!({ "schemaVersion": 2 });
        bad["planId"] = serde_json::json!("x");
        assert!(serde_json::from_value::<InstallPlan>(bad).is_err());
    }

    #[test]
    fn plan_item_accepts_null_and_missing_optional_fields() {
        let json = serde_json::json!({
            "id": "nodejs",
            "version": "24.21.0",
            "tier": "L1",
            "installScope": "user",
            "requiresAdmin": false,
            "requiresReboot": false,
            "dependsOn": [],
            "state": "pending",
            "attempts": 0,
            "error": null,
            "note": null,
            "startedAt": null,
            "finishedAt": null,
            "installDir": null,
            "archivePath": null
        });
        let item: PlanItem = serde_json::from_value(json).unwrap();
        assert_eq!(item.state, PlanItemState::Pending);
        assert_eq!(item.error, None);
        assert_eq!(item.download_attempts, None);
    }
}
