//! 激活/切换与已安装项（镜像 `src/shared/types.ts` FR-11 / FR-16 部分）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// devkit 管理的一次激活记录，用于精确回滚（不靠猜 PATH 里哪条是脏数据）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRecord {
    pub tool_id: String,
    pub version: String,
    pub link_name: String,
    /// %USERPROFILE%\.devkit\current\<linkName>
    pub link_path: String,
    /// junction 指向的真实版本目录
    pub target: String,
    pub path_entries: Vec<String>,
    pub env: HashMap<String, String>,
    pub activated_at: String,
}

/// 激活总览，设置页与「已安装」页要展示
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationSnapshot {
    pub records: Vec<ActivationRecord>,
    /// %USERPROFILE%\.devkit\bin（预留给未来的 shim）
    pub bin_dir: String,
    /// 当前用户 PATH 的完整值（只读展示，不含密码等敏感信息）
    pub user_path: String,
    /// PATH 备份文件路径；null 表示还没备份过
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_file: Option<String>,
    /// PATH 里所有 devkit 管理的条目
    pub managed_path_entries: Vec<String>,
}

/// 切换（激活）某个版本
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRequest {
    pub tool_id: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<ActivationRecord>,
    /// 需要用户重新打开终端才能生效的提示
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 已安装项展示（FR-16）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTool {
    pub tool_id: String,
    pub version: String,
    pub install_dir: String,
    /// 目录实际占用字节数
    pub size_bytes: u64,
    /// 目录创建时间（近似安装时间）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    /// 该版本当前是否是 current 链接指向的版本
    pub active: bool,
    /// 该版本是否声明了可激活
    pub activatable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallRequest {
    pub tool_id: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub ok: bool,
    /// 实际删掉的内容说明
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activate_result_all_null_fields() {
        let json = serde_json::json!({
            "ok": true,
            "record": null,
            "note": null,
            "error": null
        });
        let result: ActivateResult = serde_json::from_value(json).unwrap();
        assert!(result.ok);
        assert_eq!(result.record, None);
    }

    #[test]
    fn activation_record_full_roundtrip() {
        let json = serde_json::json!({
            "toolId": "nodejs",
            "version": "24.21.0",
            "linkName": "nodejs",
            "linkPath": "C:\\Users\\u\\.devkit\\current\\nodejs",
            "target": "C:\\Users\\u\\.devkit\\versions\\nodejs\\24.21.0",
            "pathEntries": ["{currentDir}"],
            "env": { "NODE_HOME": "{installDir}" },
            "activatedAt": "2025-01-01T00:00:00.000Z"
        });
        let record: ActivationRecord = serde_json::from_value(json).unwrap();
        let back = serde_json::to_value(&record).unwrap();
        let reread: ActivationRecord = serde_json::from_value(back).unwrap();
        assert_eq!(record, reread);
    }
}
