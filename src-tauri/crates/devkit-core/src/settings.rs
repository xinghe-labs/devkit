//! 用户配置 config.json（镜像 `src/main/core/settings/index.ts`）。
//!
//! 文件位置 `%APPDATA%\devkit\config.json`（附录 G：与 TS 版同路径，双向兼容）。
//! 所有字段 sanitize 时逐个规整 —— 配置文件是用户唯一能直接手改的状态，
//! 手改坏了不能让应用起不来，必须回退默认值。

use std::fs;
use std::path::Path;

use devkit_types::locale::{normalize_locale, Locale};
use devkit_types::plan::MirrorPreference;
use devkit_types::settings::{MirrorSetting, MirrorTarget};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 用户配置（config.json 的 13 个字段，附录 G）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserConfig {
    pub locale: Locale,
    /// 启动时检查 GitHub Release 更新（FR-13）
    pub auto_update: bool,
    /// 启动时拉取最新清单（FR-15）
    pub manifest_hot_update: bool,
    /// 清单热更新索引地址（https）；null = 未配置
    pub manifest_hot_update_url: Option<String>,
    /// 更新检查源（latest.json / latest.yml）；null = 未配置
    pub update_feed_url: Option<String>,
    /// 1 = 串行；最大 3（FR-4）
    pub concurrency: u32,
    /// 安装前创建系统还原点（FR-10）
    pub create_restore_point: bool,
    /// 下载优先使用哪个源（FR-5）
    pub mirror_preference: MirrorPreference,
    /// http://host:port；null = 跟随系统
    pub proxy: Option<String>,
    /// 安装成功后自动激活（写用户 PATH 与环境变量）
    pub activate_after_install: bool,
    /// 安装成功后自动写 npm/pip/git 镜像源
    pub configure_mirrors: bool,
    /// 各镜像目标的取值
    pub mirrors: Vec<MirrorSetting>,
    /// 批量产物根目录；null = 默认 %USERPROFILE%\.devkit
    pub data_root: Option<String>,
}

impl Default for UserConfig {
    fn default() -> Self {
        default_config()
    }
}

/// 默认镜像源：npm 与 pip 用国内镜像（国内开发者的实际选择）。
/// 对齐 TS `DEFAULT_MIRROR_URLS`。
pub fn default_mirror_url(target: MirrorTarget) -> &'static str {
    match target {
        MirrorTarget::Npm => "https://registry.npmmirror.com",
        MirrorTarget::Pip => "https://pypi.tuna.tsinghua.edu.cn/simple",
        MirrorTarget::Go => "https://goproxy.cn,direct",
        MirrorTarget::Maven => "https://maven.aliyun.com/repository/public",
        MirrorTarget::Gradle => "https://maven.aliyun.com/repository/public",
        MirrorTarget::Cargo => "https://mirrors.tuna.tsinghua.edu.cn/crates.io-index",
        MirrorTarget::Conda => "https://mirrors.tuna.tsinghua.edu.cn/anaconda",
        MirrorTarget::Nuget => "https://mirrors.huaweicloud.com/repository/nuget/v3/index.json",
        MirrorTarget::Docker => "https://docker.mirrors.ustc.edu.cn",
    }
}

/// TS `DEFAULTS`。
pub fn default_config() -> UserConfig {
    UserConfig {
        locale: devkit_types::locale::DEFAULT_LOCALE,
        auto_update: true,
        manifest_hot_update: true,
        manifest_hot_update_url: None,
        update_feed_url: None,
        concurrency: 1,
        create_restore_point: false,
        mirror_preference: MirrorPreference::Official,
        proxy: None,
        activate_after_install: true,
        configure_mirrors: false,
        mirrors: devkit_types::settings::MIRROR_TARGETS
            .iter()
            .map(|target| MirrorSetting {
                target: *target,
                enabled: true,
                url: default_mirror_url(*target).to_string(),
            })
            .collect(),
        data_root: None,
    }
}

