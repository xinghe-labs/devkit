//! 清单热更新（FR-15，镜像 `src/main/core/hotupdate/whitelist.ts` + `index.ts`）。
//!
//! 只做三件事：拉索引 → 按白名单合并 → 用同一套 Schema 校验后落到用户目录。
//! 校验不过的一律不落盘 —— 宁可继续用旧清单，也不要把一份来路不明、
//! 结构不对的清单写进去（下次启动会加载它）。

use crate::app_paths::get_user_manifest_dir;
use crate::http::{request_stream, HttpError, HttpRequestOptions};
use crate::logging;
use devkit_manifest::{validate_manifest_files, ManifestFileInput};
use devkit_types::manifest::{InstallScope, ToolManifest, ToolVersionSpec, VersionChannel};
use devkit_types::update::{HotUpdateResultView, RejectedHotUpdateEntry, UpdatedToolEntry};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 远程版本条目里允许出现的键
pub const HOT_UPDATE_ALLOWED_KEYS: &[&str] = &[
    "version",
    "channel",
    "recommended",
    "arch",
    "releaseDate",
    "sizeBytes",
    "installScope",
    "source",
    "mirrors",
];

/// 远程 source 里允许出现的键
const ALLOWED_SOURCE_KEYS: &[&str] = &["url", "sha256"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HotUpdateIndex {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "generatedAt"
    )]
    pub generated_at: Option<String>,
    pub tools: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    pub manifest: ToolManifest,
    pub accepted: usize,
    pub rejected: Vec<String>,
}

fn is_plain_object(value: &serde_json::Value) -> bool {
    value.is_object()
}

fn is_valid_version_string(version: &str) -> bool {
    // 必须以字母或数字开头：'..' 会让 join(versionsRoot, id, version) 逃逸到 versions
    // 根目录，从而覆盖其它已装工具的二进制（安全审查 H1）
    let bytes = version.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'))
}

/// 取本地清单里"安装信息最完整"的版本，用来给远程新增版本继承 install/activate/verify
fn template_source(local: &ToolManifest) -> Option<&ToolVersionSpec> {
    local
        .versions
        .iter()
        .find(|version| version.recommended == Some(true) && version.install.is_some())
        .or_else(|| {
            local
                .versions
                .iter()
                .find(|version| version.install.is_some())
        })
        .or_else(|| local.versions.first())
}

