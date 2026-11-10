//! 环境档案 / 换机迁移（FR-22，镜像 `src/main/core/profile/index.ts`）。
//!
//! 核心判断：**重装系统最痛的从来不是"装软件"，而是"恢复成原来那样"** ——
//! PATH 里的自定义条目、JAVA_HOME、镜像源、git 身份、VS Code 插件，
//! 这些东西 winget export 全都不含。
//!
//! 三条安全底线：
//!  1. **档案里绝不含任何密钥**。环境变量走白名单（只收 JAVA_HOME/GOROOT 这类路径变量）
//!  2. **导入是"差异展示 + 逐项确认"**，不是"一键覆盖"。恢复 PATH / 环境变量前一律先备份
//!  3. **装软件复用现有的安装流程**，apply_profile 只返回 selections

use crate::activate::index::read_activation_state;
use crate::config::mirrors::{apply_mirrors, read_current_mirrors};
use crate::doctor::paths::{analyze_path, normalize_entry};
use crate::exec::{run_command, RunOptions};
use crate::logging;
use devkit_types::detection::DetectionStatus;
use devkit_types::locale::LocalizedText;
use devkit_types::plan::PlanSelection;
use devkit_types::profile::{
    ApplyProfileOptions, ApplyProfileResult, DetectedToolEntry, EnvProfile, EnvProfileGit,
    EnvProfileMachine, EnvProfileMirrorEntry, InstalledToolEntry, ProfileDiff, ProfileDiffEntry,
    ProfileSummary, ProfileToolState,
};
use devkit_types::settings::{MirrorTarget, MIRROR_TARGETS};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 只收这些环境变量：都是"路径/工具链位置"，不含任何凭证
pub const PROFILE_ENV_ALLOWLIST: &[&str] = &[
    "JAVA_HOME",
    "GOROOT",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "MAVEN_HOME",
    "GRADLE_HOME",
    "PYTHONHOME",
    "GOPATH",
    "ANDROID_HOME",
    "DEVKIT_HOME",
];

/// 这些 PATH 条目是 Windows 自带的，导出时排除（换机不需要带）
const SYSTEM_PATH_PREFIXES: &[&str] = &[
    "%systemroot%",
    r"c:\windows",
    "%programfiles%",
    r"c:\program files",
    "%programfiles(x86)%",
    r"c:\program files (x86)",
    "%programdata%",
];

fn is_system_path_entry(entry: &str) -> bool {
    let lowered = entry.to_lowercase();
    SYSTEM_PATH_PREFIXES
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    /// 是否带上 git 身份（user.name / user.email）。默认不带 —— 那算个人信息
    pub include_git_identity: bool,
    /// 目标机器上要装什么；不传则由"本机已装"推导
    pub selections: Option<Vec<PlanSelection>>,
}

fn read_git_identity() -> GitIdentity {
    let read = |key: &str| -> Option<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        let result = runtime.block_on(run_command(
            "git",
            &[
                "config".to_string(),
                "--global".to_string(),
                "--get".to_string(),
                key.to_string(),
            ],
            &RunOptions {
                timeout_ms: Some(15_000),
                ..Default::default()
            },
        ));
        if result.code != Some(0) {
            return None;
        }
        let value = result.stdout.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    };
    GitIdentity {
        user_name: read("user.name"),
        user_email: read("user.email"),
    }
}

fn read_vscode_extensions() -> Vec<String> {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return Vec::new(),
    };
    let result = runtime.block_on(run_command(
        "code",
        &["--list-extensions".to_string()],
        &RunOptions {
            timeout_ms: Some(30_000),
            ..Default::default()
        },
    ));
    if result.code != Some(0) || result.spawn_error.is_some() {
        return Vec::new();
    }
    let pattern =
        regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap();
    result
        .stdout
        .lines()
        .map(|line| line.trim())
        .filter(|line| pattern.is_match(line))
        .map(|line| line.to_string())
        .collect()
}

/// 收集"本机现状"上下文（应用层组装；字段与 TS CollectContext 一致）
pub struct CollectContext<'a> {
    pub detections: &'a [devkit_types::detection::DetectionResult],
    pub installed: &'a [devkit_types::activation::InstalledTool],
    pub mirrors: &'a [devkit_types::settings::MirrorSetting],
}

fn read_user_env_blocking(name: &str) -> Option<String> {
    devkit_sys::user_env::read_user_env(name).ok().flatten()
}

