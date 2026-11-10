//! devkit-core：业务逻辑（对应 TS `src/main/core` 的 13 个模块）。
//!
//! 原则（MIGRATION-RUST.md §2）：纯逻辑 + 显式 IO 注入（CommandRunner 语义见
//! `exec`），不直接调用 Tauri API。模块按 R2–R5 各阶段逐步填充。

pub mod activate;
pub mod app_paths;
pub mod checksum;
pub mod config;
pub mod detect;
pub mod direct;
pub mod doctor;
pub mod downloader;
pub mod elevation;
pub mod env_vars;
pub mod exec;
pub mod executor;
pub mod hotupdate;
pub mod http;
pub mod logging;
pub mod manifest_fns;
pub mod offline;
pub mod placeholders;
pub mod plan;
pub mod preflight;
pub mod presets;
pub mod profile;
pub mod report;
pub mod settings;
pub mod systemconfig;
pub mod templates;
pub mod uninstall;
pub mod updater;
pub mod vscode;
pub mod zip_extract;
