//! 无依赖的 UTC 时间戳工具。
//!
//! 主进程日志与 ManifestLoadResult.loadedAt 需要 ISO 8601 字符串；
//! 不为此引入 chrono，UNIX 秒 → 公历日期用 Howard Hinnant 的 civil 算法。

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前 UTC 时间的 ISO 8601 字符串，例如 `2026-02-14T08:30:00.123Z`。
/// 与 JS `new Date().toISOString()` 同格式（毫秒三位，结尾 Z）。
pub fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso8601_from_unix(now.as_secs() as i64, now.subsec_millis())
}

/// 由 UNIX 秒 + 毫秒构造 ISO 8601 UTC 字符串。
pub fn iso8601_from_unix(unix_secs: i64, millis: u32) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant `civil_from_days`：UNIX 天数 → (y, m, d)。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_timestamps() {
        // 1970-01-01T00:00:00.000Z
        assert_eq!(iso8601_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        // 2025-01-15T08:30:00.500Z = 1736929800
        assert_eq!(
            iso8601_from_unix(1_736_929_800, 500),
            "2025-01-15T08:30:00.500Z"
        );
        // 2000-02-29T12:00:00.000Z（闰年）= 951825600
        assert_eq!(
            iso8601_from_unix(951_825_600, 0),
            "2000-02-29T12:00:00.000Z"
        );
        // 1969-12-31T23:59:59.000Z（负时间）
        assert_eq!(iso8601_from_unix(-1, 0), "1969-12-31T23:59:59.000Z");
    }

    #[test]
    fn format_matches_js_to_iso_string() {
        // JS: new Date('2026-02-14T08:30:00.123Z').getTime() / 1000
        let js_epoch_secs = 1_771_057_800;
        assert_eq!(
            iso8601_from_unix(js_epoch_secs, 123),
            "2026-02-14T08:30:00.123Z"
        );
    }
}
