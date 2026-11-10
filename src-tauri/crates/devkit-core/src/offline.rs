//! 离线包制作与导入（FR-12，镜像 `src/main/core/offline/index.ts`）。
//!
//! 关键设计：离线包里的文件**就按在线下载时的文件名**存放
//! （`<toolId>-<version>-<原文件名>`），导入时直接放进下载缓存目录。
//! "离线安装"完全复用在线流程 —— 下载器发现目标文件已存在且 SHA-256 匹配
//! 就会跳过下载，不需要为离线模式维护第二条安装路径。

use crate::checksum::sha256_file;
use crate::downloader::{download_file, DownloadRequest, DownloadSource};
use crate::logging;
use crate::manifest_fns::order_download_sources;
use devkit_types::download_name::{download_file_name, DownloadNameInput};
use devkit_types::manifest::{LicenseTier, ToolManifest};
use devkit_types::plan::MirrorPreference;
use devkit_types::update::{OfflinePackResult, SkippedOfflineItem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 离线包内的归档目录名
pub const OFFLINE_ARCHIVE_DIR: &str = "archives";
pub const OFFLINE_INDEX_FILE: &str = "offline.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineEntry {
    pub tool_id: String,
    pub version: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfflineIndex {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "devkitVersion")]
    pub devkit_version: String,
    pub entries: Vec<OfflineEntry>,
}

/// 离线包里的文件名必须是"纯文件名"。
///
/// path.join 会把 `..` 归一化掉，所以不校验就等于让一个手工构造的离线包
/// 读写下载目录之外的文件（安全审查 M3）。这里只接受单层文件名。
pub fn assert_safe_file_name(name: &str, context: &str) -> Result<String, String> {
    let valid = {
        let bytes = name.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 121
            && bytes[0].is_ascii_alphanumeric()
            && !name.contains("..")
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    };
    if !valid {
        return Err(format!(
            "{context} 里的文件名不合法：{:.80}",
            format!("{name:?}")
        ));
    }
    Ok(name.to_string())
}

/// 按许可证分级把工具分成「可进离线包」与「不可进离线包」。
///
/// SPEC §8：只有 L1（许可证明确允许再分发）才能进离线包。
/// L2/L3 打进离线包 = 把别人的发行物再分发出去，这是许可证问题，不是技术问题。
pub fn partition_by_redistributable(
    tools: &[ToolManifest],
) -> (Vec<ToolManifest>, Vec<SkippedOfflineItem>) {
    let mut packable: Vec<ToolManifest> = Vec::new();
    let mut skipped: Vec<SkippedOfflineItem> = Vec::new();

    for tool in tools {
        match tool.tier {
            LicenseTier::L1 => packable.push(tool.clone()),
            LicenseTier::L2 => skipped.push(SkippedOfflineItem {
                id: tool.id.clone(),
                tier: tool.tier,
                reason: "L2：可自动下载安装，但发行物不得再分发（不进离线包）".to_string(),
            }),
            LicenseTier::L3 => skipped.push(SkippedOfflineItem {
                id: tool.id.clone(),
                tier: tool.tier,
                reason: "L3：仅引导官网，不自动安装".to_string(),
            }),
        }
    }

    (packable, skipped)
}

/// 离线包里的归档文件名。
///
/// **必须与执行器找的那个名字一致**，所以这里不自己拼，直接调
/// `download_file_name` 的唯一实现。
pub fn archive_file_name(
    tool_id: &str,
    version: &str,
    url: &str,
    install_type: Option<&str>,
) -> Result<String, String> {
    download_file_name(&DownloadNameInput {
        tool_id,
        version,
        url,
        install_type,
    })
}

pub struct PackOfflineOptions<'a> {
    pub tool_ids: &'a [String],
    pub tools: &'a HashMap<String, ToolManifest>,
    pub pack_dir: &'a Path,
    pub download_dir: &'a Path,
    pub devkit_version: &'a str,
    pub mirror_preference: &'a MirrorPreference,
    pub proxy: Option<String>,
}

pub struct PackProgress {
    pub done: usize,
    pub total: usize,
    pub label: String,
}

