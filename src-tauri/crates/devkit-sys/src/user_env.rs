//! 用户/机器级环境变量与 PATH 读写（镜像 `src/main/core/activate/windows.ts` + `verify.ts` 的读取部分）。
//!
//! 为什么不用 `setx`：setx 在 1024 字符处静默截断，而开发机的 PATH 经常远超这个长度
//! （SPEC §6.7 明确禁用）。这里直接写注册表 `HKCU\Environment`，写回时显式声明为
//! ExpandString，不展开用户原有的 `%VAR%` 写法。
//!
//! 相比 TS 的 PowerShell 方案：Rust 用 windows-registry 直接读写 + 原生
//! `SendMessageTimeoutW` 广播 —— 减一层进程调用，行为一致。

use windows_registry::LOCAL_MACHINE;

const ENV_KEY: &str = r"Environment";
const MACHINE_ENV_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

/// 广播 WM_SETTINGCHANGE，让已经打开的"资源管理器/终端"有机会感知到环境变量变化。
/// 失败不致命（新开的终端从 explorer 继承；没收到广播就得重登）——与 TS 一样吞掉。
fn broadcast_env_change() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    const HWND_BROADCAST: HWND = HWND(0xFFFF as _);
    const SMTO_TIMEOUT_MS: u32 = 3000;

    // "Environment" 是固定 ASCII，栈上构造 UTF-16 + NUL
    let mut wide: Vec<u16> = "Environment".encode_utf16().collect();
    wide.push(0);

    unsafe {
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(PCWSTR::from_raw(wide.as_ptr()).0 as isize),
            SMTO_ABORTIFHUNG,
            SMTO_TIMEOUT_MS,
            Some(&mut result),
        );
    }
}

/// 读注册表某键下某值的**原始字符串**（不展开 %VAR%）；值不存在返回 None。
fn read_raw_string(
    root: &windows_registry::Key,
    subkey: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let key = root
        .open(subkey)
        .map_err(|error| format!("打开注册表 {subkey} 失败：{error}"))?;
    match key.get_string(name) {
        Ok(value) => Ok(Some(value)),
        Err(_) => Ok(None), // 值不存在 ≠ 键读不到；错误细节由调用方需要时再查
    }
}

/// 读用户级环境变量原始值；不存在返回 None。变量名必须合法（防注入）。
pub fn read_user_env(name: &str) -> Result<Option<String>, String> {
    validate_env_name(name)?;
    read_raw_string(windows_registry::CURRENT_USER, ENV_KEY, name)
}

/// 读用户级 PATH 的**原始值**（不展开 %VAR%）。
pub fn read_user_path() -> Result<String, String> {
    Ok(read_raw_string(windows_registry::CURRENT_USER, ENV_KEY, "Path")?.unwrap_or_default())
}

/// 读机器级 PATH 的**原始值**（只读，不需要管理员）。
pub fn read_machine_path() -> Result<String, String> {
    Ok(read_raw_string(LOCAL_MACHINE, MACHINE_ENV_KEY, "Path")?.unwrap_or_default())
}

/// 写用户级环境变量；value 为 None 表示删除该变量。
/// 保持 REG_EXPAND_SZ 类型（ExpandString），不展开用户原有的 %VAR% 写法。
pub fn write_user_env(name: &str, value: Option<&str>) -> Result<(), String> {
    validate_env_name(name)?;
    let key = windows_registry::CURRENT_USER
        .create(ENV_KEY)
        .map_err(|error| format!("打开注册表 {ENV_KEY} 失败：{error}"))?;
    match value {
        Some(value) => key
            .set_expand_string(name, value)
            .map_err(|error| format!("写入用户环境变量 {name} 失败：{error}")),
        None => key
            .remove_value(name)
            .map_err(|error| format!("删除用户环境变量 {name} 失败：{error}")),
    }?;
    broadcast_env_change();
    Ok(())
}

