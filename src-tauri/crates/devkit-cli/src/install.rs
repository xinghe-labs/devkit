//! `devkit-cli install <toolId> [version]`（镜像 `scripts/install-tool.ts`）。
//!
//! 用途：
//!  · 端到端验收 —— 真实下载、真实 SHA-256 校验、真实解压、真实自检
//!  · 排查"界面里装失败了但不知道哪一步"的问题，这里能看到完整日志
//!  · 新增清单后自测
//!
//! 安全边界（与界面完全一致）：
//!  · 只装到 %USERPROFILE%\.devkit\versions\<tool>\<version>\
//!  · 不改系统 PATH、不写 Program Files、不需要管理员
//!  · 自检用绝对路径，验证的是刚装进去的那一份

use crate::manifest_dir;
use devkit_types::plan::{MirrorPreference, PlanItemState, PlanOptions, PlanSelection};
use std::collections::HashMap;
use std::io::Write;
use tokio_util::sync::CancellationToken;

fn state_label(state: PlanItemState) -> &'static str {
    match state {
        PlanItemState::Pending => "等待",
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

fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 10.0 || unit == 0 {
        format!("{:.0} {}", value, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub(crate) fn run(args: &[String]) -> i32 {
    let tool_id = args
        .first()
        .map(String::as_str)
        .unwrap_or("nodejs")
        .to_string();
    let version_arg = args.get(1).filter(|v| !v.trim().is_empty()).cloned();

    let dir = manifest_dir();
    let loaded = devkit_manifest::load_manifests(&dir, None, true);
    if !loaded.errors.is_empty() {
        eprintln!(
            "有 {} 个清单未通过校验，请先执行 manifest-check",
            loaded.errors.len()
        );
        return 1;
    }

    // 与界面走**同一套**路径解析（含 DEVKIT_DATA_ROOT 覆盖）。
    // install-tool.ts 当年手写 join(homedir(), '.devkit', ...)，导致脚本与应用
    // 各用一份下载缓存 —— 同一个文件各下一份，缓存命中不了。这里直接用 app_paths。
    let versions_root = devkit_core::app_paths::get_versions_root();
    let download_dir = devkit_core::app_paths::get_download_dir();
    let log_dir = devkit_core::app_paths::get_data_root().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    println!(
        "\n数据根目录  {}",
        devkit_core::app_paths::get_data_root().display()
    );

    let mirror = std::env::var("DEVKIT_MIRROR")
        .ok()
        .and_then(|raw| match raw.as_str() {
            "official" => Some(MirrorPreference::Official),
            "aliyun" => Some(MirrorPreference::Aliyun),
            "tuna" => Some(MirrorPreference::Tuna),
            "ustc" => Some(MirrorPreference::Ustc),
            _ => None,
        });
    let options = PlanOptions {
        concurrency: 1,
        mirror_preference: mirror.unwrap_or(MirrorPreference::Huaweicloud),
        proxy: std::env::var("DEVKIT_PROXY").ok().filter(|p| !p.is_empty()),
        create_restore_point: false,
        dry_run: std::env::var("DEVKIT_DRY_RUN").as_deref() == Ok("1"),
    };
    let selections: Vec<PlanSelection> = vec![PlanSelection {
        tool_id: tool_id.clone(),
        version: version_arg,
    }];
    let plan = match devkit_core::plan::build_plan(devkit_core::plan::BuildPlanParams {
        selections: &selections,
        tools: &loaded.tools,
        options: &options,
        devkit_version: "0.1.0-dev",
        manifest_revision: &crate::utc_now_iso()[..10],
        versions_root: &versions_root,
    }) {
        Ok(plan) => plan,
        Err(failure) => {
            eprintln!("计划生成失败：{}", failure.detail);
            return 1;
        }
    };

    println!("\n计划 {}", plan.plan_id);
    if let Some(item) = plan.items.first() {
        println!("  安装位置  {}", item.install_dir.as_deref().unwrap_or("—"));
    }
    println!("  下载缓存  {}", download_dir.display());

    let tools_map: HashMap<String, devkit_types::manifest::ToolManifest> = loaded
        .tools
        .iter()
        .map(|tool| (tool.id.clone(), tool.clone()))
        .collect();

    let rt = tokio::runtime::Runtime::new().expect("创建 tokio runtime 失败");
    let preflight = rt.block_on(devkit_core::preflight::run_preflight(
        devkit_core::preflight::PreflightInput {
            plan: &plan,
            tools: &tools_map,
            target_path: &versions_root.display().to_string(),
            max_probes: Some(3),
            available_tool_ids: None,
        },
    ));

    println!(
        "\n预检：{}",
        if preflight.ok {
            "通过"
        } else {
            "存在阻断问题"
        }
    );
    for check in &preflight.checks {
        let mark = match check.level {
            devkit_types::preflight::PreflightLevel::Ok => "✓",
            devkit_types::preflight::PreflightLevel::Warn => "!",
            devkit_types::preflight::PreflightLevel::Error => "✗",
        };
        println!("  {mark} {}", check.message);
    }
    if !preflight.ok {
        eprintln!("\n预检未通过，已中止（与界面行为一致）");
        return 1;
    }

    println!("\n开始安装…\n");

    let npm_cmd = devkit_core::direct::resolve_npm_cmd(
        Some(&devkit_core::app_paths::get_current_root()),
        &versions_root,
    )
    .0;

    let cancel = CancellationToken::new();
    let last_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let on_update: devkit_core::executor::OnUpdateFn = {
        let last_line = std::sync::Arc::clone(&last_line);
        std::sync::Arc::new(
            move |plan: devkit_types::plan::InstallPlan,
                  current_item_id: Option<String>,
                  detail: Option<devkit_types::plan::InstallProgressDetail>| {
                let item = plan
                    .items
                    .iter()
                    .find(|item| Some(&item.id) == current_item_id.as_ref())
                    .or_else(|| plan.items.first());
                let Some(item) = item else { return };
                let progress = match detail.as_ref().and_then(|entry| entry.received) {
                    Some(received) => {
                        let total = detail.as_ref().and_then(|entry| entry.total).flatten();
                        match total {
                            Some(total) => {
                                format!(" {}/{}", format_bytes(received), format_bytes(total))
                            }
                            None => format!(" {}", format_bytes(received)),
                        }
                    }
                    None => String::new(),
                };
                let line = format!(
                    "{}@{} {}{}",
                    item.id,
                    item.version,
                    state_label(item.state),
                    progress
                );
                let mut last = last_line
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if line != *last {
                    *last = line.clone();
                    let stdout = std::io::stdout();
                    let mut handle = stdout.lock();
                    let _ = write!(handle, "\r  {line:<64}");
                    let _ = handle.flush();
                }
            },
        )
    };

    let plan_for_run = plan.clone();
    let final_plan = rt.block_on(devkit_core::executor::run_plan(
        devkit_core::executor::RunPlanOptions {
            plan: plan_for_run,
            tools: tools_map.clone(),
            download_dir,
            log_dir,
            pending_path: None,
            dry_run: plan.options.dry_run,
            cancel: cancel.clone(),
            activate: None,
            run_elevated_command: None,
            on_update: Some(on_update),
            npm_cmd,
        },
    ));
    // 清掉 \r 进度行（与 TS 的 process.stdout.write('\r' + ' '.repeat(70)) 对齐）
    print!("\r{}", " ".repeat(70));

    let finished = &final_plan.items[0];
    println!("\r结果：{}", state_label(finished.state));
    println!(
        "  说明      {}",
        finished
            .error
            .clone()
            .or_else(|| finished.note.clone())
            .unwrap_or_else(|| "—".to_string())
    );
    let duration = match (&finished.started_at, &finished.finished_at) {
        (Some(started), Some(finished_at)) => {
            // ISO 字符串直接算不可靠；started/finished 都来自执行器，格式一致。
            // 这里只做展示：解析失败就显示 —
            match (parse_iso_ms(started), parse_iso_ms(finished_at)) {
                (Some(s), Some(f)) => format!("{:.1}s", (f - s).abs() / 1000.0),
                _ => "—".to_string(),
            }
        }
        _ => "—".to_string(),
    };
    println!("  耗时      {duration}");

    println!("\n──── 报告预览 ────\n");
    println!(
        "{}",
        devkit_core::report::render_report(&final_plan, &tools_map, devkit_types::Locale::ZhCn)
    );

    if finished.state != PlanItemState::Success {
        return 1;
    }
    0
}

/// 解析执行器写入的 ISO 时间戳为毫秒（只用于耗时展示）。
fn parse_iso_ms(stamp: &str) -> Option<f64> {
    // 形如 2026-11-10T12:34:56.789Z / 2026-11-10T12:34:56Z
    let (date, time) = stamp.split_once('T')?;
    let time = time.trim_end_matches('Z');
    let (hms, millis) = match time.split_once('.') {
        Some((hms, frac)) => (
            hms,
            frac.parse::<f64>().unwrap_or(0.0) / 10f64.powi(frac.len() as i32),
        ),
        None => (time, 0.0),
    };
    let mut parts = hms.split(':');
    let hour: f64 = parts.next()?.parse().ok()?;
    let minute: f64 = parts.next()?.parse().ok()?;
    let second: f64 = parts.next()?.parse().ok()?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    // 粗略天数差足够展示耗时（同一天/跨天都成立）
    let days = days_from_civil(year, month, day);
    Some(
        (days * 86_400) as f64 * 1000.0
            + hour * 3_600_000.0
            + minute * 60_000.0
            + second * 1000.0
            + millis,
    )
}

/// civil_from_days 的逆变换（耗时展示专用，精度到天）。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