/// 制作离线包：逐个下载推荐版本 → 拷进 archives/ → 写 offline.json 索引。
pub async fn pack_offline(
    options: &PackOfflineOptions<'_>,
    mut on_progress: impl FnMut(PackProgress),
) -> OfflinePackResult {
    let archives_dir = options.pack_dir.join(OFFLINE_ARCHIVE_DIR);

    let result = async {
        fs::create_dir_all(&archives_dir).map_err(|error| format!("创建离线包目录失败：{error}"))?;

        let all_selected: Vec<&ToolManifest> = options
            .tool_ids
            .iter()
            .filter_map(|id| options.tools.get(id))
            .collect();
        let selected_refs: Vec<ToolManifest> =
            all_selected.into_iter().cloned().collect();
        let (selected, skipped) = partition_by_redistributable(&selected_refs);
        for item in &skipped {
            logging::global().warn("offline", &format!("{} 是 {:?}，已从离线包中排除", item.id, item.tier));
        }

        let mut entries: Vec<OfflineEntry> = Vec::new();
        let mut total_bytes: u64 = 0;
        let mut done: usize = 0;

        for tool in &selected {
            let Some(version) = tool
                .versions
                .iter()
                .find(|item| item.recommended == Some(true))
                .or_else(|| tool.versions.first())
            else {
                logging::global().warn("offline", &format!("{} 没有可下载的版本，已跳过", tool.id));
                continue;
            };
            let Some(source) = &version.source else {
                logging::global().warn("offline", &format!("{} 没有可下载的版本，已跳过", tool.id));
                continue;
            };
            let Some(expected_sha) = &source.sha256 else {
                logging::global().warn("offline", &format!("{} 没有可下载的版本，已跳过", tool.id));
                continue;
            };

            let install_type_tag: Option<String> = version
                .install
                .as_ref()
                .map(|install| {
                    serde_json::to_value(install.install_type)
                        .ok()
                        .and_then(|value| value.as_str().map(|tag| tag.to_string()))
                        .unwrap_or_default()
                });
            let file_name = archive_file_name(
                &tool.id,
                &version.version,
                &source.url,
                install_type_tag.as_deref(),
            )?;
            let target: PathBuf = options.download_dir.join(&file_name);

            let sources: Vec<DownloadSource> = order_download_sources(version, options.mirror_preference)
                .into_iter()
                .map(|reference| DownloadSource { name: reference.name, url: reference.url })
                .collect();

            let download = download_file(&DownloadRequest {
                sources,
                sha256: expected_sha.clone(),
                size_bytes: version.size_bytes,
                target_file: target,
                proxy: options.proxy.clone(),
                timeout_ms: None,
                idle_timeout_ms: None,
                min_speed_bytes_per_sec: None,
                speed_grace_ms: None,
                retries_per_source: None,
                allow_insecure: false,
                cancel: None,
                on_progress: None,
                on_phase: None,
            })
            .await;

            if !download.ok {
                return Err(format!(
                    "{} 下载失败：{}",
                    tool.id,
                    download.error.unwrap_or_default()
                ));
            }

            let copy_target = archives_dir.join(&file_name);
            if !copy_target.exists() {
                let downloaded = download
                    .file_path
                    .clone()
                    .unwrap_or_else(|| options.download_dir.join(&file_name));
                fs::copy(&downloaded, &copy_target).map_err(|error| format!("拷贝离线文件失败：{error}"))?;
            }

            let size = fs::metadata(&copy_target).map_err(|error| error.to_string())?.len();
            total_bytes += size;
            done += 1;
            on_progress(PackProgress { done, total: selected.len(), label: tool.id.clone() });

            entries.push(OfflineEntry {
                tool_id: tool.id.clone(),
                version: version.version.clone(),
                file_name,
                sha256: expected_sha.clone(),
                size_bytes: size,
                url: source.url.clone(),
            });
        }

        let index = OfflineIndex {
            schema_version: 1,
            created_at: devkit_types::timeutil::iso8601_now(),
            devkit_version: options.devkit_version.to_string(),
            entries: entries.clone(),
        };
        write_json(options.pack_dir.join(OFFLINE_INDEX_FILE), &index)?;

        write_json(
            options.pack_dir.join("README.json"),
            &serde_json::json!({
                "zh-CN": "这是 devkit 生成的离线安装包。把整个文件夹拷到目标机器，在 devkit 里选择「从离线包安装」并指向本目录即可。",
                "en-US": "This is an offline pack generated by devkit. Copy the whole folder to the target machine and use \"Install from offline pack\" in devkit."
            }),
        )?;

        let skipped = partition_by_redistributable(&selected_refs).1;
        logging::global().info(
            "offline",
            &format!(
                "离线包已生成：{}（{} 个文件 / {} 字节{}）",
                options.pack_dir.display(),
                entries.len(),
                total_bytes,
                if skipped.is_empty() {
                    String::new()
                } else {
                    format!("；因许可证分级排除 {} 项", skipped.len())
                }
            ),
        );
        Ok(OfflinePackResult {
            ok: true,
            pack_dir: Some(options.pack_dir.display().to_string()),
            file_count: entries.len() as u32,
            total_bytes,
            skipped,
            error: None,
        })
    }
    .await;

    match result {
        Ok(pack) => pack,
        Err(error) => {
            logging::global().error("offline", &format!("生成离线包失败：{error}"));
            OfflinePackResult {
                ok: false,
                pack_dir: None,
                file_count: 0,
                total_bytes: 0,
                skipped: Vec::new(),
                error: Some(error),
            }
        }
    }
}

