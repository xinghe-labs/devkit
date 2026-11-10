//! 预设方案（FR-3，镜像 `src/main/core/presets/index.ts`）。
//!
//! 内置预设写死在代码里（不能删），用户预设落在 presets\<id>.json。
//! 预设本身只是"勾选结果"，不含任何命令 —— 所以导入别人的预设不会带来额外风险，
//! 真正的安全边界仍在清单模板那一层。

use crate::app_paths::get_preset_dir;
use crate::logging;
use devkit_types::locale::LocalizedText;
use devkit_types::plan::PlanSelection;
use devkit_types::Preset;
use std::fs;

fn preset(id: &str, zh: &str, en: &str, desc_zh: &str, desc_en: &str, tools: &[&str]) -> Preset {
    Preset {
        id: id.to_string(),
        name: [
            ("zh-CN".to_string(), zh.to_string()),
            ("en-US".to_string(), en.to_string()),
        ]
        .into_iter()
        .collect(),
        description: [
            ("zh-CN".to_string(), desc_zh.to_string()),
            ("en-US".to_string(), desc_en.to_string()),
        ]
        .into_iter()
        .collect(),
        builtin: true,
        tools: tools
            .iter()
            .map(|tool_id| PlanSelection {
                tool_id: (*tool_id).to_string(),
                version: None,
            })
            .collect(),
    }
}

/// 内置预设（与 TS BUILTIN_PRESETS 逐字对齐）
pub fn builtin_presets() -> Vec<Preset> {
    vec![
        preset(
            "base",
            "基础必备",
            "Essentials",
            "无论做什么开发都用得上的四件套：Git、7-Zip、Node.js、Python",
            "Four things every developer needs: Git, 7-Zip, Node.js, Python",
            &["git", "sevenzip", "nodejs", "python"],
        ),
        preset(
            "frontend",
            "前端开发",
            "Frontend",
            "Node.js + pnpm + Git + VS Code，开箱即用的前端工作台",
            "Node.js + pnpm + Git + VS Code — a ready-to-go frontend workbench",
            &["git", "nodejs", "pnpm", "vscode"],
        ),
        preset(
            "java",
            "Java 后端",
            "Java backend",
            "Eclipse Temurin JDK + Maven + Gradle + Git + VS Code（不用 Oracle JDK）",
            "Eclipse Temurin JDK + Maven + Gradle + Git + VS Code (no Oracle JDK)",
            &["git", "jdk-temurin", "maven", "gradle", "vscode"],
        ),
        preset(
            "python",
            "Python 开发",
            "Python",
            "Python + Git + VS Code，适合脚本、爬虫与数据方向",
            "Python + Git + VS Code for scripting, scraping and data work",
            &["git", "python", "vscode"],
        ),
        preset(
            "go",
            "Go 开发",
            "Go",
            "Go 工具链 + Git + VS Code",
            "The Go toolchain + Git + VS Code",
            &["git", "go", "vscode"],
        ),
        preset(
            "rust",
            "Rust 开发",
            "Rust",
            "rustup + Git + VS Code（工具链落在版本目录里，不污染全局）",
            "rustup + Git + VS Code, with the toolchain kept inside the version directory",
            &["git", "rust", "vscode"],
        ),
        preset(
            "cpp",
            "C/C++ 开发",
            "C/C++",
            "CMake + Ninja + Git + VS Code，配合 MSVC 或 MinGW 使用",
            "CMake + Ninja + Git + VS Code, to pair with MSVC or MinGW",
            &["git", "cmake", "ninja", "vscode"],
        ),
        preset(
            "ai",
            "AI 编码",
            "AI coding",
            "Claude Code（npm 发行）+ Codex CLI（独立二进制）+ Git + Node.js + VS Code",
            "Claude Code (npm) + Codex CLI (standalone binary) + Git + Node.js + VS Code",
            &["git", "nodejs", "vscode", "claude-code", "codex"],
        ),
        preset(
            "fullstack",
            "全栈 Web",
            "Full-stack web",
            "Node.js + pnpm + Python + SQLite + Git + VS Code",
            "Node.js + pnpm + Python + SQLite + Git + VS Code",
            &["git", "nodejs", "pnpm", "python", "sqlite", "vscode"],
        ),
    ]
}

