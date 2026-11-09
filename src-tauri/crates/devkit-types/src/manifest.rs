//! 工具清单类型（镜像 `src/shared/types.ts` 清单部分，对齐 `tool.schema.json`）。
//!
//! serde 约定：
//! - `deny_unknown_fields` 对齐 Schema 的 `additionalProperties: false`
//!   —— 清单路径上未知字段直接报错，热更新合并后的写入同样过这道闸
//!   （附录 B.1 规则 6）。
//! - `LocalizedText` 是任意语种 map，不受 `deny_unknown_fields` 影响
//!   （它作用于外层字段名，map 键属于数据）。

use crate::detection::{DetectCommandSpec, DetectSpec};
use crate::locale::LocalizedText;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 清单分类，决定左侧导航分组
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    Runtime,
    Build,
    Database,
    Container,
    Editor,
    Ai,
    Tool,
}

/// 清单分类的固定排序（镜像 manifest/index.ts CATEGORY_ORDER）。
pub const TOOL_CATEGORY_ORDER: [ToolCategory; 7] = [
    ToolCategory::Runtime,
    ToolCategory::Build,
    ToolCategory::Database,
    ToolCategory::Container,
    ToolCategory::Editor,
    ToolCategory::Ai,
    ToolCategory::Tool,
];

impl ToolCategory {
    pub fn order(self) -> usize {
        TOOL_CATEGORY_ORDER
            .iter()
            .position(|c| *c == self)
            .unwrap_or(usize::MAX)
    }
}

/// 许可证分级（见 SPEC §8），直接决定能否进离线包：
/// - L1 许可证明确允许再分发 → 可进离线包
/// - L2 可自动下载安装，但不得再分发 → 不进离线包
/// - L3 仅跳转官网，不自动安装
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LicenseTier {
    #[serde(rename = "L1")]
    L1,
    #[serde(rename = "L2")]
    L2,
    #[serde(rename = "L3")]
    L3,
}

/// 清单成熟度：
/// - detect-only：目前只能检测，安装信息（source/sha256/install）尚未补齐
/// - ready：可执行完整安装，Schema 会强制要求 source.sha256 与 install 模板
///
/// 这个字段存在的意义是：不允许「看起来能装、实际装不了」的清单混进来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManifestStatus {
    DetectOnly,
    Ready,
}

/// 清单来源。builtin = 内置清单；remote = 热更新后的清单（FR-15）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManifestSource {
    Builtin,
    Remote,
}

/// 安装包类型。
///
/// 每一种都对应一组**写死在代码里**的静默安装参数（见 core/templates），
/// 清单只能引用模板名，不能自定义命令行 —— 否则热更新通道就等于任意命令执行通道。
///
/// - zip        压缩包，解压到版本目录
/// - msi        Windows Installer，走 msiexec /qn
/// - exe-nsis   NSIS 安装器（7-Zip 等），走 /S
/// - exe-inno   Inno Setup 安装器（VS Code 等），走 /VERYSILENT
/// - exe-7zsfx  7-Zip 自解压包（PortableGit 等），走 -o<dir> -y
/// - exe-custom 自带安装器（Python / rustup），参数由内置模板固定
/// - npm        npm 包（AI 编码 agent 这类只发 npm 的工具）：装进版本目录，不污染全局 npm
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallType {
    Msi,
    ExeNsis,
    ExeInno,
    // serde 的 kebab-case 在 "Exe7Zsfx" 的数字处不断词（会产出 "exe7-zsfx"），
    // TS 字面量是 "exe-7zsfx"，显式 rename 对齐
    #[serde(rename = "exe-7zsfx")]
    Exe7Zsfx,
    ExeCustom,
    Zip,
    Npm,
}

