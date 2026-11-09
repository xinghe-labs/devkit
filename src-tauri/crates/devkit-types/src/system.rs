//! 系统配置（镜像 `src/shared/types.ts` FR-6 系统配置部分）。

use crate::locale::LocalizedText;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemConfigId {
    GitIdentity,
    PowershellPolicy,
    LongPaths,
    DeveloperMode,
    SshKey,
    MachinePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfigItem {
    pub id: SystemConfigId,
    pub label: LocalizedText,
    /// true = 需要管理员（会弹一次 UAC）
    pub requires_admin: bool,
    pub configured: bool,
    /// 当前状态的可读描述，例如 "张三 <a@b.com>" 或 "未启用"
    pub detail: String,
    pub hint: LocalizedText,
    /// 这一项是否被 devkit 改过（有备份记录）
    pub devkit_modified: bool,
    /// 备份时间；没有备份则为 null
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_at: Option<String>,
    /// 是否提供还原。SSH 私钥恒为 false —— 删私钥是破坏性操作
    pub revertible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfigRevertRequest {
    pub id: SystemConfigId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfigRequest {
    pub id: SystemConfigId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_email: Option<String>,
    /// 仅 machine-path 用：add = 把已激活工具写进机器 PATH；remove = 移除 devkit 的条目
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_path_mode: Option<MachinePathMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MachinePathMode {
    Add,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfigResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub requires_admin: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_config_id_kebab_names() {
        assert_eq!(
            serde_json::to_value(SystemConfigId::GitIdentity).unwrap(),
            "git-identity"
        );
        assert_eq!(
            serde_json::to_value(SystemConfigId::PowershellPolicy).unwrap(),
            "powershell-policy"
        );
        assert_eq!(
            serde_json::to_value(SystemConfigId::MachinePath).unwrap(),
            "machine-path"
        );
    }
}
