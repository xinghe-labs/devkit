//! 安装计划的构建与持久化（对应 TS `core/plan/index.ts`，SPEC §7.4）。
//!
//! 这个模块只做两件事：把"用户勾了什么"变成一份可执行的计划，以及把计划写进 pending.json
//! 供重启后续跑（FR-17）。实际执行在 executor 里。
//!
//! 与 TS 的差异：TS 里 save/load/clear 失败会走 logger.warn 吞掉错误；
//! Rust 侧遵循"纯逻辑 + 显式 IO 注入"，把 `io::Result` 原样返回，由调用方
//! （Tauri command / devkit-cli）决定怎么记日志 —— 语义等价（都是"续跑失败不影响安装"），
//! 但错误不会被静默丢弃。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use devkit_manifest::pick_recommended_version;
use devkit_types::manifest::{ManifestStatus, ToolManifest, ToolVersionSpec};
use devkit_types::plan::{
    InstallPlan, PendingPlanLoad, PlanBuildError, PlanItem, PlanItemState, PlanOptions,
    PlanSelection, PlanSummary, SchemaVersion,
};
use devkit_types::timeutil;

use crate::placeholders::is_installable_version;
use crate::templates::resolve_install_template;

#[derive(Debug, Clone, thiserror::Error)]
#[error("有 {count} 项无法安装 —— {detail}")]
pub struct PlanBuildFailure {
    pub problems: Vec<PlanBuildError>,
    pub count: usize,
    /// 展示用明细（与 Display 一致）
    pub detail: String,
}

