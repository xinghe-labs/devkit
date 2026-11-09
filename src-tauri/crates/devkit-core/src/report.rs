//! 安装报告（镜像 `src/main/core/report/markdown.ts`，FR-9）。
//!
//! 报告是用户唯一能带走的证据 —— 出了问题要能把"装了什么、哪一步失败了、
//! 自检输出了什么"原样贴给别人。所以这里不做任何美化，只求信息完整。

use std::collections::HashMap;

use devkit_types::locale::{localized_text, Locale};
use devkit_types::manifest::ToolManifest;
use devkit_types::plan::{InstallPlan, MirrorPreference, PlanItem, PlanItemState};

fn state_label(state: PlanItemState) -> &'static str {
    match state {
        PlanItemState::Pending => "未开始",
        PlanItemState::Downloading => "下载中",
        PlanItemState::Verifying => "校验中",
        PlanItemState::Installing => "安装中",
        PlanItemState::Checking => "自检中",
        PlanItemState::Success => "成功",
        PlanItemState::Failed => "失败",
        PlanItemState::Skipped => "跳过",
        PlanItemState::Cancelled => "已取消",
    }
}

fn state_icon(state: PlanItemState) -> &'static str {
    match state {
        PlanItemState::Pending => "·",
        PlanItemState::Downloading => "↓",
        PlanItemState::Verifying => "#",
        PlanItemState::Installing => "+",
        PlanItemState::Checking => "?",
        PlanItemState::Success => "✓",
        PlanItemState::Failed => "✗",
        PlanItemState::Skipped => "−",
        PlanItemState::Cancelled => "×",
    }
}

/// 解析 ISO-8601（`2026-10-12T07:00:00.000Z`）为毫秒时间戳。
fn parse_iso_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let parse = |start: usize, end: usize| value.get(start..end)?.parse::<i64>().ok();
    let year = parse(0, 4)?;
    let month = parse(5, 7)?;
    let day = parse(8, 10)?;
    let hour = parse(11, 13)?;
    let minute = parse(14, 16)?;
    let second = parse(17, 19)?;
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        parse(20, 23)?
    } else {
        0
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

/// 与 timeutil 里的 civil 算法互逆（Howard Hinnant 的 days_from_civil）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn format_duration(started_at: Option<&str>, finished_at: Option<&str>) -> String {
    let (Some(started_at), Some(finished_at)) = (started_at, finished_at) else {
        return "—".to_string();
    };
    let (Some(start), Some(finish)) = (parse_iso_millis(started_at), parse_iso_millis(finished_at))
    else {
        return "—".to_string();
    };
    let delta = finish - start;
    if delta < 0 {
        return "—".to_string();
    }
    if delta < 1_000 {
        format!("{delta}ms")
    } else {
        format!("{:.1}s", delta as f64 / 1_000.0)
    }
}

/// 表格单元格里的 | 会破坏 Markdown 表格结构
fn escape_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace("\r\n", " ")
        .replace('\n', " ")
}

fn mirror_label(preference: MirrorPreference) -> &'static str {
    match preference {
        MirrorPreference::Official => "official",
        MirrorPreference::Huaweicloud => "huaweicloud",
        MirrorPreference::Aliyun => "aliyun",
        MirrorPreference::Tuna => "tuna",
        MirrorPreference::Ustc => "ustc",
    }
}

