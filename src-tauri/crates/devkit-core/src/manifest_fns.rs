//! 清单纯函数（对齐 src/shared/manifest.ts）。

use devkit_types::manifest::{MirrorSpec, ToolManifest, ToolVersionSpec};
use devkit_types::plan::MirrorPreference;

/// 取推荐版本；没有标 recommended 就退化为第一个版本；一个版本都没有则返回 None
pub fn pick_recommended_version(tool: &ToolManifest) -> Option<ToolVersionSpec> {
    tool.versions
        .iter()
        .find(|version| version.recommended == Some(true))
        .or_else(|| tool.versions.first())
        .cloned()
}

/// 按 id 建索引
pub fn index_by_id(tools: &[ToolManifest]) -> std::collections::HashMap<String, ToolManifest> {
    tools
        .iter()
        .map(|tool| (tool.id.clone(), tool.clone()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSourceRef {
    pub name: String,
    pub url: String,
}

/// 按镜像偏好排出下载源的尝试顺序：
/// 首选源排第一，其余按清单里的声明顺序跟在后面。
///
/// 实测各源速度相差极大（华为云 8.2 MB/s vs 官方源 191 KB/s），
/// 而且镜像会滞后（清华只到 v24.1.0），所以"首选"只是排序，失败仍会依次回退。
pub fn order_download_sources(
    version: &ToolVersionSpec,
    preference: &MirrorPreference,
) -> Vec<DownloadSourceRef> {
    let mut candidates: Vec<DownloadSourceRef> = Vec::new();

    if let Some(source) = &version.source {
        candidates.push(DownloadSourceRef {
            name: "official".to_string(),
            url: source.url.clone(),
        });
    }
    for mirror in version.mirrors.as_deref().unwrap_or(&[]) {
        let MirrorSpec { name, url } = mirror;
        candidates.push(DownloadSourceRef {
            name: name.clone(),
            url: url.clone(),
        });
    }

    let preference_name = match preference {
        MirrorPreference::Official => "official",
        MirrorPreference::Huaweicloud => "huaweicloud",
        MirrorPreference::Aliyun => "aliyun",
        MirrorPreference::Tuna => "tuna",
        MirrorPreference::Ustc => "ustc",
    };
    let index = candidates
        .iter()
        .position(|item| item.name == preference_name);
    match index {
        Some(index) if index > 0 => {
            let mut ordered = vec![candidates[index].clone()];
            ordered.extend(
                candidates
                    .into_iter()
                    .enumerate()
                    .filter_map(|(position, item)| (position != index).then_some(item)),
            );
            ordered
        }
        _ => candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::manifest::{Arch, InstallScope, SourceSpec, ToolVersionSpec};
    use devkit_types::plan::MirrorPreference;

    fn names(pairs: &[(&str, &str)]) -> devkit_types::locale::LocalizedText {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn tool(id: &str, versions: Vec<ToolVersionSpec>) -> ToolManifest {
        ToolManifest {
            id: id.to_string(),
            category: devkit_types::manifest::ToolCategory::Tool,
            tier: devkit_types::manifest::LicenseTier::L1,
            status: devkit_types::manifest::ManifestStatus::Ready,
            provider: None,
            name: names(&[("zh-CN", id), ("en-US", id)]),
            description: names(&[("zh-CN", id), ("en-US", id)]),
            homepage: None,
            license: None,
            detect: devkit_types::detection::DetectSpec {
                commands: None,
                files: None,
                registry: None,
            },
            versions,
            notes: None,
        }
    }

    fn version(value: &str, recommended: Option<bool>) -> ToolVersionSpec {
        ToolVersionSpec {
            version: value.to_string(),
            channel: devkit_types::manifest::VersionChannel::Stable,
            recommended,
            arch: Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: None,
            mirrors: None,
            install: None,
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        }
    }

    fn sample_version() -> ToolVersionSpec {
        let mut entry = version("24.21.0", None);
        entry.channel = devkit_types::manifest::VersionChannel::Lts;
        entry.source = Some(SourceSpec {
            url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip".to_string(),
            sha256: None,
        });
        entry.mirrors = Some(vec![
            MirrorSpec {
                name: "huaweicloud".to_string(),
                url: "https://mirrors.huaweicloud.com/nodejs/v24.21.0/x.zip".to_string(),
            },
            MirrorSpec {
                name: "aliyun".to_string(),
                url: "https://mirrors.aliyun.com/nodejs-release/v24.21.0/x.zip".to_string(),
            },
            MirrorSpec {
                name: "tuna".to_string(),
                url: "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v24.21.0/x.zip"
                    .to_string(),
            },
        ]);
        entry
    }

    #[test]
    fn official_first_keeps_manifest_order() {
        let ordered = order_download_sources(&sample_version(), &MirrorPreference::Official);
        let names: Vec<&str> = ordered.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["official", "huaweicloud", "aliyun", "tuna"]);
    }

    #[test]
    fn preferred_mirror_moves_to_front() {
        let ordered = order_download_sources(&sample_version(), &MirrorPreference::Aliyun);
        let names: Vec<&str> = ordered.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["aliyun", "official", "huaweicloud", "tuna"]);
    }

    #[test]
    fn unknown_preference_keeps_order_silently() {
        let ordered = order_download_sources(&sample_version(), &MirrorPreference::Ustc);
        let names: Vec<&str> = ordered.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["official", "huaweicloud", "aliyun", "tuna"]);
    }

    #[test]
    fn no_mirrors_leaves_only_official() {
        let mut entry = sample_version();
        entry.mirrors = Some(Vec::new());
        let ordered = order_download_sources(&entry, &MirrorPreference::Huaweicloud);
        assert_eq!(ordered.len(), 1);
        assert_eq!(ordered[0].name, "official");
    }

    #[test]
    fn no_sources_at_all_returns_empty() {
        let mut entry = sample_version();
        entry.source = None;
        entry.mirrors = Some(Vec::new());
        assert!(order_download_sources(&entry, &MirrorPreference::Official).is_empty());
    }

    #[test]
    fn picks_recommended_over_first() {
        let t = tool(
            "nodejs",
            vec![version("24.21.0", None), version("24.20.0", Some(true))],
        );
        assert_eq!(pick_recommended_version(&t).unwrap().version, "24.20.0");
    }

    #[test]
    fn falls_back_to_first_version() {
        let t = tool("nodejs", vec![version("24.21.0", None)]);
        assert_eq!(pick_recommended_version(&t).unwrap().version, "24.21.0");
    }

    #[test]
    fn no_versions_returns_none() {
        let t = tool("nodejs", Vec::new());
        assert!(pick_recommended_version(&t).is_none());
    }

    #[test]
    fn index_maps_by_id() {
        let a = tool("nodejs", Vec::new());
        let b = tool("git", Vec::new());
        let map = index_by_id(&[a.clone(), b.clone()]);
        assert_eq!(map.get("nodejs").unwrap().id, a.id);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("git").unwrap().id, "git");
        assert!(!map.contains_key("nope"));
    }
}
