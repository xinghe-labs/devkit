//! 环境变量展开（镜像 `src/main/utils/env-vars.ts`，语义逐字对齐）。

use std::sync::OnceLock;

use regex::Regex;

fn var_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"%([^%]+)%").expect("valid regex"))
}

/// 展开字符串里的 `%VAR%` 占位。
///
/// Windows 的 %VAR% 是大小写不敏感的，这里按不敏感匹配。
/// 找不到对应变量时保留原文（而不是替换成空串），
/// 这样日志里能看到是哪个变量没解析出来。
pub fn expand_env_vars(input: &str) -> String {
    expand_env_vars_with(input, &|name| std::env::var(name).ok())
}

/// 可注入环境表的版本（测试用；生产走 [`expand_env_vars`]）。
pub fn expand_env_vars_with(input: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    var_pattern()
        .replace_all(input, |caps: &regex::Captures| {
            let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let raw_name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let name = raw_name.trim();
            if name.is_empty() {
                return whole.to_string();
            }
            match lookup(name) {
                // 空串与未定义一样保留原文（对齐 TS：value === '' 时返回 whole）
                Some(value) if !value.is_empty() => value,
                _ => whole.to_string(),
            }
        })
        .into_owned()
}

/// 判断是否是绝对路径（兼容 C:\ 与 UNC \\server\share）。
pub fn is_absolute_windows_path(input: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z]:[\\/]").expect("valid regex"))
        .is_match(input)
        || input.starts_with("\\\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name: &str| {
            map.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn expands_case_insensitively() {
        let env = table(&[("ProgramFiles", "C:\\Program Files")]);
        assert_eq!(
            expand_env_vars_with("%PROGRAMFILES%\\node", &env),
            "C:\\Program Files\\node"
        );
        assert_eq!(
            expand_env_vars_with("%ProgramFiles%\\node", &env),
            "C:\\Program Files\\node"
        );
    }

    #[test]
    fn keeps_unknown_and_empty_vars() {
        let env = table(&[("EMPTY", "")]);
        assert_eq!(expand_env_vars_with("%MISSING%\\x", &env), "%MISSING%\\x");
        assert_eq!(expand_env_vars_with("%EMPTY%\\x", &env), "%EMPTY%\\x");
    }

    #[test]
    fn empty_name_keeps_literal() {
        let env = table(&[]);
        assert_eq!(expand_env_vars_with("%%", &env), "%%");
    }

    #[test]
    fn absolute_path_detection() {
        assert!(is_absolute_windows_path("C:\\Users\\x"));
        assert!(is_absolute_windows_path("c:/users/x"));
        assert!(is_absolute_windows_path("\\\\server\\share"));
        assert!(!is_absolute_windows_path("relative\\path"));
        assert!(!is_absolute_windows_path("C:"));
    }
}