/// 与 TS `PRESET_ID = /^[a-z0-9][a-z0-9-]{1,39}$/` 一致
fn preset_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() >= 2
        && bytes.len() <= 40
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 与 TS `^[a-z0-9][a-z0-9-]{0,39}$` 一致（toolId）
fn tool_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 与 TS `^[0-9A-Za-z.\-_+]{1,40}$` 一致（version）
fn version_valid(version: &str) -> bool {
    let bytes = version.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'))
}

pub fn list_builtin_presets() -> Vec<Preset> {
    builtin_presets()
}

/// 用户预设清洗：只接受白名单字段，形状不对的条目丢弃（而不是整体失败）
fn sanitize_user_preset(raw: &serde_json::Value, fallback_id: &str) -> Option<Preset> {
    let object = raw.as_object()?;

    let id = match object.get("id").and_then(|value| value.as_str()) {
        Some(id) if preset_id_valid(id) => id.to_string(),
        _ => fallback_id.to_string(),
    };

    let name: LocalizedText = match object.get("name") {
        Some(value) if value.is_object() => serde_json::from_value(value.clone()).ok()?,
        _ => return None,
    };
    let description: LocalizedText = object
        .get("description")
        .filter(|value| value.is_object())
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    let tools: Vec<PlanSelection> = object
        .get("tools")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    let tool_id = item.get("toolId").and_then(|value| value.as_str())?;
                    if !tool_id_valid(tool_id) {
                        return None;
                    }
                    let version = item.get("version").and_then(|value| value.as_str());
                    match version {
                        Some(version) if version_valid(version) => Some(PlanSelection {
                            tool_id: tool_id.to_string(),
                            version: Some(version.to_string()),
                        }),
                        _ => Some(PlanSelection {
                            tool_id: tool_id.to_string(),
                            version: None,
                        }),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Some(Preset {
        id,
        name,
        description,
        builtin: false,
        tools,
    })
}

pub fn list_user_presets() -> Vec<Preset> {
    let dir = get_preset_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut presets: Vec<Preset> = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        match fs::read_to_string(entry.path())
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|raw| sanitize_user_preset(&raw, name.trim_end_matches(".json")))
        {
            Some(preset) => presets.push(preset),
            None => logging::global().warn("preset", &format!("预设 {name} 解析失败，已跳过")),
        }
    }
    presets.sort_by(|a, b| a.id.cmp(&b.id));
    presets
}

pub fn list_presets() -> Vec<Preset> {
    let mut all = list_builtin_presets();
    all.extend(list_user_presets());
    all
}

/// 保存用户预设。返回 Err(原因) 对齐 TS 抛错。
pub fn save_user_preset(raw: &serde_json::Value) -> Result<Preset, String> {
    let Some(preset) = sanitize_user_preset(raw, "") else {
        return Err("预设格式不合法：需要一个 1~40 位的小写 id 和至少一个名称".to_string());
    };
    if preset.id.is_empty() {
        return Err("预设格式不合法：需要一个 1~40 位的小写 id 和至少一个名称".to_string());
    }
    if builtin_presets().iter().any(|item| item.id == preset.id) {
        return Err(format!("\"{}\" 是内置预设的 id，请换一个", preset.id));
    }

    let dir = get_preset_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("创建预设目录失败：{error}"))?;
    let path = dir.join(format!("{}.json", preset.id));
    let text = serde_json::to_string_pretty(&preset).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{text}\n")).map_err(|error| format!("写预设文件失败：{error}"))?;
    logging::global().info(
        "preset",
        &format!("已保存预设 {}（{} 项）", preset.id, preset.tools.len()),
    );
    Ok(preset)
}

pub fn delete_user_preset(id: &str) -> Result<bool, String> {
    if !preset_id_valid(id) {
        return Err(format!("预设 id 不合法：{id}"));
    }
    if builtin_presets().iter().any(|item| item.id == id) {
        return Err("内置预设不能删除".to_string());
    }

    let file = get_preset_dir().join(format!("{id}.json"));
    match fs::remove_file(&file) {
        Ok(()) => {
            logging::global().info("preset", &format!("已删除预设 {id}"));
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true), // rmSync force 语义
        Err(error) => {
            logging::global().warn("preset", &format!("删除预设 {id} 失败：{error}"));
            Ok(false)
        }
    }
}

