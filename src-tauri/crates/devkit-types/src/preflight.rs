//! 预检相关类型（镜像 `src/shared/types.ts` 的 PreflightCheck / PreflightResult）。

use serde::{Deserialize, Serialize};

/// 单项检查结论。`error` 会禁用「开始安装」按钮，`warn` 只提示不阻断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreflightLevel {
    Ok,
    Warn,
    Error,
}

/// 预检单项（对齐 TS `PreflightCheck`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    /// 检查项标识，如 "os-version" / "disk" / "network:nodejs"
    pub id: String,
    pub level: PreflightLevel,
    /// 中文消息（预检报告直接展示）
    pub message: String,
}

/// 预检结果（对齐 TS `PreflightResult`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    /// 所有检查项都不是 error
    pub ok: bool,
    pub checks: Vec<PreflightCheck>,
    /// 计划内各版本 sizeBytes 之和（无值按 0）
    pub total_download_bytes: u64,
    /// 计划内存在需要管理员权限的项
    pub requires_admin: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_roundtrip_kebab() {
        assert_eq!(serde_json::to_value(PreflightLevel::Ok).unwrap(), "ok");
        assert_eq!(serde_json::to_value(PreflightLevel::Warn).unwrap(), "warn");
        assert_eq!(
            serde_json::to_value(PreflightLevel::Error).unwrap(),
            "error"
        );
        assert_eq!(
            serde_json::from_value::<PreflightLevel>(serde_json::json!("error")).unwrap(),
            PreflightLevel::Error
        );
    }

    #[test]
    fn result_roundtrip_camel_case() {
        let json = serde_json::json!({
            "ok": false,
            "checks": [
                { "id": "disk", "level": "error", "message": "D:\\ 剩余空间不足" }
            ],
            "totalDownloadBytes": 1073741824,
            "requiresAdmin": true
        });
        let result: PreflightResult = serde_json::from_value(json).unwrap();
        assert!(!result.ok);
        assert_eq!(result.checks.len(), 1);
        assert_eq!(result.total_download_bytes, 1073741824);
        assert!(result.requires_admin);
    }
}