fn read_user_path_blocking() -> String {
    devkit_sys::user_env::read_user_path().unwrap_or_default()
}

/// 把"本机现状"收成一份档案
pub fn collect_profile(context: &CollectContext<'_>, options: &ExportOptions) -> EnvProfile {
    let user_path = read_user_path_blocking();
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let analysis = analyze_path(
        &user_path,
        &|path| std::path::Path::new(path).exists(),
        &env_map,
    );

    let devkit_managed: HashSet<String> = read_activation_state()
        .records
        .iter()
        .flat_map(|record| {
            record
                .path_entries
                .iter()
                .map(|entry| normalize_entry(entry))
        })
        .collect();

    let user_path_extra: Vec<String> = analysis
        .entries
        .iter()
        .filter(|entry| entry.kind == devkit_types::doctor::PathEntryKind::Ok)
        .map(|entry| entry.raw.clone())
        .filter(|entry| !is_system_path_entry(entry))
        .filter(|entry| !devkit_managed.contains(&normalize_entry(entry)))
        .collect();

    let mut env: HashMap<String, String> = HashMap::new();
    for name in PROFILE_ENV_ALLOWLIST {
        if let Some(value) = read_user_env_blocking(name) {
            if !value.trim().is_empty() {
                env.insert((*name).to_string(), value);
            }
        }
    }

    let current_mirrors = read_current_mirrors();
    let current_values = [
        current_mirrors.npm,
        current_mirrors.pip,
        current_mirrors.go,
        current_mirrors.maven,
        current_mirrors.gradle,
        current_mirrors.cargo,
        current_mirrors.conda,
        current_mirrors.nuget,
        current_mirrors.docker,
    ];

    // 目标机器上要装什么：本机已装（或 devkit 已装）的那些工具
    let installed_ids: HashSet<&str> = context
        .installed
        .iter()
        .map(|item| item.tool_id.as_str())
        .collect();
    let selections: Vec<PlanSelection> = options.selections.clone().unwrap_or_else(|| {
        context
            .detections
            .iter()
            .filter(|result| {
                matches!(
                    result.status,
                    DetectionStatus::Installed
                        | DetectionStatus::VersionMismatch
                        | DetectionStatus::PathMissing
                ) || installed_ids.contains(result.tool_id.as_str())
            })
            .map(|result| {
                // devkit 装过就带上具体版本（换机能复现同一版本），否则只带工具 id
                match context
                    .installed
                    .iter()
                    .find(|item| item.tool_id == result.tool_id)
                {
                    Some(mine) => PlanSelection {
                        tool_id: result.tool_id.clone(),
                        version: Some(mine.version.clone()),
                    },
                    None => PlanSelection {
                        tool_id: result.tool_id.clone(),
                        version: None,
                    },
                }
            })
            .collect()
    });

    let vscode_extensions = read_vscode_extensions();
    let git = if options.include_git_identity {
        read_git_identity()
    } else {
        GitIdentity::default()
    };

    let profile = EnvProfile {
        schema_version: devkit_types::plan::SchemaVersion::One,
        created_at: devkit_types::timeutil::iso8601_now(),
        devkit_version: env!("CARGO_PKG_VERSION").to_string(),
        machine: EnvProfileMachine {
            platform: "win32".to_string(),
            arch: std::env::consts::ARCH.to_string(),
            os_release: devkit_sys::registry::windows_build_number()
                .map(|build| format!("10.0.{build}"))
                .unwrap_or_else(|| "unknown".to_string()),
        },
        detected: context
            .detections
            .iter()
            .map(|result| DetectedToolEntry {
                tool_id: result.tool_id.clone(),
                status: result.status,
                version: result.installed_version.clone(),
            })
            .collect(),
        installed: context
            .installed
            .iter()
            .map(|item| InstalledToolEntry {
                tool_id: item.tool_id.clone(),
                version: item.version.clone(),
                activated: item.active,
            })
            .collect(),
        user_path_extra,
        env,
        mirrors: context
            .mirrors
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let current = current_values.get(index).and_then(|value| value.clone());
                EnvProfileMirrorEntry {
                    target: serde_json::to_value(item.target)
                        .ok()
                        .and_then(|value| value.as_str().map(|tag| tag.to_string()))
                        .unwrap_or_default(),
                    url: if item.enabled {
                        current.or_else(|| Some(item.url.clone()))
                    } else {
                        None
                    },
                }
            })
            .collect(),
        git: EnvProfileGit {
            user_name: git.user_name,
            user_email: git.user_email,
        },
        vscode_extensions,
        selections,
    };

    logging::global().info(
        "profile",
        &format!(
            "已收集环境档案：{} 个检测结果、{} 个 devkit 安装、{} 条自定义 PATH、{} 个环境变量、{} 个插件",
            profile.detected.len(),
            profile.installed.len(),
            profile.user_path_extra.len(),
            profile.env.len(),
            profile.vscode_extensions.len()
        ),
    );
    profile
}