/// 导入：接受一份预设 JSON（例如别人分享的文件内容）
pub fn import_preset(raw: &serde_json::Value) -> Result<Preset, String> {
    save_user_preset(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_presets_match_ts_list() {
        let presets = builtin_presets();
        assert_eq!(presets.len(), 9);
        let ids: Vec<&str> = presets.iter().map(|preset| preset.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "base",
                "frontend",
                "java",
                "python",
                "go",
                "rust",
                "cpp",
                "ai",
                "fullstack"
            ]
        );
        // 每个内置预设 builtin=true、至少一个工具、双语名称
        assert!(presets
            .iter()
            .all(|preset| preset.builtin && !preset.tools.is_empty()));
        assert!(presets
            .iter()
            .all(|preset| preset.name.contains_key("zh-CN") && preset.name.contains_key("en-US")));
        // base 四件套
        let base = presets.iter().find(|preset| preset.id == "base").unwrap();
        let tool_ids: Vec<&str> = base
            .tools
            .iter()
            .map(|tool| tool.tool_id.as_str())
            .collect();
        assert_eq!(tool_ids, vec!["git", "sevenzip", "nodejs", "python"]);
    }

    #[test]
    fn sanitize_rejects_bad_shapes_and_keeps_good_ones() {
        // 名称缺失 → None
        assert!(sanitize_user_preset(&serde_json::json!({"id": "x", "tools": []}), "fb").is_none());

        // 非法 toolId 被过滤，非法 version 退化为无版本
        let raw = serde_json::json!({
            "id": "my-preset",
            "name": {"zh-CN": "我的"},
            "tools": [
                {"toolId": "git", "version": "2.43.0"},
                {"toolId": "BAD_ID"},
                {"toolId": "nodejs", "version": "../evil"}
            ]
        });
        let preset = sanitize_user_preset(&raw, "fb").unwrap();
        assert_eq!(preset.id, "my-preset");
        assert!(!preset.builtin);
        assert_eq!(preset.tools.len(), 2, "BAD_ID 被过滤");
        assert_eq!(preset.tools[0].version.as_deref(), Some("2.43.0"));
        assert_eq!(preset.tools[1].version, None, "路径逃逸版本退化为无版本");
    }

    #[test]
    fn save_and_delete_user_preset_roundtrip() {
        let guard = crate::app_paths::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("devkit-preset-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("DEVKIT_APP_DATA", &dir);

        // 内置 id 拒绝
        let raw = serde_json::json!({
            "id": "base",
            "name": {"zh-CN": "x"},
            "tools": []
        });
        assert!(save_user_preset(&raw).is_err());

        // 保存
        let raw = serde_json::json!({
            "id": "my-setup",
            "name": {"zh-CN": "我的", "en-US": "Mine"},
            "tools": [{"toolId": "git"}]
        });
        let saved = save_user_preset(&raw).unwrap();
        assert_eq!(saved.id, "my-setup");
        let listed = list_user_presets();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], saved);
        // list_presets = 内置 + 用户
        assert_eq!(list_presets().len(), 10);

        // 非内置可删
        assert!(delete_user_preset("my-setup").unwrap());
        assert!(list_user_presets().is_empty());

        // 内置不可删
        assert!(delete_user_preset("base").is_err());
        // 不存在的 id 删除也返回 true（rmSync force 语义）
        assert!(delete_user_preset("no-such").unwrap());

        drop(guard);
        std::env::remove_var("DEVKIT_APP_DATA");
    }

    #[test]
    fn preset_id_validation_matches_ts() {
        assert!(preset_id_valid("my-preset"));
        assert!(preset_id_valid("a1"));
        assert!(!preset_id_valid("x")); // 太短（TS 要求 {1,39} 尾段）
        assert!(!preset_id_valid("Bad"));
        assert!(!preset_id_valid("-lead"));
        assert!(!tool_id_valid("BAD"));
        assert!(tool_id_valid("a")); // toolId 允许单字符
        assert!(!version_valid("../evil"));
        assert!(version_valid("2.43.0"));
    }
}
