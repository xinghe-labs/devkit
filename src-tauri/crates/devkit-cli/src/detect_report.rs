//! `devkit-cli detect-report`（镜像 `scripts/detect-report.ts`）。
//!
//! 用途：
//!  · 开发时快速验证检测规则是否正确，不用每次开界面
//!  · 排查"为什么某个工具没被检测到"——它会把命中依据（命令/文件/注册表）打出来
//!  · 新增清单后自测

use crate::manifest_dir;

fn status_label(status: devkit_types::detection::DetectionStatus) -> &'static str {
    match status {
        devkit_types::detection::DetectionStatus::Installed => "已安装",
        devkit_types::detection::DetectionStatus::VersionMismatch => "版本不同",
        devkit_types::detection::DetectionStatus::PathMissing => "PATH 未生效",
        devkit_types::detection::DetectionStatus::NotInstalled => "未安装",
        devkit_types::detection::DetectionStatus::Error => "检测出错",
    }
}

/// 中英文混排对齐：中文按 2 个宽度算（TS detect-report.ts 同规则）。
fn pad(value: &str, width: usize) -> String {
    let display: usize = value
        .chars()
        .map(|ch| if (ch as u32) > 0x2e80 { 2 } else { 1 })
        .sum();
    let mut result = value.to_string();
    for _ in display..width {
        result.push(' ');
    }
    result
}

pub(crate) fn run(_args: &[String]) -> i32 {
    let dir = manifest_dir();
    let loaded = devkit_manifest::load_manifests(&dir, None, true);
    if !loaded.errors.is_empty() {
        eprintln!(
            "有 {} 个清单未通过校验，请先执行 manifest-check",
            loaded.errors.len()
        );
        return 1;
    }

    let rt = tokio::runtime::Runtime::new().expect("创建 tokio runtime 失败");
    let results = rt.block_on(devkit_core::detect::detect_all(
        &loaded.tools,
        &devkit_sys::registry::get_installed_programs().unwrap_or_default(),
        devkit_core::detect::DetectAllOptions { concurrency: None },
        None,
    ));

    println!("\n环境检测报告");
    println!("{}", "─".repeat(110));
    println!(
        "{}{}{}{}命中依据",
        pad("工具", 16),
        pad("状态", 14),
        pad("已装版本", 20),
        pad("推荐版本", 20)
    );
    println!("{}", "─".repeat(110));

    for result in &results {
        println!(
            "{}{}{}{}{}",
            pad(&result.tool_id, 16),
            pad(status_label(result.status), 14),
            pad(result.installed_version.as_deref().unwrap_or("—"), 20),
            pad(result.recommended_version.as_deref().unwrap_or("—"), 20),
            result
                .evidence
                .as_deref()
                .or(result.error.as_deref())
                .unwrap_or("—")
        );
    }

    println!("{}", "─".repeat(110));

    let mut by_status: Vec<(devkit_types::detection::DetectionStatus, usize)> = Vec::new();
    for result in &results {
        if let Some(entry) = by_status
            .iter_mut()
            .find(|(status, _)| *status == result.status)
        {
            entry.1 += 1;
        } else {
            by_status.push((result.status, 1));
        }
    }
    let summary: Vec<String> = by_status
        .iter()
        .map(|(status, count)| format!("{} {count}", status_label(*status)))
        .collect();
    println!("合计 {} 个：{}", results.len(), summary.join(" · "));
    0
}

#[cfg(test)]
mod tests {
    use super::pad;

    #[test]
    fn pad_counts_cjk_as_two() {
        assert_eq!(pad("ab", 5).chars().count(), 5);
        // 中文 2 宽度：2 个汉字 = 4 宽度，补 1 个空格到 5
        assert_eq!(pad("中文", 5).chars().count(), 3);
    }
}
