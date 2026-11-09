//! 系统配置（FR-6，镜像 `src/main/core/systemconfig/index.ts`）。
//!
//! 原则：**能用户级做的绝不提权**。
//!  · git 身份、SSH key、PowerShell 执行策略 → 用户级，直接做
//!  · 长路径、开发者模式 → 写 HKLM，必须提权，走提权助手（会弹一次 UAC）
//!
//! 每一项都先「读」再「写」；**P1-2 起：改之前先记账，能精确还原**
//! （见 `backup.rs`）。规矩是「读不到就不改」—— 备份不了的东西不碰。

mod backup;
mod registry;

pub use backup::{
    clear_backup_entry, describe_backup_file, get_backup_entry, read_system_config_backup,
    record_backup, SystemConfigBackup, SystemConfigBackupEntry,
};
pub use registry::{
    is_missing_value_error, parse_reg_dword, read_reg_dword, reg_delete_args, reg_dword_add_args,
    to_ps_path, to_reg_path,
};

use crate::activate::index::read_activation_state;
use crate::activate::machine_path::{read_machine_path_raw, sync_machine_path, MachinePathMode};
use crate::app_paths::{get_current_root, get_data_root};
use crate::elevation::{ElevatedOutcome, ElevatedRunner, ElevatedStep};
use crate::exec::{run_command, RunOptions};
use crate::logging;
use devkit_types::locale::LocalizedText;
use devkit_types::system::{
    MachinePathMode as RequestMachinePathMode, SystemConfigId, SystemConfigItem,
    SystemConfigRequest, SystemConfigResult,
};
use devkit_types::timeutil::iso8601_now;
use registry::RegistryRead;
use std::path::Path;

const REG_LONG_PATHS_PATH: &str = r"HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem";
const REG_LONG_PATHS_NAME: &str = "LongPathsEnabled";
const REG_DEV_MODE_PATH: &str = r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock";
const REG_DEV_MODE_NAME: &str = "AllowDevelopmentWithoutDevLicense";

/// 优先用 devkit 自己激活的那份 git，其次是 PATH 上的
fn resolve_git() -> String {
    let activated = get_current_root().join(r"git\cmd\git.exe");
    if activated.exists() {
        return activated.to_string_lossy().to_string();
    }
    "git".to_string()
}

fn resolve_ssh_keygen() -> String {
    let from_git = get_current_root().join(r"git\usr\bin\ssh-keygen.exe");
    if from_git.exists() {
        return from_git.to_string_lossy().to_string();
    }
    "ssh-keygen".to_string()
}

fn ssh_key_path() -> std::path::PathBuf {
    ssh_dir().join("id_ed25519")
}

async fn read_git_config(git: &str, key: &str) -> Option<String> {
    let result = run_command(
        git,
        &["config".to_string(), "--global".to_string(), "--get".to_string(), key.to_string()],
        &RunOptions { timeout_ms: Some(15_000), ..Default::default() },
    )
    .await;
    if result.code != Some(0) {
        return None;
    }
    let value = result.stdout.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// 读 PowerShell 当前用户作用域的执行策略。
///
/// 读不到就是读不到，**返回 None 而不是猜一个值** —— 因为备份要拿它当原值。
pub async fn read_execution_policy() -> Option<String> {
    let result = run_command(
        "powershell.exe",
        &["-NoProfile".to_string(), "-Command".to_string(),
          "(Get-ExecutionPolicy -Scope CurrentUser).ToString()".to_string()],
        &RunOptions { timeout_ms: Some(20_000), ..Default::default() },
    )
    .await;
    if result.code != Some(0) {
        return None;
    }
    let value = result.stdout.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn label_zh_en(zh: &str, en: &str) -> LocalizedText {
    [
        ("zh-CN".to_string(), zh.to_string()),
        ("en-US".to_string(), en.to_string()),
    ]
    .into_iter()
    .collect()
}

fn ssh_home_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(".").to_path_buf())
}

fn ssh_dir() -> std::path::PathBuf {
    ssh_home_dir().join(".ssh")
}