impl PlanBuildFailure {
    fn new(problems: Vec<PlanBuildError>) -> Self {
        let detail = problems
            .iter()
            .map(|item| format!("{}：{}", item.tool_id, item.reason))
            .collect::<Vec<_>>()
            .join("；");
        Self {
            count: problems.len(),
            problems,
            detail,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BuildPlanParams<'a> {
    pub selections: &'a [PlanSelection],
    pub tools: &'a [ToolManifest],
    pub options: &'a PlanOptions,
    pub devkit_version: &'a str,
    pub manifest_revision: &'a str,
    /// 版本目录根：%USERPROFILE%\.devkit\versions
    pub versions_root: &'a Path,
}

/// 生成 planId：`YYYYMMDD-HHMMSS-4位hex`。
/// TS 用本地时间格式化；Rust 无依赖方案统一用 UTC（planId 只是标识符，不参与展示，
/// 不影响功能；已在 MIGRATION-RUST.md 附录记录该偏离）。
/// suffix 由调用方注入以便测试；生产入口 make_plan_id 用亚秒纳秒做熵源。
pub fn make_plan_id_from_unix(unix_secs: i64, suffix_hex: &str) -> String {
    let stamp = format_stamp(unix_secs);
    format!("{stamp}-{suffix_hex}")
}

pub fn make_plan_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // 熵源：纳秒抖动。planId 不是安全令牌，只要"两次调用不重复"即可。
    let nanos = now.subsec_nanos() as u64 ^ now.as_secs().rotate_left(32);
    let suffix = format!("{:04x}", nanos & 0xffff);
    make_plan_id_from_unix(now.as_secs() as i64, &suffix)
}

/// 把 UNIX 秒按 UTC 格式化成 YYYYMMDD-HHMMSS（复用 timeutil 的 civil 算法思路，
/// 这里内联一份小实现避免依赖其内部函数）。
fn format_stamp(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// Howard Hinnant civil_from_days（与 devkit-types/timeutil 相同实现，属复制而非依赖内部）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

/// 依赖排序：被依赖的排在前面。
/// 出现环时返回 Err 而不是死循环 —— 清单写错了要让人看到，不能悄悄跳过。
pub fn topological_sort(items: &[PlanItem]) -> Result<Vec<PlanItem>, String> {
    let by_id: HashMap<&str, &PlanItem> =
        items.iter().map(|item| (item.id.as_str(), item)).collect();
    let mut sorted: Vec<PlanItem> = Vec::new();
    let mut visiting: HashSet<String> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::new();

    fn visit<'a>(
        item: &'a PlanItem,
        by_id: &HashMap<&str, &'a PlanItem>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        sorted: &mut Vec<PlanItem>,
    ) -> Result<(), String> {
        if visited.contains(&item.id) {
            return Ok(());
        }
        if visiting.contains(&item.id) {
            let mut chain: Vec<String> = visiting.iter().cloned().collect();
            chain.push(item.id.clone());
            // TS 用插入顺序展示链条；HashSet 无序，这里按 items 原始顺序排列后拼接
            return Err(format!("依赖出现环：{}", chain.join(" → ")));
        }
        visiting.insert(item.id.clone());
        for dependency in &item.depends_on {
            if let Some(dependency_item) = by_id.get(dependency.as_str()) {
                visit(dependency_item, by_id, visiting, visited, sorted)?;
            }
        }
        visiting.remove(&item.id);
        visited.insert(item.id.clone());
        sorted.push(item.clone());
        Ok(())
    }

    for item in items {
        visit(item, &by_id, &mut visiting, &mut visited, &mut sorted)?;
    }
    Ok(sorted)
}

pub fn summarize(items: &[PlanItem]) -> PlanSummary {
    let count = |state: PlanItemState| -> u32 {
        items.iter().filter(|item| item.state == state).count() as u32
    };
    PlanSummary {
        total: items.len() as u32,
        success: count(PlanItemState::Success),
        failed: count(PlanItemState::Failed),
        skipped: count(PlanItemState::Skipped),
        cancelled: count(PlanItemState::Cancelled),
    }
}

pub fn build_plan(params: BuildPlanParams<'_>) -> Result<InstallPlan, PlanBuildFailure> {
    let BuildPlanParams {
        selections,
        tools,
        options,
        devkit_version,
        manifest_revision,
        versions_root,
    } = params;

    let by_id: HashMap<&str, &ToolManifest> =
        tools.iter().map(|tool| (tool.id.as_str(), tool)).collect();
    let mut problems: Vec<PlanBuildError> = Vec::new();
    let mut items: Vec<PlanItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for selection in selections {
        if !seen.insert(selection.tool_id.clone()) {
            continue;
        }

        let Some(tool) = by_id.get(selection.tool_id.as_str()) else {
            problems.push(PlanBuildError {
                tool_id: selection.tool_id.clone(),
                reason: "清单里没有这个工具".to_string(),
            });
            continue;
        };

        let version: Option<&ToolVersionSpec> = match &selection.version {
            Some(requested) => tool.versions.iter().find(|item| &item.version == requested),
            None => pick_recommended_version(tool),
        };

        let Some(version) = version else {
            problems.push(PlanBuildError {
                tool_id: tool.id.clone(),
                reason: match &selection.version {
                    Some(requested) => format!("清单里没有版本 {requested}"),
                    None => "清单里没有可安装的版本".to_string(),
                },
            });
            continue;
        };

        if !is_installable_version(version) {
            problems.push(PlanBuildError {
                tool_id: tool.id.clone(),
                reason: format!(
                    "版本 {} 的安装信息尚未补齐（清单状态：{}）",
                    version.version,
                    match tool.status {
                        ManifestStatus::DetectOnly => "detect-only",
                        ManifestStatus::Ready => "ready",
                    }
                ),
            });
            continue;
        }

        // 提前解析模板：模板名写错、参数不合规都应该在这里就暴露，而不是跑到一半才失败
        if let Err(error) = resolve_install_template(version.install.as_ref()) {
            problems.push(PlanBuildError {
                tool_id: tool.id.clone(),
                reason: error.message,
            });
            continue;
        }

        // 纵深防御：即使清单/Schema/热更新三处都被绕过，这里也拦一次。
        // 版本号里的 ".." 会让 join 归一化掉路径段，把安装目录指到 versions 根目录甚至更外面。
        // Rust 的 join 不做归一化，所以这里手动检查相对路径里是否混入 .. / 根 / 盘符组件
        // （与 TS 的 relative().startsWith('..') + isAbsolute 判定等价）。
        let install_dir: PathBuf = versions_root.join(&tool.id).join(&version.version);
        let escaped = match install_dir.strip_prefix(versions_root) {
            Err(_) => true,
            Ok(relative) => {
                relative.as_os_str().is_empty()
                    || relative.components().any(|component| {
                        matches!(
                            component,
                            Component::ParentDir | Component::RootDir | Component::Prefix(_)
                        )
                    })
            }
        };
        if escaped {
            problems.push(PlanBuildError {
                tool_id: tool.id.clone(),
                reason: format!(
                    "版本号 {} 会让安装目录落到版本根目录之外（{}），已拒绝",
                    version.version,
                    install_dir.display()
                ),
            });
            continue;
        }

        items.push(PlanItem {
            id: tool.id.clone(),
            version: version.version.clone(),
            tier: tool.tier,
            install_scope: version.install_scope,
            requires_admin: version.install_scope == devkit_types::manifest::InstallScope::Machine,
            requires_reboot: version.requires_reboot.unwrap_or(false),
            depends_on: version.depends_on.clone().unwrap_or_default(),
            state: PlanItemState::Pending,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: Some(install_dir.to_string_lossy().to_string()),
            archive_path: None,
            download_attempts: None,
        });
    }

    if !problems.is_empty() {
        return Err(PlanBuildFailure::new(problems));
    }
    if items.is_empty() {
        return Err(PlanBuildFailure::new(vec![PlanBuildError {
            tool_id: "-".to_string(),
            reason: "没有选择任何可安装的项".to_string(),
        }]));
    }

    let sorted = topological_sort(&items).map_err(|message| {
        PlanBuildFailure::new(vec![PlanBuildError {
            tool_id: "-".to_string(),
            reason: message,
        }])
    })?;

    let summary = summarize(&sorted);
    Ok(InstallPlan {
        schema_version: SchemaVersion::One,
        plan_id: make_plan_id(),
        created_at: timeutil::iso8601_now(),
        devkit_version: devkit_version.to_string(),
        manifest_revision: manifest_revision.to_string(),
        options: options.clone(),
        items: sorted,
        summary,
    })
}

/* ------------------------------------------------------------------ */
/* pending.json：重启后续跑（FR-17）                                    */
/* ------------------------------------------------------------------ */

/// TS 的 looksLikePlan 是浅校验（schemaVersion=1 + planId 非空 + items 里每项有
/// string id/state）。Rust 侧先用同一规则过一遍 Value，再走强类型反序列化；
/// 反序列化失败（例如 state 拼错）同样按 invalid 处理 —— 比 TS 更严格，但只
/// 严格在"本来就该拒绝"的方向上。
fn looks_like_plan(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return false;
    }
    match object.get("planId").and_then(|v| v.as_str()) {
        Some(plan_id) if !plan_id.is_empty() => {}
        _ => return false,
    }
    let Some(items) = object.get("items").and_then(|v| v.as_array()) else {
        return false;
    };
    items.iter().all(|item| {
        item.as_object()
            .map(|item| {
                item.get("id").map(|v| v.is_string()).unwrap_or(false)
                    && item.get("state").map(|v| v.is_string()).unwrap_or(false)
            })
            .unwrap_or(false)
    })
}

