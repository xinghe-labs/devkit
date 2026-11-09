//! 用**注册表登记的卸载程序**卸载（镜像 `src/main/core/uninstall/registry.ts`，
//! 清单里 `uninstall.type === 'registry'`，机器级 MSI 都是）。
//!
//! 机器级 MSI 装完会在 `HKLM\...\Uninstall\{ProductCode}` 留一条卸载记录。
//! devkit 原来的卸载只删版本目录，于是「应用和功能」里留着幽灵条目。
//! 优先走 MSI 标准卸载：键名本身就是 ProductCode，直接 `msiexec /x {GUID} /qn /norestart`。

use crate::elevation::{ElevatedRunner, ElevatedStep};
use crate::logging;
use devkit_types::detection::{InstalledProgram, RegistryDetectRule};
use devkit_types::manifest::ToolManifest;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryUninstallTarget {
    /// 「应用和功能」里显示的名字，用于日志与提示
    pub display_name: String,
    /// 卸载命令（已切好）
    pub cmd: String,
    pub args: Vec<String>,
    pub kind: String, // "msi" | "exe"
    /// 定位到的那条注册表键；卸载完要复查它没了
    pub key_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryUninstallResult {
    pub ok: bool,
    /// 定位到的目标；None 表示这台机器上没找到对应卸载记录
    pub target: Option<RegistryUninstallTarget>,
    pub detail: Option<String>,
    pub error: Option<String>,
}

const GUID_KEY: &str = r"^\{[0-9A-Fa-f-]{36}\}$";

/// 把 Windows 命令行切成 argv。
///
/// 规则简单但够用：双引号包裹的片段保留空格，其余按空白切。
/// `UninstallString` 常见形态：
///   `"C:\Program Files\Foo\uninst.exe" /S`
///   `MsiExec.exe /I{90160000-...}`
pub fn split_windows_command(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for ch in command.trim().chars() {
        match ch {
            '"' => {
                quoted = !quoted;
            }
            c if !quoted && c.is_whitespace() => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// 按清单的 detect.registry 规则找出对应的卸载条目（与检测用同一套匹配逻辑）
pub fn find_uninstall_entry(
    rules: Option<&Vec<RegistryDetectRule>>,
    programs: &[InstalledProgram],
) -> Option<InstalledProgram> {
    let rules = rules?;
    if rules.is_empty() || programs.is_empty() {
        return None;
    }

    for rule in rules {
        for program in programs {
            if program.hive != rule.hive || program.view != rule.view {
                continue;
            }
            if !program.key_path.to_ascii_lowercase().contains(&rule.path.to_ascii_lowercase()) {
                continue;
            }

            let mut matched = true;
            for (field, pattern) in &rule.match_rules {
                let Some(value) = program.fields.get(field) else {
                    matched = false;
                    break;
                };
                let Ok(expression) = Regex::new(&format!("(?i){pattern}")) else {
                    matched = false;
                    break;
                };
                if !expression.is_match(value) {
                    matched = false;
                    break;
                }
            }
            if matched {
                return Some(program.clone());
            }
        }
    }
    None
}

/// 从一条卸载记录推导出该怎么卸
pub fn plan_uninstall(program: &InstalledProgram) -> Option<RegistryUninstallTarget> {
    let display_name = program
        .fields
        .get("DisplayName")
        .cloned()
        .unwrap_or_else(|| program.key_path.clone());
    let last_segment = program.key_path.split('\\').next_back().unwrap_or_default();

    // MSI：键名就是 ProductCode
    if Regex::new(GUID_KEY).is_ok_and(|guid| guid.is_match(last_segment)) {
        return Some(RegistryUninstallTarget {
            display_name,
            cmd: "msiexec.exe".to_string(),
            args: vec!["/x".to_string(), last_segment.to_string(), "/qn".to_string(), "/norestart".to_string()],
            kind: "msi".to_string(),
            key_path: program.key_path.clone(),
        });
    }

    // 非 MSI：优先 QuietUninstallString（无界面），否则 UninstallString
    let raw = program
        .fields
        .get("QuietUninstallString")
        .or_else(|| program.fields.get("UninstallString"))?;
    let parts = split_windows_command(raw);
    let (cmd, args) = parts.split_first()?;
    Some(RegistryUninstallTarget {
        display_name,
        cmd: cmd.clone(),
        args: args.to_vec(),
        kind: "exe".to_string(),
        key_path: program.key_path.clone(),
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryUninstallOutcome {
    pub ok: bool,
    pub target: Option<RegistryUninstallTarget>,
    pub detail: Option<String>,
    pub error: Option<String>,
}

/// 执行注册表卸载。
///
/// 走提权（MSI 卸载要管理员），**卸载后重新扫一遍注册表确认那条记录真的没了** ——
/// 与 devkit 其他地方一致：写操作之后必须复验，不能只看命令退出码。
pub fn uninstall_by_registry(
    tool: &ToolManifest,
    elevated: &dyn ElevatedRunner,
) -> RegistryUninstallOutcome {
    let entry = match devkit_sys::registry::get_installed_programs() {
        Ok(programs) => find_uninstall_entry(tool.detect.registry.as_ref(), &programs),
        Err(error) => {
            return RegistryUninstallOutcome {
                ok: false,
                target: None,
                detail: None,
                error: Some(format!("读取注册表卸载记录失败：{error}")),
            }
        }
    };

    let Some(entry) = entry else {
        // 没有记录不算失败：可能本来就不是走注册表装的（比如用户手工解压的）
        return RegistryUninstallOutcome { ok: true, target: None, detail: None, error: None };
    };

    let Some(target) = plan_uninstall(&entry) else {
        return RegistryUninstallOutcome {
            ok: false,
            target: None,
            detail: None,
            error: Some(format!(
                "「{}」有卸载记录，但既不是 MSI 也没有可用的 UninstallString，无法自动卸载",
                entry.fields.get("DisplayName").cloned().unwrap_or_else(|| entry.key_path.clone())
            )),
        };
    };

    let outcome = elevated.run(vec![ElevatedStep::Exec {
        label: format!("卸载 {}", target.display_name),
        cmd: target.cmd.clone(),
        args: target.args.clone(),
    }]);
    if !outcome.ok {
        return RegistryUninstallOutcome {
            ok: false,
            target: Some(target.clone()),
            detail: None,
            error: Some(if outcome.cancelled {
                "用户取消了管理员授权，注册表卸载未执行".to_string()
            } else {
                format!(
                    "卸载 {} 失败：{}",
                    target.display_name,
                    outcome.error.unwrap_or_else(|| "未知原因".to_string())
                )
            }),
        };
    }

    // 复验：那条卸载记录必须消失
    match devkit_sys::registry::get_installed_programs() {
        Ok(after) => {
            if let Some(still_there) = find_uninstall_entry(tool.detect.registry.as_ref(), &after) {
                return RegistryUninstallOutcome {
                    ok: false,
                    target: Some(target.clone()),
                    detail: None,
                    error: Some(format!(
                        "卸载命令已执行，但「{}」的卸载记录仍在（{}）—— 可能被安装器忽略了",
                        target.display_name, still_there.key_path
                    )),
                };
            }
        }
        Err(error) => {
            logging::global().warn("uninstall", &format!("复验注册表卸载结果失败：{error}"));
        }
    }

    logging::global().info(
        "uninstall",
        &format!("已通过注册表卸载 {}（{}）", target.display_name, target.kind),
    );
    let detail = format!(
        "已卸载「{}」（{}）",
        target.display_name,
        if target.kind == "msi" { "MSI" } else { "自带卸载程序" }
    );
    RegistryUninstallOutcome {
        ok: true,
        target: Some(target),
        detail: Some(detail),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::detection::{RegistryHive, RegistryDetectRule, RegistryView};
    use std::collections::HashMap;

    fn program(key_path: &str, fields: &[(&str, &str)]) -> InstalledProgram {
        InstalledProgram {
            hive: RegistryHive::Hklm,
            view: RegistryView::View64,
            key_path: key_path.to_string(),
            fields: fields.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    fn msi_rule() -> RegistryDetectRule {
        let mut match_rules = HashMap::new();
        match_rules.insert("DisplayName".to_string(), "7-Zip".to_string());
        RegistryDetectRule {
            hive: RegistryHive::Hklm,
            view: RegistryView::View64,
            path: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall".to_string(),
            match_rules,
            version_from: None,
        }
    }

    fn rule_with_field(field: &str, pattern: &str) -> RegistryDetectRule {
        let mut match_rules = HashMap::new();
        match_rules.insert(field.to_string(), pattern.to_string());
        RegistryDetectRule {
            hive: RegistryHive::Hklm,
            view: RegistryView::View64,
            path: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall".to_string(),
            match_rules,
            version_from: None,
        }
    }

    #[test]
    fn split_windows_command_preserves_quoted_spaces() {
        assert_eq!(
            split_windows_command(r#""C:\Program Files\Foo\uninst.exe" /S"#),
            vec![r"C:\Program Files\Foo\uninst.exe".to_string(), "/S".to_string()]
        );
        assert_eq!(
            split_windows_command("MsiExec.exe /I{90160000-0000-0000-0000-000000000000}"),
            vec![
                "MsiExec.exe".to_string(),
                "/I{90160000-0000-0000-0000-000000000000}".to_string()
            ]
        );
        assert!(split_windows_command("   ").is_empty());
    }

    #[test]
    fn find_uninstall_entry_matches_rules() {
        let rules = vec![msi_rule()];

        let programs = vec![program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{23170F69-40C1-2702-0000-000000000000}",
            &[("DisplayName", "7-Zip 23.01 (x64)")],
        )];
        let found = find_uninstall_entry(Some(&rules), &programs).expect("matched");
        assert!(found.key_path.contains("{23170F69"));

        // 字段不匹配 → None
        let other = vec![program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{23170F69-40C1-2702-0000-000000000000}",
            &[("DisplayName", "Something Else")],
        )];
        assert!(find_uninstall_entry(Some(&rules), &other).is_none());

        // 无规则 / 无程序 → None
        assert!(find_uninstall_entry(None, &programs).is_none());
        assert!(find_uninstall_entry(Some(&rules), &[]).is_none());
    }

    #[test]
    fn plan_uninstall_msi_uses_product_code() {
        let entry = program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{23170F69-40C1-2702-0000-000000000000}",
            &[("DisplayName", "7-Zip 23.01 (x64)")],
        );
        let target = plan_uninstall(&entry).expect("msi plan");
        assert_eq!(target.cmd, "msiexec.exe");
        assert_eq!(
            target.args,
            vec!["/x".to_string(), "{23170F69-40C1-2702-0000-000000000000}".to_string(),
                 "/qn".to_string(), "/norestart".to_string()]
        );
        assert_eq!(target.kind, "msi");
    }

    #[test]
    fn plan_uninstall_exe_prefers_quiet_string() {
        let entry = program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Foo",
            &[
                ("DisplayName", "Foo"),
                ("UninstallString", r#""C:\Program Files\Foo\uninst.exe" /S"#),
                ("QuietUninstallString", r#""C:\Program Files\Foo\uninst.exe" /S /silent"#),
            ],
        );
        let target = plan_uninstall(&entry).expect("exe plan");
        assert_eq!(target.kind, "exe");
        assert_eq!(target.args, vec!["/S".to_string(), "/silent".to_string()]);

        // 没有 UninstallString → None
        let bare = program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Bar",
            &[("DisplayName", "Bar")],
        );
        assert!(plan_uninstall(&bare).is_none());
    }

    #[test]
    fn find_entry_rejects_bad_regex_and_missing_field() {
        // 非法正则 → 该规则不匹配（不是 panic）
        let bad = vec![rule_with_field("DisplayName", "([")];
        let programs = vec![program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\X",
            &[("DisplayName", "Foo")],
        )];
        assert!(find_uninstall_entry(Some(&bad), &programs).is_none());

        // 字段缺失 → 不匹配
        let missing = vec![rule_with_field("Nope", ".*")];
        let programs = vec![program(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\X",
            &[("DisplayName", "Foo")],
        )];
        assert!(find_uninstall_entry(Some(&missing), &programs).is_none());
    }
}
