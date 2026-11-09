//! 环境体检（镜像 `src/main/core/doctor/index.ts` + `fix.ts`）。
//!
//! 设计原则：
//!  1. **诊断阶段不写任何东西** —— 所有检查都是读注册表/读文件系统/跑 where
//!  2. 修复必须显式触发，而且**先备份**
//!  3. 用户级修复直接做；机器级修复要管理员，单独确认（提权助手）
//!  4. 每条发现都给「人话解释 + 具体证据（是哪一条、值是什么）」，而不是一句"环境有问题"

pub mod paths;

pub use paths::{
    analysis_to_view, analyze_path, expand_with_report, normalize_entry, PathAnalysis,
    TOTAL_PATH_WARN_LENGTH, USER_PATH_WARN_LENGTH,
};

use crate::activate::index::{
    deactivate_tool, get_link_path, read_activation_state, remove_junction, UserEnvIo,
};
use crate::activate::machine_path::read_machine_path_raw;
use crate::app_paths::{get_backup_dir, get_current_root, get_data_root};
use crate::elevation::{ElevatedRunner, ElevatedStep};
use crate::logging;
use crate::systemconfig::get_system_config_status;
use devkit_types::doctor::{
    DoctorCategory, DoctorFinding, DoctorFix, DoctorFixId, DoctorFixResult, DoctorLevel,
    DoctorReport, DoctorSummary, FixScope, PathEntryKind,
};
use devkit_types::locale::LocalizedText;
use devkit_types::timeutil::iso8601_now;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// 每个工具在 PATH 上解析到几个目标（多于一个就说明"跑的不是你以为的那个"）
pub type CommandResolver<'a> = &'a dyn Fn(&str) -> Vec<String>;

/// 体检的读入（应用层注入真实实现；测试注入内存值）
pub struct DoctorInputs<'a> {
    pub read_user_path: &'a dyn Fn() -> Result<String, String>,
    pub read_machine_path: &'a dyn Fn() -> Result<String, String>,
    pub resolve_command: CommandResolver<'a>,
    /// 环境变量快照（大小写不敏感查找由 paths 负责）
    pub env: HashMap<String, String>,
    /// 目录是否存在（默认 std::path::Path::exists；测试可注入）
    pub exists: &'a dyn Fn(&str) -> bool,
}

const COMMANDS_TO_PROBE: &[&str] =
    &["node", "npm", "python", "java", "git", "code", "go", "docker"];

/// 关键环境变量：值指向的目录必须存在
const ENV_VARS_TO_CHECK: &[&str] =
    &["JAVA_HOME", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "MAVEN_HOME", "PYTHONHOME"];

fn lt(zh: &str, en: &str) -> LocalizedText {
    [("zh-CN".to_string(), zh.to_string()), ("en-US".to_string(), en.to_string())]
        .into_iter()
        .collect()
}

fn judge(kind: PathEntryKind) -> bool {
    matches!(kind, PathEntryKind::Malformed | PathEntryKind::Missing | PathEntryKind::UnexpandedVar)
}

