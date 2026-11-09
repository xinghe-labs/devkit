//! 安装/自检命令里的占位符替换（对应 TS `core/installer/placeholders.ts`）。
//!
//! 为什么需要：装到用户级版本目录后，`verify` 不能写 `node -v` —— 那会命中 PATH 上
//! 本来就有的 Node，得到假阳性。必须让清单写成 `{installDir}\node.exe`，
//! 验证的才是刚装进去的那一份（见 SPEC「安装 ≠ 激活」）。

use devkit_types::manifest::ToolVersionSpec;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaceholderVars {
    pub install_dir: String,
    pub version: String,
    pub tool_id: String,
}

#[derive(Debug, thiserror::Error)]
#[error("未知占位符 {{{name}}}（出现在 {input:?}）")]
pub struct UnknownPlaceholderError {
    pub name: String,
    pub input: String,
}

static PLACEHOLDER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\{([a-zA-Z][a-zA-Z0-9]*)\}").expect("占位符正则合法")
});

pub fn substitute_placeholders(
    input: &str,
    vars: &PlaceholderVars,
) -> Result<String, UnknownPlaceholderError> {
    let mut result = String::with_capacity(input.len());
    let mut last_end = 0;
    for captures in PLACEHOLDER.captures_iter(input) {
        let whole = captures.get(0).expect("group 0 必然存在");
        let name = captures.get(1).expect("捕获组 1 必然存在").as_str();
        result.push_str(&input[last_end..whole.start()]);
        match name {
            "installDir" => result.push_str(&vars.install_dir),
            "version" => result.push_str(&vars.version),
            "toolId" => result.push_str(&vars.tool_id),
            // 宁可报错也不要原样传给命令行 —— 未知占位符通常意味着清单写错了，
            // 静默放行只会让用户看到一个莫名其妙的"命令找不到"
            _ => {
                return Err(UnknownPlaceholderError {
                    name: name.to_string(),
                    input: input.to_string(),
                })
            }
        }
        last_end = whole.end();
    }
    result.push_str(&input[last_end..]);
    Ok(result)
}

/// 判断某个版本是否具备完整安装信息（status=ready 的清单由 Schema 保证，这里是运行期兜底）
pub fn is_installable_version(version: &ToolVersionSpec) -> bool {
    match (&version.source, &version.install) {
        (Some(source), Some(install)) => !source.url.is_empty() && !install.template.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> PlaceholderVars {
        PlaceholderVars {
            install_dir: r"C:\u\.devkit\versions\node\24.1.0".to_string(),
            version: "24.1.0".to_string(),
            tool_id: "node".to_string(),
        }
    }

    #[test]
    fn substitutes_known_placeholders() {
        assert_eq!(
            substitute_placeholders(r"{installDir}\node.exe -v", &vars()).unwrap(),
            r"C:\u\.devkit\versions\node\24.1.0\node.exe -v"
        );
        assert_eq!(
            substitute_placeholders("{toolId}-{version}", &vars()).unwrap(),
            "node-24.1.0"
        );
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(
            substitute_placeholders("node -v", &vars()).unwrap(),
            "node -v"
        );
        // 数字开头不是占位符（正则要求首字符是字母）
        assert_eq!(
            substitute_placeholders("{1abc}", &vars()).unwrap(),
            "{1abc}"
        );
    }

    #[test]
    fn rejects_unknown_placeholder() {
        let error = substitute_placeholders("{installDir} {bogus}", &vars()).unwrap_err();
        assert_eq!(error.name, "bogus");
        assert!(error.to_string().contains("未知占位符 {bogus}"));
    }

    #[test]
    fn installable_requires_source_and_template() {
        let mut spec = devkit_types::manifest::ToolVersionSpec {
            version: "1.0.0".to_string(),
            channel: devkit_types::manifest::VersionChannel::Stable,
            recommended: None,
            arch: devkit_types::manifest::Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: devkit_types::manifest::InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: None,
            mirrors: None,
            install: None,
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        };
        assert!(!is_installable_version(&spec));
        spec.source = Some(devkit_types::manifest::SourceSpec {
            url: "https://example.com/x.zip".to_string(),
            sha256: Some("abc".to_string()),
        });
        spec.install = Some(devkit_types::manifest::InstallSpec {
            install_type: devkit_types::manifest::InstallType::Zip,
            template: "unzip".to_string(),
            params: None,
        });
        assert!(is_installable_version(&spec));
    }
}