/// 安装范围。必须逐项声明，不存在全局默认（见 SPEC §9）：
/// - user：装到用户目录，不需要管理员
/// - machine：装到 Program Files / 需要写系统注册表 / 装服务 → 需要提权
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallScope {
    User,
    Machine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSpec {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MirrorSpec {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolLicense {
    pub spdx: String,
    pub redistributable: bool,
}

/// 安装参数。
/// 安全关键：`template` 只能引用代码内置的白名单模板，
/// `params` 只能填模板声明过的占位符 —— 清单无权自定义命令行（见 SPEC FR-15 / NFR-1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallSpec {
    #[serde(rename = "type")]
    pub install_type: InstallType,
    pub template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallSpec {
    #[serde(rename = "type")]
    pub uninstall_type: UninstallType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UninstallType {
    Registry,
    Custom,
    None,
}

/// 激活声明（FR-11）。
///
/// 「安装 ≠ 激活」：安装只把文件放进版本目录；只有声明了 activate 的版本
/// 才会被真正接到用户环境里（PATH + 环境变量 + current 切换链接）。
/// 这样用户可以「先装好、先不接进 PATH」，也可以在多版本之间来回切。
///
/// 路径里可用占位符：{installDir} {currentDir} {version} {toolId}
/// currentDir = %USERPROFILE%\.devkit\current\<linkName>（junction，指向当前激活的版本）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateSpec {
    /// 需要加进用户 PATH 的目录（顺序即优先级）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_entries: Option<Vec<String>>,
    /// 需要写入的用户级环境变量，例如 JAVA_HOME / GOROOT / CARGO_HOME
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    /// 切换链接名，默认等于 tool id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_name: Option<String>,
}

/// 版本通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VersionChannel {
    Lts,
    Stable,
    Beta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolVersionSpec {
    pub version: String,
    pub channel: VersionChannel,
    /// 默认选中项；同一个工具最多一个为 true
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
    pub arch: Arch,
    /// ISO 日期 YYYY-MM-DD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub install_scope: InstallScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_reboot: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirrors: Option<Vec<MirrorSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<InstallSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uninstall: Option<UninstallSpec>,
    /// 激活声明；不写表示该版本装完不接进 PATH（只落在版本目录里）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activate: Option<ActivateSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configure: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<DetectCommandSpec>,
}

/// 目标架构。当前只有 x64（Schema 里是 const）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Arch {
    #[serde(rename = "x64")]
    X64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolManifest {
    pub id: String,
    pub category: ToolCategory,
    pub tier: LicenseTier,
    pub status: ManifestStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ManifestProvider>,
    pub name: LocalizedText,
    pub description: LocalizedText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<ToolLicense>,
    pub detect: DetectSpec,
    /// 允许为空数组：表示该工具目前只支持检测，版本信息待补齐
    pub versions: Vec<ToolVersionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<LocalizedText>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManifestProvider {
    Direct,
    Scoop,
    Winget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLoadError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLoadResult {
    pub tools: Vec<ToolManifest>,
    pub errors: Vec<ManifestLoadError>,
    /// builtin = 内置清单；remote = 热更新后的清单（FR-15）
    pub source: ManifestSource,
    pub dir: String,
    pub loaded_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_json() -> serde_json::Value {
        serde_json::json!({
            "id": "demo-tool",
            "category": "runtime",
            "tier": "L1",
            "status": "ready",
            "name": { "zh-CN": "演示工具", "en-US": "Demo Tool" },
            "description": { "zh-CN": "描述" },
            "detect": { "commands": [ { "cmd": "demo", "args": ["--version"] } ] },
            "versions": [ {
                "version": "1.0.0",
                "channel": "stable",
                "recommended": true,
                "arch": "x64",
                "installScope": "user",
                "source": {
                    "url": "https://example.com/demo-1.0.0.zip",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                },
                "install": { "type": "zip", "template": "zip-extract" }
            } ]
        })
    }

    #[test]
    fn manifest_roundtrip_minimal() {
        let manifest: ToolManifest = serde_json::from_value(minimal_json()).unwrap();
        assert_eq!(manifest.id, "demo-tool");
        assert_eq!(manifest.category, ToolCategory::Runtime);
        assert_eq!(manifest.versions[0].channel, VersionChannel::Stable);
        assert_eq!(
            manifest.versions[0].install.as_ref().unwrap().install_type,
            InstallType::Zip
        );

        // 回写后再次读入，信息无损
        let written = serde_json::to_value(&manifest).unwrap();
        let reread: ToolManifest = serde_json::from_value(written).unwrap();
        assert_eq!(manifest, reread);
    }

    #[test]
    fn manifest_rejects_unknown_fields() {
        let mut json = minimal_json();
        json["bogusField"] = serde_json::json!(1);
        let result = serde_json::from_value::<ToolManifest>(json);
        assert!(
            result.is_err(),
            "unknown 字段必须被拒绝（additionalProperties:false）"
        );
    }

    #[test]
    fn manifest_rejects_bad_enum_values() {
        let mut json = minimal_json();
        json["tier"] = serde_json::json!("L9");
        assert!(serde_json::from_value::<ToolManifest>(json).is_err());
    }

    #[test]
    fn install_type_kebab_names_match_ts_literals() {
        assert_eq!(
            serde_json::to_value(InstallType::ExeNsis).unwrap(),
            "exe-nsis"
        );
        assert_eq!(
            serde_json::to_value(InstallType::Exe7Zsfx).unwrap(),
            "exe-7zsfx"
        );
        assert_eq!(
            serde_json::to_value(InstallType::ExeCustom).unwrap(),
            "exe-custom"
        );
        assert_eq!(
            serde_json::to_value(ManifestStatus::DetectOnly).unwrap(),
            "detect-only"
        );
    }

    #[test]
    fn arch_is_const_x64() {
        assert!(serde_json::from_value::<Arch>(serde_json::json!("x64")).is_ok());
        assert!(serde_json::from_value::<Arch>(serde_json::json!("arm64")).is_err());
    }
}
