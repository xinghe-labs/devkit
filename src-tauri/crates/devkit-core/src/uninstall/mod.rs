//! 已安装项列表与卸载（FR-16，镜像 `src/main/core/uninstall/index.ts`）。
//!
//! 一条硬性边界：**只卸载 devkit 自己装的东西**。
//! 判断依据是「版本目录在 versions\<tool>\<version>\ 下」，
//! 而不是"PATH 上有这个命令"——后者会诱导用户把系统里原有的 Node/Java 一起删掉。
//!
//! 卸载语义是「只卸载不回滚」：删掉版本目录、取消激活、移除 PATH 与环境变量。

use crate::activate::index::{
    deactivate_tool, get_activated_version, get_link_path, remove_junction, UserEnvIo,
};
use crate::direct::remove_install_dir;
use crate::logging;
use devkit_types::activation::{InstalledTool, UninstallResult};
use devkit_types::manifest::ToolManifest;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub mod registry;

pub use registry::{
    find_uninstall_entry, plan_uninstall, split_windows_command, uninstall_by_registry,
    RegistryUninstallTarget,
};

/// 版本目录名：数字或字母开头都接受（rust 的版本标签来自 rustup 自己的版本号）
pub fn is_version_dir(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || name.len() > 40 {
        return false;
    }
    let first = bytes[0];
    let valid_first = first.is_ascii_digit() || first.is_ascii_alphabetic();
    valid_first && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// 列出一个工具目录下的版本目录；不是目录或读不到就返回 None
fn list_version_dirs(tool_dir: &Path) -> Option<Vec<String>> {
    let meta = fs::metadata(tool_dir).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let mut names: Vec<String> = fs::read_dir(tool_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| is_version_dir(name))
        .collect();
    names.sort();
    Some(names)
}

fn birth_time_iso(dir: &Path) -> Option<String> {
    let meta = fs::metadata(dir).ok()?;
    let created = meta.created().ok()?;
    let unix = created
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(devkit_types::timeutil::iso8601_from_unix(
        unix.as_secs() as i64,
        unix.subsec_millis(),
    ))
}

pub fn list_installed(
    tools: &[ToolManifest],
    versions_root: &Path,
    activated_versions: &HashMap<String, String>,
) -> Vec<InstalledTool> {
    let Ok(entries) = fs::read_dir(versions_root) else {
        return Vec::new();
    };

    let mut result: Vec<InstalledTool> = Vec::new();
    let by_id: HashMap<&str, &ToolManifest> =
        tools.iter().map(|tool| (tool.id.as_str(), tool)).collect();

    for entry in entries.filter_map(|entry| entry.ok()) {
        let tool_id = entry.file_name().to_string_lossy().to_string();
        let tool_dir = versions_root.join(&tool_id);
        let Some(versions) = list_version_dirs(&tool_dir) else {
            continue;
        };

        let tool = by_id.get(tool_id.as_str()).copied();
        let activated = activated_versions.get(&tool_id);

        for version in versions {
            let install_dir = tool_dir.join(&version);
            let spec = tool
                .and_then(|tool| tool.versions.iter().find(|item| item.version == version));
            let meta_created = birth_time_iso(&install_dir);
            result.push(InstalledTool {
                tool_id: tool_id.clone(),
                version: version.clone(),
                install_dir: install_dir.to_string_lossy().to_string(),
                size_bytes: 0,
                installed_at: meta_created,
                active: activated.map(|v| v == &version).unwrap_or(false),
                activatable: spec.map(|spec| spec.activate.is_some()).unwrap_or(false),
            });
        }
    }

    result.sort_by(|a, b| a.tool_id.cmp(&b.tool_id).then(a.version.cmp(&b.version)));
    result
}

/// 带体积统计的版本（体积统计要遍历目录，比较慢，单独提供）
pub async fn list_installed_with_size(
    tools: &[ToolManifest],
    versions_root: &Path,
    activated_versions: &HashMap<String, String>,
) -> Vec<InstalledTool> {
    let mut items = list_installed(tools, versions_root, activated_versions);
    for item in &mut items {
        item.size_bytes =
            crate::direct::directory_size(Path::new(&item.install_dir)).await;
    }
    items
}

/// 卸载一个已安装版本。
///
/// `tool` 传了就检查 `versions[].uninstall.type`：`registry` 表示这东西会在注册表
/// 留卸载记录（机器级 MSI 都是），必须先走它自己的卸载程序，否则
/// 「应用和功能」里会留一条幽灵条目。
pub async fn uninstall_version(
    io: &dyn UserEnvIo,
    elevated: &dyn crate::elevation::ElevatedRunner,
    tool_id: &str,
    version: &str,
    versions_root: &Path,
    tool: Option<&ToolManifest>,
) -> UninstallResult {
    let mut removed: Vec<String> = Vec::new();

    let id_ok = {
        let bytes = tool_id.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 40
            && bytes[0].is_ascii_lowercase()
            && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    };
    if !id_ok {
        return UninstallResult { ok: false, removed, error: Some(format!("工具 id 不合法：{tool_id}")) };
    }
    if !is_version_dir(version) {
        return UninstallResult { ok: false, removed, error: Some(format!("版本号不合法：{version}")) };
    }

    let install_dir = versions_root.join(tool_id).join(version);
    if !install_dir.exists() {
        return UninstallResult {
            ok: false,
            removed,
            error: Some(format!("没有找到已安装的 {tool_id}@{version}")),
        };
    }

    // 先看清单有没有声明要走注册表卸载（机器级 MSI）。
    // 必须在删目录**之前**做 —— 卸载程序可能依赖目录里还在的东西。
    let spec = tool.and_then(|tool| tool.versions.iter().find(|item| item.version == version));
    if let Some(spec) = spec {
        if spec.uninstall.as_ref().is_some_and(|u| u.uninstall_type == devkit_types::manifest::UninstallType::Registry) {
            if let Some(tool) = tool {
                let by_registry = registry::uninstall_by_registry(tool, elevated);
                if let Some(detail) = by_registry.detail {
                    removed.push(detail);
                }
                if !by_registry.ok {
                    // 注册表卸载失败就**停在这里**：删掉目录只会让情况更糟
                    // （卸载程序找不到文件，用户既装不上也卸不掉）
                    logging::global().warn(
                        "uninstall",
                        &format!("注册表卸载失败，已中止：{}", by_registry.error.as_deref().unwrap_or("")),
                    );
                    return UninstallResult {
                        ok: false,
                        removed,
                        error: by_registry.error.or_else(|| Some("注册表卸载失败".to_string())),
                    };
                }
            }
        }
    }

    // 如果卸载的正是当前激活的版本，先取消激活（否则 PATH 会指向不存在的目录）
    if get_activated_version(tool_id).as_deref() == Some(version) {
        match deactivate_tool(io, tool_id) {
            Ok(mut deactivated) => {
                removed.append(&mut deactivated);
            }
            Err(error) => {
                logging::global().warn("uninstall", &format!("取消激活失败（继续删除文件）：{error}"));
            }
        }
    }

    if let Err(error) = remove_install_dir(&install_dir, versions_root).await {
        logging::global().error("uninstall", &format!("卸载 {tool_id}@{version} 失败：{error:?}"));
        return UninstallResult { ok: false, removed, error: Some(format!("{error:?}")) };
    }
    removed.push(format!("安装目录 {}", install_dir.display()));

    // 版本目录空了就把工具目录一起收掉，避免留下空壳
    if let Ok(mut entries) = fs::read_dir(versions_root.join(tool_id)) {
        if entries.next().is_none()
            && fs::remove_dir(versions_root.join(tool_id)).is_ok() {
                removed.push(format!("空目录 {}", versions_root.join(tool_id).display()));
            }
            // 收尾失败不影响卸载结论
    }

    logging::global().info("uninstall", &format!("已卸载 {tool_id}@{version}：{}", removed.join("；")));
    UninstallResult { ok: true, removed, error: None }
}

/// 清掉指向不存在目录的 junction（诊断/修复用）
pub fn prune_dangling_links(tool_ids: &[String], versions_root: &Path) -> Vec<String> {
    let mut pruned: Vec<String> = Vec::new();
    for tool_id in tool_ids {
        let Some(activated) = get_activated_version(tool_id) else {
            continue;
        };
        let target = versions_root.join(tool_id).join(&activated);
        if !target.exists() && remove_junction(&get_link_path(tool_id)).unwrap_or(false) {
            pruned.push(tool_id.clone());
        }
    }
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devkit-uninstall-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn version_dir_rules() {
        assert!(is_version_dir("20.11.1"));
        assert!(is_version_dir("v1_2_3"));
        assert!(is_version_dir("1.82.0-x86_64"));
        assert!(!is_version_dir(""));
        assert!(!is_version_dir(".hidden"));
        assert!(!is_version_dir("-leading"));
        // 超长拒绝
        let long = "a".repeat(41);
        assert!(!is_version_dir(&long));
    }

    #[test]
    fn list_installed_scans_and_sorts() {
        let root = temp_root("list");
        fs::create_dir_all(root.join("nodejs").join("20.11.1")).unwrap();
        fs::create_dir_all(root.join("nodejs").join("18.0.0")).unwrap();
        fs::create_dir_all(root.join("git").join("2.43.0")).unwrap();
        // 非版本目录被忽略
        fs::create_dir_all(root.join("git").join("_cache")).unwrap();
        // 非目录的 toolId 被忽略
        fs::write(root.join("notes.txt"), "x").unwrap();

        let mut activated = HashMap::new();
        activated.insert("nodejs".to_string(), "20.11.1".to_string());

        let items = list_installed(&[], &root, &activated);
        assert_eq!(items.len(), 3);
        // 排序：工具名 → 版本名
        assert_eq!(items[0].tool_id, "git");
        assert_eq!(items[0].version, "2.43.0");
        assert_eq!(items[1].tool_id, "nodejs");
        assert_eq!(items[1].version, "18.0.0");
        assert_eq!(items[2].version, "20.11.1");
        assert!(items[2].active);
        assert!(!items[1].active);
        // 版本目录存在但 _cache 不出现在结果里
        assert!(items.iter().all(|item| item.version != "_cache"));
    }

    #[test]
    fn list_installed_missing_root_returns_empty() {
        let items = list_installed(&[], Path::new(r"D:\definitely-not-exists-xyz"), &HashMap::new());
        assert!(items.is_empty());
    }

    #[test]
    fn uninstall_rejects_bad_ids() {
        let root = temp_root("badids");
        let io = FakeUserIo;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let elevated = crate::elevation::NoElevation;

        let result = rt.block_on(uninstall_version(&io, &elevated, "Bad_ID", "1.0", &root, None));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("工具 id 不合法"));

        let result = rt.block_on(uninstall_version(&io, &elevated, "nodejs", ".bad", &root, None));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("版本号不合法"));

        let result = rt.block_on(uninstall_version(&io, &elevated, "nodejs", "1.0", &root, None));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("没有找到已安装的"));
    }

    #[test]
    fn uninstall_removes_dir_and_empty_tool_dir() {
        let root = temp_root("remove");
        let install_dir = root.join("nodejs").join("20.11.1");
        fs::create_dir_all(&install_dir).unwrap();
        fs::write(install_dir.join("node.exe"), "fake").unwrap();

        let io = FakeUserIo;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let elevated = crate::elevation::NoElevation;

        let result = rt.block_on(uninstall_version(&io, &elevated, "nodejs", "20.11.1", &root, None));
        assert!(result.ok, "error: {:?}", result.error);
        assert!(result.removed.iter().any(|item| item.contains("安装目录")));
        // 工具目录空了 → 一并收掉
        assert!(!root.join("nodejs").exists());
        assert!(result.removed.iter().any(|item| item.contains("空目录")));
    }

    /// 不碰真实环境的空 UserEnvIo（测试里没有激活记录，取消激活分支不会走到）
    struct FakeUserIo;
    impl crate::activate::index::UserEnvIo for FakeUserIo {
        fn read_env(&self, _name: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn write_env(&self, _name: &str, _value: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn read_path(&self) -> Result<String, String> {
            Ok(String::new())
        }
        fn write_path(&self, _value: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn prune_dangling_links_no_activation() {
        let root = temp_root("prune");
        // 无激活 → 不动
        assert!(prune_dangling_links(&["git".to_string()], &root).is_empty());
    }
}