pub async fn run_doctor(inputs: &DoctorInputs<'_>) -> DoctorReport {
    let mut findings: Vec<DoctorFinding> = Vec::new();

    let user_raw = (inputs.read_user_path)().unwrap_or_default();
    let machine_raw = (inputs.read_machine_path)().unwrap_or_default();

    let user_analysis = analyze_path(&user_raw, inputs.exists, &inputs.env);
    let machine_analysis = analyze_path(&machine_raw, inputs.exists, &inputs.env);

    /* ---------------- 1. 用户级 PATH ---------------- */
    if !user_analysis.problems.is_empty() {
        findings.push(DoctorFinding {
            id: "user-path-problems".to_string(),
            level: if user_analysis.problems.iter().any(|entry| judge(entry.kind)) {
                DoctorLevel::Error
            } else {
                DoctorLevel::Warn
            },
            category: DoctorCategory::Path,
            title: lt("用户 PATH 里有无效条目", "Your user PATH contains invalid entries"),
            detail: lt(
                "这些条目指向不存在的目录、或者是相对路径/被截断的片段。它们不会让系统崩溃，\
                 但会拖慢每一次命令查找，也会让\"装了却跑不起来\"变得难以排查。",
                "These entries point at non-existent directories, or are relative/truncated fragments. \
                 They do not break Windows, but they slow down every command lookup and make \
                 \"installed but not found\" much harder to debug.",
            ),
            evidence: user_analysis
                .problems
                .iter()
                .map(|entry| format!("第 {} 条：{} —— {}", entry.index, entry.raw, entry.reason.clone().unwrap_or_default()))
                .collect(),
            fix: Some(DoctorFix {
                id: DoctorFixId::CleanUserPath,
                label: lt("清理用户 PATH", "Clean user PATH"),
                scope: FixScope::User,
            }),
        });
    } else {
        findings.push(DoctorFinding {
            id: "user-path-ok".to_string(),
            level: DoctorLevel::Ok,
            category: DoctorCategory::Path,
            title: lt("用户 PATH 正常", "User PATH is healthy"),
            detail: lt(
                &format!("共 {} 条，全部指向存在的目录，没有重复。", user_analysis.entries.len()),
                &format!(
                    "{} entries, all pointing at existing directories, no duplicates.",
                    user_analysis.entries.len()
                ),
            ),
            evidence: Vec::new(),
            fix: None,
        });
    }

    /* ---------------- 2. 机器级 PATH（只读诊断） ---------------- */
    if !machine_analysis.problems.is_empty() {
        findings.push(DoctorFinding {
            id: "machine-path-problems".to_string(),
            level: DoctorLevel::Error,
            category: DoctorCategory::Path,
            title: lt("机器级 PATH 里有无效条目", "The machine-level PATH contains invalid entries"),
            detail: lt(
                "机器级 PATH 对所有用户生效，改它需要管理员权限。下面这些条目多半是历史上某个安装器\
                 用 setx 之类写 PATH 时被截断留下的 —— `C:\\P`、`ogram Files\\Git\\cmd` 这种片段就是典型痕迹。\
                 devkit **只做诊断，不会自动改机器级 PATH**；要清理请点修复并确认提权。",
                "The machine PATH applies to every user and changing it needs admin rights. These entries \
                 are usually leftovers from an installer truncating PATH via setx — fragments like `C:\\P` \
                 or `ogram Files\\Git\\cmd` are the giveaway. devkit only diagnoses this; cleaning it is an \
                 explicit, elevated action.",
            ),
            evidence: machine_analysis
                .problems
                .iter()
                .map(|entry| format!("第 {} 条：{} —— {}", entry.index, entry.raw, entry.reason.clone().unwrap_or_default()))
                .collect(),
            fix: Some(DoctorFix {
                id: DoctorFixId::CleanMachinePath,
                label: lt("清理机器级 PATH（需要管理员）", "Clean machine PATH (needs admin)"),
                scope: FixScope::Machine,
            }),
        });
    } else {
        findings.push(DoctorFinding {
            id: "machine-path-ok".to_string(),
            level: DoctorLevel::Ok,
            category: DoctorCategory::Path,
            title: lt("机器级 PATH 正常", "Machine PATH is healthy"),
            detail: lt(
                &format!("共 {} 条，没有发现问题。", machine_analysis.entries.len()),
                &format!("{} entries, nothing wrong found.", machine_analysis.entries.len()),
            ),
            evidence: Vec::new(),
            fix: None,
        });
    }

    /* ---------------- 3. PATH 长度 ---------------- */
    if user_raw.chars().count() > USER_PATH_WARN_LENGTH {
        findings.push(DoctorFinding {
            id: "user-path-too-long".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::Path,
            title: lt("用户 PATH 过长", "User PATH is too long"),
            detail: lt(
                "PATH 越长，每敲一条命令系统就要多查一圈；而且不少老工具会在这个长度上出问题。\
                 清理掉无效条目通常能缩短一大截。",
                "The longer PATH gets, the more the shell has to scan for every command, and older tools \
                 start misbehaving. Cleaning invalid entries usually shortens it a lot.",
            ),
            evidence: vec![format!(
                "当前 {} 字符，建议控制在 {} 以内",
                user_raw.chars().count(),
                USER_PATH_WARN_LENGTH
            )],
            fix: None,
        });
    }

    let total_length = user_raw.chars().count() + machine_raw.chars().count();
    if total_length > TOTAL_PATH_WARN_LENGTH {
        findings.push(DoctorFinding {
            id: "total-path-too-long".to_string(),
            level: DoctorLevel::Error,
            category: DoctorCategory::Path,
            title: lt("PATH 总长度接近系统上限", "Total PATH is near the system limit"),
            detail: lt(
                "用户级与机器级加起来已经接近 Windows 的实际可用上限，继续加条目会开始随机失效。",
                "User and machine PATH combined are near what Windows can practically handle; adding more \
                 entries starts failing unpredictably.",
            ),
            evidence: vec![format!(
                "用户 {} + 机器 {} = {} 字符",
                user_raw.chars().count(),
                machine_raw.chars().count(),
                total_length
            )],
            fix: None,
        });
    }

    /* ---------------- 4. 命令解析（跑的是不是你以为的那个） ---------------- */
    let resolved: Vec<(String, Vec<String>)> = COMMANDS_TO_PROBE
        .iter()
        .map(|cmd| ((*cmd).to_string(), (inputs.resolve_command)(cmd)))
        .collect();
    let ambiguous: Vec<&(String, Vec<String>)> =
        resolved.iter().filter(|(_, paths)| paths.len() > 1).collect();
    let found: Vec<&(String, Vec<String>)> =
        resolved.iter().filter(|(_, paths)| !paths.is_empty()).collect();

    if !ambiguous.is_empty() {
        let mut evidence: Vec<String> = Vec::new();
        for (cmd, paths) in &ambiguous {
            for (i, path) in paths.iter().enumerate() {
                evidence.push(format!(
                    "{cmd} → {path}{}",
                    if i == 0 { "（实际生效）" } else { "" }
                ));
            }
        }
        findings.push(DoctorFinding {
            id: "command-ambiguous".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::Command,
            title: lt("有命令解析到多个位置", "Some commands resolve to more than one location"),
            detail: lt(
                "同一个命令在 PATH 上有多份时，实际跑的是**排在最前面**的那一个。\
                 这经常造成\"我明明装了新版本，跑的却是旧版本\"。",
                "When a command exists in several PATH entries, the one that runs is the **first** one. \
                 This is the usual cause of \"I installed the new version but the old one runs\".",
            ),
            evidence,
            fix: None,
        });
    }

    if found.is_empty() {
        findings.push(DoctorFinding {
            id: "no-commands".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::Command,
            title: lt("PATH 上没有任何开发命令", "No developer commands on PATH"),
            detail: lt(
                "node / python / git / java 等一个都找不到。如果这是一台新机器，这很正常。",
                "None of node / python / git / java were found. On a fresh machine that is expected.",
            ),
            evidence: Vec::new(),
            fix: None,
        });
    } else {
        findings.push(DoctorFinding {
            id: "commands-found".to_string(),
            level: DoctorLevel::Ok,
            category: DoctorCategory::Command,
            title: lt("PATH 上的开发命令", "Developer commands on PATH"),
            detail: lt(
                &format!("找到 {} 个命令。", found.len()),
                &format!("Found {} commands.", found.len()),
            ),
            evidence: found
                .iter()
                .filter_map(|(cmd, paths)| paths.first().map(|first| format!("{cmd} → {first}")))
                .collect(),
            fix: None,
        });
    }

    /* ---------------- 5. 关键环境变量 ---------------- */
    let mut bad_env: Vec<String> = Vec::new();
    for name in ENV_VARS_TO_CHECK {
        let Some(value) = paths::lookup_env(&inputs.env, name) else {
            continue;
        };
        if value.trim().is_empty() {
            bad_env.push(format!("{name} 是空值"));
            continue;
        }
        if !(inputs.exists)(&value) {
            bad_env.push(format!("{name} = {value}（这个目录不存在）"));
        }
    }

    if !bad_env.is_empty() {
        findings.push(DoctorFinding {
            id: "env-var-broken".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::Env,
            title: lt(
                "有环境变量指向不存在的位置",
                "Some environment variables point at missing locations",
            ),
            detail: lt(
                "这类变量（JAVA_HOME / GOROOT 等）指向不存在的目录时，构建工具会报一些很难懂的错。\
                 通常是工具卸载或换了安装位置之后忘了改。",
                "When these variables (JAVA_HOME / GOROOT …) point at missing directories, build tools fail \
                 with confusing errors. Usually a leftover after uninstalling or relocating a tool.",
            ),
            evidence: bad_env,
            fix: None,
        });
    }

    /* ---------------- 6. devkit 自身一致性 ---------------- */
    let mut dangling: Vec<String> = Vec::new();
    let state = read_activation_state();
    for record in &state.records {
        if !(inputs.exists)(&record.target) {
            dangling.push(format!(
                "{}：激活记录指向 {}，但这个目录已经不在了",
                record.tool_id, record.target
            ));
        }
    }
    // PATH 里还有 devkit 的条目、但记录里没有对应工具
    for entry in &user_analysis.entries {
        let lowered = entry.raw.to_lowercase();
        if !lowered.contains("devkit") && !lowered.contains(".devkit") {
            continue;
        }
        let still_managed = state.records.iter().any(|record| {
            record
                .path_entries
                .iter()
                .any(|path| path.to_lowercase() == lowered)
        });
        if !still_managed {
            dangling.push(format!(
                "PATH 里有 devkit 条目「{}」，但激活记录里已经没有它了",
                entry.raw
            ));
        }
    }

    if !dangling.is_empty() {
        findings.push(DoctorFinding {
            id: "devkit-dangling".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::Devkit,
            title: lt("devkit 激活状态有残留", "Leftover devkit activation state"),
            detail: lt(
                "激活记录与实际情况对不上，多半是手工删过版本目录。可以一键清理残留。",
                "Activation records no longer match reality — usually because a version directory was \
                 deleted by hand. This can be cleaned up in one step.",
            ),
            evidence: dangling,
            fix: Some(DoctorFix {
                id: DoctorFixId::PruneDevkitState,
                label: lt("清理 devkit 残留", "Clean up devkit leftovers"),
                scope: FixScope::User,
            }),
        });
    }

    let activated: Vec<String> = state
        .records
        .iter()
        .map(|record| format!("{}@{}", record.tool_id, record.version))
        .collect();
    findings.push(DoctorFinding {
        id: "devkit-state".to_string(),
        level: DoctorLevel::Ok,
        category: DoctorCategory::Devkit,
        title: lt("devkit 状态", "devkit state"),
        detail: lt(
            &format!(
                "数据根目录：{}\n当前激活：{}",
                get_data_root().display(),
                if activated.is_empty() {
                    "（没有激活任何工具）".to_string()
                } else {
                    activated.join("、")
                }
            ),
            &format!(
                "Data root: {}\nActivated: {}",
                get_data_root().display(),
                if activated.is_empty() { "(nothing activated)".to_string() } else { activated.join(", ") }
            ),
        ),
        evidence: vec![
            format!("切换链接目录：{}", get_current_root().display()),
            format!(
                "PATH 备份：{}",
                state
                    .backup_file
                    .clone()
                    .unwrap_or_else(|| "（还没改过用户 PATH，所以没有备份）".to_string())
            ),
        ],
        fix: None,
    });

    /* ---------------- 7. 系统项（复用 systemconfig 的只读检测） ---------------- */
    let system_items = get_system_config_status().await;
    let not_configured: Vec<_> = system_items.iter().filter(|item| !item.configured).collect();
    if !not_configured.is_empty() {
        findings.push(DoctorFinding {
            id: "system-items".to_string(),
            level: DoctorLevel::Warn,
            category: DoctorCategory::System,
            title: lt("有系统项未配置", "Some system settings are not configured"),
            detail: lt(
                "这些不是\"坏了\"，但开了之后开发会顺很多。可以逐项在「设置 → 系统配置」里处理。",
                "These are not broken, but enabling them makes development smoother. Handle them under \
                 Settings → System configuration.",
            ),
            evidence: not_configured
                .iter()
                .map(|item| {
                    format!(
                        "{}：{}",
                        item.label.get("zh-CN").cloned().unwrap_or_else(|| format!("{:?}", item.id)),
                        item.detail
                    )
                })
                .collect(),
            fix: None,
        });
    }

    let summary = DoctorSummary {
        ok: findings.iter().filter(|item| item.level == DoctorLevel::Ok).count() as u32,
        warn: findings.iter().filter(|item| item.level == DoctorLevel::Warn).count() as u32,
        error: findings.iter().filter(|item| item.level == DoctorLevel::Error).count() as u32,
    };

    logging::global().info(
        "doctor",
        &format!(
            "体检完成：{} 个问题、{} 个注意、{} 项正常",
            summary.error, summary.warn, summary.ok
        ),
    );

    DoctorReport {
        ran_at: iso8601_now(),
        findings,
        summary,
        user_path: analysis_to_view(&user_analysis),
        machine_path: analysis_to_view(&machine_analysis),
    }
}