/// 写用户 PATH（保持 REG_EXPAND_SZ 类型）。
pub fn write_user_path(value: &str) -> Result<(), String> {
    write_user_env("Path", Some(value))
        .map_err(|error| error.replace("用户环境变量 Path", "用户 PATH"))
}

/// 环境变量名合法性（对齐 TS 正则 `^[A-Z][A-Z0-9_]{0,40}$`）。
pub fn validate_env_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 41
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_');
    if valid {
        Ok(())
    } else {
        Err(format!("环境变量名不合法：{name}"))
    }
}

/// 读**展开后**的机器级 / 用户级 PATH（对齐 TS verify.ts readEffectivePaths：
/// 用 RegGetValueW 的 RRF_RT_REG_SZ 自动展开 REG_EXPAND_SZ，等价于 .NET 的
/// GetEnvironmentVariable('Path', Machine/User)）。
pub fn read_effective_paths() -> Result<(String, String), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

    fn read_expanded(
        hkey: windows::Win32::System::Registry::HKEY,
        subkey: &str,
        value: &str,
    ) -> String {
        let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let value_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buffer = vec![0u8; 16384];
        loop {
            let mut len = buffer.len() as u32;
            let status: WIN32_ERROR = unsafe {
                RegGetValueW(
                    hkey,
                    PCWSTR::from_raw(subkey_w.as_ptr()),
                    PCWSTR::from_raw(value_w.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    Some(buffer.as_mut_ptr().cast()),
                    Some(&mut len),
                )
            };
            match status {
                ERROR_SUCCESS => {
                    // len 含 NUL；截到 len-2 个字节（UTF-16）
                    let bytes = &buffer[..(len.saturating_sub(2)) as usize];
                    return String::from_utf16_lossy(
                        bytes
                            .chunks_exact(2)
                            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                            .collect::<Vec<u16>>()
                            .as_slice(),
                    );
                }
                // 输出缓冲不够 → 扩一倍再试
                e if e == ERROR_MORE_DATA => {
                    buffer.resize(buffer.len() * 2, 0);
                }
                _ => return String::new(), // 键或值不存在：空（TS 解析失败同样回空）
            }
        }
    }

    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    Ok((
        read_expanded(HKEY_LOCAL_MACHINE, MACHINE_ENV_KEY, "Path"),
        read_expanded(HKEY_CURRENT_USER, ENV_KEY, "Path"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_name_validation() {
        assert!(validate_env_name("JAVA_HOME").is_ok());
        assert!(validate_env_name("PATH").is_ok());
        assert!(validate_env_name("A").is_ok());
        assert!(validate_env_name("bad-name").is_err());
        assert!(validate_env_name("1ABC").is_err());
        assert!(validate_env_name("").is_err());
        assert!(validate_env_name("A;B").is_err());
        assert!(validate_env_name(&"A".repeat(42)).is_err());
    }

    /// 真机读写回归：写一个专用测试变量再删掉（对应 TS windows.ts 的行为语义）。
    #[test]
    fn user_env_roundtrip_real_machine() {
        let name = "DEVKIT_TEST_VAR_XY";
        write_user_env(name, Some("C:\\test %USERPROFILE%")).unwrap();
        // 原始读：不展开 %VAR%
        assert_eq!(
            read_user_env(name).unwrap().as_deref(),
            Some("C:\\test %USERPROFILE%")
        );
        // 删除
        write_user_env(name, None).unwrap();
        assert_eq!(read_user_env(name).unwrap(), None);
    }

    #[test]
    fn read_paths_never_panics() {
        // 本机 PATH 必然存在；读原始值与展开值都不应失败
        let user = read_user_path().unwrap();
        let machine = read_machine_path().unwrap();
        let (em, eu) = read_effective_paths().unwrap();
        assert!(!user.is_empty() || !machine.is_empty());
        // 展开读可能与原始读不同（有 %VAR% 时），但都必须能读
        let _ = (em.len(), eu.len());
    }
}
