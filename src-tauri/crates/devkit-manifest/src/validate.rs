//! 清单校验（镜像 `src/main/core/manifest/validate.ts`）。
//!
//! 两层：
//! 1. **结构**：serde 反序列化。`deny_unknown_fields` 对齐 `additionalProperties:false`，
//!    非 Option 字段对齐 `required`，枚举对齐 `enum`。
//! 2. **约束**：手写复刻 Ajv 的 pattern / minLength / minItems / minProperties，
//!    以及 validate.ts 里四项 Schema 表达不了的语义检查。
//!
//! 报错风格对齐 Ajv：收集全部违规再一次性返回，而不是修一个报一个。

use devkit_types::locale::LocalizedText;
use devkit_types::manifest::{
    ActivateSpec, InstallSpec, SourceSpec, ToolManifest, ToolVersionSpec, UninstallSpec,
};
use devkit_types::ManifestStatus;
use std::collections::HashMap;

use devkit_types::manifest::ManifestLoadError;

/// 一个待校验的清单文件（文件名 + 原始 JSON）
#[derive(Debug, Clone)]
pub struct ManifestFileInput {
    pub file: String,
    pub data: serde_json::Value,
}

/// 单个清单的 Schema 层错误（字段路径 + 说明）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaCheckError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for SchemaCheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.path, self.message)
    }
}

/// 一批清单的校验结果（镜像 `ManifestValidationResult`）
#[derive(Debug, Clone, Default)]
pub struct ManifestValidationResult {
    pub tools: Vec<ToolManifest>,
    pub errors: Vec<ManifestLoadError>,
}