fn pick_whitelisted(
    raw: &serde_json::Value,
    base: Option<&ToolVersionSpec>,
    tool_id: &str,
    rejected: &mut Vec<String>,
) -> Option<ToolVersionSpec> {
    let object = raw.as_object()?;

    for key in object.keys() {
        if !HOT_UPDATE_ALLOWED_KEYS.contains(&key.as_str()) {
            rejected.push(format!(
                "{tool_id}: 远程条目里的 \"{key}\" 不在白名单内，已忽略"
            ));
        }
    }

    let version = raw
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if !is_valid_version_string(version) {
        rejected.push(format!("{tool_id}: 远程条目缺少合法版本号，已跳过"));
        return None;
    }

    let source = raw
        .get("source")
        .filter(|value| is_plain_object(value))
        .cloned()
        .unwrap_or_default();
    let url = source
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let sha256 = source
        .get("sha256")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    if !url.starts_with("https://") {
        rejected.push(format!("{tool_id}@{version}: 下载地址不是 https，已跳过"));
        return None;
    }
    let sha_ok = sha256.len() == 64 && sha256.chars().all(|c| c.is_ascii_hexdigit());
    if !sha_ok {
        rejected.push(format!(
            "{tool_id}@{version}: 缺少合法的 SHA-256，已跳过（没有校验和的版本不允许下发）"
        ));
        return None;
    }
    if let Some(source_object) = source.as_object() {
        for key in source_object.keys() {
            if !ALLOWED_SOURCE_KEYS.contains(&key.as_str()) {
                rejected.push(format!(
                    "{tool_id}@{version}: source 里的 \"{key}\" 不在白名单内，已忽略"
                ));
            }
        }
    }

    let channel = match raw.get("channel").and_then(|value| value.as_str()) {
        Some("lts") => VersionChannel::Lts,
        Some("stable") => VersionChannel::Stable,
        Some("beta") => VersionChannel::Beta,
        _ => base
            .map(|base| base.channel)
            .unwrap_or(VersionChannel::Stable),
    };

    let install_scope = match raw.get("installScope").and_then(|value| value.as_str()) {
        Some("machine") => InstallScope::Machine,
        Some("user") => InstallScope::User,
        _ => {
            rejected.push(format!(
                "{tool_id}@{version}: installScope 必须是 user 或 machine，已跳过"
            ));
            return None;
        }
    };

    let mirrors: Option<Vec<devkit_types::manifest::MirrorSpec>> = raw
        .get("mirrors")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(|value| value.as_str())?;
                    let url = item.get("url").and_then(|value| value.as_str())?;
                    if name.is_empty() || !url.starts_with("https://") {
                        return None;
                    }
                    Some(devkit_types::manifest::MirrorSpec {
                        name: name.to_string(),
                        url: url.to_string(),
                    })
                })
                .collect()
        });

    let size_bytes = raw
        .get("sizeBytes")
        .and_then(|value| value.as_f64())
        .and_then(|value| {
            if value.is_finite() && value >= 0.0 {
                Some(value.trunc() as u64)
            } else {
                None
            }
        });

    let release_date = raw
        .get("releaseDate")
        .and_then(|value| value.as_str())
        .filter(|value| {
            value.len() == 10
                && value.as_bytes()[4] == b'-'
                && value.as_bytes()[7] == b'-'
                && value.chars().all(|c| c.is_ascii_digit() || c == '-')
        })
        .map(|value| value.to_string());

    // 远程只允许这一批字段，其余从 base 继承 —— 用 JSON 组装后走严格反序列化，
    // deny_unknown_fields 保证我们没漏掉不该远程控制的字段
    let mut spec = serde_json::json!({
        "version": version,
        "channel": channel,
        "arch": "x64",
        "installScope": install_scope,
        "source": { "url": url, "sha256": sha256.to_lowercase() },
    });
    if raw.get("recommended") == Some(&serde_json::Value::Bool(true)) {
        spec["recommended"] = serde_json::Value::Bool(true);
    }
    if let Some(release_date) = release_date {
        spec["releaseDate"] = serde_json::Value::String(release_date);
    }
    if let Some(size_bytes) = size_bytes {
        spec["sizeBytes"] = serde_json::Value::Number(size_bytes.into());
    }
    if let Some(mirrors) = mirrors {
        if !mirrors.is_empty() {
            spec["mirrors"] = serde_json::to_value(&mirrors).unwrap_or(serde_json::Value::Null);
        }
    }
    // 以下几样永远来自本地清单，远程无权修改
    if let Some(base) = base {
        if let Some(install) = &base.install {
            spec["install"] = serde_json::to_value(install).unwrap_or(serde_json::Value::Null);
        }
        if let Some(activate) = &base.activate {
            spec["activate"] = serde_json::to_value(activate).unwrap_or(serde_json::Value::Null);
        }
        if let Some(verify) = &base.verify {
            spec["verify"] = serde_json::to_value(verify).unwrap_or(serde_json::Value::Null);
        }
        if let Some(uninstall) = &base.uninstall {
            spec["uninstall"] = serde_json::to_value(uninstall).unwrap_or(serde_json::Value::Null);
        }
        if let Some(depends_on) = &base.depends_on {
            spec["dependsOn"] = serde_json::to_value(depends_on).unwrap_or(serde_json::Value::Null);
        }
        if base.requires_reboot == Some(true) {
            spec["requiresReboot"] = serde_json::Value::Bool(true);
        }
    }

    serde_json::from_value(spec).ok()
}

