//! devkit-types：IPC 契约的 serde 强类型层（Rust 侧唯一事实源）。
//!
//! 对应 TS 侧 `src/shared/types.ts`；字段命名用 `#[serde(rename_all = "camelCase")]`
//! 逐一对齐。翻译规则见仓库根 MIGRATION-RUST.md 附录 B。

pub const IPC_METHOD_COUNT: usize = 46;
pub const IPC_PUSH_COUNT: usize = 2;

/// 对齐 `src/shared/types.ts` 的 `AppInfo`（11 字段）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub locale: String,
    pub platform: String,
    pub arch: String,
    pub is_packaged: bool,
    pub manifest_dir: String,
    pub log_dir: String,
    pub log_file: String,
    pub electron_version: String,
    pub node_version: String,
    pub chrome_version: String,
}