/// 校验一份外部拿到的档案（可能是别人给的，不能直接信）
pub fn sanitize_profile(raw: &serde_json::Value) -> Result<EnvProfile, String> {
    let Some(object) = raw.as_object() else {
        return Err("档案不是一个对象".to_string());
    };
    if object.get("schemaVersion").and_then(|value| value.as_u64()) != Some(1) {
        return Err(format!(
            "档案版本不支持：{}",
            object
                .get("schemaVersion")
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".to_string())
        ));
    }

    let tool_id_ok = |id: &str| {
        let bytes = id.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 40
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..]
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    };
    let version_ok = |version: &str| {
        let bytes = version.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 40
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    };

    let safe_selections: Vec<PlanSelection> = object
        .get("selections")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    let tool_id = item.get("toolId").and_then(|value| value.as_str())?;
                    if !tool_id_ok(tool_id) {
                        return None;
                    }
                    let version = item.get("version").and_then(|value| value.as_str());
                    Some(PlanSelection {
                        tool_id: tool_id.to_string(),
                        version: version
                            .filter(|value| version_ok(value))
                            .map(|value| value.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let safe_path_extra: Vec<String> = object
        .get("userPathExtra")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|entry| {
                    regex::Regex::new(r"^[a-zA-Z]:[\\/]")
                        .unwrap()
                        .is_match(entry)
                })
                .map(|entry| entry.to_string())
                .collect()
        })
        .unwrap_or_default();

    let mut env: HashMap<String, String> = HashMap::new();
    if let Some(env_object) = object.get("env").and_then(|value| value.as_object()) {
        for (name, value) in env_object {
            // 只收白名单里的变量名 —— 别人给的档案不能往我们环境里塞任意变量
            if !PROFILE_ENV_ALLOWLIST.contains(&name.as_str()) {
                continue;
            }
            if let Some(text) = value.as_str() {
                if text.len() <= 500 {
                    env.insert(name.clone(), text.to_string());
                }
            }
        }
    }

    let detected: Vec<DetectedToolEntry> = object
        .get("detected")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let installed: Vec<InstalledToolEntry> = object
        .get("installed")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let mirrors: Vec<EnvProfileMirrorEntry> = object
        .get("mirrors")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let vscode_extensions: Vec<String> = object
        .get("vscodeExtensions")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| item.as_str().map(|text| text.to_string()))
                .take(500)
                .collect()
        })
        .unwrap_or_default();
    let machine = object
        .get("machine")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let machine: EnvProfileMachine = serde_json::from_value(machine).unwrap_or(EnvProfileMachine {
        platform: "unknown".to_string(),
        arch: "unknown".to_string(),
        os_release: "unknown".to_string(),
    });
    let git: EnvProfileGit = object
        .get("git")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or(EnvProfileGit {
            user_name: None,
            user_email: None,
        });

    Ok(EnvProfile {
        schema_version: devkit_types::plan::SchemaVersion::One,
        created_at: object
            .get("createdAt")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(devkit_types::timeutil::iso8601_now),
        devkit_version: object
            .get("devkitVersion")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        machine,
        detected,
        installed,
        user_path_extra: safe_path_extra,
        env,
        mirrors,
        git,
        vscode_extensions,
        selections: safe_selections,
    })
}

/// 档案对比上下文
pub struct DiffContext<'a> {
    pub tools: &'a [devkit_types::manifest::ToolManifest],
    pub detections: &'a [devkit_types::detection::DetectionResult],
    pub installed: &'a [devkit_types::activation::InstalledTool],
}

