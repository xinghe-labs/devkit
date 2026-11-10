//! 系统配置的备份账本（镜像 `src/main/core/systemconfig/backup.ts`）。
//!
//! 1. **单文件 + 按项首写胜出**：第二次「启用」时原值已经被自己改过了，
//!    再存一次就把真正的原值覆盖掉了。只留第一次改动前的样子。
//! 2. **必须区分「原本不存在」与「原本为 0」**：还原动作完全不同
//!    （前者删值，后者写回 0），记录里用 `existed` 显式表达。
//! 3. **`ssh-key` 不记账**：私钥可能已用于 GitHub/GitLab，删除是破坏性操作。

use crate::app_paths::get_backup_dir;
use crate::logging;
use devkit_types::system::SystemConfigId;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const BACKUP_FILE_NAME: &str = "system-config.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SystemConfigBackupEntry {
    Registry {
        id: SystemConfigId,
        /// 存 reg.exe 风格（HKLM\...），读的时候直接可用
        path: String,
        name: String,
        /// false = 原本不存在（还原时删值）；true = 原本存在（还原时写回 value）
        existed: bool,
        value: Option<u32>,
        value_type: String, // "REG_DWORD"
        backed_up_at: String,
    },
    GitConfig {
        id: SystemConfigId,
        keys: Vec<GitConfigKeyBackup>,
        backed_up_at: String,
    },
    ExecutionPolicy {
        id: SystemConfigId,
        scope: String, // "CurrentUser"
        existed: bool,
        value: Option<String>,
        backed_up_at: String,
    },
    MachinePath {
        id: SystemConfigId,
        /// 机器级 PATH 原文（整串，还原时整串写回）
        value: String,
        /// 条目数，仅用于展示
        entry_count: u32,
        backed_up_at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitConfigKeyBackup {
    pub key: String,
    pub existed: bool,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemConfigBackup {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub entries: Vec<SystemConfigBackupEntry>,
}

impl SystemConfigBackup {
    pub fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

/// Registry 变体里的 `valueType` 字段名做 camelCase 映射（serde tag 内部字段不自动改）。
/// 通过手写小函数规避：序列化时把 value_type → valueType。
pub fn entry_to_json(entry: &SystemConfigBackupEntry) -> serde_json::Value {
    let mut value = serde_json::to_value(entry).expect("backup entry serialize");
    if let Some(obj) = value.as_object_mut() {
        if let Some(ty) = obj.remove("value_type") {
            obj.insert("valueType".to_string(), ty);
        }
        if let Some(at) = obj.remove("backed_up_at") {
            obj.insert("backedUpAt".to_string(), at);
        }
        if let Some(count) = obj.remove("entry_count") {
            obj.insert("entryCount".to_string(), count);
        }
    }
    value
}

pub fn entry_from_json(value: &serde_json::Value) -> Option<SystemConfigBackupEntry> {
    let mut value = value.clone();
    if let Some(obj) = value.as_object_mut() {
        if let Some(ty) = obj.remove("valueType") {
            obj.insert("value_type".to_string(), ty);
        }
        if let Some(at) = obj.remove("backedUpAt") {
            obj.insert("backed_up_at".to_string(), at);
        }
        if let Some(count) = obj.remove("entryCount") {
            obj.insert("entry_count".to_string(), count);
        }
    }
    serde_json::from_value(value).ok()
}

fn backup_file_path() -> PathBuf {
    get_backup_dir().join(BACKUP_FILE_NAME)
}

pub fn read_system_config_backup() -> SystemConfigBackup {
    let file = backup_file_path();
    if !file.exists() {
        return SystemConfigBackup::empty();
    }
    match fs::read_to_string(&file) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(parsed) => {
                let entries = parsed
                    .get("entries")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(entry_from_json).collect::<Vec<_>>())
                    .unwrap_or_default();
                SystemConfigBackup {
                    schema_version: SCHEMA_VERSION,
                    entries,
                }
            }
            Err(error) => {
                // 账本坏了不能让程序起不来；当空的处理，并在日志里留痕
                logging::global().warn(
                    "system",
                    &format!("系统配置备份账本损坏，按空处理：{error}"),
                );
                SystemConfigBackup::empty()
            }
        },
        Err(error) => {
            logging::global().warn(
                "system",
                &format!("系统配置备份账本读取失败，按空处理：{error}"),
            );
            SystemConfigBackup::empty()
        }
    }
}

pub fn get_backup_entry(id: SystemConfigId) -> Option<SystemConfigBackupEntry> {
    read_system_config_backup()
        .entries
        .into_iter()
        .find(|entry| entry_id(entry) == id)
}

fn write_backup(backup: &SystemConfigBackup) {
    let path = backup_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json: Vec<serde_json::Value> = backup.entries.iter().map(entry_to_json).collect();
    let payload = serde_json::json!({ "schemaVersion": backup.schema_version, "entries": json });
    let text = serde_json::to_string_pretty(&payload).expect("backup serialize");
    fs::write(&path, format!("{text}\n")).expect("write backup ledger");
}