fn render_plan_report(
    plan: &InstallPlan,
    tools: &HashMap<String, ToolManifest>,
    locale: Locale,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    let summary = &plan.summary;

    lines.push("# devkit 安装报告".to_string());
    lines.push(String::new());
    lines.push(format!("- 计划 ID：{}", plan.plan_id));
    lines.push(format!(
        "- 生成时间：{}",
        devkit_types::timeutil::iso8601_now()
    ));
    lines.push(format!("- devkit 版本：{}", plan.devkit_version));
    lines.push(format!("- 清单版本：{}", plan.manifest_revision));
    lines.push(format!(
        "- 镜像偏好：{}",
        mirror_label(plan.options.mirror_preference)
    ));
    lines.push(format!(
        "- 代理：{}",
        plan.options.proxy.as_deref().unwrap_or("跟随系统")
    ));
    lines.push(format!(
        "- 结果：成功 {} · 失败 {} · 跳过 {} · 取消 {}（共 {}）",
        summary.success, summary.failed, summary.skipped, summary.cancelled, summary.total
    ));
    lines.push(String::new());

    lines.push("## 逐项结果".to_string());
    lines.push(String::new());
    lines.push("| 状态 | 工具 | 版本 | 安装目录 | 耗时 | 说明 |".to_string());
    lines.push("| --- | --- | --- | --- | --- | --- |".to_string());

    for item in &plan.items {
        let name = tools
            .get(&item.id)
            .map(|tool| localized_text(Some(&tool.name), locale, &item.id))
            .unwrap_or_else(|| item.id.clone());
        let note = item.error.as_deref().or(item.note.as_deref()).unwrap_or("");
        lines.push(format!(
            "| {} {} | {} | {} | {} | {} | {} |",
            state_icon(item.state),
            state_label(item.state),
            escape_cell(&name),
            item.version,
            escape_cell(item.install_dir.as_deref().unwrap_or("—")),
            format_duration(item.started_at.as_deref(), item.finished_at.as_deref()),
            escape_cell(note)
        ));
    }

    // 下载尝试记录：只要试过不止一个源，或者有失败尝试，就单列出来
    let with_attempts: Vec<&PlanItem> = plan
        .items
        .iter()
        .filter(|item| {
            !item
                .download_attempts
                .as_ref()
                .map(|list| list.is_empty())
                .unwrap_or(true)
        })
        .collect();
    if !with_attempts.is_empty() {
        lines.push(String::new());
        lines.push("## 下载尝试记录".to_string());
        lines.push(String::new());
        lines.push("> 同一个文件会按镜像偏好依次尝试多个源；下面列出每次尝试的结果。".to_string());
        for item in with_attempts {
            lines.push(String::new());
            lines.push(format!("### {}@{}", item.id, item.version));
            lines.push(String::new());
            lines.push("| # | 源 | 地址 | 结果 |".to_string());
            lines.push("| --- | --- | --- | --- |".to_string());
            for (index, attempt) in item.download_attempts.as_ref().unwrap().iter().enumerate() {
                lines.push(format!(
                    "| {} | {} | {} | {} |",
                    index + 1,
                    escape_cell(&attempt.source),
                    escape_cell(&attempt.url),
                    escape_cell(&attempt.error)
                ));
            }
            if item.state == PlanItemState::Success {
                if let Some(archive_path) = &item.archive_path {
                    lines.push(String::new());
                    lines.push(format!("- 最终使用：{archive_path}"));
                }
            }
        }
    }

    let problems: Vec<&PlanItem> = plan
        .items
        .iter()
        .filter(|item| matches!(item.state, PlanItemState::Failed | PlanItemState::Skipped))
        .collect();
    if !problems.is_empty() {
        lines.push(String::new());
        lines.push("## 需要关注".to_string());
        for item in problems {
            lines.push(String::new());
            lines.push(format!(
                "### {}@{} — {}",
                item.id,
                item.version,
                state_label(item.state)
            ));
            lines.push(String::new());
            lines.push(format!("- 错误：{}", item.error.as_deref().unwrap_or("—")));
            if let Some(note) = &item.note {
                lines.push(format!("- 说明：{note}"));
            }
            if let Some(archive_path) = &item.archive_path {
                lines.push(format!("- 下载产物：{archive_path}"));
            }
        }
    }

    lines.push(String::new());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push("> 本报告由 devkit 自动生成，未上传到任何服务器。".to_string());
    lines.push(
        "> 本次安装全部落在用户级版本目录（%USERPROFILE%\\.devkit\\versions\\），未修改系统 PATH、未写 Program Files。"
            .to_string(),
    );

    lines.join("\n")
}

