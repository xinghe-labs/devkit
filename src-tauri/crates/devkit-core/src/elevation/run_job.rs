//! 执行一个提权作业（镜像 `src/main/core/elevation/run-job.ts`）。
//!
//! ## 通信方式
//!
//! - 主进程 → 提权进程：**命令行**（`powershell -EncodedCommand`），不经过任何文件
//! - 提权进程 → 主进程：一个结果文件（用户可写目录，但带随机 nonce）
//!
//! ## 为什么主进程→提权进程不能走文件
//!
//! 那个目录**用户可写**，而提权进程以管理员身份读取并执行它的内容。
//! 根因是主进程与提权进程之间**没有可认证的通道**：主进程能写的东西攻击者也能写。
//!
//! ## 结果文件为什么可以留在磁盘上
//!
//! 伪造结果只能让主进程以为"步骤成功了"，**不能获得代码执行**。再加上 nonce，
//! 预置一份结果文件也没用了。

use super::helper_script::{
    build_elevated_script, encode_for_power_shell, is_elevated, make_job_id, make_nonce,
    ElevationJobOutcome, ElevationJobStep, MAX_ENCODED_COMMAND_CHARS,
};
use crate::exec::{run_command, RunOptions};
use crate::logging;
use std::path::{Path, PathBuf};

/// 命令行长度余量：还要装下 `Start-Process ... -ArgumentList @(...)` 这层包装
const HELPER_ARG_WRAPPER_CHARS: usize = 200;

const JOB_TIMEOUT_MS: u64 = 40 * 60 * 1000;

pub struct RunJobOptions<'a> {
    pub job_dir: &'a Path,
    pub steps: &'a [ElevationJobStep],
    /// 强制走非提权路径（单测与"本来就是管理员"的场景）
    pub force_unelevated: bool,
}

async fn run_power_shell(args: &[String], timeout_ms: u64) -> (Option<i32>, String) {
    let mut full: Vec<String> = vec!["-NoProfile".to_string(), "-NonInteractive".to_string()];
    full.extend_from_slice(args);
    let result = run_command(
        "powershell.exe",
        &full,
        &RunOptions {
            timeout_ms: Some(timeout_ms),
            ..Default::default()
        },
    )
    .await;
    let stderr = if result.stderr.trim().is_empty() {
        result.spawn_error.unwrap_or_default()
    } else {
        result.stderr
    };
    (result.code, stderr)
}