/* ------------------------------ 修复 ------------------------------ */

fn backup_file(kind: &str, content: &str) -> Result<String, String> {
    let dir = get_backup_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let file = dir.join(format!("{kind}-{}.txt", logging::timestamp_slug()));
    std::fs::write(&file, content).map_err(|error| format!("写备份文件失败：{error}"))?;
    logging::global().info("doctor", &format!("已备份 {kind} 原文：{}", file.display()));
    Ok(file.display().to_string())
}

/// 清理用户级 PATH：只删重复/不存在/畸形/未解析变量的条目
pub fn clean_user_path(io: &dyn UserEnvIo) -> DoctorFixResult {
    let raw = match io.read_path() {
        Ok(raw) => raw,
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: None, error: Some(error) }
        }
    };
    let env: HashMap<String, String> =
        std::env::vars().collect();
    let analysis = analyze_path(&raw, &|path| PathBuf::from(path).exists(), &env);

    if !analysis.changed {
        return DoctorFixResult { ok: true, changed: vec![], backup_file: None, error: None };
    }
    if analysis.suggested.trim().is_empty() {
        return DoctorFixResult {
            ok: false,
            changed: vec![],
            backup_file: None,
            error: Some("清理后用户 PATH 会变成空值，已拒绝执行。请手工检查（原文已保留）".to_string()),
        };
    }

    let file = match backup_file("user-path", &raw) {
        Ok(file) => file,
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: None, error: Some(error) }
        }
    };
    if let Err(error) = io.write_path(&analysis.suggested) {
        return DoctorFixResult { ok: false, changed: vec![], backup_file: Some(file), error: Some(error) };
    }

    // 复验：重新读一遍，确认真的写进去了
    match io.read_path() {
        Ok(after) if after == analysis.suggested => {}
        Ok(_) => {
            return DoctorFixResult {
                ok: false,
                changed: vec![],
                backup_file: Some(file),
                error: Some("写入后复验不一致，可能被其它程序改回去了。原文已备份，请手工确认".to_string()),
            }
        }
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: Some(file), error: Some(error) }
        }
    }

    let removed: Vec<String> = analysis
        .problems
        .iter()
        .map(|entry| format!("第 {} 条：{} —— {}", entry.index, entry.raw, entry.reason.clone().unwrap_or_default()))
        .collect();
    logging::global().info("doctor", &format!("用户 PATH 已清理：移除 {} 条", removed.len()));
    DoctorFixResult { ok: true, changed: removed, backup_file: Some(file), error: None }
}