fn write_json(path: PathBuf, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{text}\n")).map_err(|error| format!("写文件失败：{error}"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub ok: bool,
    pub imported: usize,
    pub missing: Vec<String>,
    pub entries: Vec<OfflineEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 把离线包里的归档放进下载缓存，并逐个校验 SHA-256。
/// 校验失败的文件会被跳过（而不是写进去让后续安装以"校验失败"的名义报错）。
pub async fn import_offline_pack(pack_dir: &Path, download_dir: &Path) -> ImportResult {
    let index_file = pack_dir.join(OFFLINE_INDEX_FILE);
    if !index_file.exists() {
        return ImportResult {
            ok: false,
            imported: 0,
            missing: Vec::new(),
            entries: Vec::new(),
            error: Some(format!("找不到 {}", index_file.display())),
        };
    }

    let Some(index) = read_json::<OfflineIndex>(&index_file) else {
        return ImportResult {
            ok: false,
            imported: 0,
            missing: Vec::new(),
            entries: Vec::new(),
            error: Some("离线包索引格式不匹配".to_string()),
        };
    };
    if index.schema_version != 1 {
        return ImportResult {
            ok: false,
            imported: 0,
            missing: Vec::new(),
            entries: Vec::new(),
            error: Some("离线包索引格式不匹配".to_string()),
        };
    }

    if let Err(error) = fs::create_dir_all(download_dir) {
        return ImportResult {
            ok: false,
            imported: 0,
            missing: Vec::new(),
            entries: index.entries,
            error: Some(error.to_string()),
        };
    }

    let archives_dir = pack_dir.join(OFFLINE_ARCHIVE_DIR);
    let mut missing: Vec<String> = Vec::new();
    let mut imported: usize = 0;

    for entry in &index.entries {
        let file_name = match assert_safe_file_name(&entry.file_name, "离线包索引") {
            Ok(name) => name,
            Err(error) => {
                return ImportResult {
                    ok: false,
                    imported,
                    missing,
                    entries: index.entries,
                    error: Some(error),
                }
            }
        };
        let source = archives_dir.join(&file_name);
        if !source.exists() {
            missing.push(entry.file_name.clone());
            continue;
        }

        let actual = match sha256_file(&source) {
            Ok(hash) => hash,
            Err(error) => {
                logging::global().warn(
                    "offline",
                    &format!("离线包内 {file_name} 哈希计算失败：{error}"),
                );
                missing.push(file_name);
                continue;
            }
        };
        if !actual.eq_ignore_ascii_case(&entry.sha256) {
            logging::global().warn("offline", &format!("离线包内 {file_name} 校验失败，已跳过"));
            missing.push(file_name);
            continue;
        }

        let target = download_dir.join(&file_name);
        match fs::copy(&source, &target) {
            Ok(_) => imported += 1,
            Err(error) => {
                return ImportResult {
                    ok: false,
                    imported,
                    missing,
                    entries: index.entries,
                    error: Some(format!("拷贝到下载缓存失败：{error}")),
                }
            }
        }
    }

    logging::global().info(
        "offline",
        &format!(
            "离线包导入完成：{}/{} 个文件进入下载缓存",
            imported,
            index.entries.len()
        ),
    );
    ImportResult {
        ok: true,
        imported,
        missing,
        entries: index.entries,
        error: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePackSummary {
    pub name: String,
    pub entries: u32,
}

/// 列出磁盘上现有的离线包（设置页展示用）
pub fn list_offline_packs(dir: &Path) -> Vec<OfflinePackSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut packs: Vec<OfflinePackSummary> = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let index_file = dir.join(&name).join(OFFLINE_INDEX_FILE);
        if !index_file.exists() {
            continue;
        }
        if let Some(index) = read_json::<OfflineIndex>(&index_file) {
            packs.push(OfflinePackSummary {
                name,
                entries: index.entries.len() as u32,
            });
        }
        // 索引坏了就不列出来
    }
    packs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_name_rejects_traversal_and_weird_names() {
        assert!(assert_safe_file_name("node-v20.11.1-win-x64.zip", "索引").is_ok());
        assert!(assert_safe_file_name("vscode-1.141.0-stable.exe", "索引").is_ok());
        assert!(assert_safe_file_name("../evil.zip", "索引").is_err());
        assert!(assert_safe_file_name(r"sub\dir.zip", "索引").is_err());
        assert!(assert_safe_file_name("", "索引").is_err());
        assert!(assert_safe_file_name(".hidden", "索引").is_err());
        assert!(assert_safe_file_name("-leading", "索引").is_err());
    }

    #[test]
    fn partition_by_redistributable_splits_by_tier() {
        let manifest = |id: &str, tier: &str| -> ToolManifest {
            serde_json::from_str(&format!(
                r#"{{"id":"{id}","category":"runtime","tier":"{tier}","status":"ready","provider":"direct","name":{{"zh-CN":"x"}},"description":{{"zh-CN":"x"}},"detect":{{}},"versions":[]}}"#
            ))
            .unwrap()
        };
        let l1 = manifest("a", "L1");
        let l2 = manifest("b", "L2");
        let l3 = manifest("c", "L3");

        let (packable, skipped) = partition_by_redistributable(&[l1, l2, l3]);
        assert_eq!(packable.len(), 1);
        assert_eq!(skipped.len(), 2);
        assert!(skipped
            .iter()
            .any(|item| item.id == "b" && item.reason.contains("L2")));
        assert!(skipped
            .iter()
            .any(|item| item.id == "c" && item.reason.contains("L3")));
    }

    #[test]
    fn archive_file_name_matches_executor_rule() {
        // 与执行器一致（download_file_name 唯一实现）
        let name = archive_file_name(
            "nodejs",
            "20.11.1",
            "https://nodejs.org/dist/node.zip",
            None,
        )
        .expect("zip 名");
        assert!(name.starts_with("nodejs-20.11.1-"), "{name}");
    }

    #[test]
    fn import_rejects_missing_index_and_bad_checksum() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // 没有索引
            let empty =
                std::env::temp_dir().join(format!("devkit-offline-empty-{}", std::process::id()));
            let _ = fs::remove_dir_all(&empty);
            fs::create_dir_all(&empty).unwrap();
            let result = import_offline_pack(&empty, &empty).await;
            assert!(!result.ok);
            assert!(result
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("找不到"));

            // 坏校验和被跳过
            let pack =
                std::env::temp_dir().join(format!("devkit-offline-bad-{}", std::process::id()));
            let _ = fs::remove_dir_all(&pack);
            let archives = pack.join(OFFLINE_ARCHIVE_DIR);
            fs::create_dir_all(&archives).unwrap();
            fs::write(archives.join("good.zip"), b"hello").unwrap();
            let index = OfflineIndex {
                schema_version: 1,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                devkit_version: "0.6.2".into(),
                entries: vec![OfflineEntry {
                    tool_id: "x".into(),
                    version: "1".into(),
                    file_name: "good.zip".into(),
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                        .into(),
                    size_bytes: 5,
                    url: "https://example.com/good.zip".into(),
                }],
            };
            write_json(pack.join(OFFLINE_INDEX_FILE), &index).unwrap();

            let download_dir =
                std::env::temp_dir().join(format!("devkit-offline-dl-{}", std::process::id()));
            let result = import_offline_pack(&pack, &download_dir).await;
            assert!(result.ok);
            assert_eq!(result.imported, 0);
            assert_eq!(
                result.missing,
                vec!["good.zip".to_string()],
                "校验失败被跳过而不是写进去"
            );
        });
    }

    #[test]
    fn import_accepts_correct_checksum_and_lists_packs() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let pack =
                std::env::temp_dir().join(format!("devkit-offline-ok-{}", std::process::id()));
            let _ = fs::remove_dir_all(&pack);
            let archives = pack.join(OFFLINE_ARCHIVE_DIR);
            fs::create_dir_all(&archives).unwrap();
            fs::write(archives.join("good.zip"), b"hello").unwrap();
            let sha = sha256_file(&archives.join("good.zip")).unwrap();

            let index = OfflineIndex {
                schema_version: 1,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                devkit_version: "0.6.2".into(),
                entries: vec![OfflineEntry {
                    tool_id: "x".into(),
                    version: "1".into(),
                    file_name: "good.zip".into(),
                    sha256: sha,
                    size_bytes: 5,
                    url: "https://example.com/good.zip".into(),
                }],
            };
            write_json(pack.join(OFFLINE_INDEX_FILE), &index).unwrap();

            let root =
                std::env::temp_dir().join(format!("devkit-offline-packs-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let pack2 = root.join("my-pack");
            let pack2_archives = pack2.join(OFFLINE_ARCHIVE_DIR);
            fs::create_dir_all(&pack2_archives).unwrap();
            fs::write(pack2_archives.join("good.zip"), b"hello").unwrap();
            write_json(pack2.join(OFFLINE_INDEX_FILE), &index).unwrap();

            // list_offline_packs
            let packs = list_offline_packs(&root);
            assert_eq!(packs.len(), 1);
            assert_eq!(packs[0].name, "my-pack");
            assert_eq!(packs[0].entries, 1);

            // 导入成功
            let download_dir =
                std::env::temp_dir().join(format!("devkit-offline-dl2-{}", std::process::id()));
            let result = import_offline_pack(&pack2, &download_dir).await;
            assert!(result.ok, "error: {:?}", result.error);
            assert_eq!(result.imported, 1);
            assert!(download_dir.join("good.zip").exists());
        });
    }
}