pub async fn run_job(options: &RunJobOptions<'_>) -> ElevationJobOutcome {
    let steps = options.steps;

    if steps.is_empty() {
        return ElevationJobOutcome {
            ok: true,
            elevated: false,
            cancelled: false,
            steps: Vec::new(),
            error: None,
        };
    }

    if let Err(error) = std::fs::create_dir_all(options.job_dir) {
        return ElevationJobOutcome {
            ok: false,
            elevated: false,
            cancelled: false,
            steps: Vec::new(),
            error: Some(format!("创建提权作业目录失败：{error}")),
        };
    }

    let (Ok(job_id), Ok(nonce)) = (make_job_id(), make_nonce()) else {
        return ElevationJobOutcome {
            ok: false,
            elevated: false,
            cancelled: false,
            steps: Vec::new(),
            error: Some("生成提权作业随机 id/nonce 失败（系统 RNG 不可用）".to_string()),
        };
    };
    let result_file: PathBuf = options.job_dir.join(format!("result-{job_id}.json"));

    // 上一次中断留下的同名结果文件不可能存在（id 是随机的），但清一下更稳
    let _ = std::fs::remove_file(&result_file);

    let script = build_elevated_script(&super::helper_script::ElevatedJobPayload {
        job_id: &job_id,
        steps,
        result_file: &result_file.to_string_lossy(),
        nonce: &nonce,
    });
    let encoded = encode_for_power_shell(&script);

    if encoded.len() > MAX_ENCODED_COMMAND_CHARS - HELPER_ARG_WRAPPER_CHARS {
        return ElevationJobOutcome {
            ok: false,
            elevated: false,
            cancelled: false,
            steps: Vec::new(),
            error: Some(format!(
                "提权作业太大，无法安全传递（编码后 {} 字符，上限约 {MAX_ENCODED_COMMAND_CHARS}）。请减少一次提权的步骤数后重试。",
                encoded.len()
            )),
        };
    }

    let already_admin = !options.force_unelevated && is_elevated().await;
    let elevated = !already_admin && !options.force_unelevated;

    if elevated {
        logging::global().info(
            "elevation",
            &format!(
                "需要管理员权限，正在请求一次授权（共 {} 个步骤）…",
                steps.len()
            ),
        );
        // 整个作业只弹一次 UAC，主进程等它跑完。
        // 用 -EncodedCommand 而不是 -File：提权进程不读磁盘上的任何脚本。
        let argument_list = [
            "-NoProfile".to_string(),
            "-EncodedCommand".to_string(),
            encoded,
        ]
        .iter()
        .map(|value| super::helper_script::ps_quote(value))
        .collect::<Vec<_>>()
        .join(",");
        let command = format!(
            "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @({argument_list})"
        );
        let (code, stderr) =
            run_power_shell(&["-Command".to_string(), command], JOB_TIMEOUT_MS).await;
        if code != Some(0) {
            let cancelled = regex::Regex::new(
                r"(?i)canceled by the user|cancelled by the user|操作已被用户取消",
            )
            .unwrap()
            .is_match(&stderr);
            let message = if cancelled {
                "用户取消了管理员授权，需要管理员权限的步骤没有执行".to_string()
            } else {
                format!(
                    "提权进程启动失败：{}",
                    if stderr.trim().is_empty() {
                        format!("退出码 {:?}", code)
                    } else {
                        stderr.trim().to_string()
                    }
                )
            };
            logging::global().warn("elevation", &message);
            return ElevationJobOutcome {
                ok: false,
                elevated: true,
                cancelled,
                steps: Vec::new(),
                error: Some(message),
            };
        }
    } else {
        logging::global().info(
            "elevation",
            if already_admin {
                "当前已是管理员，直接执行"
            } else {
                "非提权模式（测试）执行"
            },
        );
        let (code, stderr) =
            run_power_shell(&["-EncodedCommand".to_string(), encoded], JOB_TIMEOUT_MS).await;
        if code != Some(0) && !result_file.exists() {
            let message = format!(
                "助手脚本执行失败：{}",
                if stderr.trim().is_empty() {
                    format!("退出码 {:?}", code)
                } else {
                    stderr.trim().to_string()
                }
            );
            logging::global().warn("elevation", &message);
            return ElevationJobOutcome {
                ok: false,
                elevated: false,
                cancelled: false,
                steps: Vec::new(),
                error: Some(message),
            };
        }
    }

    if !result_file.exists() {
        let message = "提权进程没有写出结果文件（可能被杀软拦截或进程被中断）".to_string();
        logging::global().warn("elevation", &message);
        return ElevationJobOutcome {
            ok: false,
            elevated,
            cancelled: false,
            steps: Vec::new(),
            error: Some(message),
        };
    }

    // 双保险：万一某个 PowerShell 版本仍然写出 BOM，这里也要能读
    let raw = match std::fs::read_to_string(&result_file) {
        Ok(raw) => raw,
        Err(error) => {
            let message = format!("提权结果文件无法解析：{error}");
            logging::global().warn("elevation", &message);
            return ElevationJobOutcome {
                ok: false,
                elevated,
                cancelled: false,
                steps: Vec::new(),
                error: Some(message),
            };
        }
    };
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ResultFile {
        #[serde(default)]
        job_id: Option<String>,
        #[serde(default)]
        nonce: Option<String>,
        #[serde(default)]
        ok: Option<bool>,
        #[serde(default)]
        steps: Option<Vec<super::helper_script::StepResult>>,
        #[serde(default)]
        error: Option<String>,
    }

    let parsed: ResultFile = match serde_json::from_str(raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            let message = format!("提权结果文件无法解析：{error}");
            logging::global().warn("elevation", &message);
            return ElevationJobOutcome {
                ok: false,
                elevated,
                cancelled: false,
                steps: Vec::new(),
                error: Some(message),
            };
        }
    };

    // 结果文件在用户可写目录，所以要确认它确实是**本次**作业写的。
    if parsed.nonce.as_deref() != Some(nonce.as_str())
        || parsed.job_id.as_deref() != Some(job_id.as_str())
    {
        let message = "提权结果文件与本次作业不匹配（可能被其他进程写入），已忽略".to_string();
        logging::global().warn("elevation", &message);
        return ElevationJobOutcome {
            ok: false,
            elevated,
            cancelled: false,
            steps: Vec::new(),
            error: Some(message),
        };
    }

    let step_results = parsed.steps.unwrap_or_default();
    for step in &step_results {
        logging::global().info(
            "elevation",
            &format!(
                "{} {}{}",
                if step.ok { "✓" } else { "✗" },
                step.label,
                step.error
                    .clone()
                    .map(|error| format!(" —— {error}"))
                    .unwrap_or_default()
            ),
        );
    }

    ElevationJobOutcome {
        ok: parsed.ok == Some(true),
        elevated,
        cancelled: false,
        error: if parsed.ok == Some(true) {
            None
        } else {
            Some(
                parsed
                    .error
                    .or_else(|| {
                        step_results
                            .iter()
                            .find(|step| !step.ok)
                            .and_then(|step| step.error.clone())
                    })
                    .unwrap_or_else(|| "提权步骤失败".to_string()),
            )
        },
        steps: step_results,
    }
}
