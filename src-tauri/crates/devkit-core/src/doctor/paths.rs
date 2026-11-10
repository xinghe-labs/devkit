//! PATH 条目的**纯分析逻辑**（镜像 `src/main/core/doctor/paths.ts`）。
//!
//! 抽成纯函数（把「目录是否存在」与「环境变量表」当参数传进来）是因为
//! 这段代码要处理的是用户机器上真实存在的脏数据 —— 只有能单测才能保证
//! 它不会把好的条目误判成坏的（误判会导致用户点"一键修复"删掉正确的东西）。

use devkit_types::doctor::{PathAnalysisView, PathEntryKind, PathEntryView};
use std::collections::HashMap;
use std::sync::OnceLock;

/// 大小写不敏感地取环境变量
pub fn lookup_env(env: &HashMap<String, String>, name: &str) -> Option<String> {
    if let Some(value) = env.get(name) {
        return Some(value.clone());
    }
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

/// 展开 %VAR%。与 env_vars 的 expandEnvVars 不同：
/// 那里"找不到就保留原文"，这里要**把找不到的变量识别出来**，
/// 所以额外返回 unresolved 列表。
pub fn expand_with_report(input: &str, env: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut unresolved: Vec<String> = Vec::new();
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] != '%' {
            result.push(chars[i]);
            i += 1;
            continue;
        }
        // 找闭合的 %
        match chars[i + 1..].iter().position(|&c| c == '%') {
            Some(end_rel) => {
                let end_abs = i + 1 + end_rel;
                let raw_name: String = chars[i + 1..end_abs].iter().collect();
                let name = raw_name.trim();
                if name.is_empty() {
                    // 空变量名（如 "100%%"）：保留原文
                    result.push('%');
                    i += 1;
                } else {
                    match lookup_env(env, name) {
                        Some(value) if !value.is_empty() => result.push_str(&value),
                        _ => {
                            unresolved.push(name.to_string());
                            for &c in &chars[i..=end_abs] {
                                result.push(c);
                            }
                        }
                    }
                    i = end_abs + 1;
                }
            }
            None => {
                // 没有闭合的 %：保留剩余原文
                for &c in &chars[i..] {
                    result.push(c);
                }
                break;
            }
        }
    }
    (result, unresolved)
}

