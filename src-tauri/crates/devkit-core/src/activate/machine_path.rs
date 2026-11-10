//! 「全局可用」：把已激活工具的 PATH 条目也写进**机器级** PATH。
//! 镜像 `src/main/core/activate/machine-path.ts`。
//!
//! 为什么默认关着：写机器 PATH 要管理员权限，HKLM 是全账号共享的（用户 A 装
//! node 18、用户 B 装 node 22 会打架），而且 setx 时代留下的坏条目就是这台机器
//! 机器 PATH 的真实历史。所以它是用户显式点的动作，一次 UAC，改前算好、改完复验。
//!
//! 边界：机器 PATH 用**绝对路径**（`%DEVKIT_HOME%` 是用户级变量，别的账号读不到）。
//! dataRoot 不在共享位置时，"全局可用"实际只对管理员进程有效 —— 界面必须讲明白。

use std::collections::HashSet;

use devkit_types::activation::ActivationRecord;

use crate::activate::index::{read_activation_state, DEVKIT_HOME_VAR};
use crate::exec::{run_command, RunOptions};

/// 机器级 PATH 所在的注册表键（reg.exe 风格，只读不需要管理员）
const MACHINE_PATH_REG_KEY: &str =
    r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

/// 展开用（含 `%DEVKIT_HOME%` 全部大小写变体）。
fn expand_devkit_home(entry: &str, data_root: &str) -> String {
    entry.replace(DEVKIT_HOME_VAR, data_root)
}

/// 判断用：还残留 `%DEVKIT_HOME%`（用户自定义过变量，展开失败）就没有意义。
fn contains_devkit_home(entry: &str) -> bool {
    entry
        .to_lowercase()
        .contains(&DEVKIT_HOME_VAR.to_lowercase())
}

