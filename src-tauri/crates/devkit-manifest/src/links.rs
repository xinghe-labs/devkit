//! 清单纯函数（镜像 `src/shared/manifest.ts`）。

use devkit_types::manifest::{MirrorSpec, ToolManifest, ToolVersionSpec};
use devkit_types::MirrorPreference;
use std::collections::HashMap;

/// 取推荐版本；没有标 recommended 就退化为第一个版本；一个版本都没有则返回 null。
pub fn pick_recommended_version(tool: &ToolManifest) -> Option<&ToolVersionSpec> {
    tool.versions
        .iter()
        .find(|version| version.recommended.unwrap_or(false))
        .or_else(|| tool.versions.first())
}

/// 按 id 建索引（UI 里频繁按 id 找工具，避免每次线性查找）。
pub fn index_by_id(tools: &[ToolManifest]) -> HashMap<&str, &ToolManifest> {
    tools.iter().map(|tool| (tool.id.as_str(), tool)).collect()
}

/// 下载源引用
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadSourceRef {
    pub name: String,
    pub url: String,
}

/// 一个版本的全部下载源候选（首选源 + 镜像，声明顺序）。
pub fn download_source_candidates(version: &ToolVersionSpec) -> Vec<DownloadSourceRef> {
    let mut candidates = Vec::new();
    if let Some(source) = &version.source {
        candidates.push(DownloadSourceRef {
            name: "official".to_string(),
            url: source.url.clone(),
        });
    }
    for mirror in version.mirrors.iter().flatten() {
        candidates.push(DownloadSourceRef {
            name: mirror.name.clone(),
            url: mirror.url.clone(),
        });
    }
    candidates
}

/// 按镜像偏好排出下载源的尝试顺序：
/// 首选源排第一，其余按清单里的声明顺序跟在后面。
///
/// 实测各源速度相差极大（华为云 8.2 MB/s vs 官方源 191 KB/s），
/// 而且镜像会滞后（清华只到 v24.1.0），所以"首选"只是排序，失败仍会依次回退。
pub fn order_download_sources(
    version: &ToolVersionSpec,
    preference: MirrorPreference,
) -> Vec<DownloadSourceRef> {
    let candidates = download_source_candidates(version);
    let preferred_name = match preference {
        MirrorPreference::Official => "official",
        MirrorPreference::Huaweicloud => "huaweicloud",
        MirrorPreference::Aliyun => "aliyun",
        MirrorPreference::Tuna => "tuna",
        MirrorPreference::Ustc => "ustc",
    };
    let index = candidates
        .iter()
        .position(|item| item.name == preferred_name);
    match index {
        None | Some(0) => candidates,
        Some(position) => {
            let mut ordered = vec![candidates[position].clone()];
            for (i, candidate) in candidates.iter().enumerate() {
                if i != position {
                    ordered.push(candidate.clone());
                }
            }
            ordered
        }
    }
}

/// 镜像声明里的名称常量（镜像名与 MirrorPreference 字面量的映射在清单里自由命名，
/// 这里只提供官方源固定名）。
pub const OFFICIAL_SOURCE_NAME: &str = "official";

/// 从镜像声明里按偏好找 url（找不到返回 None，由调用方回退官方源）。
pub fn mirror_url_by_name<'a>(version: &'a ToolVersionSpec, name: &str) -> Option<&'a MirrorSpec> {
    version
        .mirrors
        .iter()
        .flatten()
        .find(|mirror| mirror.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_with_versions(versions: serde_json::Value) -> ToolManifest {
        let base = serde_json::json!({
            "id": "demo-tool",
            "category": "runtime",
            "tier": "L1",
            "status": "detect-only",
            "name": { "zh-CN": "工具" },
            "description": { "zh-CN": "描述" },
            "detect": { "commands": [ { "cmd": "demo" } ] },
        });
        let mut value = base;
        value["versions"] = versions;
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn picks_recommended_or_first() {
        let tool = tool_with_versions(serde_json::json!([
            { "version": "1.0.0", "channel": "stable", "arch": "x64", "installScope": "user" },
            { "version": "2.0.0", "channel": "lts", "recommended": true, "arch": "x64", "installScope": "user" }
        ]));
        assert_eq!(pick_recommended_version(&tool).unwrap().version, "2.0.0");

        let tool = tool_with_versions(serde_json::json!([
            { "version": "1.0.0", "channel": "stable", "arch": "x64", "installScope": "user" }
        ]));
        assert_eq!(pick_recommended_version(&tool).unwrap().version, "1.0.0");

        let tool = tool_with_versions(serde_json::json!([]));
        assert!(pick_recommended_version(&tool).is_none());
    }

    #[test]
    fn orders_sources_with_preference_first() {
        let tool = tool_with_versions(serde_json::json!([
            {
                "version": "1.0.0", "channel": "stable", "arch": "x64", "installScope": "user",
                "source": { "url": "https://official.example.com/a.zip" },
                "mirrors": [
                    { "name": "huaweicloud", "url": "https://huawei.example.com/a.zip" },
                    { "name": "tuna", "url": "https://tuna.example.com/a.zip" }
                ]
            }
        ]));
        let version = &tool.versions[0];

        let ordered = order_download_sources(version, MirrorPreference::Official);
        assert_eq!(ordered[0].name, "official");
        assert_eq!(ordered.len(), 3);

        let ordered = order_download_sources(version, MirrorPreference::Huaweicloud);
        assert_eq!(
            ordered.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["huaweicloud", "official", "tuna"],
            "首选提前，其余保持声明顺序"
        );

        let ordered = order_download_sources(version, MirrorPreference::Ustc);
        assert_eq!(
            ordered.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["official", "huaweicloud", "tuna"],
            "偏好源不存在时保持原序"
        );
    }

    #[test]
    fn index_by_id_lookups() {
        let tool_a = tool_with_versions(serde_json::json!([]));
        let tool_b = tool_with_versions(serde_json::json!([]));
        let tools = [tool_a, tool_b];
        let index = index_by_id(&tools);
        assert!(index.contains_key("demo-tool"));
    }
}