/// 档案 vs 本机：缺什么、版本差什么、已经有什么
pub fn diff_profile(profile: &EnvProfile, context: &DiffContext<'_>) -> ProfileDiff {
    let detection_by_id: HashMap<&str, &devkit_types::detection::DetectionResult> = context
        .detections
        .iter()
        .map(|item| (item.tool_id.as_str(), item))
        .collect();
    let installed_by_id: HashMap<&str, &devkit_types::activation::InstalledTool> = context
        .installed
        .iter()
        .map(|item| (item.tool_id.as_str(), item))
        .collect();

    let tools: Vec<ProfileDiffEntry> = profile
        .selections
        .iter()
        .map(|selection| {
            let tool = context
                .tools
                .iter()
                .find(|tool| tool.id == selection.tool_id);
            let detection = detection_by_id.get(selection.tool_id.as_str()).copied();
            let mine = installed_by_id.get(selection.tool_id.as_str()).copied();

            let state = if mine.is_some() {
                ProfileToolState::InstalledByDevkit
            } else if detection.is_some_and(|item| item.status == DetectionStatus::Installed) {
                ProfileToolState::AlreadyPresent
            } else if detection.is_some_and(|item| {
                matches!(
                    item.status,
                    DetectionStatus::VersionMismatch | DetectionStatus::PathMissing
                )
            }) {
                ProfileToolState::VersionDiffers
            } else {
                ProfileToolState::Missing
            };

            ProfileDiffEntry {
                tool_id: selection.tool_id.clone(),
                name: tool.map(|tool| tool.name.clone()),
                wanted_version: selection.version.clone(),
                current_version: mine
                    .map(|mine| mine.version.clone())
                    .or_else(|| detection.and_then(|item| item.installed_version.clone())),
                state,
            }
        })
        .collect();

    // PATH 条目：档案里有、本机没有的
    let current_path = read_user_path_blocking();
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let current_entries: HashSet<String> = analyze_path(
        &current_path,
        &|path| std::path::Path::new(path).exists(),
        &env_map,
    )
    .entries
    .iter()
    .map(|entry| normalize_entry(&entry.raw))
    .collect();
    let missing_path_entries: Vec<String> = profile
        .user_path_extra
        .iter()
        .filter(|entry| !current_entries.contains(&normalize_entry(entry)))
        .cloned()
        .collect();

    // 环境变量：档案里有、本机没有或值不同的
    let mut env_to_restore: HashMap<String, String> = HashMap::new();
    for (name, value) in &profile.env {
        let current = read_user_env_blocking(name);
        if current.as_deref() != Some(value.as_str()) {
            env_to_restore.insert(name.clone(), value.clone());
        }
    }

    let to_install = tools
        .iter()
        .filter(|entry| {
            matches!(
                entry.state,
                ProfileToolState::Missing | ProfileToolState::VersionDiffers
            )
        })
        .count();
    let already_present = tools.len() - to_install;
    let diff = ProfileDiff {
        tools,
        missing_path_entries: missing_path_entries.clone(),
        env_to_restore: env_to_restore.clone(),
        vscode_extensions: profile.vscode_extensions.clone(),
        summary: ProfileSummary {
            to_install: to_install as u32,
            already_present: already_present as u32,
            path_entries: missing_path_entries.len() as u32,
            env_vars: env_to_restore.len() as u32,
        },
    };

    logging::global().info(
        "profile",
        &format!(
            "档案差异：需安装 {}、已有 {}、PATH 待恢复 {}、环境变量待恢复 {}",
            diff.summary.to_install,
            diff.summary.already_present,
            diff.summary.path_entries,
            diff.summary.env_vars
        ),
    );
    diff
}

fn write_user_env_blocking(name: &str, value: &str) -> Result<(), String> {
    devkit_sys::user_env::write_user_env(name, Some(value))
}

fn write_user_path_blocking(value: &str) -> Result<(), String> {
    devkit_sys::user_env::write_user_path(value)
}

fn git_config_global(key: &str, value: &str) -> bool {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return false,
    };
    let result = runtime.block_on(run_command(
        "git",
        &[
            "config".to_string(),
            "--global".to_string(),
            key.to_string(),
            value.to_string(),
        ],
        &RunOptions {
            timeout_ms: Some(15_000),
            ..Default::default()
        },
    ));
    result.code == Some(0)
}

