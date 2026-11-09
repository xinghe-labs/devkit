//! devkit-sys：Windows 系统写入面（对应 TS `src/main/core` 的系统模块）。
//!
//! R3 已填：registry（已安装程序扫描，决策 D6 直读）、disk（磁盘剩余空间，预检用）。
//! R4 填充：machine-path / junction / env-vars / systemconfig /
//! uninstall / vscode / elevation（提权四条安全不变式见 MIGRATION-RUST.md §6.5）。

pub mod disk;
pub mod junction;
pub mod registry;
pub mod user_env;
