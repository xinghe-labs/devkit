//! devkit-manifest：清单加载、校验与查询（镜像 `src/main/core/manifest/`）。
//!
//! 与 TS 侧的结构对应：
//! - `validate.rs`  ← `manifest/validate.ts`（serde 结构校验 + 语义检查）
//! - `loader.rs`    ← `manifest/index.ts`（目录扫描、热更新覆盖、排序、缓存）
//! - `links.rs`     ← `src/shared/manifest.ts`（推荐版本、下载源排序等纯函数）
//!
//! 架构决策（附录 B.1 规则 6）：不移植 Ajv。
//! 结构约束由 serde `deny_unknown_fields` + 必填字段承担；
//! Ajv 的 pattern / enum / minProperties 约束在 `validate.rs` 手写复刻，
//! 让 Rust 侧拒绝与 Ajv 相同的清单（契约测试逐条对齐）。

// R1 先落契约层：部分公共 API（index_by_id / order_download_sources 等）
// 在 R2/R3 接线后才会被消费，届时删除此 allow。
#![allow(dead_code)]

mod links;
mod loader;
mod validate;

pub use links::{download_source_candidates, order_download_sources, pick_recommended_version};
pub use loader::{clear_manifest_cache, load_manifests};
pub use validate::{
    validate_manifest_files, validate_manifest_json, ManifestFileInput, SchemaCheckError,
};