/// 镜像地址白名单（MIRROR_URL_PATTERN，安全审查 H2）。
fn mirror_url_ok(url: &str) -> bool {
    devkit_types::settings::is_valid_mirror_url(url)
}

/// `sanitizeMirrors`：只认 9 个目标；url 空/非法回退默认值（TS 语义：enabled 默认 false）。
fn sanitize_mirrors(raw: Option<&Value>) -> Vec<MirrorSetting> {
    devkit_types::settings::MIRROR_TARGETS
        .iter()
        .map(|target| {
            let found = raw.and_then(|raw| raw.as_array()).and_then(|list| {
                list.iter().find_map(|item| {
                    let item = item.as_object()?;
                    let raw_target = item.get("target")?;
                    let parsed: Option<MirrorTarget> =
                        serde_json::from_value(raw_target.clone()).ok();
                    parsed.filter(|parsed| parsed == target).map(|_| item)
                })
            });
            let url = found
                .and_then(|item| item.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_else(|| default_mirror_url(*target));
            let url = if url.is_empty() || !mirror_url_ok(url) {
                default_mirror_url(*target).to_string()
            } else {
                url.to_string()
            };
            MirrorSetting {
                target: *target,
                enabled: found
                    .and_then(|item| item.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                url,
            }
        })
        .collect()
}

/// `sanitize`：逐字段规整（未知/非法值回退默认，绝不 panic）。
pub fn sanitize(raw: &Value, ui_locale: Option<Locale>) -> UserConfig {
    let concurrency = raw
        .get("concurrency")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let mirror_raw = raw
        .get("mirrorPreference")
        .and_then(Value::as_str)
        .unwrap_or("official");
    let mirror_preference = match mirror_raw {
        "huaweicloud" => MirrorPreference::Huaweicloud,
        "aliyun" => MirrorPreference::Aliyun,
        "tuna" => MirrorPreference::Tuna,
        "ustc" => MirrorPreference::Ustc,
        _ => MirrorPreference::Official,
    };
    let proxy = raw
        .get("proxy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let https_or_none = |field: &str| -> Option<String> {
        raw.get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| mirror_url_ok(value))
            .map(str::to_string)
    };
    // 必须是绝对路径：相对路径会按主进程的 cwd 解析，等于让渲染进程指定任意位置
    let data_root = raw
        .get("dataRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| Path::new(value).is_absolute())
        .map(str::to_string);

    UserConfig {
        locale: {
            let raw_locale = raw.get("locale").and_then(Value::as_str);
            // locale 字段缺省时才用系统语言提示（对齐 TS `input.locale ?? systemLocale()`）
            normalize_locale(match raw_locale {
                Some(value) => Some(value),
                None => ui_locale.map(|locale| match locale {
                    Locale::ZhCn => "zh-CN",
                    Locale::EnUs => "en-US",
                }),
            })
        },
        auto_update: raw.get("autoUpdate").and_then(Value::as_bool) != Some(false),
        manifest_hot_update: raw.get("manifestHotUpdate").and_then(Value::as_bool) != Some(false),
        manifest_hot_update_url: https_or_none("manifestHotUpdateUrl"),
        update_feed_url: https_or_none("updateFeedUrl"),
        concurrency: if concurrency.is_finite() {
            (concurrency as u32).clamp(1, 3)
        } else {
            1
        },
        create_restore_point: raw.get("createRestorePoint").and_then(Value::as_bool) == Some(true),
        mirror_preference,
        proxy,
        activate_after_install: raw.get("activateAfterInstall").and_then(Value::as_bool)
            != Some(false),
        configure_mirrors: raw.get("configureMirrors").and_then(Value::as_bool) == Some(true),
        data_root,
        mirrors: sanitize_mirrors(raw.get("mirrors")),
    }
}

/// 读 config.json（文件不存在或损坏 → 默认值，不报错）。
///
/// 对齐 TS `loadConfig`；ui_locale 是系统语言提示（TS 用 `app.getLocale()`，
/// Rust 侧由 app 层传注册表读到的 UI 语言），首次运行时按系统语言初始化。
pub fn load_config(file: &Path, ui_locale: Option<Locale>) -> UserConfig {
    match fs::read_to_string(file) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(raw) => sanitize(&raw, ui_locale),
            Err(error) => {
                log::warn!("配置文件损坏，已回退默认值：{error}");
                UserConfig {
                    locale: ui_locale.unwrap_or(devkit_types::locale::DEFAULT_LOCALE),
                    ..default_config()
                }
            }
        },
        Err(_) => UserConfig {
            locale: ui_locale.unwrap_or(devkit_types::locale::DEFAULT_LOCALE),
            ..default_config()
        },
    }
}