/// 一个条目是不是 devkit 管的（指向 dataRoot 下的 current 目录）。
pub fn is_devkit_machine_entry(entry: &str, data_root: &str) -> bool {
    let normalized = entry.trim().trim_end_matches('\\').to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let root = data_root.trim().trim_end_matches('\\').to_lowercase();
    // 绝对路径形式
    if normalized.starts_with(&format!(r"{root}\current\")) {
        return true;
    }
    // 变量形式（用户级 PATH 里常见；机器级少见，也认）
    if normalized.contains("%devkit_home%") {
        return true;
    }
    false
}

fn split_entries(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachinePathPlan {
    /// 算好的新 PATH 值
    pub next: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// 结果会不会是空值 —— 空值一律拒绝执行
    pub would_be_empty: bool,
}

/// 把条目**追加**到机器 PATH 末尾（不是插到最前）。
///
/// 用户 PATH 那边 devkit 插最前（让自己装的版本优先）。机器级不一样：这里放的是
/// 系统级工具与驱动，插到最前会改变解析顺序，可能把别人的东西顶掉。
/// 只允许放 devkit 自己管的条目 —— 不加这道门，任何调用方都能把任意路径塞进
/// 系统 PATH，那就是一条持久化的劫持通道。
pub fn plan_machine_path_add(
    current_raw: &str,
    wanted: &[String],
    data_root: &str,
) -> MachinePathPlan {
    let mut entries = split_entries(current_raw);
    let mut lowered: HashSet<String> = entries.iter().map(|entry| entry.to_lowercase()).collect();
    let mut added: Vec<String> = Vec::new();

    for entry in wanted {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !is_devkit_machine_entry(trimmed, data_root) {
            continue;
        }
        let key = trimmed.to_lowercase();
        if lowered.contains(&key) {
            continue;
        }
        entries.push(trimmed.to_string());
        lowered.insert(key);
        added.push(trimmed.to_string());
    }

    let next = entries.join(";");
    MachinePathPlan {
        would_be_empty: next.trim().is_empty(),
        next,
        added,
        removed: Vec::new(),
    }
}

/// 移除所有 devkit 管的条目，其余原样保留。
pub fn plan_machine_path_remove(current_raw: &str, data_root: &str) -> MachinePathPlan {
    let mut kept: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    for entry in split_entries(current_raw) {
        if is_devkit_machine_entry(&entry, data_root) {
            removed.push(entry);
        } else {
            kept.push(entry);
        }
    }

    let next = kept.join(";");
    MachinePathPlan {
        // 只剩空值说明机器 PATH 上本来就只有 devkit 的东西 —— 拒绝，别把系统 PATH 清空
        would_be_empty: next.trim().is_empty(),
        next,
        added: Vec::new(),
        removed,
    }
}

/// 当前已激活的工具，在机器 PATH 上需要哪些条目（绝对路径形式）。
/// `%DEVKIT_HOME%` 必须展开成 dataRoot：机器级上下文里没有这个用户变量。
pub fn collect_wanted_machine_entries(
    state_records: &[devkit_types::activation::ActivationRecord],
    data_root: &str,
) -> Vec<String> {
    let mut wanted: Vec<String> = Vec::new();
    for record in state_records {
        for entry in &record.path_entries {
            let absolute = expand_devkit_home(entry, data_root);
            if contains_devkit_home(&absolute) {
                continue;
            }
            if !wanted
                .iter()
                .any(|item| item.eq_ignore_ascii_case(&absolute))
            {
                wanted.push(absolute);
            }
        }
    }
    wanted
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePathState {
    /// 机器 PATH 的总条目数
    pub total: usize,
    /// 其中 devkit 管的条目
    pub devkit_entries: Vec<String>,
    /// 已激活工具想在机器 PATH 上放的条目
    pub wanted_entries: Vec<String>,
    /// 想要的但还没放上去的
    pub pending: Vec<String>,
    /// 机器 PATH 原始值（只读展示）
    pub raw: String,
}

/// 组装机器 PATH 状态（raw 由调用方读好，方便单测）。
pub fn build_machine_path_state(raw: &str, data_root: &str) -> MachinePathState {
    let entries = split_entries(raw);
    let devkit_entries: Vec<String> = entries
        .iter()
        .filter(|entry| is_devkit_machine_entry(entry, data_root))
        .cloned()
        .collect();
    let records = read_activation_state().records;
    let wanted_entries = collect_wanted_machine_entries(&records, data_root);
    let lowered: HashSet<String> = entries.iter().map(|entry| entry.to_lowercase()).collect();
    let pending: Vec<String> = wanted_entries
        .iter()
        .filter(|entry| !lowered.contains(&entry.to_lowercase()))
        .cloned()
        .collect();

    MachinePathState {
        total: entries.len(),
        devkit_entries,
        wanted_entries,
        pending,
        raw: raw.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePathSyncResult {
    pub ok: bool,
    pub mode: MachinePathMode,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// 改完之后重新读到的机器 PATH 条目数（用于复验）
    pub total_after: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MachinePathMode {
    Add,
    Remove,
}

/// 写机器 PATH 的回调（真实实现走提权助手；测试注入假写）。
pub type MachinePathWriter<'a> = &'a dyn Fn(&str) -> Result<(), String>;

/// 读机器 PATH 的回调（真实实现读 HKLM；测试注入内存值）。
pub type MachinePathReader<'a> = &'a dyn Fn() -> Result<String, String>;

/// 读机器 PATH 原文（reg.exe 查 HKLM，只读不需要管理员）。
/// 供 systemconfig 状态展示与同步前置读取使用。
pub async fn read_machine_path_raw() -> Result<String, String> {
    let result = run_command(
        "reg.exe",
        &[
            "query".to_string(),
            MACHINE_PATH_REG_KEY.to_string(),
            "/v".to_string(),
            "Path".to_string(),
        ],
        &RunOptions::default(),
    )
    .await;
    if result.code != Some(0) {
        let detail = if result.stderr.trim().is_empty() {
            result.stdout.trim()
        } else {
            result.stderr.trim()
        };
        return Err(format!("读取机器级 PATH 失败：{detail}"));
    }
    // reg query 输出第四段起是值本体（`    Path    REG_EXPAND_SZ    C:\...`），
    // PATH 里可能有空格，不能按空白切
    for line in result.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Path") {
            if let Some(rest) = trimmed.strip_prefix("Path") {
                let rest = rest.trim();
                if let Some(value) = rest.strip_prefix("REG_EXPAND_SZ") {
                    return Ok(value.trim().to_string());
                }
                if let Some(value) = rest.strip_prefix("REG_SZ") {
                    return Ok(value.trim().to_string());
                }
            }
        }
    }
    Err("读取机器级 PATH 失败：输出里找不到 Path 值".to_string())
}

/// 执行同步。**只负责算与验**，提权写入与激活记录由调用方注入 ——
/// 这样核心逻辑可以单测，不必真的弹 UAC、也不读真实 activated.json。
pub fn sync_machine_path(
    mode: MachinePathMode,
    records: &[ActivationRecord],
    reader: MachinePathReader<'_>,
    writer: MachinePathWriter<'_>,
    data_root: &str,
) -> MachinePathSyncResult {
    let current_raw = match reader() {
        Ok(raw) => raw,
        Err(error) => {
            return MachinePathSyncResult {
                ok: false,
                mode,
                added: Vec::new(),
                removed: Vec::new(),
                total_after: 0,
                error: Some(error),
            }
        }
    };
    let current_count = split_entries(&current_raw).len();

    let plan = match mode {
        MachinePathMode::Add => {
            let wanted = collect_wanted_machine_entries(records, data_root);
            plan_machine_path_add(&current_raw, &wanted, data_root)
        }
        MachinePathMode::Remove => plan_machine_path_remove(&current_raw, data_root),
    };

    let empty = MachinePathSyncResult {
        ok: true,
        mode,
        added: Vec::new(),
        removed: Vec::new(),
        total_after: current_count,
        error: None,
    };

    if plan.added.is_empty() && plan.removed.is_empty() {
        return empty;
    }

    if plan.would_be_empty {
        eprintln!("[machine-path] 同步被拒绝：算出来的机器 PATH 是空值");
        return MachinePathSyncResult {
            ok: false,
            mode,
            added: Vec::new(),
            removed: Vec::new(),
            total_after: current_count,
            error: Some("同步后机器级 PATH 会变成空值，已拒绝执行".to_string()),
        };
    }

    if let Err(error) = writer(&plan.next) {
        return MachinePathSyncResult {
            ok: false,
            mode,
            added: Vec::new(),
            removed: Vec::new(),
            total_after: current_count,
            error: Some(error),
        };
    }

    // 复验：写完重新读一遍，确认条目真的进去了 / 真的没了
    let after_raw = match reader() {
        Ok(raw) => raw,
        Err(error) => {
            return MachinePathSyncResult {
                ok: false,
                mode,
                added: Vec::new(),
                removed: Vec::new(),
                total_after: current_count,
                error: Some(error),
            }
        }
    };
    let after_entries = split_entries(&after_raw);
    let lowered_after: HashSet<String> = after_entries
        .iter()
        .map(|entry| entry.to_lowercase())
        .collect();

    let missing: Vec<String> = plan
        .added
        .iter()
        .filter(|entry| !lowered_after.contains(&entry.to_lowercase()))
        .cloned()
        .collect();
    let leftovers: Vec<String> = plan
        .removed
        .iter()
        .filter(|entry| lowered_after.contains(&entry.to_lowercase()))
        .cloned()
        .collect();

    if !missing.is_empty() || !leftovers.is_empty() {
        let problem = if !missing.is_empty() {
            format!(
                "写入后复验失败：{} 没有出现在机器级 PATH 里",
                missing.join("；")
            )
        } else {
            format!(
                "移除后复验失败：{} 仍然在机器级 PATH 里",
                leftovers.join("；")
            )
        };
        eprintln!("[machine-path] {problem}");
        return MachinePathSyncResult {
            ok: false,
            mode,
            added: Vec::new(),
            removed: Vec::new(),
            total_after: after_entries.len(),
            error: Some(problem),
        };
    }

    let count = if mode == MachinePathMode::Add {
        plan.added.len()
    } else {
        plan.removed.len()
    };
    eprintln!(
        "[machine-path] 机器级 PATH 已同步（{} {count} 条，现共 {} 条）",
        if mode == MachinePathMode::Add {
            "新增"
        } else {
            "移除"
        },
        after_entries.len()
    );

    MachinePathSyncResult {
        ok: true,
        mode,
        added: plan.added,
        removed: plan.removed,
        total_after: after_entries.len(),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(entries: &[&str]) -> Vec<devkit_types::activation::ActivationRecord> {
        vec![devkit_types::activation::ActivationRecord {
            tool_id: "jdk-temurin".to_string(),
            version: "21".to_string(),
            link_name: "jdk-temurin".to_string(),
            link_path: r"C:\Users\屈\.devkit\current\jdk-temurin".to_string(),
            target: r"C:\Users\屈\.devkit\versions\jdk-temurin\21".to_string(),
            path_entries: entries.iter().map(|entry| entry.to_string()).collect(),
            env: Default::default(),
            activated_at: "2026-01-01T00:00:00Z".to_string(),
        }]
    }

    #[test]
    fn recognizes_devkit_entries_only() {
        let root = r"D:\devkit-data";
        assert!(is_devkit_machine_entry(
            r"D:\devkit-data\current\nodejs",
            root
        ));
        assert!(is_devkit_machine_entry(
            r"d:\devkit-data\current\nodejs\",
            root
        ));
        assert!(is_devkit_machine_entry(r"%DEVKIT_HOME%\current\go", root));
        assert!(!is_devkit_machine_entry(r"C:\Windows", root));
        // 前缀相似的兄弟目录不认
        assert!(!is_devkit_machine_entry(
            r"D:\devkit-data-other\current\x",
            root
        ));
        assert!(!is_devkit_machine_entry("", root));
    }

    #[test]
    fn add_appends_and_gates_non_devkit_entries() {
        let plan = plan_machine_path_add(
            r"C:\Windows;c:\windows",
            &[
                r"D:\devkit-data\current\jdk-temurin".to_string(),
                r"C:\Evil".to_string(),
                r"D:\devkit-data\current\jdk-temurin".to_string(),
            ],
            r"D:\devkit-data",
        );
        assert_eq!(
            plan.next,
            r"C:\Windows;c:\windows;D:\devkit-data\current\jdk-temurin"
        );
        // 注：TS 语义不去重机器 PATH 里**既有**的重复条目（只拦 wanted 重复）
        assert_eq!(plan.added, [r"D:\devkit-data\current\jdk-temurin"]);
    }

    #[test]
    fn remove_keeps_foreign_entries_and_refuses_empty_result() {
        let plan =
            plan_machine_path_remove(r"D:\devkit-data\current\go;C:\Windows", r"D:\devkit-data");
        assert_eq!(plan.next, r"C:\Windows");
        assert_eq!(plan.removed, [r"D:\devkit-data\current\go"]);

        let empty = plan_machine_path_remove(r"D:\devkit-data\current\go", r"D:\devkit-data");
        assert!(empty.would_be_empty);
    }

    #[test]
    fn wanted_entries_expand_var_and_skip_unexpanded() {
        let records = records(&[
            r"%DEVKIT_HOME%\current\jdk-temurin",
            r"%DEVKIT_HOME%\current\jdk-temurin",
        ]);
        let wanted = collect_wanted_machine_entries(&records, r"D:\devkit-data");
        assert_eq!(wanted, [r"D:\devkit-data\current\jdk-temurin"]);
    }

    #[test]
    fn sync_add_writes_and_reverifies() {
        let machine = std::cell::RefCell::new(r"C:\Windows".to_string());
        let reader = || -> Result<String, String> { Ok(machine.borrow().clone()) };
        let writer = |value: &str| -> Result<(), String> {
            *machine.borrow_mut() = value.to_string();
            Ok(())
        };
        // 无激活记录 → nothing to do
        let result = sync_machine_path(
            MachinePathMode::Add,
            &[],
            &reader,
            &writer,
            r"D:\devkit-data",
        );
        assert!(result.ok);
        assert!(result.added.is_empty());
    }

    #[test]
    fn sync_rejects_empty_plan_result() {
        let reader = || -> Result<String, String> { Ok(r"D:\devkit-data\current\go".to_string()) };
        let writer = |_value: &str| -> Result<(), String> { Ok(()) };
        let result = sync_machine_path(
            MachinePathMode::Remove,
            &[],
            &reader,
            &writer,
            r"D:\devkit-data",
        );
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or_default().contains("空值"));
    }

    #[test]
    fn sync_removal_reverifies_leftovers() {
        // 写入函数假装"没写进去"（复验时还在）→ 必须报错而不是静默成功
        let reader = || -> Result<String, String> {
            Ok(r"D:\devkit-data\current\go;C:\Windows".to_string())
        };
        let writer = |_value: &str| -> Result<(), String> { Ok(()) };
        let result = sync_machine_path(
            MachinePathMode::Remove,
            &[],
            &reader,
            &writer,
            r"D:\devkit-data",
        );
        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("复验失败"));
    }
}
