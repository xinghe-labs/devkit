//! 清单加载（镜像 `src/main/core/manifest/index.ts`）。
//!
//! 与 TS 侧的差异（有意为之，附录 E 已记录）：
//! - TS 需要 tool.schema.json + Ajv；Rust 的结构校验由 serde 承担，不读 schema 文件。
//!   打包完整性改由契约测试保证（schema 与清单同目录存在）。
//! - 目录解析（开发期 / 打包后）由 app 层传入，本 crate 保持纯函数、不依赖 Tauri。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use devkit_types::iso8601_now;
use devkit_types::manifest::{
    ManifestLoadResult, ManifestSource, ToolCategory, ToolManifest, TOOL_CATEGORY_ORDER,
};

use crate::validate::{validate_manifest_files, ManifestFileInput};

/// 模块级缓存（镜像 index.ts 的 `cache` 变量）。
static MANIFEST_CACHE: OnceLock<Mutex<Option<ManifestLoadResult>>> = OnceLock::new();

fn cache_cell() -> &'static Mutex<Option<ManifestLoadResult>> {
    MANIFEST_CACHE.get_or_init(|| Mutex::new(None))
}

/// 清空缓存（热更新写入后调用，镜像 `clearManifestCache`）。
pub fn clear_manifest_cache() {
    if let Ok(mut guard) = cache_cell().lock() {
        *guard = None;
    }
}

fn read_dir_json_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    let reader = std::fs::read_dir(dir)
        .map_err(|error| format!("找不到清单目录：{}（{error}）", dir.display()))?;
    for entry in reader {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") {
            entries.push((name, entry.path()));
        }
    }
    // TS 的 readdirSync 在 NTFS 上基本按名称序返回；这里显式排序保证确定性
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn read_manifest_inputs(
    dir: &Path,
    subdir: &str,
) -> (
    Vec<ManifestFileInput>,
    Vec<devkit_types::manifest::ManifestLoadError>,
) {
    let full = dir.join(subdir);
    let mut inputs = Vec::new();
    let mut errors = Vec::new();
    match read_dir_json_files(&full) {
        Ok(files) => {
            for (name, path) in files {
                match std::fs::read_to_string(&path) {
                    Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                        Ok(data) => inputs.push(ManifestFileInput { file: name, data }),
                        Err(error) => errors.push(devkit_types::manifest::ManifestLoadError {
                            file: name,
                            message: error.to_string(),
                        }),
                    },
                    Err(error) => errors.push(devkit_types::manifest::ManifestLoadError {
                        file: name,
                        message: error.to_string(),
                    }),
                }
            }
        }
        Err(message) => errors.push(devkit_types::manifest::ManifestLoadError {
            file: full.display().to_string(),
            message,
        }),
    }
    (inputs, errors)
}

/// 加载并校验内置清单（镜像 `loadManifests`）。
///
/// `builtin_dir`：内置清单根目录（含 `tools/` 子目录）。
/// `user_dir`：用户数据目录（热更新覆盖放 `<user>/manifest/tools/`，FR-15）；
/// 传 None 表示不读用户覆盖（单测场景）。
///
/// 校验失败的清单会被跳过并记录错误，不会导致整个应用起不来 ——
/// 一个清单写错不应该让用户完全用不了工具。
pub fn load_manifests(
    builtin_dir: &Path,
    user_dir: Option<&Path>,
    force: bool,
) -> ManifestLoadResult {
    if !force {
        if let Ok(guard) = cache_cell().lock() {
            if let Some(cached) = guard.as_ref() {
                return cached.clone();
            }
        }
    }

    let result = build_manifest_load_result(builtin_dir, user_dir);

    if let Ok(mut guard) = cache_cell().lock() {
        *guard = Some(result.clone());
    }
    result
}