/// 执行档案恢复。
///
/// 只做"环境配置"部分（PATH / 环境变量 / 镜像 / git）；
/// **装软件不在这里做** —— 返回 selections，由界面走现有的安装流程。
///
/// 注意：PATH 与环境变量的恢复**必须先备份**（调用方/应用层保证；
/// 这里沿用 devkit-sys 的 write_user_path —— 它不带备份，所以先在函数内写备份文件）。
pub fn apply_profile(profile: &EnvProfile, options: &ApplyProfileOptions) -> ApplyProfileResult {
    let mut changed: Vec<String> = Vec::new();

    let result = (|| -> Result<(), String> {
        if options.restore_user_path && !profile.user_path_extra.is_empty() {
            let raw = read_user_path_blocking();
            let env_map: HashMap<String, String> = std::env::vars().collect();
            let existing: HashSet<String> =
                analyze_path(&raw, &|path| std::path::Path::new(path).exists(), &env_map)
                    .entries
                    .iter()
                    .map(|entry| normalize_entry(&entry.raw))
                    .collect();
            let to_add: Vec<&String> = profile
                .user_path_extra
                .iter()
                .filter(|entry| !existing.contains(&normalize_entry(entry)))
                .collect();

            if !to_add.is_empty() {
                // 先备份原文（与 doctor 修复同一条规矩）
                let backup_dir = crate::app_paths::get_backup_dir();
                std::fs::create_dir_all(&backup_dir)
                    .map_err(|error| format!("创建备份目录失败：{error}"))?;
                let backup_file = backup_dir.join(format!(
                    "user-path-{}.txt",
                    crate::logging::timestamp_slug()
                ));
                std::fs::write(&backup_file, &raw)
                    .map_err(|error| format!("写 PATH 备份失败：{error}"))?;
                logging::global().info(
                    "profile",
                    &format!("恢复 PATH 前已备份原文：{}", backup_file.display()),
                );

                // 追加到末尾而不是插到最前：档案来自另一台机器，不确定它的优先级意图
                let next = if raw.trim().is_empty() {
                    to_add
                        .iter()
                        .map(|entry| entry.as_str())
                        .collect::<Vec<_>>()
                        .join(";")
                } else {
                    format!(
                        "{raw};{}",
                        to_add
                            .iter()
                            .map(|entry| entry.as_str())
                            .collect::<Vec<_>>()
                            .join(";")
                    )
                };
                write_user_path_blocking(&next)?;
                for entry in &to_add {
                    changed.push(format!("用户 PATH += {entry}"));
                }
            }
        }

        if options.restore_env {
            for (name, value) in &profile.env {
                write_user_env_blocking(name, value)?;
                changed.push(format!("环境变量 {name} = {value}"));
            }
        }

        if options.restore_mirrors && !profile.mirrors.is_empty() {
            let valid_targets: HashSet<String> = MIRROR_TARGETS
                .iter()
                .filter_map(|target| {
                    serde_json::to_value(target)
                        .ok()
                        .and_then(|value| value.as_str().map(|tag| tag.to_string()))
                })
                .collect();
            let settings: Vec<devkit_types::settings::MirrorSetting> = profile
                .mirrors
                .iter()
                .filter(|item| item.url.is_some())
                .filter(|item| valid_targets.contains(&item.target))
                .map(|item| devkit_types::settings::MirrorSetting {
                    target: serde_json::from_value(serde_json::Value::String(item.target.clone()))
                        .unwrap_or(MirrorTarget::Npm),
                    enabled: true,
                    url: item.url.clone().unwrap_or_default(),
                })
                .collect();
            if !settings.is_empty() {
                let result = apply_mirrors(&settings);
                changed.extend(result.changed);
            }
        }

        if options.restore_git {
            if let (Some(user_name), Some(user_email)) =
                (&profile.git.user_name, &profile.git.user_email)
            {
                if git_config_global("user.name", user_name) {
                    changed.push(format!("git config --global user.name = {user_name}"));
                }
                if git_config_global("user.email", user_email) {
                    changed.push(format!("git config --global user.email = {user_email}"));
                }
            }
        }

        Ok(())
    })();

    match result {
        Ok(()) => {
            logging::global().info(
                "profile",
                &format!("档案恢复完成：{} 项变更", changed.len()),
            );
            ApplyProfileResult {
                ok: true,
                changed,
                selections: profile.selections.clone(),
                error: None,
            }
        }
        Err(error) => {
            logging::global().error("profile", &format!("档案恢复失败：{error}"));
            ApplyProfileResult {
                ok: false,
                changed,
                selections: profile.selections.clone(),
                error: Some(error),
            }
        }
    }
}