/// 写 pending.json。续跑是锦上添花，写不进去不能影响安装本身 ——
/// 调用方拿到 Err 只记日志（对齐 TS 的 try/catch+warn）。
pub fn save_pending_plan(path: &Path, plan: &InstallPlan) -> std::io::Result<()> {
    let payload = serde_json::to_string_pretty(plan)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, payload)
}

/// 读 pending.json。文件不存在 → None；结构不匹配/解析失败 → Invalid。
pub fn load_pending_plan(path: &Path) -> PendingPlanLoad {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PendingPlanLoad::None;
    };
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&raw);
    let Ok(value) = parsed else {
        return PendingPlanLoad::Invalid {
            reason: "计划文件格式不匹配".to_string(),
        };
    };
    if !looks_like_plan(&value) {
        return PendingPlanLoad::Invalid {
            reason: "计划文件格式不匹配".to_string(),
        };
    }
    match serde_json::from_value::<InstallPlan>(value) {
        Ok(plan) => PendingPlanLoad::Ok { plan },
        Err(error) => PendingPlanLoad::Invalid {
            reason: format!("计划文件格式不匹配：{error}"),
        },
    }
}

/// 删除 pending.json。文件不存在视为成功（对齐 rmSync force: true）。
/// 续跑是锦上添花，失败只返回 Err 给调用方记日志，绝不能让已经成功的安装流程报错。
pub fn clear_pending_plan(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 未完成（非终态）的项
pub fn unfinished_items(plan: &InstallPlan) -> Vec<PlanItem> {
    plan.items
        .iter()
        .filter(|item| {
            !matches!(
                item.state,
                PlanItemState::Success | PlanItemState::Skipped | PlanItemState::Cancelled
            )
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::manifest::{
        InstallScope, InstallSpec, InstallType, LicenseTier, ManifestStatus, SourceSpec,
        ToolCategory, ToolVersionSpec, VersionChannel,
    };
    use devkit_types::plan::DownloadAttempt;
    use devkit_types::{DetectSpec, LocalizedText};
    use std::collections::BTreeMap;

    const OPTIONS: PlanOptions = PlanOptions {
        concurrency: 1,
        mirror_preference: devkit_types::plan::MirrorPreference::Official,
        proxy: None,
        create_restore_point: false,
        dry_run: false,
    };

    const VERSIONS_ROOT: &str = r"C:\Users\屈\.devkit\versions";

    fn installable_version(version: &str) -> ToolVersionSpec {
        ToolVersionSpec {
            version: version.to_string(),
            channel: VersionChannel::Stable,
            recommended: None,
            arch: devkit_types::manifest::Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: Some(SourceSpec {
                url: format!("https://example.com/{version}.zip"),
                sha256: Some("a".repeat(64)),
            }),
            mirrors: None,
            install: Some(InstallSpec {
                install_type: InstallType::Zip,
                template: "zip-into-version-dir".to_string(),
                params: Some(
                    [("stripComponents", "1")]
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                ),
            }),
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        }
    }

    fn names(pairs: &[(&str, &str)]) -> LocalizedText {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn make_tool(id: &str, versions: Vec<ToolVersionSpec>, status: ManifestStatus) -> ToolManifest {
        ToolManifest {
            id: id.to_string(),
            category: ToolCategory::Tool,
            tier: LicenseTier::L1,
            status,
            provider: None,
            name: names(&[("zh-CN", id), ("en-US", id)]),
            description: names(&[("zh-CN", id), ("en-US", id)]),
            homepage: None,
            license: None,
            detect: DetectSpec {
                commands: None,
                files: Some(vec![format!(r"C:\{id}.exe")]),
                registry: None,
            },
            versions,
            notes: None,
        }
    }

    fn build(
        selections: &[(&str, Option<&str>)],
        tools: &[ToolManifest],
    ) -> Result<InstallPlan, PlanBuildFailure> {
        let selections: Vec<PlanSelection> = selections
            .iter()
            .map(|(tool_id, version)| PlanSelection {
                tool_id: tool_id.to_string(),
                version: version.map(|v| v.to_string()),
            })
            .collect();
        let versions_root = PathBuf::from(VERSIONS_ROOT);
        build_plan(BuildPlanParams {
            selections: &selections,
            tools,
            options: &OPTIONS,
            devkit_version: "0.1.0",
            manifest_revision: "2026-10-10",
            versions_root: &versions_root,
        })
    }

    #[test]
    fn builds_plan_with_install_dir() {
        let tools = [make_tool(
            "nodejs",
            vec![{
                let mut version = installable_version("24.21.0");
                version.recommended = Some(true);
                version
            }],
            ManifestStatus::Ready,
        )];
        let plan = build(&[("nodejs", None)], &tools).unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].version, "24.21.0");
        assert_eq!(
            plan.items[0].install_dir.as_deref(),
            Some(r"C:\Users\屈\.devkit\versions\nodejs\24.21.0")
        );
        assert_eq!(plan.items[0].state, PlanItemState::Pending);
        assert_eq!(
            plan.summary,
            PlanSummary {
                total: 1,
                success: 0,
                failed: 0,
                skipped: 0,
                cancelled: 0
            }
        );
    }

    #[test]
    fn respects_user_specified_version_over_recommended() {
        let tools = [make_tool(
            "nodejs",
            vec![
                {
                    let mut version = installable_version("24.21.0");
                    version.recommended = Some(true);
                    version
                },
                installable_version("24.20.0"),
            ],
            ManifestStatus::Ready,
        )];
        let plan = build(&[("nodejs", Some("24.20.0"))], &tools).unwrap();
        assert_eq!(plan.items[0].version, "24.20.0");
    }

    #[test]
    fn deduplicates_same_tool() {
        let tools = [make_tool(
            "nodejs",
            vec![installable_version("24.21.0")],
            ManifestStatus::Ready,
        )];
        let plan = build(&[("nodejs", None), ("nodejs", None)], &tools).unwrap();
        assert_eq!(plan.items.len(), 1);
    }

    #[test]
    fn requires_admin_derived_from_scope() {
        let mut version = installable_version("16.0");
        version.install_scope = InstallScope::Machine;
        let tools = [make_tool("pg", vec![version], ManifestStatus::Ready)];
        let plan = build(&[("pg", None)], &tools).unwrap();
        assert!(plan.items[0].requires_admin);
    }

    #[test]
    fn rejects_unknown_tool() {
        let error = build(&[("nope", None)], &[]).unwrap_err();
        assert_eq!(error.problems[0].reason, "清单里没有这个工具");
        assert_eq!(error.problems[0].tool_id, "nope");
    }

    #[test]
    fn rejects_not_installable_version_with_status() {
        let mut version = installable_version("3.30.0");
        version.source = None;
        version.install = None;
        let tools = [make_tool(
            "cmake",
            vec![version],
            ManifestStatus::DetectOnly,
        )];
        let error = build(&[("cmake", None)], &tools).unwrap_err();
        assert!(
            error.problems[0].reason.contains("尚未补齐"),
            "{}",
            error.problems[0].reason
        );
        assert!(
            error.problems[0].reason.contains("detect-only"),
            "{}",
            error.problems[0].reason
        );
    }

    #[test]
    fn rejects_tool_without_versions() {
        let tools = [make_tool("cmake", vec![], ManifestStatus::DetectOnly)];
        let error = build(&[("cmake", None)], &tools).unwrap_err();
        assert!(
            error.problems[0].reason.contains("没有可安装的版本"),
            "{}",
            error.problems[0].reason
        );
    }

    #[test]
    fn rejects_unknown_template_at_build_time() {
        let mut version = installable_version("24.21.0");
        version.install = Some(InstallSpec {
            install_type: InstallType::Zip,
            template: "no-such-template".to_string(),
            params: None,
        });
        let tools = [make_tool("nodejs", vec![version], ManifestStatus::Ready)];
        let error = build(&[("nodejs", None)], &tools).unwrap_err();
        assert!(
            error.problems[0].reason.contains("未知的安装模板"),
            "{}",
            error.problems[0].reason
        );
    }

    #[test]
    fn rejects_empty_selection() {
        let error = build(&[], &[]).unwrap_err();
        assert!(
            error.to_string().contains("没有选择任何可安装的项"),
            "{}",
            error
        );
    }

    #[test]
    fn plan_build_failure_message_lists_problems() {
        let error = PlanBuildFailure::new(vec![
            PlanBuildError {
                tool_id: "a".to_string(),
                reason: "原因一".to_string(),
            },
            PlanBuildError {
                tool_id: "b".to_string(),
                reason: "原因二".to_string(),
            },
        ]);
        assert_eq!(error.to_string(), "有 2 项无法安装 —— a：原因一；b：原因二");
    }

    #[test]
    fn sorts_dependencies_first() {
        let mut docker = installable_version("1.0");
        docker.depends_on = Some(vec!["wsl2".to_string()]);
        let tools = [
            make_tool("docker", vec![docker], ManifestStatus::Ready),
            make_tool(
                "wsl2",
                vec![installable_version("2.0")],
                ManifestStatus::Ready,
            ),
        ];
        let plan = build(&[("docker", None), ("wsl2", None)], &tools).unwrap();
        let ids: Vec<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["wsl2", "docker"]);
    }

    #[test]
    fn cycle_detection_errors_instead_of_looping() {
        let item = |id: &str, depends_on: &[&str]| PlanItem {
            id: id.to_string(),
            version: "1.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
            state: PlanItemState::Pending,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: None,
            archive_path: None,
            download_attempts: None,
        };
        let items = [item("a", &["b"]), item("b", &["a"])];
        let error = topological_sort(&items).unwrap_err();
        assert!(error.contains("依赖出现环"), "{}", error);
    }

    #[test]
    fn unknown_dependency_does_not_error() {
        let item = PlanItem {
            id: "a".to_string(),
            version: "1.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: vec!["not-selected".to_string()],
            state: PlanItemState::Pending,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: None,
            archive_path: None,
            download_attempts: None,
        };
        let sorted = topological_sort(&[item]).unwrap();
        assert_eq!(sorted[0].id, "a");
    }

    #[test]
    fn summarize_counts_by_state() {
        let item = |state: PlanItemState| PlanItem {
            id: state_k(state).to_string(),
            version: "1.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: vec![],
            state,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: None,
            archive_path: None,
            download_attempts: None,
        };
        let items = vec![
            item(PlanItemState::Success),
            item(PlanItemState::Success),
            item(PlanItemState::Failed),
            item(PlanItemState::Skipped),
            item(PlanItemState::Pending),
        ];
        assert_eq!(
            summarize(&items),
            PlanSummary {
                total: 5,
                success: 2,
                failed: 1,
                skipped: 1,
                cancelled: 0
            }
        );
    }

    fn state_k(state: PlanItemState) -> &'static str {
        match state {
            PlanItemState::Success => "success",
            PlanItemState::Failed => "failed",
            PlanItemState::Skipped => "skipped",
            PlanItemState::Pending => "pending",
            PlanItemState::Cancelled => "cancelled",
            _ => "other",
        }
    }

    #[test]
    fn plan_id_format_and_uniqueness() {
        // 2026-10-10T15:30:00 UTC = 1791646200
        let first = make_plan_id_from_unix(1_791_646_200, "abcd");
        assert_eq!(first, "20261010-153000-abcd");

        let a = make_plan_id();
        let b = make_plan_id();
        let pattern = regex::Regex::new(r"^\d{8}-\d{6}-[0-9a-f]{4}$").unwrap();
        assert!(pattern.is_match(&a), "{a}");
        assert!(pattern.is_match(&b), "{b}");
    }

    #[test]
    fn rejects_version_escaping_versions_root() {
        let mut version = installable_version("..\\..\\evil");
        version.version = "..\\..\\evil".to_string();
        let tools = [make_tool("nodejs", vec![version], ManifestStatus::Ready)];
        let error = build(&[("nodejs", None)], &tools).unwrap_err();
        assert!(
            error.problems[0].reason.contains("落到版本根目录之外"),
            "{}",
            error.problems[0].reason
        );
    }

    /* ---------------- pending.json 双向兼容 ---------------- */

    fn sample_plan() -> InstallPlan {
        let tools = [make_tool(
            "nodejs",
            vec![installable_version("24.21.0")],
            ManifestStatus::Ready,
        )];
        build(&[("nodejs", None)], &tools).unwrap()
    }

    #[test]
    fn pending_plan_roundtrip() {
        let plan = sample_plan();
        let dir = std::env::temp_dir().join(format!("devkit-plan-{}", std::process::id()));
        let path = dir.join("pending.json");
        let _ = std::fs::create_dir_all(&dir);

        save_pending_plan(&path, &plan).unwrap();
        let loaded = load_pending_plan(&path);
        let PendingPlanLoad::Ok { plan: loaded_plan } = loaded else {
            panic!("期望读取成功");
        };
        assert_eq!(loaded_plan.plan_id, plan.plan_id);
        assert_eq!(loaded_plan.items, plan.items);

        clear_pending_plan(&path).unwrap();
        assert!(!path.exists());
        // 再清一次：文件不存在视为成功（对齐 rmSync force:true）
        clear_pending_plan(&path).unwrap();

        // 清空后读取 → none
        assert_eq!(load_pending_plan(&path), PendingPlanLoad::None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_plan_accepts_ts_written_shape() {
        // 模拟 TS 版写出的 pending.json（camelCase + null 字段）
        let dir = std::env::temp_dir().join(format!("devkit-plan-ts-{}", std::process::id()));
        let path = dir.join("pending.json");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "planId": "20260214-083000-1a2b",
  "createdAt": "2026-02-14T08:30:00.000Z",
  "devkitVersion": "0.6.2",
  "manifestRevision": "builtin",
  "options": {
    "concurrency": 2,
    "mirrorPreference": "official",
    "proxy": null,
    "createRestorePoint": false,
    "dryRun": false
  },
  "items": [
    {
      "id": "nodejs",
      "version": "24.21.0",
      "tier": "L1",
      "installScope": "user",
      "requiresAdmin": false,
      "requiresReboot": false,
      "dependsOn": [],
      "state": "failed",
      "attempts": 2,
      "error": "下载失败",
      "note": null,
      "startedAt": "2026-02-14T08:31:00.000Z",
      "finishedAt": null,
      "installDir": "C:\\Users\\u\\.devkit\\versions\\nodejs\\24.21.0",
      "archivePath": null,
      "downloadAttempts": [
        { "source": "official", "url": "https://nodejs.org/dist.zip", "error": "timeout" }
      ]
    }
  ],
  "summary": { "total": 1, "success": 0, "failed": 1, "skipped": 0, "cancelled": 0 }
}"#,
        )
        .unwrap();

        let loaded = load_pending_plan(&path);
        let PendingPlanLoad::Ok { plan } = loaded else {
            panic!("TS 写出的 pending.json 必须能被 Rust 读回");
        };
        assert_eq!(plan.items[0].state, PlanItemState::Failed);
        assert_eq!(plan.items[0].attempts, 2);
        assert_eq!(
            plan.items[0]
                .download_attempts
                .as_deref()
                .map(|a| a[0].source.as_str()),
            Some("official")
        );
        let unfinished = unfinished_items(&plan);
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].id, "nodejs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_plan_rejects_bad_shape() {
        let dir = std::env::temp_dir().join(format!("devkit-plan-bad-{}", std::process::id()));
        let path = dir.join("pending.json");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(&path, r#"{"schemaVersion": 2, "planId": "x", "items": []}"#).unwrap();
        let loaded = load_pending_plan(&path);
        let PendingPlanLoad::Invalid { reason } = loaded else {
            panic!("schemaVersion != 1 必须按 invalid 处理");
        };
        assert!(reason.contains("不匹配"), "{reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_attempt_is_default_compatible() {
        // Rust 写出的 DownloadAttempt 序列化成 camelCase，TS 能读
        let attempt = DownloadAttempt {
            source: "huaweicloud".to_string(),
            url: "https://mirrors.huaweicloud.com/x.zip".to_string(),
            error: "404".to_string(),
        };
        let json = serde_json::to_value(&attempt).unwrap();
        assert_eq!(json["source"], "huaweicloud");
        assert_eq!(json["url"], "https://mirrors.huaweicloud.com/x.zip");
        assert_eq!(json["error"], "404");
    }

    #[test]
    fn btree_and_hashmap_params_equivalent() {
        // resolve_install_template 用 BTreeMap 清洗参数；HashMap→BTreeMap 转换无损
        let mut map = BTreeMap::new();
        map.insert("stripComponents".to_string(), "1".to_string());
        assert_eq!(map.get("stripComponents").map(String::as_str), Some("1"));
    }
}
