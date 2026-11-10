//! 用户级配置文件模块（R5）：镜像源配置（FR-5）等。

pub mod mirrors;

pub use mirrors::{
    apply_mirrors, conda_block, condarc_has_conflicts, minimal_maven_settings,
    minimal_nuget_config, read_current_mirrors, upsert_docker_registry_mirrors,
    upsert_ini_section_value, upsert_ini_value, upsert_marked_block, upsert_maven_mirror,
    upsert_nuget_source, CurrentMirrors,
};
