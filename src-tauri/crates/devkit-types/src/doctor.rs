//! 环境体检（镜像 `src/shared/types.ts` FR-21 部分）。

use crate::locale::LocalizedText;
use serde::{Deserialize, Serialize};

pub type DoctorLevel = PreflightLevelAlias;

/// 复用预检等级的三档语义：ok / warn / error。
/// TS 侧 DoctorLevel 与 PreflightCheck.level 是同一组字面量。
pub type PreflightLevelAlias = crate::plan::PreflightLevel;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorCategory {
    Path,
    Env,
    Command,
    Devkit,
    System,
}

/// 可以一键修复的项；其余只能给建议（改之前一律先备份）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorFixId {
    CleanUserPath,
    CleanMachinePath,
    PruneDevkitState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFix {
    pub id: DoctorFixId,
    pub label: LocalizedText,
    /// user = 直接改；machine = 需要管理员（走提权助手）
    pub scope: FixScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FixScope {
    User,
    Machine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFinding {
    pub id: String,
    pub level: DoctorLevel,
    pub category: DoctorCategory,
    pub title: LocalizedText,
    pub detail: LocalizedText,
    /// 具体证据：哪一条、值是什么。不能只给一句"环境有问题"
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<DoctorFix>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathEntryKind {
    Ok,
    Missing,
    UnexpandedVar,
    Malformed,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntryView {
    pub index: u32,
    pub raw: String,
    pub kind: PathEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathAnalysisView {
    pub entries: Vec<PathEntryView>,
    /// 清理后的建议值（只删重复与无效条目，顺序不动）
    pub suggested: String,
    pub changed: bool,
    pub counts: std::collections::HashMap<PathEntryKind, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSummary {
    pub ok: u32,
    pub warn: u32,
    pub error: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ran_at: String,
    pub findings: Vec<DoctorFinding>,
    pub summary: DoctorSummary,
    pub user_path: PathAnalysisView,
    pub machine_path: PathAnalysisView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFixResult {
    pub ok: bool,
    /// 实际做了什么（逐条列出被移除的东西）
    pub changed: Vec<String>,
    /// 改动前的备份文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_fix_id_kebab_names() {
        assert_eq!(
            serde_json::to_value(DoctorFixId::CleanUserPath).unwrap(),
            "clean-user-path"
        );
        assert_eq!(
            serde_json::to_value(DoctorFixId::PruneDevkitState).unwrap(),
            "prune-devkit-state"
        );
    }

    #[test]
    fn doctor_report_accepts_null_reason() {
        let json = serde_json::json!({
            "index": 0,
            "raw": "C:\\tools\\bin",
            "kind": "ok",
            "reason": null,
            "duplicateOf": null
        });
        let entry: PathEntryView = serde_json::from_value(json).unwrap();
        assert_eq!(entry.kind, PathEntryKind::Ok);
    }
}
