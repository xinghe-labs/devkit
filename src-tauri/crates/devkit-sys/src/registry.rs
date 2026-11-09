//! 已安装程序扫描（对应 TS `src/main/core/detect/registry.ts`，决策 D6：直读注册表）。
//!
//! 原 TS 用 `reg.exe query /s` 子进程 + 文本解析；Rust 改用 windows crate 直读直查，
//! 消灭子进程与一半解析代码。扫描语义保持逐字对齐：
//! 只扫 4 个标准位置（TS 的 reg.exe 4 组参数，经实测 /reg:32 不会对字面
//! WOW6432Node 路径做二次重定向），一次扫完由调用方缓存。

use std::collections::HashMap;

use devkit_types::detection::{InstalledProgram, RegistryHive, RegistryView};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, NO_ERROR};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    REG_VALUE_TYPE, RRF_RT_REG_SZ,
};

/// 单次扫描配置：hive + 路径 + 视图（对齐 TS 的 UNINSTALL_KEYS 顺序）。
struct ScanTarget {
    hive: RegistryHive,
    view: RegistryView,
    /// Uninstall 子键所在路径（不含 hive；32 位视图走字面 WOW6432Node 路径）
    path: &'static str,
}

const SCAN_TARGETS: [ScanTarget; 4] = [
    ScanTarget {
        hive: RegistryHive::Hklm,
        view: RegistryView::View64,
        path: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    },
    ScanTarget {
        hive: RegistryHive::Hklm,
        view: RegistryView::View32,
        path: "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    },
    ScanTarget {
        hive: RegistryHive::Hkcu,
        view: RegistryView::View64,
        path: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    },
    ScanTarget {
        hive: RegistryHive::Hkcu,
        view: RegistryView::View32,
        path: "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    },
];

fn root_key(hive: RegistryHive) -> HKEY {
    match hive {
        RegistryHive::Hklm => HKEY_LOCAL_MACHINE,
        RegistryHive::Hkcu => HKEY_CURRENT_USER,
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 把一个 Uninstall 子键的全部值读成字符串表。
/// 字符串化规则对齐 reg.exe 输出形态：REG_SZ/EXPAND_SZ 原文；DWORD `0x%x (n)`；其余空串。
fn read_fields(key: HKEY) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut index = 0u32;
    loop {
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let mut ty = 0u32;
        let mut data = [0u8; 2048];
        let mut data_len = data.len() as u32;
        let result = unsafe {
            RegEnumValueW(
                key,
                index,
                PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut ty),
                Some(data.as_mut_ptr()),
                Some(&mut data_len),
            )
        };
        if result != NO_ERROR || result == ERROR_NO_MORE_ITEMS {
            break;
        }
        index += 1;

        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let value = stringify_value(REG_VALUE_TYPE(ty), &data[..data_len as usize]);
        fields.insert(name, value);
    }
    fields
}

fn stringify_value(ty: REG_VALUE_TYPE, data: &[u8]) -> String {
    // REG_SZ = 1, REG_EXPAND_SZ = 2（含结尾 NUL 的 UTF-16）
    if ty.0 == 1 || ty.0 == 2 {
        let units: Vec<u16> = data
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&unit| unit != 0)
            .collect();
        return String::from_utf16_lossy(&units);
    }
    // REG_DWORD = 4：reg.exe 输出形如 `0x1f4 (500)`
    if ty.0 == 4 && data.len() == 4 {
        let value = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        return format!("0x{value:x} ({value})");
    }
    String::new()
}

/// 枚举一个 Uninstall 键下的全部子键，读出每个子键的值表。
fn scan_one(target: &ScanTarget) -> Result<Vec<InstalledProgram>, String> {
    let subpath = wide(target.path);
    let mut flags = KEY_READ;
    flags |= match target.view {
        RegistryView::View32 => KEY_WOW64_32KEY,
        RegistryView::View64 => KEY_WOW64_64KEY,
    };
    let mut key = HKEY::default();
    let open = unsafe {
        RegOpenKeyExW(
            root_key(target.hive),
            PCWSTR(subpath.as_ptr()),
            0,
            flags,
            &mut key,
        )
    };
    // 键不存在时返回错误，属于正常情况（对齐 TS 的 debug 日志分支）
    if open.is_err() {
        return Ok(Vec::new());
    }

    let mut programs = Vec::new();
    let mut index = 0u32;
    loop {
        let mut key_buf = [0u16; 256];
        let mut key_len = key_buf.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                key,
                index,
                PWSTR(key_buf.as_mut_ptr()),
                &mut key_len,
                None,
                PWSTR::null(),
                None,
                None,
            )
        };
        if result != NO_ERROR || result == ERROR_NO_MORE_ITEMS {
            break;
        }
        index += 1;

        let key_name = String::from_utf16_lossy(&key_buf[..key_len as usize]);
        let _sub = HKEY::default();
        let sub_name = wide(&key_name);
        let mut sub = HKEY::default();
        let sub_open = unsafe { RegOpenKeyExW(key, PCWSTR(sub_name.as_ptr()), 0, flags, &mut sub) };
        if sub_open.is_err() {
            continue;
        }
        let fields = read_fields(sub);
        unsafe {
            let _ = RegCloseKey(sub);
        }

        // 与 TS 一致：没有 DisplayName 的项不收（有些占位键只有 UninstallString）
        if fields.contains_key("DisplayName") {
            let full_path = format!(
                "{}\\{}\\{}",
                match target.hive {
                    RegistryHive::Hklm => "HKEY_LOCAL_MACHINE",
                    RegistryHive::Hkcu => "HKEY_CURRENT_USER",
                },
                target.path,
                key_name
            );
            programs.push(InstalledProgram {
                hive: target.hive,
                view: target.view,
                key_path: full_path,
                fields,
            });
        }
    }

    unsafe {
        let _ = RegCloseKey(key);
    }
    Ok(programs)
}

