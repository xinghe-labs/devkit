//! 用户配置与镜像源（镜像 `src/shared/types.ts` FR-5 / FR-6 部分）。

use crate::locale::Locale;
use crate::plan::MirrorPreference;
use serde::{Deserialize, Serialize};

/// 可一键切换的国内镜像目标。只包含"用写配置文件就能生效、不需要先装好某个工具"的目标
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorTarget {
    Npm,
    Pip,
    Go,
    Maven,
    Gradle,
    Cargo,
    Conda,
    Nuget,
    Docker,
}

pub const MIRROR_TARGETS: [MirrorTarget; 9] = [
    MirrorTarget::Npm,
    MirrorTarget::Pip,
    MirrorTarget::Go,
    MirrorTarget::Maven,
    MirrorTarget::Gradle,
    MirrorTarget::Cargo,
    MirrorTarget::Conda,
    MirrorTarget::Nuget,
    MirrorTarget::Docker,
];

/// 镜像地址允许的形状（写镜像时的白名单正则，MIRROR_URL_PATTERN）。
///
/// 刻意用白名单字符集而不是「排除危险字符」：镜像地址会被写进 .npmrc / pip.ini /
/// settings.xml / init.gradle / config.toml / .condarc / daemon.json 七种格式里，
/// 黑名单漏一个字符就是一次配置注入（安全审查 H2）。
/// 只保留 URL 里真正会用到的字符，连单引号、双引号、反斜杠、换行、$ 和花括号都不给。
///
/// 返回 true 表示该 URL 允许作为镜像地址写入配置文件。
pub fn is_valid_mirror_url(url: &str) -> bool {
    // TS: /^https:\/\/[A-Za-z0-9._~:/@!*,=+-]{3,200}$/
    let body = match url.strip_prefix("https://") {
        Some(rest) => rest,
        None => return false,
    };
    let ok_len = (3..=200).contains(&body.len());
    ok_len
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._~:/@!*,=+-".contains(c))
}

/// 单个镜像目标的取值；url 为空表示用官方源
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSetting {
    pub target: MirrorTarget,
    pub enabled: bool,
    pub url: String,
}

/// 镜像写入结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorApplyResult {
    pub ok: bool,
    pub changed: Vec<String>,
    pub backup_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 用户配置视图（IPC `settings:get` 返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfigView {
    pub locale: Locale,
    pub auto_update: bool,
    pub manifest_hot_update: bool,
    /// 清单热更新索引地址（https）；null 表示未配置，功能关闭
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_hot_update_url: Option<String>,
    /// 更新检查源（latest.json / latest.yml）；null 表示未配置
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_feed_url: Option<String>,
    pub concurrency: u32,
    pub create_restore_point: bool,
    pub mirror_preference: MirrorPreference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// 安装成功后自动激活（写用户 PATH 与环境变量）
    pub activate_after_install: bool,
    /// 安装成功后自动写 npm/pip/git 镜像源
    pub configure_mirrors: bool,
    pub mirrors: Vec<MirrorSetting>,
    /// 是否已备份过用户 PATH
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_backup_file: Option<String>,
    /// 批量产物（版本目录 / 下载缓存 / 切换链接）的根目录。
    /// null = 用默认值 %USERPROFILE%\.devkit；改成别的盘可避免系统盘被塞满。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_root: Option<String>,
    /// 实际生效的根目录（已解析过环境变量与默认值）
    pub effective_data_root: String,
    /// 这个根目录是从哪来的
    pub data_root_source: DataRootSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataRootSource {
    Env,
    Config,
    Default,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_url_whitelist_matches_ts_pattern() {
        assert!(is_valid_mirror_url("https://registry.npmmirror.com"));
        assert!(is_valid_mirror_url(
            "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
        ));
        assert!(is_valid_mirror_url("https://a.cn"));
        assert!(!is_valid_mirror_url("http://a.cn")); // 非 https
        assert!(!is_valid_mirror_url("https://a\"b.com")); // 双引号（注入）
        assert!(!is_valid_mirror_url("https://a$b.com")); // $
        assert!(!is_valid_mirror_url("https://a{b}")); // 花括号
        assert!(!is_valid_mirror_url("https://ab")); // 长度 < 3
        assert!(!is_valid_mirror_url(&format!(
            "https://{}",
            "a".repeat(201)
        )));
        assert!(is_valid_mirror_url(&format!("https://{}", "a".repeat(200))));
    }

    #[test]
    fn mirror_target_kebab_names() {
        assert_eq!(serde_json::to_value(MirrorTarget::Nuget).unwrap(), "nuget");
        assert_eq!(
            serde_json::from_value::<MirrorTarget>(serde_json::json!("npm")).unwrap(),
            MirrorTarget::Npm
        );
    }

    #[test]
    fn user_config_view_accepts_null_urls() {
        let json = serde_json::json!({
            "locale": "zh-CN",
            "autoUpdate": true,
            "manifestHotUpdate": false,
            "manifestHotUpdateUrl": null,
            "updateFeedUrl": null,
            "concurrency": 2,
            "createRestorePoint": true,
            "mirrorPreference": "official",
            "proxy": null,
            "activateAfterInstall": true,
            "configureMirrors": false,
            "mirrors": [],
            "pathBackupFile": null,
            "dataRoot": null,
            "effectiveDataRoot": "C:\\Users\\u\\.devkit",
            "dataRootSource": "default"
        });
        let view: UserConfigView = serde_json::from_value(json).unwrap();
        assert_eq!(view.data_root_source, DataRootSource::Default);
        assert_eq!(view.proxy, None);
    }
}
