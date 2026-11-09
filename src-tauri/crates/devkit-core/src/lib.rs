//! devkit-core：业务逻辑（对应 TS `src/main/core` 的 13 个模块）。
//!
//! 原则（MIGRATION-RUST.md §2）：纯逻辑 + 显式 IO 注入（CommandRunner trait），
//! 不直接调用 Tauri API。模块按 R2–R5 各阶段逐步填充。