/// 工具 id 的格式：`^[a-z0-9][a-z0-9-]{1,39}$`
pub fn is_valid_tool_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 40 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 版本字符串：`^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$`
/// 必须以字母或数字开头：`..` 这类值会让版本目录逃逸到 versions 根目录。
fn is_valid_version(version: &str) -> bool {
    let bytes = version.as_bytes();
    if bytes.is_empty() || bytes.len() > 40 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// 安装模板名：`^[a-z0-9][a-z0-9-]*$`（只能引用代码内置白名单，不允许自定义命令行）
fn is_valid_template(template: &str) -> bool {
    let bytes = template.as_bytes();
    match bytes.first() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 语言键：`^[a-z]{2}(-[A-Z]{2})?$`
fn is_valid_locale_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let lang_ok =
        bytes.len() >= 2 && bytes[0].is_ascii_lowercase() && bytes[1].is_ascii_lowercase();
    if !lang_ok {
        return false;
    }
    match bytes.len() {
        2 => true,
        5 => bytes[2] == b'-' && bytes[3].is_ascii_uppercase() && bytes[4].is_ascii_uppercase(),
        _ => false,
    }
}

/// 日期：`^\d{4}-\d{2}-\d{2}$`（只查形状，不查日历有效性 —— 与 Ajv pattern 一致）
fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn is_https(url: &str) -> bool {
    url.starts_with("https://")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// 环境变量键：`^[A-Z][A-Z0-9_]{0,40}$`
fn is_valid_env_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    match bytes.first() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return false,
    }
    bytes.len() <= 41
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

fn push(errors: &mut Vec<SchemaCheckError>, path: &str, message: impl Into<String>) {
    errors.push(SchemaCheckError {
        path: path.to_string(),
        message: message.into(),
    });
}

fn check_localized(errors: &mut Vec<SchemaCheckError>, path: &str, text: &LocalizedText) {
    if text.is_empty() {
        push(errors, path, "至少要有一种语言的文案（minProperties 1）");
        return;
    }
    for (key, value) in text {
        if !is_valid_locale_key(key) {
            push(
                errors,
                path,
                format!("语言键 \"{key}\" 不合法（应形如 zh-CN / en-US）"),
            );
        }
        if value.is_empty() {
            push(errors, path, format!("语言 \"{key}\" 的文案不能为空"));
        }
    }
}

fn check_source(errors: &mut Vec<SchemaCheckError>, path: &str, source: &SourceSpec) {
    if !is_https(&source.url) {
        push(
            errors,
            path,
            format!("下载地址必须是 https：{}", source.url),
        );
    }
    if let Some(sha256) = &source.sha256 {
        if !is_sha256(sha256) {
            push(errors, path, "sha256 必须是 64 位小写十六进制");
        }
    }
}

fn check_install(errors: &mut Vec<SchemaCheckError>, path: &str, install: &InstallSpec) {
    if !is_valid_template(&install.template) {
        push(
            errors,
            path,
            format!(
                "安装模板名 \"{}\" 不合法（只允许小写字母、数字与连字符）",
                install.template
            ),
        );
    }
}

fn check_uninstall(errors: &mut Vec<SchemaCheckError>, path: &str, uninstall: &UninstallSpec) {
    if let Some(template) = &uninstall.template {
        if !is_valid_template(template) {
            push(errors, path, format!("卸载模板名 \"{template}\" 不合法"));
        }
    }
}

fn check_activate(errors: &mut Vec<SchemaCheckError>, path: &str, activate: &ActivateSpec) {
    let empty = activate
        .path_entries
        .as_ref()
        .is_none_or(|items| items.is_empty())
        && activate.env.as_ref().is_none_or(|map| map.is_empty())
        && activate.link_name.is_none();
    if empty {
        push(errors, path, "至少声明 pathEntries / env / linkName 之一");
    }
    if let Some(entries) = &activate.path_entries {
        if entries.is_empty() {
            push(errors, path, "pathEntries 不能是空数组");
        }
        for entry in entries {
            if entry.is_empty() {
                push(errors, path, "pathEntries 里不能有空字符串");
            }
        }
    }
    if let Some(env) = &activate.env {
        if env.is_empty() {
            push(errors, path, "env 不能是空对象");
        }
        for (key, value) in env {
            if !is_valid_env_key(key) {
                push(
                    errors,
                    path,
                    format!("环境变量名 \"{key}\" 不合法（应形如 JAVA_HOME）"),
                );
            }
            if value.is_empty() {
                push(errors, path, format!("环境变量 \"{key}\" 的值不能为空"));
            }
        }
    }
    if let Some(link_name) = &activate.link_name {
        if !is_valid_tool_id_like(link_name) {
            push(errors, path, format!("linkName \"{link_name}\" 不合法"));
        }
    }
}

/// linkName：`^[a-z0-9][a-z0-9-]{0,39}$`（与工具 id 同形，但允许只有 1 个字符）
fn is_valid_tool_id_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 40 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn check_version(errors: &mut Vec<SchemaCheckError>, base: &str, version: &ToolVersionSpec) {
    if !is_valid_version(&version.version) {
        push(
            errors,
            base,
            format!(
                "版本号 \"{}\" 不合法（必须以字母或数字开头，只含字母数字与 . _ + -）",
                version.version
            ),
        );
    }
    if let Some(date) = &version.release_date {
        if !is_valid_date(date) {
            push(errors, base, format!("发布日 \"{date}\" 不是 YYYY-MM-DD"));
        }
    }
    if let Some(depends) = &version.depends_on {
        for dependency in depends {
            if !is_valid_tool_id(dependency) {
                push(
                    errors,
                    base,
                    format!("依赖项 \"{dependency}\" 不是合法的工具 id"),
                );
            }
        }
    }
    if let Some(source) = &version.source {
        check_source(errors, &format!("{base}.source"), source);
    }
    if let Some(mirrors) = &version.mirrors {
        for mirror in mirrors {
            let path = format!("{base}.mirrors[{}]", mirror.name);
            if mirror.name.is_empty() {
                push(errors, &path, "镜像名称不能为空");
            }
            if !is_https(&mirror.url) {
                push(
                    errors,
                    &path,
                    format!("镜像地址必须是 https：{}", mirror.url),
                );
            }
        }
    }
    if let Some(install) = &version.install {
        check_install(errors, &format!("{base}.install"), install);
    }
    if let Some(uninstall) = &version.uninstall {
        check_uninstall(errors, &format!("{base}.uninstall"), uninstall);
    }
    if let Some(activate) = &version.activate {
        check_activate(errors, &format!("{base}.activate"), activate);
    }
    if let Some(configure) = &version.configure {
        for item in configure {
            if item.is_empty() {
                push(errors, &format!("{base}.configure"), "配置项不能是空字符串");
            }
        }
    }
    if let Some(verify) = &version.verify {
        if verify.cmd.is_empty() {
            push(errors, &format!("{base}.verify"), "cmd 不能为空");
        }
        // 与 Ajv 一致：schema 只约束 minLength 1；正则合法性在检测执行时验证
        if let Some(pattern) = &verify.expect_regex {
            if pattern.is_empty() {
                push(errors, &format!("{base}.verify"), "expectRegex 不能为空");
            }
        }
    }
}

fn check_detect(errors: &mut Vec<SchemaCheckError>, tool: &ToolManifest) {
    let detect = &tool.detect;
    let has_commands = detect.commands.as_ref().is_some_and(|v| !v.is_empty());
    let has_files = detect.files.as_ref().is_some_and(|v| !v.is_empty());
    let has_registry = detect.registry.as_ref().is_some_and(|v| !v.is_empty());
    if !has_commands && !has_files && !has_registry {
        push(
            errors,
            "detect",
            "至少声明一种检测手段（commands / files / registry）",
        );
        return;
    }
    if let Some(commands) = &detect.commands {
        if commands.is_empty() {
            push(errors, "detect.commands", "commands 不能是空数组");
        }
        for command in commands {
            if command.cmd.is_empty() {
                push(errors, "detect.commands", "cmd 不能为空");
            }
            if let Some(pattern) = &command.expect_regex {
                if pattern.is_empty() {
                    push(errors, "detect.commands", "expectRegex 不能为空");
                }
            }
        }
    }
    if let Some(files) = &detect.files {
        if files.is_empty() {
            push(errors, "detect.files", "files 不能是空数组");
        }
        for file in files {
            if file.is_empty() {
                push(errors, "detect.files", "文件路径不能为空");
            }
        }
    }
}

/// 对一个清单做 Schema 层约束检查（serde 已过的部分不再重复）。
fn check_schema_constraints(tool: &ToolManifest) -> Vec<SchemaCheckError> {
    let mut errors = Vec::new();

    if !is_valid_tool_id(&tool.id) {
        push(
            &mut errors,
            "id",
            format!(
                "\"{}\" 不合法（2~40 位，小写字母/数字/连字符，且以字母或数字开头）",
                tool.id
            ),
        );
    }

    check_localized(&mut errors, "name", &tool.name);
    check_localized(&mut errors, "description", &tool.description);
    if let Some(notes) = &tool.notes {
        check_localized(&mut errors, "notes", notes);
    }

    if let Some(homepage) = &tool.homepage {
        if !is_https(homepage) {
            push(
                &mut errors,
                "homepage",
                format!("主页必须是 https：{homepage}"),
            );
        }
    }

    if let Some(license) = &tool.license {
        if license.spdx.is_empty() {
            push(&mut errors, "license.spdx", "SPDX 标识不能为空");
        }
    }

    check_detect(&mut errors, tool);

    for (index, version) in tool.versions.iter().enumerate() {
        check_version(&mut errors, &format!("versions[{index}]"), version);
    }

    errors
}

/// 校验单个清单 JSON：结构 + Schema 约束。
pub fn validate_manifest_json(data: &serde_json::Value) -> Result<ToolManifest, SchemaCheckError> {
    let tool: ToolManifest =
        serde_json::from_value(data.clone()).map_err(|error| SchemaCheckError {
            path: "/".to_string(),
            message: error.to_string(),
        })?;
    let constraint_errors = check_schema_constraints(&tool);
    if !constraint_errors.is_empty() {
        // 对齐 Ajv allErrors：一次报前 6 条
        let message = constraint_errors
            .iter()
            .take(6)
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(SchemaCheckError {
            path: "/".to_string(),
            message,
        });
    }
    Ok(tool)
}

/// 校验一批清单（镜像 `validateManifests`）。
///
/// 除 Schema 约束外的四项语义检查：
///  1. id 不能重复（报在后一个文件上）
///  2. 同一个工具最多只能有一个 recommended 版本
///  3. status 为 ready 时，每个版本必须有 source.url / source.sha256 / install.template
///  4. dependsOn 指向的工具必须存在
pub fn validate_manifest_files(files: &[ManifestFileInput]) -> ManifestValidationResult {
    let mut tools: Vec<ToolManifest> = Vec::new();
    let mut errors: Vec<ManifestLoadError> = Vec::new();
    let mut seen_ids: HashMap<String, String> = HashMap::new();

    for entry in files {
        let name = entry.file.clone();

        let tool = match validate_manifest_json(&entry.data) {
            Ok(tool) => tool,
            Err(error) => {
                errors.push(ManifestLoadError {
                    file: name,
                    message: error.to_string(),
                });
                continue;
            }
        };

        if let Some(previous) = seen_ids.get(&tool.id) {
            errors.push(ManifestLoadError {
                file: name,
                message: format!("id \"{}\" 与 {} 重复", tool.id, previous),
            });
            continue;
        }

        let recommended_count = tool
            .versions
            .iter()
            .filter(|version| version.recommended.unwrap_or(false))
            .count();
        if recommended_count > 1 {
            errors.push(ManifestLoadError {
                file: name,
                message: format!(
                    "id \"{}\" 有 {} 个 recommended 版本，最多只能有一个",
                    tool.id, recommended_count
                ),
            });
            continue;
        }

        if matches!(tool.status, ManifestStatus::Ready) {
            if tool.versions.is_empty() {
                errors.push(ManifestLoadError {
                    file: name,
                    message: format!("id \"{}\" 状态为 ready 但没有任何版本", tool.id),
                });
                continue;
            }
            let incomplete: Vec<&ToolVersionSpec> = tool
                .versions
                .iter()
                .filter(|version| {
                    let has_url = version
                        .source
                        .as_ref()
                        .is_some_and(|source| !source.url.is_empty());
                    let has_sha = version
                        .source
                        .as_ref()
                        .and_then(|source| source.sha256.as_ref())
                        .is_some_and(|sha| !sha.is_empty());
                    let has_template = version
                        .install
                        .as_ref()
                        .is_some_and(|install| !install.template.is_empty());
                    !has_url || !has_sha || !has_template
                })
                .collect();
            if !incomplete.is_empty() {
                let versions = incomplete
                    .iter()
                    .map(|version| version.version.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                errors.push(ManifestLoadError {
                    file: name,
                    message: format!(
                        "id \"{}\" 状态为 ready，但版本 {} 缺少 source.url / source.sha256 / install.template",
                        tool.id, versions
                    ),
                });
                continue;
            }
        }

        seen_ids.insert(tool.id.clone(), name);
        tools.push(tool);
    }

    // dependsOn 引用完整性
    let known_ids: std::collections::HashSet<&str> =
        tools.iter().map(|tool| tool.id.as_str()).collect();
    for tool in &tools {
        for version in &tool.versions {
            for dependency in version.depends_on.iter().flatten() {
                if !known_ids.contains(dependency.as_str()) {
                    errors.push(ManifestLoadError {
                        file: seen_ids
                            .get(&tool.id)
                            .cloned()
                            .unwrap_or_else(|| tool.id.clone()),
                        message: format!(
                            "id \"{}\" 的版本 {} 依赖不存在的工具 \"{dependency}\"",
                            tool.id, version.version
                        ),
                    });
                }
            }
        }
    }

    ManifestValidationResult { tools, errors }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> serde_json::Value {
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

    fn check(data: serde_json::Value) -> ManifestValidationResult {
        validate_manifest_files(&[ManifestFileInput {
            file: "demo-tool.json".to_string(),
            data,
        }])
    }

    #[test]
    fn accepts_minimal_manifest() {
        let result = check(minimal());
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
        assert_eq!(result.tools.len(), 1);
    }

    #[test]
    fn rejects_missing_required_field() {
        let result = check(serde_json::json!({ "id": "demo-tool" }));
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn rejects_invalid_id() {
        let mut data = minimal();
        data["id"] = serde_json::json!("Demo Tool");
        assert!(!check(data).errors.is_empty());

        let mut data = minimal();
        data["id"] = serde_json::json!("A");
        assert!(
            !check(data).errors.is_empty(),
            "单字符 id 不合法（需 2~40 位）"
        );
    }

    #[test]
    fn rejects_unknown_field() {
        let mut data = minimal();
        data["unknownField"] = serde_json::json!(1);
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_http_source() {
        let mut data = minimal();
        data["versions"][0]["source"]["url"] = serde_json::json!("http://example.com/a.exe");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_bad_sha256() {
        let mut data = minimal();
        data["versions"][0]["source"]["sha256"] = serde_json::json!("short");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_missing_install_scope() {
        let mut data = minimal();
        data["versions"][0]
            .as_object_mut()
            .unwrap()
            .remove("installScope");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_bad_release_date() {
        let mut data = minimal();
        data["versions"][0]["releaseDate"] = serde_json::json!("2026/01/01");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_injected_install_template() {
        let mut data = minimal();
        data["versions"][0]["install"]["template"] = serde_json::json!("msi-silent; rm -rf /");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_bad_locale_key() {
        let mut data = minimal();
        data["name"] = serde_json::json!({ "chinese": "中文" });
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_empty_detect() {
        let mut data = minimal();
        data["detect"] = serde_json::json!({});
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_version_starting_with_dot() {
        let mut data = minimal();
        data["versions"][0]["version"] = serde_json::json!("..");
        assert!(!check(data).errors.is_empty());
    }

    #[test]
    fn rejects_duplicate_id_pointing_at_later_file() {
        let result = validate_manifest_files(&[
            ManifestFileInput {
                file: "a.json".to_string(),
                data: minimal(),
            },
            ManifestFileInput {
                file: "b.json".to_string(),
                data: minimal(),
            },
        ]);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].file, "b.json");
    }

    #[test]
    fn rejects_multiple_recommended_versions() {
        let mut data = minimal();
        let second = data["versions"][0].clone();
        data["versions"].as_array_mut().unwrap().push(second);
        let result = check(data);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);
        assert!(result.errors[0].message.contains("recommended"));
    }

    #[test]
    fn rejects_ready_without_versions() {
        let mut data = minimal();
        data["versions"] = serde_json::json!([]);
        let result = check(data);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("没有任何版本"));
    }

    #[test]
    fn rejects_ready_without_sha256() {
        let mut data = minimal();
        data["versions"][0]["source"] = serde_json::json!({
            "url": "https://example.com/demo-1.0.0.zip"
        });
        let result = check(data);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("缺少 source.url"));
    }

    #[test]
    fn accepts_detect_only_without_versions() {
        let mut data = minimal();
        data["status"] = serde_json::json!("detect-only");
        data["versions"] = serde_json::json!([]);
        let result = check(data);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
    }

    #[test]
    fn rejects_depends_on_unknown_tool() {
        let mut data = minimal();
        data["versions"][0]["dependsOn"] = serde_json::json!(["ghost-tool"]);
        let result = check(data);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("依赖不存在的工具"));
    }

    #[test]
    fn accepts_depends_on_known_tool() {
        let mut other = minimal();
        other["id"] = serde_json::json!("dep-tool");
        let mut data = minimal();
        data["versions"][0]["dependsOn"] = serde_json::json!(["dep-tool"]);
        let result = validate_manifest_files(&[
            ManifestFileInput {
                file: "dep-tool.json".to_string(),
                data: other,
            },
            ManifestFileInput {
                file: "demo-tool.json".to_string(),
                data,
            },
        ]);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
        assert_eq!(result.tools.len(), 2);
    }
}