/// 查询当前各项系统配置的状态（只读，不产生副作用）
pub async fn get_system_config_status() -> Vec<SystemConfigItem> {
    let mut items: Vec<SystemConfigItem> = Vec::new();

    // 1. git 身份
    let git = resolve_git();
    let (git_name, git_email) = tokio::join!(
        read_git_config(&git, "user.name"),
        read_git_config(&git, "user.email")
    );
    items.push(SystemConfigItem {
        id: SystemConfigId::GitIdentity,
        label: label_zh_en("Git 身份", "Git identity"),
        requires_admin: false,
        configured: git_name.is_some() && git_email.is_some(),
        detail: match (&git_name, &git_email) {
            (Some(name), Some(email)) => format!("{name} <{email}>"),
            (Some(name), None) => format!("{name}（email 缺失）"),
            (None, Some(email)) => format!("{email}（name 缺失）"),
            (None, None) => "未配置".to_string(),
        },
        hint: label_zh_en(
            "写 ~/.gitconfig 的 user.name 与 user.email，提交记录才会显示你的名字",
            "Writes user.name and user.email to ~/.gitconfig so commits show your name",
        ),
        devkit_modified: backup::get_backup_entry(SystemConfigId::GitIdentity).is_some(),
        backup_at: backup::get_backup_entry(SystemConfigId::GitIdentity)
            .map(|entry| entry_backed_up_at(&entry)),
        revertible: backup::get_backup_entry(SystemConfigId::GitIdentity).is_some(),
    });

    // 2. PowerShell 执行策略（用户级）
    let policy_value = read_execution_policy().await;
    let policy_ok = policy_value
        .as_deref()
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("RemoteSigned")
                || value.eq_ignore_ascii_case("Unrestricted")
                || value.eq_ignore_ascii_case("Bypass")
        });
    let policy_modified = backup::get_backup_entry(SystemConfigId::PowershellPolicy).is_some();
    items.push(SystemConfigItem {
        id: SystemConfigId::PowershellPolicy,
        label: label_zh_en("PowerShell 执行策略", "PowerShell execution policy"),
        requires_admin: false,
        configured: policy_ok,
        detail: policy_value.clone().unwrap_or_else(|| {
            "读不到（PowerShell 的 Security 模块可能不完整）".to_string()
        }),
        hint: label_zh_en(
            "很多脚手架脚本（npm、pnpm 的 .ps1）需要 RemoteSigned，否则会被拒绝执行",
            "Many toolchain scripts (npm/pnpm .ps1) need RemoteSigned or they refuse to run",
        ),
        devkit_modified: policy_modified,
        backup_at: backup::get_backup_entry(SystemConfigId::PowershellPolicy)
            .map(|entry| entry_backed_up_at(&entry)),
        revertible: policy_modified,
    });

    // 3. 长路径（HKLM，需要管理员）
    let long_paths = read_reg_dword(REG_LONG_PATHS_PATH, REG_LONG_PATHS_NAME).await;
    items.push(reg_item(
        SystemConfigId::LongPaths,
        "长路径支持",
        "Long path support",
        &long_paths,
        "深层 node_modules 很容易超过 260 字符，不开长路径会随机报\"路径过长\"",
        "Deep node_modules easily exceed 260 chars; without this you get random path-too-long errors",
    ));

    // 4. 开发者模式（HKLM，需要管理员）
    let dev_mode = read_reg_dword(REG_DEV_MODE_PATH, REG_DEV_MODE_NAME).await;
    items.push(reg_item(
        SystemConfigId::DeveloperMode,
        "开发者模式",
        "Developer mode",
        &dev_mode,
        "允许创建符号链接、启用设备门户，前端与容器相关工具常用",
        "Allows symlink creation and Device Portal — commonly needed by frontend and container tooling",
    ));

    // 5. 机器级 PATH（只读诊断，不在这里改）
    match read_machine_path_raw().await {
        Ok(raw) => {
            let data_root = get_data_root().to_string_lossy().to_string();
            let state = crate::activate::machine_path::build_machine_path_state(&raw, &data_root);
            let pending_count = state.pending.len();
            let modified = backup::get_backup_entry(SystemConfigId::MachinePath).is_some();
            let detail = if state.devkit_entries.is_empty() {
                format!("机器级 PATH 共 {} 条，其中没有 devkit 的条目", state.total)
            } else if pending_count > 0 {
                format!("已放 {} 条，还有 {} 条待同步", state.devkit_entries.len(), pending_count)
            } else {
                format!("已放 {} 条，与已激活工具一致", state.devkit_entries.len())
            };
            items.push(SystemConfigItem {
                id: SystemConfigId::MachinePath,
                label: label_zh_en("全局可用（机器级 PATH）", "Global availability (machine PATH)"),
                requires_admin: true,
                configured: !state.devkit_entries.is_empty() && pending_count == 0,
                detail,
                hint: label_zh_en(
                    "把已激活工具的路径也写进机器级 PATH，让提权进程（管理员终端、服务）也能找到它们。需要管理员权限。",
                    "Also writes activated tool paths into the machine PATH so elevated processes can find them. Requires admin.",
                ),
                devkit_modified: modified,
                backup_at: backup::get_backup_entry(SystemConfigId::MachinePath)
                    .map(|entry| entry_backed_up_at(&entry)),
                revertible: modified,
            });
        }
        Err(error) => {
            logging::global().warn("system", &format!("读取机器级 PATH 状态失败：{error}"));
        }
    }

    // 6. SSH key
    let key_path = ssh_key_path();
    let has_key = key_path.exists();
    items.push(SystemConfigItem {
        id: SystemConfigId::SshKey,
        label: label_zh_en("SSH 密钥", "SSH key"),
        requires_admin: false,
        configured: has_key,
        detail: if has_key {
            key_path.to_string_lossy().to_string()
        } else {
            "还没有 ed25519 密钥".to_string()
        },
        hint: label_zh_en(
            "生成 ~/.ssh/id_ed25519（无口令），用于 GitHub / GitLab 免密推送",
            "Generates ~/.ssh/id_ed25519 (no passphrase) for passwordless GitHub/GitLab pushes",
        ),
        devkit_modified: false, // ssh-key 刻意不记账
        backup_at: None,
        revertible: false,     // 私钥不提供还原：删除是破坏性操作
    });

    items
}

