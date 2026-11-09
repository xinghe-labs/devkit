//! 检测相关类型（镜像 `src/shared/types.ts` 检测部分）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 注册表检测规则：按 Uninstall 项的 DisplayName 正则匹配。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDetectRule {
    pub hive: RegistryHive,
    /// 注册表视图，32 位程序在 64 位系统上写 WOW6432Node
    pub view: RegistryView,
    /// Uninstall 子键所在路径（不含 hive）
    pub path: String,
    /// 字段名 → 正则。全部命中才算匹配成功
    #[serde(rename = "match")]
    pub match_rules: HashMap<String, String>,
    /// 从哪个字段取版本号，默认 DisplayVersion
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RegistryHive {
    #[serde(rename = "HKLM")]
    Hklm,
    #[serde(rename = "HKCU")]
    Hkcu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RegistryView {
    #[serde(rename = "32")]
    View32,
    #[serde(rename = "64")]
    View64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectCommandSpec {
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// 输出（stdout + stderr 合并）必须匹配此正则才算检测成功
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_regex: Option<String>,
}

/// 检测手段。按 commands → files → registry 的顺序尝试。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<DetectCommandSpec>>,
    /// 文件路径，支持 %ProgramFiles% 等环境变量占位
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<Vec<RegistryDetectRule>>,
}

/// 检测状态。语义（见 SPEC FR-1）：
/// - not-installed   没找到任何痕迹
/// - installed       命令可用，且主版本与推荐版本一致
/// - version-mismatch 命令可用，但主版本与推荐版本不同
/// - path-missing    文件/注册表存在，但命令跑不通 → 已装但 PATH 未生效
/// - error           检测过程本身出错（不是"没装"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectionStatus {
    NotInstalled,
    Installed,
    VersionMismatch,
    PathMissing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub tool_id: String,
    pub status: DetectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_version: Option<String>,
    /// 已装版本与推荐版本主版本号是否一致
    pub version_matches: bool,
    /// 命中依据，例如 "command:node" / "file:C:\Program Files\nodejs\node.exe"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// 检测请求载荷。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectRequest {
    /// 不传或传空数组 = 检测全部
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_ids: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_status_roundtrip_kebab() {
        assert_eq!(
            serde_json::to_value(DetectionStatus::VersionMismatch).unwrap(),
            "version-mismatch"
        );
        assert_eq!(
            serde_json::from_value::<DetectionStatus>(serde_json::json!("path-missing")).unwrap(),
            DetectionStatus::PathMissing
        );
    }

    #[test]
    fn detection_result_accepts_null_fields() {
        let json = serde_json::json!({
            "toolId": "nodejs",
            "status": "not-installed",
            "installedVersion": null,
            "recommendedVersion": "24.21.0",
            "versionMatches": false,
            "evidence": null,
            "error": null,
            "durationMs": 42
        });
        let result: DetectionResult = serde_json::from_value(json).unwrap();
        assert_eq!(result.tool_id, "nodejs");
        assert_eq!(result.installed_version, None);
        assert_eq!(result.duration_ms, 42);
    }

    #[test]
    fn detect_request_without_tool_ids_means_all() {
        let req: DetectRequest = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(req.tool_ids, None);
    }
}