/// 把远程条目合并进本地清单。
///
/// 刻意不做的两件事：
///  1. 不合并远程的 detect —— 检测规则被改掉后，用户可以装上一个"检测永远显示已安装"的假工具
///  2. 不合并远程的 install/activate —— 那就是任意命令执行
pub fn merge_hot_update(local: &ToolManifest, remote: &serde_json::Value) -> MergeOutcome {
    let mut rejected: Vec<String> = Vec::new();

    if !is_plain_object(remote) {
        return MergeOutcome {
            manifest: local.clone(),
            accepted: 0,
            rejected: vec![format!("{}: 远程条目不是对象", local.id)],
        };
    }
    if remote.get("id").and_then(|value| value.as_str()) != Some(local.id.as_str()) {
        return MergeOutcome {
            manifest: local.clone(),
            accepted: 0,
            rejected: vec![format!("{}: 远程条目的 id 不匹配", local.id)],
        };
    }
    let Some(remote_versions) = remote.get("versions").and_then(|value| value.as_array()) else {
        return MergeOutcome {
            manifest: local.clone(),
            accepted: 0,
            rejected: vec![format!("{}: 远程条目缺少 versions 数组", local.id)],
        };
    };

    let base = template_source(local);
    if base.map(|base| base.install.is_none()).unwrap_or(true) {
        // 本地还没有任何带安装模板的版本 → 没有可继承的安装方式，拒绝整条
        return MergeOutcome {
            manifest: local.clone(),
            accepted: 0,
            rejected: vec![format!(
                "{}: 本地清单没有可继承的安装模板，拒绝热更新",
                local.id
            )],
        };
    }

    let mut versions: Vec<ToolVersionSpec> = Vec::new();
    let mut accepted: usize = 0;

    for raw in remote_versions {
        if !is_plain_object(raw) {
            rejected.push(format!("{}: versions 里出现了非对象条目，已跳过", local.id));
            continue;
        }
        if let Some(picked) = pick_whitelisted(raw, base, &local.id, &mut rejected) {
            versions.push(picked);
            accepted += 1;
        }
    }

    if versions.is_empty() {
        rejected.push(format!("{}: 没有可用的远程版本", local.id));
        return MergeOutcome {
            manifest: local.clone(),
            accepted: 0,
            rejected,
        };
    }

    // 一个工具最多只能有一个 recommended：远程没标就沿用本地的推荐版本号
    let recommended_count = versions
        .iter()
        .filter(|version| version.recommended == Some(true))
        .count();
    if recommended_count > 1 {
        rejected.push(format!(
            "{}: 远程给了 {recommended_count} 个 recommended 版本，已只保留第一个",
            local.id
        ));
        let mut seen = false;
        for version in &mut versions {
            if version.recommended == Some(true) {
                if seen {
                    version.recommended = None;
                }
                seen = true;
            }
        }
    } else if recommended_count == 0 {
        let local_recommended = local
            .versions
            .iter()
            .find(|version| version.recommended == Some(true))
            .map(|version| version.version.clone());
        let matched = versions
            .iter_mut()
            .find(|version| Some(&version.version) == local_recommended.as_ref());
        match matched {
            Some(version) => version.recommended = Some(true),
            None => versions[0].recommended = Some(true),
        }
    }

    MergeOutcome {
        manifest: ToolManifest {
            versions,
            ..local.clone()
        },
        accepted,
        rejected,
    }
}

/* ------------------------------------------------------------------ */
/* 拉取与落盘                                                          */
/* ------------------------------------------------------------------ */

const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;

async fn fetch_index(url: &str, proxy: Option<String>) -> Result<HotUpdateIndex, String> {
    if !url.starts_with("https://") {
        return Err("清单更新地址必须是 https".to_string());
    }

    let response = request_stream(
        url,
        &HttpRequestOptions {
            headers: Vec::new(),
            method: crate::http::HttpMethod::Get,
            proxy,
            timeout_ms: Some(20_000),
            cancel: None,
            max_redirects: Some(4),
            allow_insecure: false,
        },
    )
    .await
    .map_err(|HttpError { message, .. }| message)?;

    if response.status != 200 {
        return Err(format!("拉取清单索引失败：HTTP {}", response.status));
    }

    use futures::StreamExt;
    let mut stream = response.stream;
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取清单索引失败：{error}"))?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > MAX_INDEX_BYTES {
            return Err(format!(
                "清单索引超过 {} MB，已拒绝",
                MAX_INDEX_BYTES / 1024 / 1024
            ));
        }
    }

    let parsed: HotUpdateIndex = serde_json::from_slice(&buffer)
        .map_err(|error| format!("清单索引不是合法 JSON：{error}"))?;
    if parsed.schema_version != 1 {
        return Err("清单索引格式不匹配（需要 schemaVersion: 1 与 tools 数组）".to_string());
    }
    Ok(parsed)
}

pub struct HotUpdateParams<'a> {
    pub url: &'a str,
    pub tools: &'a [ToolManifest],
    pub proxy: Option<String>,
}

