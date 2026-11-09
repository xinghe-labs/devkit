//! 用户环境变量读写（Windows）。镜像 `src/main/core/activate/windows.ts`。
//!
//! TS 版本为什么不用 `setx`：1024 字符静默截断会把 PATH 写坏（SPEC §6.7 禁用）；
//! 为什么不用 `[Environment]::GetEnvironmentVariable`：它会把 REG_EXPAND_SZ 里的
//! `%USERPROFILE%` 展开，写回去时用户的原始写法就丢了。
//!
//! Rust 版直接走 devkit-sys 的注册表用户视图（直读 HKCU\Environment 原始值、
//! 写回显式 ExpandString + WM_SETTINGCHANGE 广播），语义与 TS 的 PowerShell
//! 脚本一致且更快 —— 详见 devkit-sys/src/user_env.rs 模块注释。

pub use devkit_sys::user_env::{
    read_effective_paths, read_machine_path, read_user_env, read_user_path, validate_env_name,
    write_user_env, write_user_path,
};

/// 当前进程是否具备管理员权限（机器级安装/写机器 PATH 需要）。
/// 语义对齐 TS 的 WindowsPrincipal.IsInRole 检查。
pub async fn is_elevated() -> bool {
    let result = crate::exec::run_command(
        "powershell.exe",
        &[
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)".to_string(),
        ],
        &crate::exec::RunOptions {
            timeout_ms: Some(20_000),
            ..Default::default()
        },
    )
    .await;
    result.stdout.trim().eq_ignore_ascii_case("true")
}
