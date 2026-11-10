//! devkit CLI（镜像 `scripts/*.ts`，FR-12 / 附录 H 迁移映射）。
//!
//! 子命令：
//! - `install <toolId> [version]`   ← scripts/install-tool.ts：真实安装一个工具（端到端验收）
//! - `detect-report`                ← scripts/detect-report.ts：环境检测报告
//! - `make-update-index`            ← scripts/make-update-index.ts：生成 release/latest.json（FR-13）
//! - `verify-update`                ← scripts/verify-update.ts：手动验证更新包下载与校验（依赖网络）
//!
//! `manifest-check` 独立在 devkit-manifest 的同名 bin（`cargo run -p devkit-manifest --bin manifest-check`）。
//!
//! 缓与下载与 GUI 共用同一套规则（devkit-core downloader / app-paths）——
//! 这正是 install-tool.ts 当年的教训：脚本和应用各下一份，缓存命中不了。

mod detect_report;
mod install;
mod make_update_index;
mod verify_update;

use std::path::PathBuf;

fn print_usage() {
    println!(
        "devkit-cli —— devkit 维护 CLI\n\n\
用法：\n  \
devkit-cli install <toolId> [version]      真实安装一个工具（端到端验收）\n  \
devkit-cli detect-report                   环境检测报告\n  \
devkit-cli make-update-index [--dir <目录>] [--version <v>] [--runtime <tauri|electron>] [--notes <文案>] [--no-runtime]\n  \
devkit-cli verify-update                   验证更新包下载与 SHA-256 校验（联网）\n\n\
manifest 清单校验请用：cargo run -p devkit-manifest --bin manifest-check"
    );
}

/// 从仓库根解析清单目录：逐级上溯找 `resources/manifest/tools`，
/// 覆盖仓库根 / src-tauri / crates/* 三种 cwd（CLI 与测试都在这些目录下跑）。
pub(crate) fn manifest_dir() -> PathBuf {
    let mut cwd = std::env::current_dir().unwrap_or_default();
    loop {
        let candidate = cwd.join("resources/manifest");
        if candidate.join("tools").is_dir() {
            return candidate;
        }
        if !cwd.pop() {
            break;
        }
    }
    eprintln!(
        "找不到 resources/manifest/tools（从 {} 逐级上溯未命中，请在仓库内运行）",
        std::env::current_dir().unwrap_or_default().display()
    );
    std::process::exit(1);
}

/// UTC ISO-8601 时间戳（对齐 TS `new Date().toISOString()`，无 chrono 依赖）。
pub(crate) fn utc_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days（与 devkit-types/timeutil 同思路的内联实现）。
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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print_usage();
        std::process::exit(2);
    };
    let rest = &args[1..];

    let code = match command {
        "install" => install::run(rest),
        "detect-report" => detect_report::run(rest),
        "make-update-index" => make_update_index::run(rest),
        "verify-update" => verify_update::run(rest),
        "-h" | "--help" | "help" => {
            print_usage();
            0
        }
        other => {
            eprintln!("未知子命令：{other}\n");
            print_usage();
            2
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_now_iso_has_expected_shape() {
        let stamp = utc_now_iso();
        // 2026-01-01T00:00:00.000Z 形态：20 位 + Z
        assert_eq!(stamp.len(), 24, "实际：{stamp}");
        assert!(stamp.ends_with('Z'));
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert!(stamp.starts_with("20"));
    }

    #[test]
    fn civil_from_days_known_dates() {
        // 1970-01-01 = day 0
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-03-01 = day 11017（闰年 2 月之后）
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn manifest_dir_finds_repo_layout() {
        // 在仓库根或 src-tauri 下运行时都能找到
        let dir = manifest_dir();
        assert!(dir.join("tools").is_dir(), "实际：{}", dir.display());
    }
}