fn entry_id(entry: &SystemConfigBackupEntry) -> SystemConfigId {
    match entry {
        SystemConfigBackupEntry::Registry { id, .. }
        | SystemConfigBackupEntry::GitConfig { id, .. }
        | SystemConfigBackupEntry::ExecutionPolicy { id, .. }
        | SystemConfigBackupEntry::MachinePath { id, .. } => *id,
    }
}

/// 记账。**首写胜出** —— 已经记过这一项就直接返回，不覆盖。
/// 返回真正生效的记录（可能是之前那条）。
pub fn record_backup(entry: SystemConfigBackupEntry) -> SystemConfigBackupEntry {
    let mut backup = read_system_config_backup();
    if let Some(existing) = backup
        .entries
        .iter()
        .find(|item| entry_id(item) == entry_id(&entry))
    {
        return existing.clone();
    }
    backup.entries.push(entry.clone());
    write_backup(&backup);
    logging::global().info(
        "system",
        &format!(
            "已备份系统配置原值：{:?}（还原点 {}）",
            entry_id(&entry),
            backup_file_path().display()
        ),
    );
    entry
}

/// 还原成功后销账 —— 留着会让界面一直显示"已由 devkit 修改"
pub fn clear_backup_entry(id: SystemConfigId) {
    let backup = read_system_config_backup();
    let next: Vec<_> = backup
        .entries
        .iter()
        .filter(|entry| entry_id(entry) != id)
        .cloned()
        .collect();
    if next.len() == backup.entries.len() {
        return;
    }
    write_backup(&SystemConfigBackup {
        schema_version: SCHEMA_VERSION,
        entries: next,
    });
    logging::global().info("system", &format!("已清除系统配置备份记录：{id:?}"));
}

pub fn describe_backup_file() -> String {
    backup_file_path().display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::ENV_TEST_LOCK;

    /// 沙箱环境：把 DEVKIT_APP_DATA 指到临时目录（与其它环境变量测试互斥）。
    fn sandbox(tag: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let guard = ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir =
            std::env::temp_dir().join(format!("devkit-syscfg-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("DEVKIT_APP_DATA", &dir);
        (guard, dir)
    }

    fn registry_entry(id: SystemConfigId, value: Option<u32>) -> SystemConfigBackupEntry {
        SystemConfigBackupEntry::Registry {
            id,
            path: r"HKLM\SYSTEM\Control\FileSystem".into(),
            name: "LongPathsEnabled".into(),
            existed: value.is_some(),
            value,
            value_type: "REG_DWORD".into(),
            backed_up_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn record_first_write_wins_and_clear() {
        let (_guard, dir) = sandbox("ledger");
        let _ = &dir;

        // 空账本
        assert!(read_system_config_backup().entries.is_empty());

        // 记一条「原本为 0」
        let recorded = record_backup(registry_entry(SystemConfigId::LongPaths, Some(0)));
        assert!(matches!(
            recorded,
            SystemConfigBackupEntry::Registry { value: Some(0), .. }
        ));

        // 再记一条不同值 → 首写胜出，仍是 0
        let second = record_backup(registry_entry(SystemConfigId::LongPaths, Some(1)));
        assert!(matches!(
            second,
            SystemConfigBackupEntry::Registry { value: Some(0), .. }
        ));

        // 重新读文件验证持久化
        let entries = read_system_config_backup().entries;
        assert_eq!(entries.len(), 1);

        // 销账
        clear_backup_entry(SystemConfigId::LongPaths);
        assert!(get_backup_entry(SystemConfigId::LongPaths).is_none());
        // 重复销账无副作用
        clear_backup_entry(SystemConfigId::LongPaths);
    }

    #[test]
    fn corrupt_ledger_falls_back_to_empty() {
        let (_guard, dir) = sandbox("corrupt");
        let file = dir.join("backup").join(BACKUP_FILE_NAME);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{ not valid json").unwrap();

        let backup = read_system_config_backup();
        assert!(backup.entries.is_empty(), "损坏账本按空处理");
    }

    #[test]
    fn entry_json_roundtrip_camel_case() {
        let entry = registry_entry(SystemConfigId::LongPaths, Some(0));
        let json = entry_to_json(&entry);
        assert_eq!(json["kind"], "registry");
        assert_eq!(json["valueType"], "REG_DWORD");
        assert_eq!(json["backedUpAt"], "2026-01-01T00:00:00.000Z");
        assert!(json.get("value_type").is_none());

        let parsed = entry_from_json(&json).expect("roundtrip");
        assert_eq!(parsed, entry);
    }

    #[test]
    fn machine_path_entry_roundtrip() {
        let entry = SystemConfigBackupEntry::MachinePath {
            id: SystemConfigId::MachinePath,
            value: "C:\\Windows;C:\\Tools".into(),
            entry_count: 2,
            backed_up_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = entry_to_json(&entry);
        assert_eq!(json["kind"], "machine-path");
        assert_eq!(json["entryCount"], 2);
        let parsed = entry_from_json(&json).expect("roundtrip");
        assert_eq!(parsed, entry);
    }
}