/// 生成安装报告（入口）。
pub fn render_report(
    plan: &InstallPlan,
    tools: &HashMap<String, ToolManifest>,
    locale: Locale,
) -> String {
    render_plan_report(plan, tools, locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::locale::LocalizedText;
    use devkit_types::manifest::{LicenseTier, ManifestStatus, ToolCategory};
    use devkit_types::plan::{
        DownloadAttempt, MirrorPreference, PlanItem, PlanOptions, PlanSummary, SchemaVersion,
    };
    fn tools_map() -> HashMap<String, ToolManifest> {
        let mut map = HashMap::new();
        map.insert(
            "nodejs".to_string(),
            ToolManifest {
                id: "nodejs".to_string(),
                category: ToolCategory::Runtime,
                tier: LicenseTier::L1,
                status: ManifestStatus::Ready,
                provider: None,
                name: [("zh-CN".to_string(), "Node.js".to_string())]
                    .into_iter()
                    .collect::<LocalizedText>(),
                description: Default::default(),
                homepage: None,
                license: None,
                detect: Default::default(),
                versions: Vec::new(),
                notes: None,
            },
        );
        map
    }

    fn item() -> PlanItem {
        PlanItem {
            id: "nodejs".to_string(),
            version: "24.21.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: devkit_types::manifest::InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: Vec::new(),
            state: PlanItemState::Success,
            attempts: 1,
            error: None,
            note: Some("自检通过：v24.21.0".to_string()),
            started_at: Some("2026-10-12T07:00:00.000Z".to_string()),
            finished_at: Some("2026-10-12T07:00:30.000Z".to_string()),
            install_dir: Some("C:\\Users\\屈\\.devkit\\versions\\nodejs\\24.21.0".to_string()),
            archive_path: Some(
                "C:\\Users\\屈\\.devkit\\downloads\\nodejs-24.21.0-node.zip".to_string(),
            ),
            download_attempts: None,
        }
    }

    fn plan(items: Vec<PlanItem>) -> InstallPlan {
        let success = items
            .iter()
            .filter(|i| i.state == PlanItemState::Success)
            .count();
        let failed = items
            .iter()
            .filter(|i| i.state == PlanItemState::Failed)
            .count();
        InstallPlan {
            schema_version: SchemaVersion::One,
            plan_id: "20261012-070000-abcd".to_string(),
            created_at: "2026-10-12T07:00:00.000Z".to_string(),
            devkit_version: "0.1.0".to_string(),
            manifest_revision: "2026-10-12".to_string(),
            options: PlanOptions {
                concurrency: 1,
                mirror_preference: MirrorPreference::Huaweicloud,
                proxy: None,
                create_restore_point: false,
                dry_run: false,
            },
            summary: PlanSummary {
                total: items.len() as u32,
                success: success as u32,
                failed: failed as u32,
                skipped: 0,
                cancelled: 0,
            },
            items,
        }
    }

    #[test]
    fn report_contains_metadata_and_rows() {
        let report = render_report(&plan(vec![item()]), &tools_map(), Locale::ZhCn);
        assert!(report.contains("# devkit 安装报告"));
        assert!(report.contains("20261012-070000-abcd"));
        assert!(report.contains("| ✓ 成功 | Node.js | 24.21.0 |"));
        assert!(report.contains("30.0s"));
    }

    #[test]
    fn download_attempts_are_listed() {
        let report = render_report(
            &plan(vec![PlanItem {
                download_attempts: Some(vec![
                    DownloadAttempt {
                        source: "official".to_string(),
                        url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip".to_string(),
                        error: "连接中断，下载不完整：已收到 351 KB，期望 36 MB".to_string(),
                    },
                    DownloadAttempt {
                        source: "huaweicloud".to_string(),
                        url: "https://mirrors.huaweicloud.com/nodejs/v24.21.0/node-v24.21.0-win-x64.zip"
                            .to_string(),
                        error: "下载速度只有 21.9 KB/s（低于 32 KB/s），已放弃这个源".to_string(),
                    },
                ]),
                ..item()
            }]),
            &tools_map(),
            Locale::ZhCn,
        );
        assert!(report.contains("## 下载尝试记录"));
        assert!(report.contains("| 1 | official |"));
        assert!(report.contains("| 2 | huaweicloud |"));
        assert!(report.contains("下载速度只有 21.9 KB/s"));
        assert!(
            report.contains("最终使用：C:\\Users\\屈\\.devkit\\downloads\\nodejs-24.21.0-node.zip")
        );
    }

    #[test]
    fn failed_items_are_flagged() {
        let report = render_report(
            &plan(vec![PlanItem {
                state: PlanItemState::Failed,
                error: Some("自检未通过：自检目标不存在：C:\\...\\node.exe".to_string()),
                note: None,
                archive_path: Some("C:\\cache\\node.zip".to_string()),
                ..item()
            }]),
            &tools_map(),
            Locale::ZhCn,
        );
        assert!(report.contains("## 需要关注"));
        assert!(report.contains("### nodejs@24.21.0 — 失败"));
        assert!(report.contains("自检未通过"));
        assert!(report.contains("下载产物：C:\\cache\\node.zip"));
    }

    #[test]
    fn cell_pipes_and_newlines_are_escaped() {
        let report = render_report(
            &plan(vec![PlanItem {
                note: Some("第一行 | 第二行\n第三行".to_string()),
                ..item()
            }]),
            &tools_map(),
            Locale::ZhCn,
        );
        assert!(report.contains("第一行 \\| 第二行 第三行"));
    }

    #[test]
    fn healthy_plan_has_no_problem_section() {
        let report = render_report(&plan(vec![item()]), &tools_map(), Locale::ZhCn);
        assert!(!report.contains("## 需要关注"));
    }

    #[test]
    fn duration_formats_match_ts() {
        assert_eq!(
            format_duration(
                Some("2026-10-12T07:00:00.000Z"),
                Some("2026-10-12T07:00:00.250Z")
            ),
            "250ms"
        );
        assert_eq!(
            format_duration(
                Some("2026-10-12T07:00:00.000Z"),
                Some("2026-10-12T07:00:30.000Z")
            ),
            "30.0s"
        );
        assert_eq!(format_duration(None, Some("2026-10-12T07:00:30.000Z")), "—");
        // 时间倒退也不报错
        assert_eq!(
            format_duration(
                Some("2026-10-12T07:00:30.000Z"),
                Some("2026-10-12T07:00:00.000Z")
            ),
            "—"
        );
    }
}
