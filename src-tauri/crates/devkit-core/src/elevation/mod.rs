//! 提权动作（R5 全量：接口 + 真实助手，SPEC §6.6 / §6.5）。
//!
//! 核心逻辑（systemconfig / doctor / uninstall 的写路径）通过本 trait 调用提权能力，
//! 这样可以单测拒绝规则而不真的弹 UAC（TS 里 `runElevated` 被 vi.mock，同一个思路）。
//! `RealElevation` 是真实实现：一次 UAC 顺序执行完所有步骤。

pub mod helper_script;
pub mod run_job;

pub use helper_script::{
    build_elevated_script, encode_for_power_shell, is_elevated, make_job_id, make_nonce, ps_quote,
    ElevationJobOutcome, ElevationJobStep, StepResult, MAX_ENCODED_COMMAND_CHARS,
};
pub use run_job::{run_job, RunJobOptions};

use crate::app_paths::get_user_data_dir;
use crate::logging;
use serde::{Deserialize, Serialize};

/// 一条提权作业里的单个步骤。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ElevatedStep {
    /// 跑一条命令（需要管理员）
    Exec {
        label: String,
        cmd: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        /// 执行前要求该文件（cmd）的 SHA-256 等于这个值（安全审查 H3：
        /// 安装包放在用户可写目录，必须在提权进程里再校验一次）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        verify_sha256: Option<String>,
    },
    /// 系统还原点（FR-10；只在启用了系统保护时可用，失败不算致命）
    #[serde(rename = "restore-point")]
    RestorePoint { label: String, description: String },
    /// 写机器级 PATH（整串覆盖）
    #[serde(rename = "set-machine-path")]
    SetMachinePath { label: String, value: String },
}

impl ElevatedStep {
    /// 包一条安装命令成提权步骤（默认 30 分钟超时）
    pub fn exec(label: impl Into<String>, cmd: impl Into<String>, args: Vec<String>) -> Self {
        ElevatedStep::Exec {
            label: label.into(),
            cmd: cmd.into(),
            args,
            timeout_ms: Some(30 * 60 * 1000),
            verify_sha256: None,
        }
    }

    /// 带安装包 SHA-256 复验的提权步骤（H3）
    pub fn exec_verified(
        label: impl Into<String>,
        cmd: impl Into<String>,
        args: Vec<String>,
        verify_sha256: impl Into<String>,
    ) -> Self {
        ElevatedStep::Exec {
            label: label.into(),
            cmd: cmd.into(),
            args,
            timeout_ms: Some(30 * 60 * 1000),
            verify_sha256: Some(verify_sha256.into()),
        }
    }
}

/// 提权作业结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElevatedOutcome {
    pub ok: bool,
    /// 用户拒绝了 UAC（界面据此说"已取消"而不是"失败"）
    pub cancelled: bool,
    pub error: Option<String>,
}

/// 提权执行器。实现方必须保证：一次 run 只弹一次 UAC（§6.5）。
pub trait ElevatedRunner: Send + Sync {
    fn run(&self, steps: Vec<ElevatedStep>) -> ElevatedOutcome;
}

/// trait 步骤 → 作业步骤
pub fn to_job_steps(steps: &[ElevatedStep]) -> Vec<ElevationJobStep> {
    steps
        .iter()
        .map(|step| match step {
            ElevatedStep::Exec {
                label,
                cmd,
                args,
                timeout_ms,
                verify_sha256,
            } => ElevationJobStep::Exec {
                label: label.clone(),
                cmd: cmd.clone(),
                args: args.clone(),
                timeout_ms: *timeout_ms,
                verify_sha256: verify_sha256.clone(),
            },
            ElevatedStep::RestorePoint { label, description } => ElevationJobStep::RestorePoint {
                label: label.clone(),
                description: description.clone(),
            },
            ElevatedStep::SetMachinePath { label, value } => ElevationJobStep::SetMachinePath {
                label: label.clone(),
                value: value.clone(),
            },
        })
        .collect()
}

/// R5 真实实现：封装 `run_job`（一次 UAC、内联脚本、nonce 校验）。
pub struct RealElevation;

