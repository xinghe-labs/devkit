//! 激活后的"新 shell"验证。镜像 `src/main/core/activate/verify.ts`。
//!
//! 为什么必须单独做这一步：写进 PATH ≠ 生效。winget 的 PATH 相关 bug 几乎全是
//! "写进去了但新开的终端还是找不到命令"（#5678 / #3046）。而 devkit 自己的安装自检
//! 用的是 `{installDir}` 绝对路径 —— 那验证的是"文件装对了"，不是"用户敲命令能找到"。
//!
//! 做法：把机器级 PATH 与用户级 PATH 分别取出来（都已展开），拼成一个"全新进程
//! 会看到的 PATH"，用它当环境变量跑一次用户在终端里会敲的那条命令
//! （取自清单 detect.commands[0]）。
//!
//! 还要多做一步 `where.exe`：Windows 的进程 PATH 是「机器级 + 用户级」，机器级在前。
//! 系统里已有的同名工具如果在机器级 PATH 里，用户级前置的 devkit 条目并不能胜出；
//! 只看版本输出会得到假阳性，必须看 where 解析到了哪个文件。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::activate::windows::read_effective_paths;
use crate::exec::{run_command, RunOptions};

/// 用"新终端环境"验证时跑的命令（取自清单 detect.commands[0]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivationVerifySpec {
    /// 命令名必须是用户会敲的那个（node / java / go），不能是绝对路径
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_regex: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationVerifyResult {
    pub ok: bool,
    /// 命令实际解析到的文件是否属于 devkit（不是系统里原有的那一份）
    pub resolved_from_devkit: bool,
    /// where.exe 给出的第一个命中路径
    pub resolved_path: Option<String>,
    pub detail: String,
}

/// 读展开后的机器级 / 用户级 PATH；读不到就按空处理（验证降级，不阻塞激活）。
pub fn effective_paths() -> (String, String) {
    match read_effective_paths() {
        Ok((machine, user)) => (machine, user),
        Err(error) => {
            log::warn!(target: "activate", "读取生效 PATH 失败：{error}");
            (String::new(), String::new())
        }
    }
}

/// 用"新终端会看到的环境"跑一次命令。
pub async fn verify_activation(
    spec: &ActivationVerifySpec,
    machine_path: &str,
    user_path: &str,
    expected_prefix: &str,
) -> ActivationVerifyResult {
    // Windows 的进程 PATH 构成：机器级在前，用户级在后
    let effective_path = [machine_path, user_path]
        .iter()
        .filter(|part| !part.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(";");
    let env = HashMap::from([
        ("PATH".to_string(), effective_path.clone()),
        ("Path".to_string(), effective_path),
    ]);

    // 1. 先看命令解析到哪个文件
    let mut resolved_path: Option<String> = None;
    let where_result = run_command(
        "where.exe",
        std::slice::from_ref(&spec.cmd),
        &RunOptions {
            timeout_ms: Some(15_000),
            env: Some(env.clone()),
            ..Default::default()
        },
    )
    .await;
    if where_result.code == Some(0) {
        resolved_path = where_result
            .stdout
            .lines()
            .map(|line| line.trim())
            .find(|line| !line.is_empty())
            .map(|line| line.to_string());
    }

    let resolved_from_devkit = resolved_path
        .as_deref()
        .map(|path| {
            path.to_lowercase()
                .starts_with(&expected_prefix.to_lowercase())
        })
        .unwrap_or(false);

    // 2. 再跑一次命令，确认它真的能执行
    let result = run_command(
        &spec.cmd,
        spec.args.as_deref().unwrap_or(&[]),
        &RunOptions {
            timeout_ms: Some(20_000),
            env: Some(env),
            ..Default::default()
        },
    )
    .await;

    if let Some(spawn_error) = &result.spawn_error {
        return ActivationVerifyResult {
            ok: false,
            resolved_from_devkit,
            resolved_path,
            detail: format!("新终端环境里找不到 {}：{spawn_error}", spec.cmd),
        };
    }

    let output = format!("{}\n{}", result.stdout, result.stderr)
        .trim()
        .to_string();
    let first_line = output.lines().next().unwrap_or("").to_string();

    if let Some(expect_regex) = &spec.expect_regex {
        let pattern = match regex::RegexBuilder::new(expect_regex)
            .case_insensitive(true)
            .build()
        {
            Ok(pattern) => pattern,
            Err(error) => {
                return ActivationVerifyResult {
                    ok: false,
                    resolved_from_devkit,
                    resolved_path,
                    detail: format!("检测正则非法：{error}"),
                }
            }
        };
        if !pattern.is_match(&output) {
            return ActivationVerifyResult {
                ok: false,
                resolved_from_devkit,
                resolved_path,
                detail: format!("新终端环境里 {} 的输出不符合预期：{first_line}", spec.cmd),
            };
        }
    } else if result.code != Some(0) {
        return ActivationVerifyResult {
            ok: false,
            resolved_from_devkit,
            resolved_path,
            detail: format!(
                "新终端环境里 {} 退出码 {}：{first_line}",
                spec.cmd,
                result
                    .code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "?".into())
            ),
        };
    }

    if !resolved_from_devkit {
        let detail = match &resolved_path {
            None => format!(
                "{} 能执行（{first_line}），但 where.exe 没给出解析路径",
                spec.cmd
            ),
            Some(path) => format!(
                "{} 解析到了 {path}（不是 devkit 装的那份）。系统级 PATH 里的同名工具优先级高于用户级 PATH；要改用 devkit 的版本，可以直接用 {expected_prefix}\\... 下的绝对路径，或先卸掉系统里那一份",
                spec.cmd
            ),
        };
        return ActivationVerifyResult {
            ok: true,
            resolved_from_devkit: false,
            resolved_path,
            detail,
        };
    }

    ActivationVerifyResult {
        ok: true,
        resolved_from_devkit: true,
        detail: format!(
            "{} → {first_line}（{}）",
            spec.cmd,
            resolved_path
                .clone()
                .unwrap_or_else(|| "devkit 目录内".to_string())
        ),
        resolved_path,
    }
}