fn build_manifest_load_result(builtin_dir: &Path, user_dir: Option<&Path>) -> ManifestLoadResult {
    let mut errors: Vec<devkit_types::manifest::ManifestLoadError> = Vec::new();

    let (builtin_inputs, read_errors) = read_manifest_inputs(builtin_dir, "tools");
    errors.extend(read_errors);

    let builtin = validate_manifest_files(&builtin_inputs);
    errors.extend(builtin.errors.clone());

    // 热更新覆盖（FR-15）：用户目录里同名 id 的清单优先于内置清单，
    // 但用同一套校验，坏了就整条丢弃、继续用内置的那份。
    let mut override_by_id: std::collections::HashMap<String, ToolManifest> =
        std::collections::HashMap::new();
    if let Some(user) = user_dir {
        let (override_inputs, override_read_errors) = read_manifest_inputs(user, "manifest/tools");
        errors.extend(override_read_errors);
        let checked = validate_manifest_files(&override_inputs);
        errors.extend(checked.errors.clone());
        for tool in checked.tools {
            override_by_id.insert(tool.id.clone(), tool);
        }
    }

    let mut tools: Vec<ToolManifest> = builtin
        .tools
        .iter()
        .map(|tool| {
            override_by_id
                .get(&tool.id)
                .cloned()
                .unwrap_or_else(|| tool.clone())
        })
        .collect();
    let used_overrides: Vec<String> = builtin
        .tools
        .iter()
        .filter(|tool| override_by_id.contains_key(&tool.id))
        .map(|tool| tool.id.clone())
        .collect();

    // 分类排序（CATEGORY_ORDER），同类按 id 字典序
    tools.sort_by(|a, b| {
        let category_diff = a.category.order().cmp(&b.category.order());
        if category_diff != std::cmp::Ordering::Equal {
            return category_diff;
        }
        a.id.cmp(&b.id)
    });

    ManifestLoadResult {
        tools,
        errors,
        source: if used_overrides.is_empty() {
            ManifestSource::Builtin
        } else {
            ManifestSource::Remote
        },
        dir: builtin_dir.display().to_string(),
        loaded_at: iso8601_now(),
    }
}

/// 分类排序（公开给 app 层复用，例如按分类过滤时保持一致顺序）。
pub fn category_order(category: ToolCategory) -> usize {
    TOOL_CATEGORY_ORDER
        .iter()
        .position(|item| *item == category)
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_json(dir: &Path, subdir: &str, name: &str, value: serde_json::Value) {
        let target = dir.join(subdir);
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join(name),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    fn demo_tool(id: &str, category: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "category": category,
            "tier": "L1",
            "status": "detect-only",
            "name": { "zh-CN": "工具" },
            "description": { "zh-CN": "描述" },
            "detect": { "commands": [ { "cmd": id } ] },
            "versions": []
        })
    }

    #[test]
    fn loads_builtin_directory_sorted_by_category_then_id() {
        let root =
            std::env::temp_dir().join(format!("devkit-manifest-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_json(&root, "tools", "zlib.json", demo_tool("zlib", "build"));
        write_json(&root, "tools", "node.json", demo_tool("node", "runtime"));
        write_json(&root, "tools", "jdk.json", demo_tool("jdk", "runtime"));
        // 一个坏清单：被跳过但不阻塞其余
        write_json(
            &root,
            "tools",
            "broken.json",
            serde_json::json!({ "id": "broken" }),
        );

        let result = load_manifests(&root, None, true);
        let ids: Vec<&str> = result.tools.iter().map(|tool| tool.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["jdk", "node", "zlib"],
            "runtime 在 build 前，同类按 id 序"
        );
        assert_eq!(
            result.errors.len(),
            1,
            "坏清单报一条错误：{:?}",
            result.errors
        );
        assert_eq!(result.source, ManifestSource::Builtin);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_override_wins_over_builtin() {
        let root = std::env::temp_dir().join(format!("devkit-manifest-ovr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_json(&root, "tools", "node.json", demo_tool("node", "runtime"));

        let mut overridden = demo_tool("node", "runtime");
        overridden["name"] = serde_json::json!({ "zh-CN": "热更新版" });
        write_json(&root, "manifest/tools", "node.json", overridden);
        // 用户目录里的坏清单：丢弃，不影响内置
        write_json(
            &root,
            "manifest/tools",
            "bad.json",
            serde_json::json!({ "nonsense": true }),
        );

        let result = load_manifests(&root, Some(&root), true);
        assert_eq!(result.tools.len(), 1);
        assert_eq!(
            result.tools[0].name.get("zh-CN").map(String::as_str),
            Some("热更新版")
        );
        assert_eq!(result.source, ManifestSource::Remote);
        assert!(!result.errors.is_empty(), "用户坏清单要报错");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_tools_dir_reports_error_but_returns_empty() {
        let root =
            std::env::temp_dir().join(format!("devkit-manifest-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let result = load_manifests(&root, None, true);
        assert!(result.tools.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("找不到清单目录"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_hit_until_force() {
        let root =
            std::env::temp_dir().join(format!("devkit-manifest-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_json(&root, "tools", "node.json", demo_tool("node", "runtime"));

        let _first = load_manifests(&root, None, true);
        write_json(&root, "tools", "jdk.json", demo_tool("jdk", "runtime"));
        let cached = load_manifests(&root, None, false);
        assert_eq!(cached.tools.len(), 1, "走缓存");
        let refreshed = load_manifests(&root, None, true);
        assert_eq!(refreshed.tools.len(), 2, "force 重新扫描");
        clear_manifest_cache();
        let _ = fs::remove_dir_all(&root);
    }
}