/// 合并 patch 并落盘（2 空格缩进 + 尾换行，对齐 TS `writeJsonFile`）。
pub fn save_config(file: &Path, patch: &Value, ui_locale: Option<Locale>) -> UserConfig {
    let mut current = serde_json::to_value(load_config(file, ui_locale)).unwrap_or_default();
    if let (Value::Object(current), Value::Object(patch)) = (&mut current, patch) {
        for (key, value) in patch {
            current.insert(key.clone(), value.clone());
        }
    }
    let next = sanitize(&current, ui_locale);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&next) {
        Ok(body) => {
            if let Err(error) = fs::write(file, format!("{body}\n")) {
                log::error!("写入配置失败：{error}");
            }
        }
        Err(error) => log::error!("写入配置失败：{error}"),
    }
    next
}

/// `getLocale`。
pub fn get_locale(file: &Path, ui_locale: Option<Locale>) -> Locale {
    load_config(file, ui_locale).locale
}

/// `setLocale`：规整后回写，返回归一化值。
pub fn set_locale(file: &Path, input: Option<&str>, ui_locale: Option<Locale>) -> Locale {
    let locale = normalize_locale(input);
    save_config(file, &serde_json::json!({ "locale": locale }), ui_locale).locale
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("devkit-settings-tests");
        let _ = fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn defaults_match_ts() {
        let config = default_config();
        assert_eq!(config.locale, Locale::ZhCn);
        assert!(config.auto_update);
        assert!(config.manifest_hot_update);
        assert_eq!(config.concurrency, 1);
        assert!(!config.create_restore_point);
        assert_eq!(config.mirror_preference, MirrorPreference::Official);
        assert!(config.activate_after_install);
        assert!(!config.configure_mirrors);
        assert_eq!(config.mirrors.len(), 9);
        // npm/pip 默认国内镜像
        let npm = config
            .mirrors
            .iter()
            .find(|m| m.target == MirrorTarget::Npm)
            .unwrap();
        assert_eq!(npm.url, "https://registry.npmmirror.com");
        assert!(npm.enabled);
    }

    #[test]
    fn sanitize_recovers_from_garbage() {
        let raw: Value = serde_json::json!({
            "locale": "fr-FR",
            "concurrency": 99,
            "mirrorPreference": "not-a-mirror",
            "proxy": "   ",
            "dataRoot": "relative/path",
            "autoUpdate": false
        });
        let config = sanitize(&raw, None);
        assert_eq!(config.locale, Locale::ZhCn, "未知语言回默认");
        assert_eq!(config.concurrency, 3, "clamp 到 1~3");
        assert_eq!(config.mirror_preference, MirrorPreference::Official);
        assert_eq!(config.proxy, None, "空白代理视为 null");
        assert_eq!(config.data_root, None, "相对路径拒绝");
        assert!(!config.auto_update);
    }

    #[test]
    fn sanitize_keeps_valid_values() {
        let raw: Value = serde_json::json!({
            "locale": "en-US",
            "concurrency": 2,
            "mirrorPreference": "huaweicloud",
            "proxy": "http://127.0.0.1:10808",
            "dataRoot": "D:\\AgentWork\\devkit-root",
            "createRestorePoint": true,
            "configureMirrors": true
        });
        let config = sanitize(&raw, None);
        assert_eq!(config.locale, Locale::EnUs);
        assert_eq!(config.concurrency, 2);
        assert_eq!(config.mirror_preference, MirrorPreference::Huaweicloud);
        assert_eq!(config.proxy.as_deref(), Some("http://127.0.0.1:10808"));
        assert_eq!(
            config.data_root.as_deref(),
            Some("D:\\AgentWork\\devkit-root")
        );
        assert!(config.create_restore_point);
        assert!(config.configure_mirrors);
    }

    #[test]
    fn sanitize_mirrors_falls_back_on_bad_url() {
        let raw: Value = serde_json::json!({
            "mirrors": [
                { "target": "npm", "enabled": true, "url": "https://ok.example.com" },
                { "target": "pip", "enabled": true, "url": "bad url with spaces" }
            ]
        });
        let mirrors = sanitize_mirrors(raw.get("mirrors"));
        let npm = mirrors
            .iter()
            .find(|m| m.target == MirrorTarget::Npm)
            .unwrap();
        assert_eq!(npm.url, "https://ok.example.com");
        assert!(npm.enabled);
        let pip = mirrors
            .iter()
            .find(|m| m.target == MirrorTarget::Pip)
            .unwrap();
        assert_eq!(
            pip.url,
            default_mirror_url(MirrorTarget::Pip),
            "非法 url 回默认"
        );
        assert!(
            pip.enabled,
            "enabled 与 url 独立：url 回退不影响 enabled（TS 语义）"
        );
        // 没出现的项：url 默认、enabled false
        let cargo = mirrors
            .iter()
            .find(|m| m.target == MirrorTarget::Cargo)
            .unwrap();
        assert!(!cargo.enabled);
        assert_eq!(cargo.url, default_mirror_url(MirrorTarget::Cargo));
    }

    #[test]
    fn https_urls_are_whitelisted() {
        let raw: Value = serde_json::json!({
            "manifestHotUpdateUrl": "javascript:alert(1)"
        });
        assert_eq!(sanitize(&raw, None).manifest_hot_update_url, None);
        let raw: Value = serde_json::json!({
            "manifestHotUpdateUrl": "https://example.com/index.json"
        });
        assert_eq!(
            sanitize(&raw, None).manifest_hot_update_url.as_deref(),
            Some("https://example.com/index.json")
        );
    }

    #[test]
    fn load_and_save_roundtrip() {
        let file = temp_file("config-roundtrip.json");
        let _ = fs::remove_file(&file);
        // 首次：文件不存在 → 默认
        let config = load_config(&file, Some(Locale::EnUs));
        assert_eq!(config.locale, Locale::EnUs, "首次运行按系统语言初始化");
        // 写 patch
        let next = set_locale(&file, Some("zh"), None);
        assert_eq!(next, Locale::ZhCn, "容忍 zh 简写");
        // 重读
        assert_eq!(get_locale(&file, None), Locale::ZhCn);
        // 文件是 2 空格缩进 JSON（与 TS writeJsonFile 一致）
        let body = fs::read_to_string(&file).unwrap();
        assert!(
            body.contains("\"locale\": \"zh-CN\""),
            "camelCase 键名 + 空格缩进"
        );
        assert!(body.ends_with("\n"), "尾换行（TS writeFileSync 加 \\n）");
        // 损坏文件 → 默认值，不 panic
        fs::write(&file, "{broken").unwrap();
        let config = load_config(&file, None);
        assert_eq!(
            config.locale,
            Locale::ZhCn,
            "损坏回退时保留 ui hint 之外的默认 locale"
        );
    }

    #[test]
    fn set_locale_normalizes_unknown() {
        let file = temp_file("config-locale-normalize.json");
        let _ = fs::remove_file(&file);
        assert_eq!(set_locale(&file, Some("xx-YY"), None), Locale::ZhCn);
        assert_eq!(set_locale(&file, Some("en_US"), None), Locale::EnUs);
        assert_eq!(set_locale(&file, None, None), Locale::ZhCn);
    }
}
