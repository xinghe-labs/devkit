//! 版本号比较工具（镜像 `src/shared/version.ts`，语义逐字对齐）。
//!
//! 只做"主版本是否一致"这一件事，因为检测场景下追问到补丁号没有意义：
//! 装了 Node 22.23.2、清单推荐 22.12.0，这属于「同主版本，可用」，
//! 不应该报成"版本不符"去打扰用户。

use regex::Regex;
use std::sync::OnceLock;

fn number_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d+(?:\.\d+)*").expect("valid regex"))
}

fn version_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*").expect("valid regex"))
}

/// 把 "v22.23.2" / "3.13.15" / "2.47.1.windows.2" 解析成数字数组。
pub fn parse_version(input: Option<&str>) -> Vec<u64> {
    let Some(input) = input else {
        return Vec::new();
    };
    match number_run_re().find(input) {
        None => Vec::new(),
        Some(m) => m
            .as_str()
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect(),
    }
}

/// 从任意命令输出里抽出第一个版本号，抽不到返回 None。
pub fn extract_version(output: Option<&str>) -> Option<String> {
    version_token_re()
        .find(output?)
        .map(|m| m.as_str().to_string())
}

/// a > b 返回 1，a < b 返回 -1，相等返回 0（逐段比较，缺失段按 0 处理）。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let left = parse_version(Some(a));
    let right = parse_version(Some(b));
    let length = left.len().max(right.len());
    for i in 0..length {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        if l > r {
            return 1;
        }
        if l < r {
            return -1;
        }
    }
    0
}

/// 主版本是否一致（只看第一段）。
///
/// 这是一条刻意的宽松规则：装了 Node 22.23.2、清单推荐 22.12.0，
/// 补丁号不同不该去打扰用户；Python 3.13 与 3.14 在这里也算"同主版本"。
/// 取舍：宁可漏报"版本不同"，也不要误报 —— 误报会让用户对检测结果失去信任。
///
/// 若将来需要更细的粒度（例如 Python 要求次要版本也一致），
/// 应该做成清单里的逐项策略（如 versionPolicy: "minor"），而不是改全局规则。
///
/// 任一版本号解析失败时返回 true，同样是偏保守。
pub fn same_major(a: Option<&str>, b: Option<&str>) -> bool {
    let left = parse_version(a);
    let right = parse_version(b);
    if left.is_empty() || right.is_empty() {
        return true;
    }
    left[0] == right[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_extracts_number_run() {
        assert_eq!(parse_version(Some("v22.23.2")), vec![22, 23, 2]);
        assert_eq!(parse_version(Some("3.13.15")), vec![3, 13, 15]);
        assert_eq!(parse_version(Some("2.47.1.windows.2")), vec![2, 47, 1]);
        assert_eq!(parse_version(Some("git version 2.44.0")), vec![2, 44, 0]);
        assert!(parse_version(Some("no numbers here")).is_empty());
        assert!(parse_version(None).is_empty());
        assert!(parse_version(Some("")).is_empty());
    }

    #[test]
    fn extract_version_finds_token() {
        assert_eq!(
            extract_version(Some("Node.js v22.23.2 (LTS)")),
            Some("22.23.2".to_string())
        );
        assert_eq!(
            extract_version(Some("Python 3.13.1")),
            Some("3.13.1".to_string())
        );
        // 带预发布后缀
        assert_eq!(
            extract_version(Some("npm 10.9.0-beta.1")),
            Some("10.9.0-beta.1".to_string())
        );
        assert_eq!(extract_version(Some("nothing")), None);
        assert_eq!(extract_version(None), None);
    }

    #[test]
    fn compare_versions_is_segment_wise() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), 0);
        assert_eq!(compare_versions("1.2.4", "1.2.3"), 1);
        assert_eq!(compare_versions("1.2", "1.2.0"), 0); // 缺失段按 0
        assert_eq!(compare_versions("2.0.0", "10.0.0"), -1);
        assert_eq!(compare_versions("1.10.0", "1.9.0"), 1);
    }

    #[test]
    fn same_major_is_deliberately_lenient() {
        assert!(same_major(Some("22.23.2"), Some("22.12.0")));
        assert!(!same_major(Some("23.0.0"), Some("22.12.0")));
        // 解析失败偏保守：视为一致
        assert!(same_major(Some("unknown"), Some("22.12.0")));
        assert!(same_major(None, Some("22.12.0")));
        assert!(same_major(None, None));
    }
}
