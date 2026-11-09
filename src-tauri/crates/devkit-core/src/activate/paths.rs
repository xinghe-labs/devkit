//! 激活相关的**纯逻辑**：占位符展开、PATH 增删（镜像 `src/main/core/activate/paths.ts`）。
//!
//! 这个模块不碰文件系统 —— 因为 PATH 处理是「改坏用户环境」的高风险点，
//! 必须能用单测把边界情况钉死（含中文路径、含空格、大小写差异、尾随反斜杠、
//! 重复条目、PATH 超长）。

use std::collections::{HashMap, HashSet};

use devkit_types::manifest::ActivateSpec;

pub struct ActivateVars<'a> {
    pub install_dir: &'a str,
    /// `%USERPROFILE%\.devkit\current\<linkName>`
    pub current_dir: &'a str,
    pub version: &'a str,
    pub tool_id: &'a str,
}

/// 占位符展开错误（对齐 TS ActivateSpecError）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivateSpecError(pub String);

impl std::fmt::Display for ActivateSpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ActivateSpecError {}

/// 展开 `{name}` 占位符；只支持四个受支持的占位符，其余报错 ——
/// 静默放行只会让用户拿到一条指向乱码目录的 PATH。
pub fn render_activate_path(
    input: &str,
    vars: &ActivateVars<'_>,
) -> Result<String, ActivateSpecError> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'{' {
            if let Some(end) = input[index..].find('}') {
                let name = &input[index + 1..index + end];
                let valid_name = !name.is_empty()
                    && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                    && name.chars().all(|c| c.is_ascii_alphanumeric());
                if valid_name {
                    let value = match name {
                        "installDir" => vars.install_dir,
                        "currentDir" => vars.current_dir,
                        "version" => vars.version,
                        "toolId" => vars.tool_id,
                        _ => {
                            return Err(ActivateSpecError(format!(
                                "激活声明里的占位符 {{{name}}} 不被支持"
                            )))
                        }
                    };
                    out.push_str(value);
                    index += end + 1;
                    continue;
                }
            }
        }
        // 非占位符：按字符推进（避免在 UTF-8 多字节中间切断）
        let ch = input[index..].chars().next().expect("in-bounds");
        out.push(ch);
        index += ch.len_utf8();
    }

    Ok(out)
}

#[derive(Debug)]
pub struct ActivateEntries {
    pub link_name: String,
    pub path_entries: Vec<String>,
    pub env: HashMap<String, String>,
}

/// 把清单里的 activate 声明展开成"要写进用户环境的最终值"。
pub fn build_activate_entries(
    spec: &ActivateSpec,
    vars: &ActivateVars<'_>,
) -> Result<ActivateEntries, ActivateSpecError> {
    let link_name = spec
        .link_name
        .clone()
        .unwrap_or_else(|| vars.tool_id.to_string());

    let mut path_entries = Vec::new();
    for entry in spec.path_entries.as_deref().unwrap_or(&[]) {
        let rendered = render_activate_path(entry, vars)?;
        if rendered.trim().is_empty() {
            return Err(ActivateSpecError(format!(
                "{} 的激活声明里有空路径",
                vars.tool_id
            )));
        }
        if rendered.contains(';') {
            return Err(ActivateSpecError(format!(
                "{} 的激活路径不能包含分号：{rendered}",
                vars.tool_id
            )));
        }
        path_entries.push(rendered);
    }

    let mut env = HashMap::new();
    for (name, value) in spec.env.iter().flatten() {
        if !is_valid_env_name(name) {
            return Err(ActivateSpecError(format!(
                "{} 的激活环境变量名不合法：{name}",
                vars.tool_id
            )));
        }
        env.insert(name.clone(), render_activate_path(value, vars)?);
    }

    Ok(ActivateEntries {
        link_name,
        path_entries,
        env,
    })
}

/// `^[A-Z][A-Z0-9_]{0,40}$`
fn is_valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 41
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/* ------------------------------------------------------------------ */
/* PATH 增删                                                           */
/* ------------------------------------------------------------------ */