/// 清理机器级 PATH（需要管理员）
pub fn clean_machine_path(elevated: &dyn ElevatedRunner) -> DoctorFixResult {
    let raw = match read_machine_path_raw_blocking() {
        Ok(raw) => raw,
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: None, error: Some(error) }
        }
    };
    let env: HashMap<String, String> =
        std::env::vars().collect();
    let analysis = analyze_path(&raw, &|path| PathBuf::from(path).exists(), &env);

    if !analysis.changed {
        return DoctorFixResult { ok: true, changed: vec![], backup_file: None, error: None };
    }
    if analysis.suggested.trim().is_empty() {
        return DoctorFixResult {
            ok: false,
            changed: vec![],
            backup_file: None,
            error: Some("清理后机器级 PATH 会变成空值，已拒绝执行。请手工检查".to_string()),
        };
    }

    let file = match backup_file("machine-path", &raw) {
        Ok(file) => file,
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: None, error: Some(error) }
        }
    };
    let outcome = elevated.run(vec![ElevatedStep::SetMachinePath {
        label: format!("清理机器级 PATH（移除 {} 条无效条目）", analysis.problems.len()),
        value: analysis.suggested.clone(),
    }]);
    if !outcome.ok {
        return DoctorFixResult {
            ok: false,
            changed: vec![],
            backup_file: Some(file),
            error: Some(if outcome.cancelled {
                "用户取消了管理员授权".to_string()
            } else {
                outcome.error.unwrap_or_else(|| "写入机器级 PATH 失败".to_string())
            }),
        };
    }

    match read_machine_path_raw_blocking() {
        Ok(after) if after == analysis.suggested => {}
        Ok(_) => {
            return DoctorFixResult {
                ok: false,
                changed: vec![],
                backup_file: Some(file),
                error: Some("写入后复验不一致。原文已备份，请手工确认".to_string()),
            }
        }
        Err(error) => {
            return DoctorFixResult { ok: false, changed: vec![], backup_file: Some(file), error: Some(error) }
        }
    }

    let removed: Vec<String> = analysis
        .problems
        .iter()
        .map(|entry| format!("第 {} 条：{} —— {}", entry.index, entry.raw, entry.reason.clone().unwrap_or_default()))
        .collect();
    logging::global().info("doctor", &format!("机器级 PATH 已清理：移除 {} 条", removed.len()));
    DoctorFixResult { ok: true, changed: removed, backup_file: Some(file), error: None }
}

