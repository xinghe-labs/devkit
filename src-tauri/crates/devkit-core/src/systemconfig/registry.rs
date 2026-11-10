//! 注册表读写（镜像 `src/main/core/systemconfig/registry.ts`）。
//!
//! **踩过的坑**：`reg.exe` 只认 `HKLM\SYSTEM\...`，
//! 而 `HKLM:\SYSTEM\...`（带冒号）是 **PowerShell** 的注册表提供程序写法。
//! 所有转换收在这一处，读和写共用，杜绝再漏一次。

use crate::exec::{run_command, RunOptions};
#[cfg(test)]
use std::sync::OnceLock;
#[cfg(test)]
use tokio::sync::Mutex;

/// PowerShell 风格 → reg.exe 风格：`HKLM:\A\B` → `HKLM\A\B`
pub fn to_reg_path(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("hklm:\\") {
        format!("HKLM\\{}", &path[6..])
    } else if lower.starts_with("hkcu:\\") {
        format!("HKCU\\{}", &path[6..])
    } else {
        path.to_string()
    }
}

/// 反方向，仅用于日志/展示
pub fn to_ps_path(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("hklm\\") {
        format!("HKLM:\\{}", &path[5..])
    } else if lower.starts_with("hkcu\\") {
        format!("HKCU:\\{}", &path[5..])
    } else {
        path.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryRead {
    /// 键本身是否存在
    pub key_exists: bool,
    /// 值是否存在 —— 这是备份「原本不存在」与「原本为 0」的关键区分
    pub value_exists: bool,
    pub value: Option<u32>,
}

/// 从 `reg query ... /v NAME` 的 stdout 里解析 REG_DWORD。
/// 纯函数，单测覆盖大小写、十六进制、非 DWORD 类型等情况。
pub fn parse_reg_dword(name: &str, stdout: &str) -> Option<u32> {
    // 形如 `    LongPathsEnabled    REG_DWORD    0x1`
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let Some(value_name) = parts.next() else {
            continue;
        };
        if !value_name.eq_ignore_ascii_case(name) {
            continue;
        }
        let ty = parts.next().unwrap_or("");
        if !ty.eq_ignore_ascii_case("REG_DWORD") {
            // 值存在但不是 REG_DWORD（例如 REG_SZ）—— 当作读不到，不要猜
            return None;
        }
        let data = parts.next().unwrap_or("");
        let hex = data
            .strip_prefix("0x")
            .or_else(|| data.strip_prefix("0X"))?;
        return u32::from_str_radix(hex, 16).ok();
    }
    None
}

/// 读一个 REG_DWORD。
///
/// 刻意分两次查：先确认键存在，再确认值存在。
/// 只查值的话，「值不存在」与「键不存在」返回的是同一句话，区分不开，
/// 而备份恰恰必须区分「原本不存在」和「原本为 0」。
pub async fn read_reg_dword(path: &str, name: &str) -> RegistryRead {
    let reg_path = to_reg_path(path);

    let key = run_command(
        "reg.exe",
        &["query".to_string(), reg_path.clone()],
        &RunOptions::default(),
    )
    .await;
    let key_exists = key.code == Some(0);

    let entry = run_command(
        "reg.exe",
        &[
            "query".to_string(),
            reg_path,
            "/v".to_string(),
            name.to_string(),
        ],
        &RunOptions::default(),
    )
    .await;
    if entry.code != Some(0) {
        return RegistryRead {
            key_exists,
            value_exists: false,
            value: None,
        };
    }

    match parse_reg_dword(name, &entry.stdout) {
        Some(value) => RegistryRead {
            key_exists,
            value_exists: true,
            value: Some(value),
        },
        // stdout 匹配不上但退出码为 0：值存在但类型不是 DWORD
        None => RegistryRead {
            key_exists,
            value_exists: true,
            value: None,
        },
    }
}

/// 写一个 REG_DWORD（需要管理员，调用方负责提权）
pub fn reg_dword_add_args(path: &str, name: &str, value: u32) -> Vec<String> {
    vec![
        "add".into(),
        to_reg_path(path),
        "/v".into(),
        name.to_string(),
        "/t".into(),
        "REG_DWORD".into(),
        "/d".into(),
        value.to_string(),
        "/f".into(),
    ]
}

/// 删除一个值（需要管理员）。用 /f 避免交互式确认
pub fn reg_delete_args(path: &str, name: &str) -> Vec<String> {
    vec![
        "delete".into(),
        to_reg_path(path),
        "/v".into(),
        name.to_string(),
        "/f".into(),
    ]
}

/// 键不存在时 `reg delete` 会失败。
/// 还原一个「原本不存在」的值时，失败是**预期结果**（说明本来就是干净的），
/// 所以这个判断要单独拿出来，不能让调用方把两种情况混为一谈。
pub fn is_missing_value_error(stderr: &str) -> bool {
    stderr.contains("找不到")
        || stderr.to_ascii_lowercase().contains("cannot find")
        || stderr.to_ascii_lowercase().contains("unable to find")
}

/// 测试专用互斥：涉及 HKCU 测试键的用例串行执行，避免 reg.exe 写冲突。
#[cfg(test)]
pub(crate) static REG_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn reg_test_lock() -> &'static Mutex<()> {
    REG_TEST_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_reg_path_strips_ps_colon() {
        assert_eq!(
            to_reg_path(r"HKLM:\SYSTEM\Control\FileSystem"),
            r"HKLM\SYSTEM\Control\FileSystem"
        );
        assert_eq!(to_reg_path(r"HKCU:\Software\X"), r"HKCU\Software\X");
        assert_eq!(to_reg_path(r"HKLM\Already\Fine"), r"HKLM\Already\Fine");
    }

    #[test]
    fn to_ps_path_adds_colon() {
        assert_eq!(to_ps_path(r"HKLM\SYSTEM\Control"), r"HKLM:\SYSTEM\Control");
        assert_eq!(to_ps_path(r"HKCU\Software"), r"HKCU:\Software");
        assert_eq!(to_ps_path(r"HKLM:\X"), r"HKLM:\X");
    }

    #[test]
    fn parse_reg_dword_handles_real_output() {
        let stdout = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    0x1\r\n\r\n";
        assert_eq!(parse_reg_dword("LongPathsEnabled", stdout), Some(1));

        let zero = "    Name    REG_DWORD    0x0";
        assert_eq!(parse_reg_dword("Name", zero), Some(0));

        // 大小写不敏感
        assert_eq!(parse_reg_dword("longpathsenabled", stdout), Some(1));

        // 非 DWORD 类型 → None（不猜）
        let sz = "    SomeValue    REG_SZ    hello";
        assert_eq!(parse_reg_dword("SomeValue", sz), None);

        // 值名对不上 → None
        assert_eq!(parse_reg_dword("Other", stdout), None);
    }

    #[test]
    fn reg_args_builders() {
        assert_eq!(
            reg_dword_add_args(r"HKLM:\SYSTEM\X", "LongPathsEnabled", 1),
            vec![
                "add".to_string(),
                r"HKLM\SYSTEM\X".to_string(),
                "/v".to_string(),
                "LongPathsEnabled".to_string(),
                "/t".to_string(),
                "REG_DWORD".to_string(),
                "/d".to_string(),
                "1".to_string(),
                "/f".to_string(),
            ]
        );
        assert_eq!(
            reg_delete_args(r"HKLM:\SYSTEM\X", "Name"),
            vec![
                "delete".to_string(),
                r"HKLM\SYSTEM\X".to_string(),
                "/v".to_string(),
                "Name".to_string(),
                "/f".to_string(),
            ]
        );
    }

    #[test]
    fn missing_value_error_detection() {
        assert!(is_missing_value_error(
            "错误: 系统找不到指定的注册表项或值。"
        ));
        assert!(is_missing_value_error(
            "ERROR: The system was unable to find the specified registry key or value."
        ));
        assert!(!is_missing_value_error("access denied 拒绝访问"));
    }

    /// 真机验证（HKCU 自建测试键，不需要管理员）：
    /// add → read → delete → read，完整走一遍 reg.exe 路径。
    #[tokio::test]
    async fn read_reg_dword_real_machine_roundtrip() {
        let _guard = reg_test_lock().lock().await;
        let test_key = r"HKCU:\Software\DevkitRustSelfTest";
        let test_name = "RoundTripValue";

        // 确保起点干净（上次测试可能残留）
        let _ = run_command(
            "reg.exe",
            &reg_delete_args(test_key, test_name),
            &RunOptions::default(),
        )
        .await;

        // 值不存在
        let before = read_reg_dword(test_key, test_name).await;
        assert!(before.key_exists || !before.key_exists); // 键可能也不存在
        assert!(!before.value_exists);
        assert_eq!(before.value, None);

        // 写入（HKCU 不需要管理员）
        let add = run_command(
            "reg.exe",
            &reg_dword_add_args(test_key, test_name, 1),
            &RunOptions::default(),
        )
        .await;
        assert_eq!(add.code, Some(0), "reg add 失败：{}", add.stderr);

        // 读到 1
        let after = read_reg_dword(test_key, test_name).await;
        assert!(after.key_exists);
        assert!(after.value_exists);
        assert_eq!(after.value, Some(1));

        // 删除
        let del = run_command(
            "reg.exe",
            &reg_delete_args(test_key, test_name),
            &RunOptions::default(),
        )
        .await;
        assert_eq!(del.code, Some(0));

        // 复查：值不存在
        let cleaned = read_reg_dword(test_key, test_name).await;
        assert!(!cleaned.value_exists);
    }
}