/// 拆成条目并丢掉空段（PATH 里连续分号会解析出空条目）。
pub fn split_path(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// 条目比较用的规范形：小写 + 去掉尾随反斜杠/斜杠。
/// Windows 的 PATH 比较是大小写不敏感的，尾随反斜杠也无意义。
pub fn normalize_path_entry(entry: &str) -> String {
    entry.trim_end_matches(['\\', '/']).to_lowercase()
}

pub struct MergeResult {
    pub value: String,
    pub added: Vec<String>,
    pub already_present: Vec<String>,
}

/// 把条目插到 PATH **最前面**（devkit 激活的版本优先于系统里已有的同名工具），
/// 已在 PATH 里的条目不会重复插入，但会被提到最前面。
pub fn prepend_path_entries(current_path: &str, entries: &[String]) -> MergeResult {
    let existing = split_path(current_path);
    let existing_normalized: HashSet<String> = existing
        .iter()
        .map(|entry| normalize_path_entry(entry))
        .collect();

    let mut added = Vec::new();
    let mut already_present = Vec::new();
    let mut wanted = Vec::new();
    let mut wanted_normalized = HashSet::new();

    for entry in entries {
        let key = normalize_path_entry(entry);
        if !wanted_normalized.insert(key.clone()) {
            continue;
        }
        wanted.push(entry.clone());
        if existing_normalized.contains(&key) {
            already_present.push(entry.clone());
        } else {
            added.push(entry.clone());
        }
    }

    let rest: Vec<String> = existing
        .into_iter()
        .filter(|entry| !wanted_normalized.contains(&normalize_path_entry(entry)))
        .collect();

    let mut merged = wanted;
    merged.extend(rest);

    MergeResult {
        value: merged.join(";"),
        added,
        already_present,
    }
}

/// 精确移除给定条目（其余原样保留，顺序不变）。
pub fn remove_path_entries(current_path: &str, entries: &[String]) -> String {
    let doomed: HashSet<String> = entries
        .iter()
        .map(|entry| normalize_path_entry(entry))
        .collect();
    split_path(current_path)
        .into_iter()
        .filter(|entry| !doomed.contains(&normalize_path_entry(entry)))
        .collect::<Vec<_>>()
        .join(";")
}

/// 比较两次 PATH，列出"后来新增"的条目（大小写与尾随分隔符不敏感）。
///
/// 用途：有些官方安装器会自己往用户 PATH 里写目录（实测 VS Code 的 Inno 安装器），
/// 这跟 devkit 的「安装 ≠ 激活」原则冲突。
pub fn diff_path_entries(before: &str, after: &str) -> Vec<String> {
    let known: HashSet<String> = split_path(before)
        .iter()
        .map(|entry| normalize_path_entry(entry))
        .collect();
    split_path(after)
        .into_iter()
        .filter(|entry| !known.contains(&normalize_path_entry(entry)))
        .collect()
}

/// PATH 里是否已经有某个条目。
pub fn has_path_entry(current_path: &str, entry: &str) -> bool {
    let key = normalize_path_entry(entry);
    split_path(current_path)
        .iter()
        .any(|item| normalize_path_entry(item) == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> ActivateVars<'static> {
        ActivateVars {
            install_dir: r"C:\Users\屈\.devkit\versions\jdk-temurin\21.0.12.1",
            current_dir: r"C:\Users\屈\.devkit\current\jdk-temurin",
            version: "21.0.12.1",
            tool_id: "jdk-temurin",
        }
    }

    fn entries(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn spec(
        path_entries: Option<Vec<String>>,
        env: Option<HashMap<String, String>>,
    ) -> ActivateSpec {
        ActivateSpec {
            path_entries,
            env,
            link_name: None,
        }
    }

    #[test]
    fn expands_four_placeholders() {
        let vars = vars();
        assert_eq!(
            render_activate_path(r"{currentDir}\bin", &vars).unwrap(),
            r"C:\Users\屈\.devkit\current\jdk-temurin\bin"
        );
        assert_eq!(
            render_activate_path("{installDir}", &vars).unwrap(),
            vars.install_dir
        );
        assert_eq!(
            render_activate_path("{toolId}-{version}", &vars).unwrap(),
            "jdk-temurin-21.0.12.1"
        );
    }

    #[test]
    fn unknown_placeholder_errors() {
        let error = render_activate_path("{evil}", &vars()).unwrap_err();
        assert!(error.0.contains("{evil}") && error.0.contains("不被支持"));
    }

    #[test]
    fn build_entries_expands_and_defaults_link_name() {
        let mut env = HashMap::new();
        env.insert("JAVA_HOME".to_string(), "{currentDir}".to_string());
        let built = build_activate_entries(
            &spec(Some(entries(&[r"{currentDir}\bin"])), Some(env)),
            &vars(),
        )
        .unwrap();

        assert_eq!(built.link_name, "jdk-temurin");
        assert_eq!(
            built.path_entries,
            entries(&[r"C:\Users\屈\.devkit\current\jdk-temurin\bin"])
        );
        assert_eq!(
            built.env.get("JAVA_HOME").map(String::as_str),
            Some(r"C:\Users\屈\.devkit\current\jdk-temurin")
        );
    }

    #[test]
    fn rejects_bad_env_name_and_semicolon_path() {
        let mut env = HashMap::new();
        env.insert("bad-name".to_string(), "x".to_string());
        assert!(build_activate_entries(&spec(None, Some(env)), &vars()).is_err());

        let error =
            build_activate_entries(&spec(Some(entries(&["a;b"])), None), &vars()).unwrap_err();
        assert!(error.0.contains("分号"));
    }

    #[test]
    fn split_drops_empty_segments() {
        assert_eq!(split_path("a;;b;"), entries(&["a", "b"]));
        assert!(split_path("").is_empty());
    }

    #[test]
    fn normalize_ignores_case_and_trailing_slash() {
        assert_eq!(
            normalize_path_entry(r"C:\Foo\"),
            normalize_path_entry(r"c:\foo")
        );
    }

    #[test]
    fn prepend_puts_new_entries_first() {
        let result = prepend_path_entries(r"C:\Windows;C:\Tools", &entries(&[r"D:\devkit\bin"]));
        assert_eq!(result.value, r"D:\devkit\bin;C:\Windows;C:\Tools");
        assert_eq!(result.added, entries(&[r"D:\devkit\bin"]));
    }

    #[test]
    fn prepend_dedupes_and_hoists_existing() {
        let result = prepend_path_entries(
            r"C:\Windows;C:\devkit\bin;C:\Tools",
            &entries(&[r"C:\devkit\bin"]),
        );
        assert_eq!(result.value, r"C:\devkit\bin;C:\Windows;C:\Tools");
        assert!(result.added.is_empty());
        assert_eq!(result.already_present, entries(&[r"C:\devkit\bin"]));
    }

    #[test]
    fn prepend_dedupes_within_batch() {
        let result = prepend_path_entries("", &entries(&["a", "A\\", "b"]));
        assert_eq!(result.value, "a;b");
    }

    #[test]
    fn remove_is_case_and_slash_insensitive() {
        let result = remove_path_entries(r"A;c:\devkit\bin\;B", &entries(&[r"C:\DEVKIT\BIN"]));
        assert_eq!(result, "A;B");
    }

    #[test]
    fn chinese_and_spaced_paths() {
        let items = entries(&[
            r"C:\Users\屈\.devkit\current\nodejs",
            r"C:\Program Files\devkit\bin",
        ]);
        let merged = prepend_path_entries(r"C:\Windows", &items);
        assert_eq!(
            merged.value,
            format!("{};{};C:\\Windows", items[0], items[1])
        );
        assert!(has_path_entry(
            &merged.value,
            r"c:\users\屈\.devkit\current\nodejs\"
        ));

        assert_eq!(remove_path_entries(&merged.value, &items), r"C:\Windows");
    }

    #[test]
    fn repeated_activate_deactivate_is_idempotent() {
        let items = entries(&[r"C:\devkit\bin"]);
        let mut path = r"C:\Windows".to_string();
        for _ in 0..5 {
            path = prepend_path_entries(&path, &items).value;
            assert_eq!(
                split_path(&path)
                    .iter()
                    .filter(|item| item.as_str() == r"C:\devkit\bin")
                    .count(),
                1
            );
            path = remove_path_entries(&path, &items);
            assert_eq!(path, r"C:\Windows");
        }
    }

    #[test]
    fn very_long_path_not_truncated() {
        // setx 的 1024 字符陷阱
        let long: Vec<String> = (0..200)
            .map(|index| format!(r"C:\very\long\path\segment\{index}"))
            .collect();
        let original = long.join(";");
        let merged = prepend_path_entries(&original, &entries(&[r"C:\devkit\bin"]));
        assert!(merged.value.len() > 1024);
        assert!(merged.value.ends_with(&original));
        assert_eq!(
            remove_path_entries(&merged.value, &entries(&[r"C:\devkit\bin"])),
            original
        );
    }

    #[test]
    fn diff_reports_only_new_entries() {
        assert_eq!(
            diff_path_entries(r"C:\Windows", r"C:\Windows;c:\new\;C:\Windows"),
            entries(&[r"c:\new\"])
        );
    }
}