/// 同步阻塞读机器 PATH（修复入口在同步上下文里调用）
fn read_machine_path_raw_blocking() -> Result<String, String> {
    let handle = std::thread::spawn(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("创建 runtime 失败：{error}"))?
            .block_on(read_machine_path_raw())
    });
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err("读取机器级 PATH 的线程崩溃".to_string()),
    }
}

/// 清理 devkit 残留：悬空的激活记录、指向不存在的版本的 junction、没人管的 PATH 条目
pub fn prune_devkit_state(io: &dyn UserEnvIo) -> DoctorFixResult {
    let mut changed: Vec<String> = Vec::new();
    let mut backup: Option<String> = None;

    let state = read_activation_state();
    for record in &state.records {
        if PathBuf::from(&record.target).exists() {
            continue;
        }
        let outcome = deactivate_tool(io, &record.tool_id);
        changed.push(format!(
            "移除悬空激活记录：{}@{}（目标 {} 已不存在）{}",
            record.tool_id,
            record.version,
            record.target,
            match outcome {
                Ok(_) => String::new(),
                Err(error) => format!("，但取消激活时报错：{error}"),
            }
        ));
    }

    // 再扫一遍用户 PATH：还有 devkit 目录下的条目、但没有任何记录认领它们
    let still_state = read_activation_state();
    let managed: HashSet<String> = still_state
        .records
        .iter()
        .flat_map(|record| record.path_entries.iter().map(|entry| entry.to_lowercase()))
        .collect();
    let raw = match io.read_path() {
        Ok(raw) => raw,
        Err(error) => {
            return DoctorFixResult { ok: false, changed, backup_file: None, error: Some(error) }
        }
    };
    let env: HashMap<String, String> =
        std::env::vars().collect();
    let analysis = analyze_path(&raw, &|path| PathBuf::from(path).exists(), &env);
    let orphans: Vec<_> = analysis
        .entries
        .iter()
        .filter(|entry| {
            let lowered = entry.raw.to_lowercase();
            let is_devkit_entry = lowered.contains(".devkit") || lowered.contains("%devkit_home%");
            is_devkit_entry && !managed.contains(&lowered)
        })
        .collect();

    if !orphans.is_empty() {
        match backup_file("user-path", &raw) {
            Ok(file) => backup = Some(file),
            Err(error) => {
                return DoctorFixResult { ok: false, changed, backup_file: None, error: Some(error) }
            }
        }
        let cleaned = analysis
            .entries
            .iter()
            .filter(|entry| !orphans.iter().any(|orphan| orphan.index == entry.index))
            .map(|entry| entry.raw.clone())
            .collect::<Vec<_>>()
            .join(";");

        if cleaned.trim().is_empty() {
            return DoctorFixResult {
                ok: false,
                changed,
                backup_file: backup,
                error: Some("清理后用户 PATH 会变成空值，已拒绝执行".to_string()),
            };
        }

        if let Err(error) = io.write_path(&cleaned) {
            return DoctorFixResult { ok: false, changed, backup_file: backup, error: Some(error) };
        }
        for orphan in &orphans {
            changed.push(format!("移除无人认领的 devkit PATH 条目：{}", orphan.raw));
        }
    }

    // 切换链接目录里如果有指向不存在目标的链接，一并清掉
    for record in &still_state.records {
        let link_path = get_link_path(&record.link_name);
        if link_path.exists() && !PathBuf::from(&record.target).exists()
            && remove_junction(&link_path).unwrap_or(false) {
                changed.push(format!("移除悬空切换链接：{}", link_path.display()));
            }
    }

    if changed.is_empty() {
        return DoctorFixResult { ok: true, changed: vec![], backup_file: None, error: None };
    }
    logging::global().info("doctor", &format!("devkit 残留已清理：{} 项", changed.len()));
    DoctorFixResult { ok: true, changed, backup_file: backup, error: None }
}