pub async fn run_hot_update(params: &HotUpdateParams<'_>) -> HotUpdateResultView {
    let mut rejected: Vec<RejectedHotUpdateEntry> = Vec::new();
    let mut updated: Vec<UpdatedToolEntry> = Vec::new();

    let index = match fetch_index(params.url, params.proxy.clone()).await {
        Ok(index) => index,
        Err(message) => {
            logging::global().warn("hotupdate", &message);
            return HotUpdateResultView {
                ok: false,
                fetched: 0,
                applied: 0,
                rejected,
                updated,
                error: Some(message),
            };
        }
    };

    let user_tools_dir = get_user_manifest_dir().join("tools");
    if let Err(error) = fs::create_dir_all(&user_tools_dir) {
        return HotUpdateResultView {
            ok: false,
            fetched: index.tools.len() as u32,
            applied: 0,
            rejected,
            updated,
            error: Some(format!("创建用户清单目录失败：{error}")),
        };
    }

    let mut applied: u32 = 0;

    for remote in &index.tools {
        let Some(remote_id) = remote.get("id").and_then(|value| value.as_str()) else {
            rejected.push(RejectedHotUpdateEntry {
                id: remote
                    .get("id")
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".to_string()),
                reason: "远程条目缺少 id".to_string(),
            });
            continue;
        };

        let Some(local) = params.tools.iter().find(|tool| tool.id == remote_id) else {
            rejected.push(RejectedHotUpdateEntry {
                id: remote_id.to_string(),
                reason: "本地清单里没有这个工具，拒绝下发新工具".to_string(),
            });
            continue;
        };

        let merged = merge_hot_update(local, remote);
        for reason in &merged.rejected {
            rejected.push(RejectedHotUpdateEntry {
                id: remote_id.to_string(),
                reason: reason.clone(),
            });
        }
        if merged.accepted == 0 {
            continue;
        }

        // 用与内置清单完全相同的校验再拦一道
        let files = vec![ManifestFileInput {
            file: format!("{remote_id}.json"),
            data: serde_json::to_value(&merged.manifest).unwrap_or_default(),
        }];
        let checked = validate_manifest_files(&files);
        if !checked.errors.is_empty() {
            rejected.push(RejectedHotUpdateEntry {
                id: remote_id.to_string(),
                reason: format!(
                    "合并后的清单未通过校验：{}",
                    checked
                        .errors
                        .iter()
                        .map(|item| item.message.clone())
                        .collect::<Vec<_>>()
                        .join("；")
                ),
            });
            continue;
        }

        let target = user_tools_dir.join(format!("{remote_id}.json"));
        match serde_json::to_string_pretty(&merged.manifest) {
            Ok(text) => {
                if let Err(error) = fs::write(&target, format!("{text}\n")) {
                    rejected.push(RejectedHotUpdateEntry {
                        id: remote_id.to_string(),
                        reason: format!("写用户清单失败：{error}"),
                    });
                    continue;
                }
            }
            Err(error) => {
                rejected.push(RejectedHotUpdateEntry {
                    id: remote_id.to_string(),
                    reason: format!("序列化合并清单失败：{error}"),
                });
                continue;
            }
        }
        applied += 1;
        updated.push(UpdatedToolEntry {
            id: remote_id.to_string(),
            versions: merged
                .manifest
                .versions
                .iter()
                .map(|version| version.version.clone())
                .collect(),
        });
        logging::global().info(
            "hotupdate",
            &format!("{} 清单已更新：{} 个版本", remote_id, merged.accepted),
        );
    }

    logging::global().info(
        "hotupdate",
        &format!(
            "热更新完成：远程 {} 个，应用 {applied} 个，拒绝 {} 个",
            index.tools.len(),
            rejected.len()
        ),
    );
    HotUpdateResultView {
        ok: true,
        fetched: index.tools.len() as u32,
        applied,
        rejected,
        updated,
        error: None,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserManifestFile {
    pub file: String,
    pub data: serde_json::Value,
}

/// 读用户目录里的清单覆盖文件（load_manifests 会调用）
pub fn read_user_manifest_files() -> (Vec<UserManifestFile>, Vec<devkit_types::ManifestLoadError>) {
    let dir = get_user_manifest_dir().join("tools");
    let mut files: Vec<UserManifestFile> = Vec::new();
    let mut errors: Vec<devkit_types::ManifestLoadError> = Vec::new();

    let Ok(entries) = fs::read_dir(&dir) else {
        // 目录不存在 = 没做过热更新，正常
        return (files, errors);
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        match fs::read_to_string(entry.path()) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(data) => files.push(UserManifestFile { file: name, data }),
                Err(error) => errors.push(devkit_types::ManifestLoadError {
                    file: format!("(用户清单) {name}"),
                    message: error.to_string(),
                }),
            },
            Err(error) => errors.push(devkit_types::ManifestLoadError {
                file: format!("(用户清单) {name}"),
                message: error.to_string(),
            }),
        }
    }

    (files, errors)
}