fn entry_backed_up_at(entry: &SystemConfigBackupEntry) -> String {
    match entry {
        SystemConfigBackupEntry::Registry { backed_up_at, .. }
        | SystemConfigBackupEntry::GitConfig { backed_up_at, .. }
        | SystemConfigBackupEntry::ExecutionPolicy { backed_up_at, .. }
        | SystemConfigBackupEntry::MachinePath { backed_up_at, .. } => backed_up_at.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn reg_item(
    id: SystemConfigId,
    zh: &str,
    en: &str,
    read: &RegistryRead,
    hint_zh: &str,
    hint_en: &str,
) -> SystemConfigItem {
    let modified = backup::get_backup_entry(id).is_some();
    SystemConfigItem {
        id,
        label: label_zh_en(zh, en),
        requires_admin: true,
        configured: read.value == Some(1),
        detail: if !read.value_exists {
            "未启用（该值不存在）".to_string()
        } else if read.value == Some(1) {
            "已启用".to_string()
        } else {
            "未启用".to_string()
        },
        hint: label_zh_en(hint_zh, hint_en),
        devkit_modified: modified,
        backup_at: backup::get_backup_entry(id).map(|entry| entry_backed_up_at(&entry)),
        revertible: modified,
    }
}

/// 写注册表值并**先记账**。
/// 「读不到就不改」：拿不到原值就不动它 —— 备份不了的东西没有还原路径。
async fn set_registry_config(
    id: SystemConfigId,
    path: &str,
    name: &str,
    elevated: &dyn ElevatedRunner,
) -> SystemConfigResult {
    let before = read_reg_dword(path, name).await;
    if !before.key_exists {
        return fail_result(
            id,
            format!(
                "读不到 {}，无法备份原值。为避免\"改了却回不去\"，这里不继续。",
                to_ps_path(&to_reg_path(path))
            ),
        );
    }

    // 已经是 1 就不用动，但账要记（否则用户看不到"可还原"）
    if before.value == Some(1) {
        record_backup(SystemConfigBackupEntry::Registry {
            id,
            path: to_reg_path(path),
            name: name.to_string(),
            existed: before.value_exists,
            value: before.value,
            value_type: "REG_DWORD".to_string(),
            backed_up_at: now_iso(),
        });
        return ok_result(format!("{name} 已经是 1，无需改动"), false);
    }

    let outcome = elevated.run(vec![ElevatedStep::Exec {
        label: format!("启用 {id:?}"),
        cmd: "reg.exe".to_string(),
        args: reg_dword_add_args(path, name, 1),
    }]);
    if !outcome.ok {
        return fail_result(id, elevation_error(&outcome));
    }

    // 写成功了才记账 —— 没改成就别留还原点，免得界面显示"已修改"其实是假的
    record_backup(SystemConfigBackupEntry::Registry {
        id,
        path: to_reg_path(path),
        name: name.to_string(),
        existed: before.value_exists,
        value: before.value,
        value_type: "REG_DWORD".to_string(),
        backed_up_at: now_iso(),
    });
    logging::global().info(
        "system",
        &format!("已启用 {id:?}（原值：{}）", before.value.map(|v| v.to_string()).unwrap_or_else(|| "不存在".into())),
    );
    ok_result(format!("{name} = 1（部分程序需要重启才能感知）"), true)
}

fn elevation_error(outcome: &ElevatedOutcome) -> String {
    if outcome.cancelled {
        "用户取消了管理员授权".to_string()
    } else {
        outcome.error.clone().unwrap_or_else(|| "提权操作失败".to_string())
    }
}

fn ok_result(detail: String, requires_admin: bool) -> SystemConfigResult {
    SystemConfigResult { ok: true, detail: Some(detail), error: None, requires_admin }
}

fn fail_result(id: SystemConfigId, error: String) -> SystemConfigResult {
    logging::global().warn("system", &format!("系统配置 {id:?} 失败：{error}"));
    SystemConfigResult { ok: false, detail: None, error: Some(error), requires_admin: false }
}

/// 应用一项系统配置。`elevated` 由应用层注入（R5 接入真提权助手后传入真实实现）。
pub async fn apply_system_config(
    request: &SystemConfigRequest,
    elevated: &dyn ElevatedRunner,
) -> SystemConfigResult {
    let id = request.id;
    let result = match id {
        SystemConfigId::GitIdentity => {
            let name = request.git_name.as_deref().unwrap_or("").trim().to_string();
            let email = request.git_email.as_deref().unwrap_or("").trim().to_string();
            if name.is_empty() || email.is_empty() {
                return fail_result(id, "user.name 与 user.email 都不能为空".to_string());
            }
            if name.contains(['<', '>', '"', '\n']) || name.chars().count() > 80 {
                return fail_result(id, "user.name 含非法字符".to_string());
            }
            let email_ok = {
                let parts: Vec<&str> = email.split('@').collect();
                parts.len() == 2
                    && !parts[0].is_empty()
                    && !parts[0].contains(['<', '>', '"', '\n'])
                    && parts[1].contains('.')
                    && !parts[1].contains(['<', '>', '"', '\n', ' '])
                    && !parts[1].starts_with('.')
                    && !parts[1].ends_with('.')
            };
            if !email_ok {
                return fail_result(id, "user.email 格式不正确".to_string());
            }

            let git = resolve_git();

            // 记账要在写之前：先读原值
            let before_name = read_git_config(&git, "user.name").await;
            let before_email = read_git_config(&git, "user.email").await;

            for (key, value) in [("user.name", name.as_str()), ("user.email", email.as_str())] {
                let result = run_command(
                    &git,
                    &["config".to_string(), "--global".to_string(), key.to_string(), value.to_string()],
                    &RunOptions { timeout_ms: Some(15_000), ..Default::default() },
                )
                .await;
                if result.code != Some(0) {
                    let reason = if result.stderr.trim().is_empty() {
                        result.spawn_error.unwrap_or_else(|| format!("退出码 {:?}", result.code))
                    } else {
                        result.stderr.trim().to_string()
                    };
                    return fail_result(id, format!("git config {key} 失败：{reason}"));
                }
            }

            record_backup(SystemConfigBackupEntry::GitConfig {
                id,
                keys: vec![
                    backup::GitConfigKeyBackup {
                        key: "user.name".to_string(),
                        existed: before_name.is_some(),
                        value: before_name,
                    },
                    backup::GitConfigKeyBackup {
                        key: "user.email".to_string(),
                        existed: before_email.is_some(),
                        value: before_email,
                    },
                ],
                backed_up_at: now_iso(),
            });

            logging::global().info("system", &format!("Git 身份已设置为 {name} <{email}>"));
            ok_result(format!("{name} <{email}>"), false)
        }

        SystemConfigId::PowershellPolicy => {
            let before = match read_execution_policy().await {
                Some(value) => value,
                None => {
                    return fail_result(
                        id,
                        "读不到当前的执行策略（本机 PowerShell 的 Security 模块可能不完整），无法备份原值，因此不改动。"
                            .to_string(),
                    )
                }
            };

            let result = run_command(
                "powershell.exe",
                &["-NoProfile".to_string(), "-Command".to_string(),
                  "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force".to_string()],
                &RunOptions { timeout_ms: Some(30_000), ..Default::default() },
            )
            .await;
            if result.code != Some(0) {
                let reason = if result.stderr.trim().is_empty() {
                    result.spawn_error.unwrap_or_else(|| format!("退出码 {:?}", result.code))
                } else {
                    result.stderr.trim().to_string()
                };
                return fail_result(id, reason);
            }

            record_backup(SystemConfigBackupEntry::ExecutionPolicy {
                id,
                scope: "CurrentUser".to_string(),
                existed: true,
                value: Some(before.clone()),
                backed_up_at: now_iso(),
            });
            logging::global().info(
                "system",
                &format!("PowerShell 执行策略已设为 CurrentUser RemoteSigned（原值：{before}）"),
            );
            ok_result("CurrentUser → RemoteSigned".to_string(), false)
        }

        SystemConfigId::SshKey => {
            let target = ssh_key_path();
            if target.exists() {
                return ok_result(format!("已存在：{}", target.display()), false);
            }
            let dir = ssh_dir();
            let _ = std::fs::create_dir_all(&dir);
            let result = run_command(
                &resolve_ssh_keygen(),
                &[
                    "-t".to_string(), "ed25519".to_string(),
                    "-N".to_string(), String::new(),
                    "-C".to_string(), "devkit".to_string(),
                    "-f".to_string(), target.to_string_lossy().to_string(),
                ],
                &RunOptions { timeout_ms: Some(60_000), ..Default::default() },
            )
            .await;
            if result.code != Some(0) {
                let reason = if result.stderr.trim().is_empty() {
                    result.spawn_error.unwrap_or_else(|| format!("退出码 {:?}", result.code))
                } else {
                    result.stderr.trim().to_string()
                };
                return fail_result(
                    id,
                    format!(
                        "ssh-keygen 失败：{reason}。若机器上没有 ssh-keygen，请先安装 Git（devkit 的 Git 清单自带 ssh-keygen）。"
                    ),
                );
            }
            logging::global().info("system", &format!("已生成 SSH 密钥：{}", target.display()));
            // 刻意不记账：私钥可能已被用户用于 GitHub/GitLab，删掉是破坏性操作
            ok_result(
                format!("{}（私钥不提供自动删除，需要时请自行处理）", target.display()),
                false,
            )
        }

        SystemConfigId::MachinePath => {
            let mode = match request.machine_path_mode {
                Some(RequestMachinePathMode::Remove) => MachinePathMode::Remove,
                _ => MachinePathMode::Add,
            };

            // 改之前先把机器 PATH 原文记下来（整串存，还原时整串写回）
            let before_raw = match read_machine_path_raw().await {
                Ok(raw) => raw,
                Err(error) => return fail_result(id, error),
            };
            let before_count = before_raw.split(';').filter(|e| !e.trim().is_empty()).count();

            let records = read_activation_state().records;
            let data_root = get_data_root().to_string_lossy().to_string();
            let elevated_for_write: &dyn ElevatedRunner = elevated;
            let writer = |value: &str| {
                let outcome = elevated_for_write.run(vec![ElevatedStep::SetMachinePath {
                    label: "写入机器级 PATH".to_string(),
                    value: value.to_string(),
                }]);
                if outcome.ok {
                    Ok(())
                } else if outcome.cancelled {
                    Err("用户取消了管理员授权".to_string())
                } else {
                    Err(outcome.error.unwrap_or_else(|| "机器级 PATH 写入失败".to_string()))
                }
            };
            let result = sync_machine_path(mode, &records, &|| {
                Ok(before_raw.clone())
            }, &writer, &data_root);

            if !result.ok {
                return fail_result(id, result.error.unwrap_or_else(|| "同步机器级 PATH 失败".to_string()));
            }

            // 真的改了才记账 —— 没改成就别留还原点
            if !result.added.is_empty() || !result.removed.is_empty() {
                record_backup(SystemConfigBackupEntry::MachinePath {
                    id,
                    value: before_raw,
                    entry_count: before_count as u32,
                    backed_up_at: now_iso(),
                });
            }

            let detail = if !result.added.is_empty() {
                format!("已加入 {} 条，机器级 PATH 现共 {} 条", result.added.len(), result.total_after)
            } else if !result.removed.is_empty() {
                format!("已移除 {} 条，机器级 PATH 现共 {} 条", result.removed.len(), result.total_after)
            } else {
                "机器级 PATH 无需改动".to_string()
            };
            ok_result(detail, !result.added.is_empty() || !result.removed.is_empty())
        }

        SystemConfigId::LongPaths => {
            set_registry_config(id, REG_LONG_PATHS_PATH, REG_LONG_PATHS_NAME, elevated).await
        }
        SystemConfigId::DeveloperMode => {
            set_registry_config(id, REG_DEV_MODE_PATH, REG_DEV_MODE_NAME, elevated).await
        }
    };
    // 与 TS 一致：registry 类失败的 requires_admin 仍为 true
    if !result.ok && matches!(id, SystemConfigId::LongPaths | SystemConfigId::DeveloperMode) {
        return SystemConfigResult { requires_admin: true, ..result };
    }
    result
}

/// 还原某一项到 devkit 改动之前的样子（P1-2）。
///
/// 三条硬规矩：
///  1. 没有备份记录就不动手（不知道原值就谈不上还原）
///  2. 还原完**重新读一遍复验**，对不上就报错
///  3. 成功后才销账
pub async fn revert_system_config(
    id: SystemConfigId,
    elevated: &dyn ElevatedRunner,
) -> SystemConfigResult {
    if id == SystemConfigId::SshKey {
        return fail_result(
            id,
            "SSH 私钥不提供自动还原：它可能已经用于 GitHub / GitLab，删除是破坏性操作".to_string(),
        );
    }

    let entry = match get_backup_entry(id) {
        Some(entry) => entry,
        None => {
            return fail_result(
                id,
                "这一项没有 devkit 的备份记录，无法还原（可能不是 devkit 改的）".to_string(),
            )
        }
    };

    let result = match &entry {
        SystemConfigBackupEntry::Registry { path, name, existed, value, .. } => {
            let args = if *existed {
                reg_dword_add_args(path, name, value.unwrap_or(0))
            } else {
                reg_delete_args(path, name)
            };
            let outcome = elevated.run(vec![ElevatedStep::Exec {
                label: format!("还原 {id:?}"),
                cmd: "reg.exe".to_string(),
                args,
            }]);
            if !outcome.ok {
                // 「原本不存在」时删值失败是预期结果：说明本来就是干净的
                let detail = outcome.error.clone().unwrap_or_default();
                if !*existed && is_missing_value_error(&detail) {
                    clear_backup_entry(id);
                    return ok_result(format!("{name} 原本就不存在，已确认干净"), true);
                }
                let error = if outcome.cancelled {
                    "用户取消了管理员授权".to_string()
                } else if detail.is_empty() {
                    "注册表还原失败".to_string()
                } else {
                    detail
                };
                return fail_result(id, error);
            }

            let after = read_reg_dword(path, name).await;
            let matched = if *existed { after.value == *value } else { !after.value_exists };
            if !matched {
                return fail_result(
                    id,
                    format!(
                        "还原后复验不通过：期望 {}，实际 {}",
                        if *existed {
                            format!("{name}={}", value.map(|v| v.to_string()).unwrap_or_default())
                        } else {
                            format!("{name} 不存在")
                        },
                        if after.value_exists {
                            format!("{name}={}", after.value.map(|v| v.to_string()).unwrap_or_default())
                        } else {
                            "不存在".to_string()
                        }
                    ),
                );
            }

            clear_backup_entry(id);
            logging::global().info(
                "system",
                &format!("已还原 {id:?}（{}）", if *existed { format!("{name}={}", value.unwrap_or(0)) } else { "删除该值".to_string() }),
            );
            ok_result(
                if *existed {
                    format!("{name} 已还原为 {}", value.unwrap_or(0))
                } else {
                    format!("{name} 已删除（原本不存在）")
                },
                true,
            )
        }

        SystemConfigBackupEntry::GitConfig { keys, .. } => {
            let git = resolve_git();
            for item in keys {
                let args = if item.existed {
                    vec![
                        "config".to_string(),
                        "--global".to_string(),
                        item.key.clone(),
                        item.value.clone().unwrap_or_default(),
                    ]
                } else {
                    vec![
                        "config".to_string(),
                        "--global".to_string(),
                        "--unset".to_string(),
                        item.key.clone(),
                    ]
                };
                let result = run_command(
                    &git,
                    &args,
                    &RunOptions { timeout_ms: Some(15_000), ..Default::default() },
                )
                .await;
                // --unset 一个不存在的 key 会返回 5，这是预期结果
                if result.code != Some(0) && !(result.code == Some(5) && !item.existed) {
                    let reason = if result.stderr.trim().is_empty() {
                        result.spawn_error.unwrap_or_else(|| format!("退出码 {:?}", result.code))
                    } else {
                        result.stderr.trim().to_string()
                    };
                    return fail_result(id, format!("git config {} 还原失败：{reason}", item.key));
                }
            }

            for item in keys {
                let after = read_git_config(&git, &item.key).await;
                let matched = if item.existed { after == item.value } else { after.is_none() };
                if !matched {
                    return fail_result(
                        id,
                        format!(
                            "还原后复验不通过：{} 期望 {}，实际 {}",
                            item.key,
                            item.value.clone().unwrap_or_else(|| "(不存在)".to_string()),
                            after.unwrap_or_else(|| "(不存在)".to_string())
                        ),
                    );
                }
            }

            clear_backup_entry(id);
            logging::global().info("system", "Git 身份已还原");
            ok_result("Git 身份已还原到 devkit 改动之前".to_string(), false)
        }

        SystemConfigBackupEntry::ExecutionPolicy { scope, value, .. } => {
            let target = value.clone().unwrap_or_else(|| "Undefined".to_string());
            let result = run_command(
                "powershell.exe",
                &[
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    format!("Set-ExecutionPolicy -Scope {scope} {target} -Force"),
                ],
                &RunOptions { timeout_ms: Some(30_000), ..Default::default() },
            )
            .await;
            if result.code != Some(0) {
                let reason = if result.stderr.trim().is_empty() {
                    result.spawn_error.unwrap_or_else(|| format!("退出码 {:?}", result.code))
                } else {
                    result.stderr.trim().to_string()
                };
                return fail_result(id, reason);
            }

            let after = read_execution_policy().await;
            if after.as_deref() != Some(target.as_str()) {
                return fail_result(
                    id,
                    format!("还原后复验不通过：期望 {target}，实际 {}", after.unwrap_or_else(|| "(读不到)".to_string())),
                );
            }

            clear_backup_entry(id);
            logging::global().info("system", &format!("PowerShell 执行策略已还原为 {target}"));
            ok_result(format!("执行策略已还原为 {target}"), false)
        }

        SystemConfigBackupEntry::MachinePath { value, .. } => {
            let outcome = elevated.run(vec![ElevatedStep::SetMachinePath {
                label: "还原机器级 PATH".to_string(),
                value: value.clone(),
            }]);
            if !outcome.ok {
                return fail_result(
                    id,
                    if outcome.cancelled {
                        "用户取消了管理员授权".to_string()
                    } else {
                        outcome.error.unwrap_or_else(|| "机器级 PATH 还原失败".to_string())
                    },
                );
            }

            // 复验：逐条比对，不只是"条数对得上"
            let after_raw = match read_machine_path_raw().await {
                Ok(raw) => raw,
                Err(error) => return fail_result(id, error),
            };
            let after_entries: Vec<String> = after_raw
                .split(';')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();
            let expected: Vec<String> = value
                .split(';')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();

            let same = after_entries.len() == expected.len()
                && after_entries
                    .iter()
                    .zip(expected.iter())
                    .all(|(actual, want)| actual.eq_ignore_ascii_case(want));
            if !same {
                return fail_result(
                    id,
                    format!("还原后复验不通过：期望 {} 条，实际 {} 条", expected.len(), after_entries.len()),
                );
            }

            clear_backup_entry(id);
            logging::global().info(
                "system",
                &format!("机器级 PATH 已还原为 devkit 改动之前的 {} 条", expected.len()),
            );
            ok_result(format!("机器级 PATH 已还原（{} 条）", expected.len()), true)
        }
    };

    // 与 TS 一致：machine-path 失败时 requires_admin 也为 true
    if !result.ok && id == SystemConfigId::MachinePath {
        return SystemConfigResult { requires_admin: true, ..result };
    }
    result
}

fn now_iso() -> String {
    iso8601_now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::ENV_TEST_LOCK;

    struct FakeElevation {
        fail: bool,
        cancel: bool,
    }

    impl ElevatedRunner for FakeElevation {
        fn run(&self, _steps: Vec<ElevatedStep>) -> ElevatedOutcome {
            if self.cancel {
                ElevatedOutcome { ok: false, cancelled: true, error: None }
            } else if self.fail {
                ElevatedOutcome { ok: false, cancelled: false, error: Some("boom".to_string()) }
            } else {
                ElevatedOutcome { ok: true, cancelled: false, error: None }
            }
        }
    }

    fn sandbox(tag: &str) -> MutexGuard<'static, ()> {
        let guard = ENV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("devkit-syscfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DEVKIT_APP_DATA", &dir);
        guard
    }

    type MutexGuard<'a, T> = std::sync::MutexGuard<'a, T>;

    #[test]
    fn validation_guards() {
        let _guard = sandbox("validate");
        let elevated = FakeElevation { fail: false, cancel: false };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // git 身份：空值拒绝
        let request = SystemConfigRequest {
            id: SystemConfigId::GitIdentity,
            git_name: Some("  ".to_string()),
            git_email: Some("a@b.com".to_string()),
            machine_path_mode: None,
        };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("不能为空"));

        // git 身份：非法字符
        let request = SystemConfigRequest {
            id: SystemConfigId::GitIdentity,
            git_name: Some("bad<name>".to_string()),
            git_email: Some("a@b.com".to_string()),
            machine_path_mode: None,
        };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("非法字符"));

        // git 身份：邮箱格式
        let request = SystemConfigRequest {
            id: SystemConfigId::GitIdentity,
            git_name: Some("张三".to_string()),
            git_email: Some("not-an-email".to_string()),
            machine_path_mode: None,
        };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("格式不正确"));
    }

    #[test]
    fn revert_guards() {
        let _guard = sandbox("revert-guard");
        let elevated = FakeElevation { fail: false, cancel: false };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // ssh-key 拒绝还原
        let result = rt.block_on(revert_system_config(SystemConfigId::SshKey, &elevated));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("破坏性操作"));

        // 没有备份记录就不动手
        let result = rt.block_on(revert_system_config(SystemConfigId::GitIdentity, &elevated));
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("没有 devkit 的备份记录"));
    }

    #[test]
    fn registry_apply_with_fake_elevation() {
        let _guard = sandbox("reg-apply");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // 提权失败 → 如实报错（reg add 不会真的执行，因为 FakeElevation 不跑步骤）
        let elevated = FakeElevation { fail: true, cancel: false };
        let request = SystemConfigRequest {
            id: SystemConfigId::LongPaths,
            git_name: None,
            git_email: None,
            machine_path_mode: None,
        };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        // 注意：这一步会先真实读 HKLM（只读），本机该值可能已是 1 → 直接返回无需改动
        if result.ok {
            assert!(result.detail.as_deref().unwrap_or_default().contains("无需改动")
                || result.detail.as_deref().unwrap_or_default().contains("= 1"));
        } else {
            assert!(result.error.as_deref().unwrap_or_default().contains("boom"));
            assert!(result.requires_admin);
        }

        // 用户取消 UAC → cancelled 文案
        let elevated = FakeElevation { fail: false, cancel: true };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        if !result.ok {
            assert!(result.error.as_deref().unwrap_or_default().contains("取消"));
        }
    }

    #[test]
    fn machine_path_sync_with_fake_elevation_noop() {
        let _guard = sandbox("mp-fake");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // 真实读机器 PATH（只读）+ 空激活记录 → writer 不该被调用、结果应为无需改动
        let elevated = FakeElevation { fail: false, cancel: false };
        let request = SystemConfigRequest {
            id: SystemConfigId::MachinePath,
            git_name: None,
            git_email: None,
            machine_path_mode: Some(RequestMachinePathMode::Add),
        };
        let result = rt.block_on(apply_system_config(&request, &elevated));
        // 本机真实环境：读得到 PATH 就应成功且 added 为空（无激活记录）
        if result.ok {
            assert!(result.detail.as_deref().unwrap_or_default().contains("无需改动"));
        }
    }

    #[test]
    fn status_returns_six_items() {
        let _guard = sandbox("status");
        // status 是只读的（git config --get / reg query / powershell 读 / 文件存在性）
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = rt.block_on(get_system_config_status());
        assert_eq!(items.len(), 6);
        assert_eq!(items[0].id, SystemConfigId::GitIdentity);
        assert_eq!(items[1].id, SystemConfigId::PowershellPolicy);
        assert_eq!(items[2].id, SystemConfigId::LongPaths);
        assert_eq!(items[3].id, SystemConfigId::DeveloperMode);
        assert_eq!(items[4].id, SystemConfigId::MachinePath);
        assert_eq!(items[5].id, SystemConfigId::SshKey);
        // SSH 恒不可还原
        assert!(!items[5].revertible);
        assert!(!items[5].devkit_modified);
        // 长路径与开发者模式需要管理员
        assert!(items[2].requires_admin);
        assert!(items[3].requires_admin);
        assert!(items[4].requires_admin);
    }
}