/// 扫描已安装程序（注册表 Uninstall 项）。
///
/// 只扫 4 个标准位置，一次扫完缓存起来 —— 12 个清单各自去查注册表会慢到无法接受。
/// 这份数据后面 FR-16（卸载）也会复用，因为它同时带出了 UninstallString。
///
/// 单个目标读不到（键不存在/权限不足）时跳过而不是整体失败：
/// HKCU 下没有对应键是干净机器上的常态。
pub fn get_installed_programs() -> Result<Vec<InstalledProgram>, String> {
    let mut collected = Vec::new();
    for target in &SCAN_TARGETS {
        {
            let programs = scan_one(target)?;
            collected.extend(programs)
        }
    }
    Ok(collected)
}

/// 读取单个注册表字符串值（detect 之外的场景复用；不存在/非字符串返回 None）。
pub fn get_string_value(hive: RegistryHive, path: &str, name: &str) -> Option<String> {
    let subpath = wide(path);
    let name_w = wide(name);
    let mut flags = KEY_READ;
    // 常规读取用 64 位视图（native）；调用方需要 32 位视图时显式走 scan
    flags |= KEY_WOW64_64KEY;
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(root_key(hive), PCWSTR(subpath.as_ptr()), 0, flags, &mut key) }
        != NO_ERROR
    {
        return None;
    }
    let mut data_len = 0u32;
    let result = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut data_len),
        )
    };
    if result != NO_ERROR {
        unsafe {
            let _ = RegCloseKey(key);
        }
        return None;
    }
    let mut data = vec![0u8; data_len as usize];
    let result = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut data_len),
        )
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if result != NO_ERROR {
        return None;
    }
    let units: Vec<u16> = data[..data_len as usize]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&unit| unit != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// 读取 Windows build 号（对应 TS 的 os.release() "10.0.19045" 第三段）。
///
/// 从注册表 CurrentVersion 的 CurrentBuildNumber 读（REG_SZ 的十进制文本），
/// UBR（Update Build Revision）不拼入 —— os.release() 也不带 UBR。
pub fn windows_build_number() -> Option<u32> {
    let build = get_string_value(
        RegistryHive::Hklm,
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        "CurrentBuildNumber",
    )?;
    build.trim().parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「版本字段提取」用例（D6 保留）：扫描结果能读出 DisplayName/DisplayVersion。
    /// 本机必然装有某些带 DisplayName 的 Uninstall 项（Windows 自身就有）。
    #[test]
    fn scan_finds_programs_with_display_fields() {
        let programs = get_installed_programs().expect("扫描不应整体失败");
        assert!(!programs.is_empty(), "本机 Uninstall 表不该为空");
        let with_version = programs
            .iter()
            .filter(|program| program.fields.contains_key("DisplayVersion"))
            .count();
        assert!(with_version > 0, "至少应有带 DisplayVersion 的程序");
        // keyPath 必须带 hive 全名（detect 的 matchRegistry 用 includes 匹配）
        let sample = &programs[0];
        assert!(
            sample.key_path.starts_with("HKEY_LOCAL_MACHINE\\")
                || sample.key_path.starts_with("HKEY_CURRENT_USER\\")
        );
    }

    /// 「WOW6432Node 差异」用例（D6 保留）：两个视图都能打开，
    /// 且 hive/view 字段如实标注来源（matchRegistry 靠它们过滤）。
    #[test]
    fn scan_reports_hive_and_view_correctly() {
        let programs = get_installed_programs().expect("扫描不应整体失败");
        let hklm_64 = programs
            .iter()
            .filter(|program| {
                program.hive == RegistryHive::Hklm && program.view == RegistryView::View64
            })
            .count();
        let hklm_32 = programs
            .iter()
            .filter(|program| {
                program.hive == RegistryHive::Hklm && program.view == RegistryView::View32
            })
            .count();
        assert!(hklm_64 > 0, "HKLM 64 位视图不该为空");
        assert!(hklm_32 > 0, "HKLM 32 位视图（WOW6432Node）不该为空");
    }

    #[test]
    fn build_number_parses() {
        // 本机 build 号必然 >= 10240（Windows 10 起步）；读不到返回 None 也不该 panic
        if let Some(build) = windows_build_number() {
            assert!(build >= 10_240, "build 号异常：{build}");
        }
    }
}