impl ElevatedRunner for RealElevation {
    fn run(&self, steps: Vec<ElevatedStep>) -> ElevatedOutcome {
        let job_dir = get_elevation_dir();
        let job_steps = to_job_steps(&steps);
        let outcome = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::try_current()
                .ok()
                .map(|handle| {
                    handle.block_on(run_job(&RunJobOptions {
                        job_dir: &job_dir,
                        steps: &job_steps,
                        force_unelevated: false,
                    }))
                })
                .unwrap_or_else(|| {
                    match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime.block_on(run_job(&RunJobOptions {
                            job_dir: &job_dir,
                            steps: &job_steps,
                            force_unelevated: false,
                        })),
                        Err(error) => ElevationJobOutcome {
                            ok: false,
                            elevated: false,
                            cancelled: false,
                            steps: Vec::new(),
                            error: Some(error.to_string()),
                        },
                    }
                })
        });
        logging::global().info(
            "elevation",
            &format!(
                "提权作业结束：{}（提权={}，步骤 {}）{}",
                if outcome.ok { "成功" } else { "失败" },
                outcome.elevated,
                outcome.steps.len(),
                outcome
                    .error
                    .clone()
                    .map(|error| format!("，{error}"))
                    .unwrap_or_default()
            ),
        );
        ElevatedOutcome {
            ok: outcome.ok,
            cancelled: outcome.cancelled,
            error: outcome.error,
        }
    }
}

/// 提权作业文件放在用户数据目录，卸载时随 devkit 一起清掉
pub fn get_elevation_dir() -> std::path::PathBuf {
    get_user_data_dir().join("elevation")
}

/// R4 占位实现保留（单测注入）：任何提权动作都如实报错而不是假装成功。
pub struct NoElevation;

impl ElevatedRunner for NoElevation {
    fn run(&self, _steps: Vec<ElevatedStep>) -> ElevatedOutcome {
        ElevatedOutcome {
            ok: false,
            cancelled: false,
            error: Some("提权助手不可用（测试注入）；本操作需要管理员权限".to_string()),
        }
    }
}

/// 安装前创建系统还原点（FR-10）
pub fn create_restore_point() -> ElevatedOutcome {
    RealElevation.run(vec![ElevatedStep::RestorePoint {
        label: "创建系统还原点".to_string(),
        description: format!(
            "devkit 安装前自动创建（{}）",
            devkit_types::timeutil::iso8601_now()
        ),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_elevation_reports_honestly() {
        let outcome = NoElevation.run(vec![ElevatedStep::exec(
            "启用 long-paths",
            "reg.exe",
            vec!["add".into()],
        )]);
        assert!(!outcome.ok);
        assert!(!outcome.cancelled);
        assert!(outcome
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("提权"));
    }

    #[test]
    fn exec_constructors_set_defaults() {
        let plain =
            ElevatedStep::exec("装 7-Zip", "msiexec.exe", vec!["/i".into(), "x.msi".into()]);
        match &plain {
            ElevatedStep::Exec {
                timeout_ms,
                verify_sha256,
                ..
            } => {
                assert_eq!(*timeout_ms, Some(30 * 60 * 1000));
                assert!(verify_sha256.is_none());
            }
            _ => panic!("应为 Exec"),
        }
        let verified = ElevatedStep::exec_verified("装 7-Zip", "msiexec.exe", vec![], "ABCDEF");
        match &verified {
            ElevatedStep::Exec { verify_sha256, .. } => {
                assert_eq!(verify_sha256.as_deref(), Some("ABCDEF"));
            }
            _ => panic!("应为 Exec"),
        }
    }

    #[test]
    fn step_mapping_preserves_everything() {
        let steps = vec![
            ElevatedStep::exec_verified(
                "a",
                "cmd.exe",
                vec!["/c".to_string()],
                String::from("sha"),
            ),
            ElevatedStep::RestorePoint {
                label: "rp".into(),
                description: "d".into(),
            },
            ElevatedStep::SetMachinePath {
                label: "mp".into(),
                value: r"C:\X".into(),
            },
        ];
        let mapped = to_job_steps(&steps);
        assert_eq!(mapped.len(), 3);
        let json = serde_json::to_value(&mapped).unwrap();
        assert_eq!(json[0]["kind"], "exec");
        assert_eq!(json[0]["verifySha256"], "sha");
        assert_eq!(json[1]["kind"], "restore-point");
        assert_eq!(json[2]["kind"], "set-machine-path");
    }

    #[test]
    fn elevation_dir_under_user_data() {
        let dir = get_elevation_dir();
        assert!(dir.ends_with("elevation"));
    }
}