/// 给界面显示的档案摘要（导入后先让用户看清里面是什么）
pub fn describe_profile(profile: &EnvProfile) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "来源：{} / {} / build {}",
        profile.machine.platform, profile.machine.arch, profile.machine.os_release
    ));
    lines.push(format!("生成时间：{}", profile.created_at));
    lines.push(format!(
        "工具：{} 项要装，其中 devkit 装过的 {} 项",
        profile.selections.len(),
        profile.installed.len()
    ));
    lines.push(format!("自定义 PATH：{} 条", profile.user_path_extra.len()));
    lines.push(format!(
        "环境变量：{} 个{}",
        profile.env.len(),
        if profile.env.is_empty() {
            String::new()
        } else {
            format!(
                "（{}）",
                profile.env.keys().cloned().collect::<Vec<_>>().join("、")
            )
        }
    ));
    lines.push(format!(
        "镜像源：{} 项已配置",
        profile
            .mirrors
            .iter()
            .filter(|item| item.url.is_some())
            .count()
    ));
    lines.push(format!(
        "VS Code 插件：{} 个",
        profile.vscode_extensions.len()
    ));
    if let Some(user_name) = &profile.git.user_name {
        lines.push(format!(
            "git 身份：{user_name} <{}>",
            profile
                .git
                .user_email
                .clone()
                .unwrap_or_else(|| "—".to_string())
        ));
    }
    lines
}

/// 档案默认保存位置（用户可以在保存对话框里改）
pub fn default_profile_file_name() -> String {
    let stamp = &devkit_types::timeutil::iso8601_now()[..10];
    format!("devkit-profile-{stamp}.json")
}

#[allow(unused)]
fn unused_localized_helper(_: LocalizedText) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> EnvProfile {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "devkitVersion": "0.6.2",
            "machine": {"platform": "win32", "arch": "x86_64", "osRelease": "10.0.26300"},
            "detected": [{"toolId": "git", "status": "installed", "version": "2.43.0"}],
            "installed": [],
            "userPathExtra": [r"D:\tools\bin", "%systemroot%\\System32"],
            "env": {"JAVA_HOME": r"D:\jdk", "EVIL_VAR": "x"},
            "mirrors": [{"target": "npm", "url": "https://npmmirror.com"}],
            "git": {"userName": "张三", "userEmail": "z@x.com"},
            "vscodeExtensions": ["ms-python.python"],
            "selections": [{"toolId": "git"}, {"toolId": "nodejs", "version": "20.11.1"}]
        }))
        .unwrap()
    }

    #[test]
    fn sanitize_filters_env_allowlist_and_path_shapes() {
        let profile = sample_profile();
        let sanitized = sanitize_profile(&serde_json::to_value(&profile).unwrap()).unwrap();

        // env 只收白名单：EVIL_VAR 被丢掉
        assert!(sanitized.env.contains_key("JAVA_HOME"));
        assert!(!sanitized.env.contains_key("EVIL_VAR"));

        // userPathExtra 只收绝对路径：%systemroot% 开头但不是盘符路径 → 被过滤
        assert_eq!(sanitized.user_path_extra, vec![r"D:\tools\bin".to_string()]);

        // git 身份保留
        assert_eq!(sanitized.git.user_name.as_deref(), Some("张三"));
        assert_eq!(
            sanitized.vscode_extensions,
            vec!["ms-python.python".to_string()]
        );
        assert_eq!(sanitized.selections.len(), 2);
    }

    #[test]
    fn sanitize_rejects_wrong_schema_and_non_object() {
        assert!(sanitize_profile(&serde_json::json!({"schemaVersion": 2})).is_err());
        assert!(sanitize_profile(&serde_json::json!("not an object")).is_err());
        assert!(sanitize_profile(&serde_json::json!(null)).is_err());
    }

    #[test]
    fn describe_profile_lists_lines() {
        let lines = describe_profile(&sample_profile());
        assert!(lines.iter().any(|line| line.contains("win32")));
        assert!(lines.iter().any(|line| line.contains("2 项要装")));
        assert!(lines.iter().any(|line| line.contains("2 条")));
        assert!(lines
            .iter()
            .any(|line| line.contains("git 身份：张三 <z@x.com>")));
    }

    #[test]
    fn default_profile_file_name_has_date() {
        let name = default_profile_file_name();
        assert!(name.starts_with("devkit-profile-"), "{name}");
        assert!(name.ends_with(".json"));
    }
}