/// 条目比较用的规范形：小写 + 去掉尾随分隔符 + 把连续分隔符压成一个
pub fn normalize_entry(entry: &str) -> String {
    let mut out = String::with_capacity(entry.len());
    let mut last_was_sep = false;
    for ch in entry.chars() {
        if ch == '\\' || ch == '/' {
            if !last_was_sep {
                out.push('\\');
            }
            last_was_sep = true;
        } else {
            out.push(ch);
            last_was_sep = false;
        }
    }
    while out.ends_with('\\') {
        out.pop();
    }
    out.to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathEntryAnalysis {
    /// 在 PATH 里的位置（从 1 开始，方便用户对照）
    pub index: usize,
    pub raw: String,
    /// 展开 %VAR% 之后的路径
    pub expanded: String,
    pub kind: PathEntryKind,
    /// 人话说明（只在非 ok 时给出）
    pub reason: Option<String>,
    /// 与哪一条重复（kind=duplicate 时给出，1-based）
    pub duplicate_of: Option<usize>,
}

/// **结构性**问题的判定 —— 只覆盖"这条目根本不可能是有效路径"的情况。
///
/// 刻意不在这里判"目录不存在"：那是事实问题，由调用方用 exists 判断。
/// 更刻意的是**不在这里判"看起来像被截断"** —— 因为 `D:\go` 这种两字符的目录名
/// 是完全合法的。截断只能是"不存在 + 结构可疑"两个条件同时成立时的**提示**，
/// 不能单独作为判定依据（否则会误报，而误报会让用户不敢点"一键修复"）。
pub fn classify_structural_problem(entry: &str) -> Option<String> {
    fn regex_cached(pattern: &'static str) -> &'static regex::Regex {
        static DRIVE_ONLY: OnceLock<regex::Regex> = OnceLock::new();
        static ABSOLUTE: OnceLock<regex::Regex> = OnceLock::new();
        static VERSION: OnceLock<regex::Regex> = OnceLock::new();
        match pattern {
            "drive_only" => {
                Some(DRIVE_ONLY.get_or_init(|| regex::Regex::new(r"^[a-zA-Z]:[\\/]?$").unwrap()))
            }
            "absolute" => {
                Some(ABSOLUTE.get_or_init(|| regex::Regex::new(r"^[a-zA-Z]:[\\/]").unwrap()))
            }
            _ => Some(VERSION.get_or_init(|| regex::Regex::new(r"^v?\d+(\.\d+)+$").unwrap())),
        }
        .unwrap()
    }

    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return Some("空条目".to_string());
    }

    // 只有盘符：C: 或 C:\
    if regex_cached("drive_only").is_match(trimmed) {
        return Some(format!(
            "「{trimmed}」只有盘符，没有具体目录 —— 把整盘加进 PATH 会拖慢每一次命令查找"
        ));
    }

    // 驱动器绝对路径 或 UNC
    let is_absolute = regex_cached("absolute").is_match(trimmed) || trimmed.starts_with(r"\\");
    if !is_absolute {
        if regex_cached("version").is_match(trimmed) {
            return Some(format!(
                "「{trimmed}」是个版本号，不是路径（多半是某个工具写 PATH 时漏了前缀）"
            ));
        }
        return Some(format!(
            "「{trimmed}」不是绝对路径。PATH 里的相对路径含义随当前目录变化，属于无效条目"
        ));
    }

    None
}

/// 结构上合法、但短得可疑 —— 只在"目录也不存在"时作为补充提示。
///
/// 实测见过的 `C:\P` 就是 `C:\Program Files\...` 被 setx 截断后的残留。
/// 但 `D:\go` 是合法目录，所以这条规则**不能单独用来判坏**。
pub fn looks_truncated(entry: &str) -> bool {
    regex::Regex::new(r"^[a-zA-Z]:\\[^\\]{1,2}$")
        .unwrap()
        .is_match(entry.trim())
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PathAnalysis {
    pub entries: Vec<PathEntryAnalysis>,
    /// 需要处理的条目（非 ok）
    pub problems: Vec<PathEntryAnalysis>,
    /// 去重并剔除坏条目之后的建议值
    pub suggested: String,
    /// 建议值与原文不同则为 true
    pub changed: bool,
    pub counts: HashMap<PathEntryKind, u32>,
}

/// 分析一整条 PATH（用户级或机器级都可以）。
///
/// 建议值的规则很保守：**只删两类东西** —— 重复条目、以及指向不存在目录/畸形/未解析变量的条目。
/// 顺序不动、大小写不动、尾随分隔符不动。用户点"修复"时看到的 diff 应该一眼能看懂。
pub fn analyze_path(
    raw_path: &str,
    exists: &dyn Fn(&str) -> bool,
    env: &HashMap<String, String>,
) -> PathAnalysis {
    let parts: Vec<&str> = raw_path.split(';').map(|part| part.trim()).collect();
    let mut entries: Vec<PathEntryAnalysis> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut counts: HashMap<PathEntryKind, u32> = HashMap::new();
    for kind in [
        PathEntryKind::Ok,
        PathEntryKind::Missing,
        PathEntryKind::UnexpandedVar,
        PathEntryKind::Malformed,
        PathEntryKind::Duplicate,
    ] {
        counts.insert(kind, 0);
    }

    for raw in parts {
        if raw.is_empty() {
            continue;
        }

        let index = entries.len() + 1;
        let (expanded, unresolved) = expand_with_report(raw, env);

        let mut kind = PathEntryKind::Ok;
        let mut reason: Option<String> = None;
        let mut duplicate_of: Option<usize> = None;

        // 判定顺序很重要，这里踩过坑：
        //  · %NOODE_PATH% 展开不了、同时也不是绝对路径 —— 但用户需要知道的是
        //    "这个变量不存在"，所以 unresolved 要排在结构性判定**前面**
        //  · C:\P 结构上是合法绝对路径，只是目录不存在 —— 应该报 missing，
        //    再把"像被截断"作为补充提示，而不是直接判成 malformed
        if unresolved.is_empty() {
            if let Some(problem) = classify_structural_problem(&expanded) {
                kind = PathEntryKind::Malformed;
                reason = Some(problem);
            } else if !exists(&expanded) {
                kind = PathEntryKind::Missing;
                reason = Some(if looks_truncated(&expanded) {
                    "这个目录不存在，而且路径短得可疑 —— 很像 PATH 被截断写入时留下的残片（例如 C:\\Program Files\\... 只写进去一个 C:\\P）".to_string()
                } else {
                    "这个目录不存在了（多半是工具卸载后留下的残渣）".to_string()
                });
            } else {
                let key = normalize_entry(&expanded);
                if let Some(previous) = seen.get(&key).copied() {
                    kind = PathEntryKind::Duplicate;
                    duplicate_of = Some(previous);
                    reason = Some(format!(
                        "与第 {previous} 条是同一个目录（写法不同，实际重复）"
                    ));
                } else {
                    seen.insert(key, index);
                }
            }
        } else {
            kind = PathEntryKind::UnexpandedVar;
            reason = Some(format!(
                "条目里的 %{}% 这个环境变量不存在（可能是拼错了，或变量已被删除）",
                unresolved.join("%、%")
            ));
        }

        *counts.entry(kind).or_insert(0) += 1;
        entries.push(PathEntryAnalysis {
            index,
            raw: raw.to_string(),
            expanded,
            kind,
            reason,
            duplicate_of,
        });
    }

    let suggested = entries
        .iter()
        .filter(|entry| entry.kind == PathEntryKind::Ok)
        .map(|entry| entry.raw.clone())
        .collect::<Vec<_>>()
        .join(";");

    let problems = entries
        .iter()
        .filter(|entry| entry.kind != PathEntryKind::Ok)
        .cloned()
        .collect();

    PathAnalysis {
        changed: suggested != raw_path.trim(),
        suggested,
        entries,
        problems,
        counts,
    }
}

/// PATH 长度告警阈值：用户级 PATH 超过 2047、总 PATH 超过 8191 都会开始出问题
pub const USER_PATH_WARN_LENGTH: usize = 2047;
pub const TOTAL_PATH_WARN_LENGTH: usize = 8191;

/// 把内部分析转成 IPC 视图（丢弃 expanded 等内部字段）
pub fn analysis_to_view(analysis: &PathAnalysis) -> PathAnalysisView {
    PathAnalysisView {
        entries: analysis
            .entries
            .iter()
            .map(|entry| PathEntryView {
                index: entry.index as u32,
                raw: entry.raw.clone(),
                kind: entry.kind,
                reason: entry.reason.clone(),
                duplicate_of: entry.duplicate_of.map(|value| value as u32),
            })
            .collect(),
        suggested: analysis.suggested.clone(),
        changed: analysis.changed,
        counts: analysis.counts.iter().map(|(k, v)| (*k, *v)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn expand_with_report_resolves_and_reports() {
        let env_map = env(&[("JAVA_HOME", r"D:\jdk"), ("DevKitHome", r"D:\devkit-data")]);
        let (expanded, unresolved) =
            expand_with_report(r"%JAVA_HOME%\bin;%NOODE_PATH%;%DevKitHome%", &env_map);
        assert_eq!(expanded, r"D:\jdk\bin;%NOODE_PATH%;D:\devkit-data");
        assert_eq!(unresolved, vec!["NOODE_PATH"]);

        // 大小写不敏感
        let (expanded, unresolved) = expand_with_report(r"%java_home%", &env_map);
        assert_eq!(expanded, r"D:\jdk");
        assert!(unresolved.is_empty());

        // 空变量名保留原文；未闭合 % 保留原文
        let (expanded, _) = expand_with_report("100%%;%BAD", &env_map);
        assert_eq!(expanded, "100%%;%BAD");
    }

    #[test]
    fn normalize_entry_folds_separators_and_case() {
        assert_eq!(
            normalize_entry(r"D:\MySQL\bin"),
            normalize_entry(r"D:/MySQL//bin\")
        );
        assert_eq!(normalize_entry(r"D:\MySQL\bin"), r"d:\mysql\bin");
        assert_eq!(normalize_entry(r"D:\MySQL\bin\\"), r"d:\mysql\bin");
    }

    #[test]
    fn structural_problem_classification() {
        assert!(classify_structural_problem("").is_some());
        assert!(classify_structural_problem("C:")
            .unwrap()
            .contains("只有盘符"));
        assert!(classify_structural_problem(r"C:\")
            .unwrap()
            .contains("只有盘符"));
        assert!(classify_structural_problem("v16.13.1")
            .unwrap()
            .contains("版本号"));
        assert!(classify_structural_problem("node_global")
            .unwrap()
            .contains("不是绝对路径"));
        // 合法绝对路径 → None（D:\go 是合法目录名！）
        assert_eq!(classify_structural_problem(r"D:\go"), None);
        assert_eq!(
            classify_structural_problem(r"C:\Program Files\Git\cmd"),
            None
        );
        assert_eq!(classify_structural_problem(r"\\server\share"), None);
    }

    #[test]
    fn looks_truncated_matches_only_suspicious_short() {
        assert!(looks_truncated(r"C:\P"));
        // 1-2 个字符都算“短得可疑”；D:\go 也命中 —— 所以它只能当 missing 时的补充提示，
        // 不能单独判坏（见 classify_structural_problem 的注释）
        assert!(looks_truncated(r"D:\go"));
        assert!(!looks_truncated(r"D:\go2"));
        assert!(!looks_truncated(r"C:\Program Files"));
    }

    fn fake_exists<'a>(paths: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        let set: std::collections::HashSet<String> =
            paths.iter().map(|p| normalize_entry(p)).collect();
        move |path: &str| set.contains(&normalize_entry(path))
    }

    #[test]
    fn analyze_path_flags_real_world_dirty_entries() {
        let env_map = env(&[]);
        let exists = fake_exists(&[r"C:\Windows", r"C:\Windows\System32", r"D:\tools\bin"]);
        let raw = r"C:\Windows;C:\P;ogram Files\Git\cmd;v16.13.1;node_global;%NOODE_PATH%;D:\tools\bin;D:\tools\\bin;C:\Windows";

        let analysis = analyze_path(raw, &exists, &env_map);
        assert_eq!(analysis.entries.len(), 9);

        // 逐条判定
        assert_eq!(analysis.entries[0].kind, PathEntryKind::Ok);
        assert_eq!(analysis.entries[1].kind, PathEntryKind::Missing); // C:\P，短得可疑
        assert!(analysis.entries[1]
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("截断"));
        assert_eq!(analysis.entries[2].kind, PathEntryKind::Malformed); // ogram Files\...
        assert_eq!(analysis.entries[3].kind, PathEntryKind::Malformed); // v16.13.1
        assert_eq!(analysis.entries[4].kind, PathEntryKind::Malformed); // node_global
        assert_eq!(analysis.entries[5].kind, PathEntryKind::UnexpandedVar); // %NOODE_PATH%
        assert_eq!(analysis.entries[6].kind, PathEntryKind::Ok);
        assert_eq!(analysis.entries[7].kind, PathEntryKind::Duplicate); // D:\tools\\bin
        assert_eq!(analysis.entries[7].duplicate_of, Some(7));
        assert_eq!(analysis.entries[8].kind, PathEntryKind::Duplicate); // C:\Windows 重复
        assert_eq!(analysis.entries[8].duplicate_of, Some(1));

        // 建议值只保留 ok 条目，顺序不动
        assert_eq!(analysis.suggested, r"C:\Windows;D:\tools\bin");
        assert!(analysis.changed);
        assert_eq!(analysis.problems.len(), 7);
        assert_eq!(analysis.counts[&PathEntryKind::Ok], 2);
        assert_eq!(analysis.counts[&PathEntryKind::Missing], 1);
        assert_eq!(analysis.counts[&PathEntryKind::Malformed], 3);
        assert_eq!(analysis.counts[&PathEntryKind::UnexpandedVar], 1);
        assert_eq!(analysis.counts[&PathEntryKind::Duplicate], 2);
    }

    #[test]
    fn analyze_path_clean_input_reports_unchanged() {
        let env_map = env(&[]);
        let exists = fake_exists(&[r"C:\Windows"]);
        let raw = r"C:\Windows";
        let analysis = analyze_path(raw, &exists, &env_map);
        assert!(!analysis.changed);
        assert_eq!(analysis.suggested, raw);
        assert!(analysis.problems.is_empty());
    }
}
