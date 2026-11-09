//! 界面语言与多语言文案（镜像 `src/shared/types.ts` + `src/shared/localized.ts`）。

use serde::{Deserialize, Serialize};

/// 界面语言。新增语言时同时更新 `LOCALES` 与回退链。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Locale {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

pub const LOCALES: [Locale; 2] = [Locale::ZhCn, Locale::EnUs];
pub const DEFAULT_LOCALE: Locale = Locale::ZhCn;

impl Locale {
    /// 回退链：当前语言 → zh-CN → en-US。
    pub fn fallback_chain(self) -> Vec<Locale> {
        let mut chain = vec![self];
        chain.extend(LOCALES.into_iter().filter(|item| *item != self));
        chain
    }
}

/// 多语言文案。manifest 里的 name / description / notes 用这个结构。
/// 允许缺语言，取值时由 [`localized_text`] 按回退链兜底。
/// TS 侧为 `Partial<Record<Locale, string>>`；serde 直接用 map。
pub type LocalizedText = std::collections::HashMap<String, String>;

/// 语言回退链（SPEC FR-14）：
///   当前语言 → zh-CN → en-US → 清单里第一个可用值。
/// 保证任何情况下都返回非空字符串，UI 永远不会出现 undefined / 空白。
pub fn localized_text(text: Option<&LocalizedText>, locale: Locale, fallback: &str) -> String {
    let Some(text) = text else {
        return fallback.to_string();
    };

    for key in locale.fallback_chain() {
        let tag = match key {
            Locale::ZhCn => "zh-CN",
            Locale::EnUs => "en-US",
        };
        if let Some(value) = text.get(tag) {
            if !value.trim().is_empty() {
                return value.clone();
            }
        }
    }

    // 清单里出现了回退链之外的语种（例如未来加了 ja-JP 而 UI 还没支持）
    text.values()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

/// 把任意输入规整成受支持的 Locale，未知值一律落到默认语言。
pub fn normalize_locale(input: Option<&str>) -> Locale {
    if let Some(input) = input {
        if input == "zh-CN" {
            return Locale::ZhCn;
        }
        if input == "en-US" {
            return Locale::EnUs;
        }
        // 容忍 "zh" / "zh-CN" / "en" / "en-US" / "en_US" 这类写法
        let lowered = input.to_lowercase().replace('_', "-");
        if lowered.starts_with("zh") {
            return Locale::ZhCn;
        }
        if lowered.starts_with("en") {
            return Locale::EnUs;
        }
    }
    DEFAULT_LOCALE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> LocalizedText {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn localized_text_follows_fallback_chain() {
        let text = map(&[("en-US", "English")]);
        // zh-CN 缺失 → 回退 en-US
        assert_eq!(localized_text(Some(&text), Locale::ZhCn, ""), "English");
    }

    #[test]
    fn localized_text_prefers_requested_locale() {
        let text = map(&[("zh-CN", "中文"), ("en-US", "English")]);
        assert_eq!(localized_text(Some(&text), Locale::EnUs, ""), "English");
        assert_eq!(localized_text(Some(&text), Locale::ZhCn, ""), "中文");
    }

    #[test]
    fn localized_text_falls_back_to_first_available() {
        // 回退链之外的语种（未来加 ja-JP 而 UI 未支持）
        let text = map(&[("ja-JP", "日本語")]);
        assert_eq!(localized_text(Some(&text), Locale::ZhCn, "F"), "日本語");
        assert_eq!(localized_text(None, Locale::ZhCn, "F"), "F");
    }

    #[test]
    fn localized_text_skips_blank_values() {
        let text = map(&[("zh-CN", "  "), ("en-US", "English")]);
        assert_eq!(localized_text(Some(&text), Locale::ZhCn, ""), "English");
    }

    #[test]
    fn normalize_locale_tolerates_variants() {
        assert_eq!(normalize_locale(Some("zh-CN")), Locale::ZhCn);
        assert_eq!(normalize_locale(Some("zh")), Locale::ZhCn);
        assert_eq!(normalize_locale(Some("en_US")), Locale::EnUs);
        assert_eq!(normalize_locale(Some("EN")), Locale::EnUs);
        assert_eq!(normalize_locale(Some("fr-FR")), Locale::ZhCn);
        assert_eq!(normalize_locale(None), Locale::ZhCn);
        assert_eq!(normalize_locale(Some("not a locale")), Locale::ZhCn);
    }
}