/// 清空用户清单覆盖，回到内置清单
pub fn clear_user_manifests() -> usize {
    let dir = get_user_manifest_dir().join("tools");
    let mut removed: usize = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(|entry| entry.ok()) {
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    logging::global().info("hotupdate", &format!("已清空 {removed} 个用户清单覆盖文件"));
    removed
}

pub fn user_tools_dir() -> PathBuf {
    get_user_manifest_dir().join("tools")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_manifest() -> ToolManifest {
        serde_json::from_str(
            r#"{
                "id": "nodejs",
                "category": "runtime",
                "tier": "L1",
                "status": "ready",
                "provider": "direct",
                "name": {"zh-CN": "Node.js"},
                "description": {"zh-CN": "JavaScript 运行时"},
                "detect": {"commands": [{"cmd": "node", "versionArgs": ["--version"]}]},
                "versions": [{
                    "version": "20.11.1",
                    "channel": "lts",
                    "recommended": true,
                    "arch": "x64",
                    "installScope": "user",
                    "source": {"url": "https://nodejs.org/dist/node.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
                    "install": {"type": "zip", "template": "zip-default", "params": {"strip": "1"}}, "verify": {"cmd": "node", "versionArgs": ["--version"]},
                    "activate": {"pathEntries": ["{installDir}"]}
                }]
            }"#,
        )
        .unwrap()
    }

    fn remote_entry(payload: &str) -> serde_json::Value {
        serde_json::from_str(payload).unwrap()
    }

    #[test]
    fn whitelist_rejects_dangerous_fields() {
        let local = local_manifest();
        // 远程试图带 install（任意命令执行）+ 非法版本号（路径逃逸）
        let remote = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [
                    {"version": "20.11.2", "installScope": "user",
                     "source": {"url": "https://evil.com/x.zip", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                     "install": {"type": "custom", "template": {"cmd": "evil.exe", "args": []}}},
                    {"version": "../escape", "installScope": "user",
                     "source": {"url": "https://x.com/y.zip", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
                    {"version": "20.11.3", "installScope": "user",
                     "source": {"url": "http://not-https/x.zip", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}},
                    {"version": "20.11.4", "installScope": "user",
                     "source": {"url": "https://x.com/z.zip", "sha256": "nothex"}}
                ]
            }"#,
        );
        let outcome = merge_hot_update(&local, &remote);
        // 对齐 TS：未知键只记拒绝原因，条目本身仍走白名单合并（install 被本地继承替换）
        assert_eq!(outcome.accepted, 1, "只有第一条（合法 https+sha256）被接受");
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("\"install\" 不在白名单内")));
        assert!(
            outcome
                .rejected
                .iter()
                .any(|reason| reason.contains("缺少合法版本号")),
            "路径逃逸版本号必须拦下"
        );
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("不是 https")));
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("缺少合法的 SHA-256")));
        // 被接受的合并结果里也不该有远程 install —— 这条用例里 accepted=0，专门再验证一次字段来源：
        let ok_remote = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [{"version": "20.11.2", "installScope": "user",
                     "source": {"url": "https://nodejs.org/dist/v20.11.2/node.zip", "sha256": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},
                     "install": {"type": "custom", "template": {"cmd": "evil.exe", "args": []}}}]
            }"#,
        );
        let outcome = merge_hot_update(&local, &ok_remote);
        assert_eq!(outcome.accepted, 1);
        assert_eq!(outcome.manifest.versions.len(), 1);
        let merged_version = &outcome.manifest.versions[0];
        // install 来自本地模板，不是远程的 evil.exe
        let install_json = serde_json::to_value(merged_version.install.as_ref().unwrap()).unwrap();
        assert_eq!(
            install_json["type"], "zip",
            "install 必须继承本地，远程无权改"
        );
        // activate / verify 同样来自本地
        assert!(merged_version.activate.is_some());
        // source 的小写化
        let source = merged_version.source.as_ref().unwrap();
        assert_eq!(
            source.sha256.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
    }

    #[test]
    fn whitelist_rejects_unknown_keys_and_mismatched_id() {
        let local = local_manifest();

        // id 不匹配
        let wrong_id = remote_entry(r#"{"id": "git", "versions": []}"#);
        let outcome = merge_hot_update(&local, &wrong_id);
        assert_eq!(outcome.accepted, 0);
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("id 不匹配")));

        // 非 https + 未知键
        let unknown_keys = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [{"version": "20.11.2", "installScope": "user",
                     "detect": {"commands": []},
                     "source": {"url": "https://x.com/y.zip", "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "evil": 1}}]
            }"#,
        );
        let outcome = merge_hot_update(&local, &unknown_keys);
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("\"detect\" 不在白名单内")));
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("source 里的 \"evil\" 不在白名单内")));
    }

    #[test]
    fn recommended_dedup_and_default() {
        let local = local_manifest();

        // 远程给了两个 recommended → 只保留第一个
        let two_recommended = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [
                    {"version": "20.11.2", "recommended": true, "installScope": "user",
                     "source": {"url": "https://x.com/a.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
                    {"version": "20.11.3", "recommended": true, "installScope": "user",
                     "source": {"url": "https://x.com/b.zip", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
                ]
            }"#,
        );
        let outcome = merge_hot_update(&local, &two_recommended);
        assert_eq!(outcome.accepted, 2);
        let recommended: Vec<_> = outcome
            .manifest
            .versions
            .iter()
            .filter(|version| version.recommended == Some(true))
            .collect();
        assert_eq!(recommended.len(), 1, "只保留一个 recommended");
        assert_eq!(recommended[0].version, "20.11.2");

        // 远程一个都没标 → 沿用本地的推荐版本号（20.11.1 不在远程列表 → 落到第一个）
        let none_recommended = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [
                    {"version": "20.11.2", "installScope": "user",
                     "source": {"url": "https://x.com/a.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
                ]
            }"#,
        );
        let outcome = merge_hot_update(&local, &none_recommended);
        assert!(outcome.manifest.versions[0].recommended == Some(true));
    }

    #[test]
    fn mirrors_and_inheritance() {
        let local = local_manifest();
        let with_mirrors = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [{"version": "20.11.2", "installScope": "machine",
                     "channel": "beta",
                     "releaseDate": "2026-01-15",
                     "sizeBytes": 123456.7,
                     "mirrors": [{"name": "npmmirror", "url": "https://npmmirror.com/a.zip"}, {"name": "", "url": "https://bad"}],
                     "source": {"url": "https://x.com/a.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
            }"#,
        );
        let outcome = merge_hot_update(&local, &with_mirrors);
        assert_eq!(outcome.accepted, 1);
        let version = &outcome.manifest.versions[0];
        assert!(matches!(version.channel, VersionChannel::Beta));
        assert!(matches!(version.install_scope, InstallScope::Machine));
        assert_eq!(version.release_date.as_deref(), Some("2026-01-15"));
        assert_eq!(version.size_bytes, Some(123456));
        assert_eq!(
            version.mirrors.as_ref().unwrap().len(),
            1,
            "非法 mirror 被过滤"
        );
        // 继承本地 uninstall（本地没有 → None）
        assert!(version.uninstall.is_none());
        // 远程没写 recommended → 沿用本地推荐规则落到第一个（对齐 TS recommendedCount==0 分支）
        assert_eq!(version.recommended, Some(true));
    }

    #[test]
    fn no_installable_base_rejects_everything() {
        let mut local = local_manifest();
        local.versions[0].install = None;
        let remote = remote_entry(
            r#"{
                "id": "nodejs",
                "versions": [{"version": "20.11.2", "installScope": "user",
                     "source": {"url": "https://x.com/a.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
            }"#,
        );
        let outcome = merge_hot_update(&local, &remote);
        assert_eq!(outcome.accepted, 0);
        assert!(outcome
            .rejected
            .iter()
            .any(|reason| reason.contains("没有可继承的安装模板")));
    }

    #[test]
    fn user_manifest_files_roundtrip_and_clear() {
        let guard = crate::app_paths::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("devkit-hotupdate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("DEVKIT_APP_DATA", &dir);

        // 空
        let (files, errors) = read_user_manifest_files();
        assert!(files.is_empty() && errors.is_empty());

        // 写一个覆盖文件
        let tools_dir = user_tools_dir();
        fs::create_dir_all(&tools_dir).unwrap();
        fs::write(tools_dir.join("nodejs.json"), r#"{"id":"nodejs"}"#).unwrap();
        fs::write(tools_dir.join("broken.json"), "{ bad").unwrap();

        let (files, errors) = read_user_manifest_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file, "nodejs.json");
        assert_eq!(errors.len(), 1);
        assert!(errors[0].file.contains("broken.json"));

        // 清空
        let removed = clear_user_manifests();
        assert_eq!(removed, 2);
        let (files, _) = read_user_manifest_files();
        assert!(files.is_empty());

        drop(guard);
        std::env::remove_var("DEVKIT_APP_DATA");
    }
}
