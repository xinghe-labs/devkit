//! 提权动作的抽象（R4 先立接口，R5 接入真正的提权助手）。
//!
//! 核心逻辑（systemconfig / doctor / uninstall 的写路径）通过本 trait 调用提权能力，
//! 这样可以单测拒绝规则而不真的弹 UAC（TS 里 `runElevated` 被 vi.mock，同一个思路）。
//! R5 在 devkit-sys 实现真正的 Windows 提权助手后替换 `NoElevation`。

/// 一条提权作业里的单个步骤。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElevatedStep {
    /// 跑一条命令（需要管理员）
    Exec {
        label: String,
        cmd: String,
        args: Vec<String>,
    },
    /// 写机器级 PATH（整串覆盖）
    SetMachinePath { label: String, value: String },
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

/// R4 占位实现：提权助手尚未接入（R5），任何提权动作都如实报错而不是假装成功。
pub struct NoElevation;

impl ElevatedRunner for NoElevation {
    fn run(&self, _steps: Vec<ElevatedStep>) -> ElevatedOutcome {
        ElevatedOutcome {
            ok: false,
            cancelled: false,
            error: Some("提权助手尚未接入（R5）；本操作需要管理员权限".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_elevation_reports_honestly() {
        let outcome = NoElevation.run(vec![ElevatedStep::Exec {
            label: "启用 long-paths".into(),
            cmd: "reg.exe".into(),
            args: vec!["add".into()],
        }]);
        assert!(!outcome.ok);
        assert!(!outcome.cancelled);
        assert!(outcome
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("提权"));
    }
}