pub fn apply_doctor_fix(
    io: &dyn UserEnvIo,
    elevated: &dyn ElevatedRunner,
    fix_id: DoctorFixId,
) -> DoctorFixResult {
    let result = match fix_id {
        DoctorFixId::CleanUserPath => clean_user_path(io),
        DoctorFixId::CleanMachinePath => clean_machine_path(elevated),
        DoctorFixId::PruneDevkitState => prune_devkit_state(io),
    };
    if !result.ok {
        logging::global().error(
            "doctor",
            &format!("修复 {fix_id:?} 失败：{}", result.error.clone().unwrap_or_default()),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::ENV_TEST_LOCK;
    use crate::elevation::{ElevatedOutcome, ElevatedRunner, ElevatedStep};
    use std::sync::MutexGuard;

    struct FakeIo {
        path: std::sync::Mutex<String>,
    }

    impl UserEnvIo for FakeIo {
        fn read_env(&self, _name: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn write_env(&self, _name: &str, _value: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn read_path(&self) -> Result<String, String> {
            Ok(self.path.lock().unwrap().clone())
        }
        fn write_path(&self, value: &str) -> Result<(), String> {
            *self.path.lock().unwrap() = value.to_string();
            Ok(())
        }
    }

    struct FakeElevation {
        cancel: bool,
    }

    impl ElevatedRunner for FakeElevation {
        fn run(&self, _steps: Vec<ElevatedStep>) -> ElevatedOutcome {
            if self.cancel {
                ElevatedOutcome { ok: false, cancelled: true, error: None }
            } else {
                ElevatedOutcome { ok: true, cancelled: false, error: None }
            }
        }
    }

    fn sandbox(tag: &str) -> MutexGuard<'static, ()> {
        let guard = ENV_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("devkit-doctor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DEVKIT_APP_DATA", &dir);
        guard
    }

    fn fake_exists<'a>(paths: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        let set: HashSet<String> = paths.iter().map(|p| normalize_entry(p)).collect();
        move |path: &str| set.contains(&normalize_entry(path))
    }

    #[test]
    fn doctor_reports_dirty_paths_with_evidence() {
        let _guard = sandbox("report");
        let io = FakeIo { path: std::sync::Mutex::new(String::new()) };
        let elevated = FakeElevation { cancel: false };

        // 用户 PATH 脏、机器 PATH 干净；命令解析模拟 node 两个路径
        let user_raw = std::sync::Mutex::new(r"C:\Windows;C:\P;%NOODE_PATH%;v16.13.1".to_string());
        let machine_raw = std::sync::Mutex::new(r"C:\Windows\System32".to_string());

        let read_user = || Ok(user_raw.lock().unwrap().clone());
        let read_machine = || Ok(machine_raw.lock().unwrap().clone());
        let resolve = |cmd: &str| -> Vec<String> {
            if cmd == "node" {
                vec![r"C:\nodejs\node.exe".to_string(), r"D:\old\node.exe".to_string()]
            } else {
                Vec::new()
            }
        };
        let exists = fake_exists(&[r"C:\Windows", r"C:\Windows\System32"]);

        let inputs = DoctorInputs {
            read_user_path: &read_user,
            read_machine_path: &read_machine,
            resolve_command: &resolve,
            env: HashMap::new(),
            exists: &exists,
        };

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let report = rt.block_on(run_doctor(&inputs));

        // 用户 PATH 有 3 个问题（C:\P missing、%NOODE_PATH% unexpanded、v16.13.1 malformed）
        let finding = report
            .findings
            .iter()
            .find(|item| item.id == "user-path-problems")
            .expect("user-path-problems 应存在");
        assert_eq!(finding.level, DoctorLevel::Error);
        assert_eq!(finding.evidence.len(), 3);
        assert!(finding.evidence.iter().any(|line| line.contains(r"C:\P")));
        assert!(finding.fix.is_some());

        // 机器 PATH 干净
        assert!(report.findings.iter().any(|item| item.id == "machine-path-ok"));

        // 命令歧义
        let ambiguous = report
            .findings
            .iter()
            .find(|item| item.id == "command-ambiguous")
            .expect("command-ambiguous 应存在");
        assert_eq!(ambiguous.level, DoctorLevel::Warn);
        assert!(ambiguous.evidence.iter().any(|line| line.contains("（实际生效）")));

        // summary 计数与 findings 一致
        assert_eq!(
            report.summary.ok as usize,
            report.findings.iter().filter(|item| item.level == DoctorLevel::Ok).count()
        );
        assert!(report.user_path.changed);
        assert!(!report.machine_path.changed);
        let _ = (&io, &elevated);
    }

    #[test]
    fn clean_user_path_backs_up_and_verifies() {
        let _guard = sandbox("clean-user");
        let raw = r"C:\Windows;C:\P;C:\Windows";
        let io = FakeIo { path: std::sync::Mutex::new(raw.to_string()) };

        let result = clean_user_path(&io);
        assert!(result.ok, "error: {:?}", result.error);
        assert_eq!(result.changed.len(), 2); // C:\P 与重复的 C:\Windows
        let backup = result.backup_file.expect("应写备份文件");
        assert!(PathBuf::from(&backup).exists());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), raw);
        // 写入生效
        assert_eq!(io.read_path().unwrap(), r"C:\Windows");
    }

    #[test]
    fn clean_user_path_refuses_empty_result() {
        let _guard = sandbox("clean-user-empty");
        let io = FakeIo { path: std::sync::Mutex::new(r"C:\P".to_string()) };
        let result = clean_user_path(&io);
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("拒绝执行"));
        // 没写
        assert_eq!(io.read_path().unwrap(), r"C:\P");
    }

    #[test]
    fn clean_user_path_noop_when_clean() {
        let _guard = sandbox("clean-user-noop");
        let io = FakeIo { path: std::sync::Mutex::new(r"C:\Windows".to_string()) };
        let result = clean_user_path(&io);
        assert!(result.ok);
        assert!(result.changed.is_empty());
        assert!(result.backup_file.is_none());
    }

    #[test]
    fn apply_unknown_fix_is_reported() {
        let _guard = sandbox("apply");
        let io = FakeIo { path: std::sync::Mutex::new(String::new()) };
        let elevated = FakeElevation { cancel: true };
        // prune 在干净环境下是无操作
        let result = apply_doctor_fix(&io, &elevated, DoctorFixId::PruneDevkitState);
        assert!(result.ok, "error: {:?}", result.error);
    }
}
