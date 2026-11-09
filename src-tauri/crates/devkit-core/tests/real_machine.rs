//! R3 真机验收（MIGRATION-RUST.md §R3：真机 detect 判定 + 本机预检必须过）。
//!
//! 手动触发：
//! ```text
//! cargo test -p devkit-core --test real_machine -- --ignored --nocapture
//! ```

use devkit_core::detect::{detect_all, DetectAllOptions};
use devkit_core::preflight::{run_preflight, PreflightInput, ToolMap};
use devkit_types::detection::{DetectCommandSpec, DetectSpec, DetectionStatus};
use devkit_types::manifest::{
    LicenseTier, ManifestStatus, ToolCategory, ToolManifest, ToolVersionSpec,
};
use devkit_types::plan::{
    MirrorPreference, PlanItem, PlanItemState, PlanOptions, PlanSummary, SchemaVersion,
};
use devkit_types::preflight::PreflightLevel;

fn minimal_tool(id: &str, cmd: &str) -> ToolManifest {
    ToolManifest {
        id: id.to_string(),
        category: ToolCategory::Runtime,
        tier: LicenseTier::L1,
        status: ManifestStatus::Ready,
        provider: None,
        name: [(("zh-CN".to_string()), id.to_string())]
            .into_iter()
            .collect(),
        description: Default::default(),
        homepage: None,
        license: None,
        detect: DetectSpec {
            commands: Some(vec![DetectCommandSpec {
                cmd: cmd.to_string(),
                args: Some(vec!["--version".to_string()]),
                expect_regex: None,
            }]),
            files: None,
            registry: None,
        },
        versions: vec![ToolVersionSpec {
            version: "999.0.0".to_string(),
            channel: devkit_types::manifest::VersionChannel::Stable,
            recommended: Some(true),
            arch: devkit_types::manifest::Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: devkit_types::manifest::InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: None,
            mirrors: None,
            install: None,
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        }],
        notes: None,
    }
}

#[tokio::test]
#[ignore = "真机断言，手动触发"]
async fn real_machine_detect_and_preflight() {
    // 1. 真实工具检测：git（本机有）→ installed / version-mismatch（推荐版本是假的 999.0.0，
    //    所以 version-mismatch 才是"检测到真实版本"的正确证据）；node 同理
    let git = minimal_tool("git", "git");
    let node = minimal_tool("nodejs", "node");
    let ghost = minimal_tool(
        "definitely-not-a-real-tool-xyz",
        "definitely-not-real-cmd-xyz",
    );
    let results = detect_all(
        &[git, node, ghost],
        &[],
        DetectAllOptions {
            concurrency: Some(4),
        },
        None,
    )
    .await;

    for result in &results {
        println!(
            "{:<32} {:?} version={:?} evidence={:?} {}ms",
            result.tool_id,
            result.status,
            result.installed_version,
            result.evidence,
            result.duration_ms
        );
    }

    let git_result = results.iter().find(|r| r.tool_id == "git").unwrap();
    let node_result = results.iter().find(|r| r.tool_id == "nodejs").unwrap();
    let ghost_result = results
        .iter()
        .find(|r| r.tool_id == "definitely-not-a-real-tool-xyz")
        .unwrap();

    // git/node 若安装了：installed（版本匹配假推荐 999 不可能）→ 应为 version-mismatch 且带真实版本
    for result in [git_result, node_result] {
        if result.status == DetectionStatus::VersionMismatch {
            assert!(
                result.installed_version.is_some(),
                "version-mismatch 必须带真实版本号"
            );
            assert!(result
                .evidence
                .as_deref()
                .unwrap_or("")
                .starts_with("command:"));
        } else {
            // 未装的机器上允许 not-installed，但绝不能是 error
            assert_eq!(result.status, DetectionStatus::NotInstalled);
        }
    }
    // 不存在的工具：not-installed（绝不能 error —— "查不出"≠"没装"，但这里命令确实不存在）
    assert_eq!(ghost_result.status, DetectionStatus::NotInstalled);

    // 2. 本机预检：这台开发机（非虚拟机）必须能过预检
    let plan = devkit_types::plan::InstallPlan {
        schema_version: SchemaVersion::One,
        plan_id: "real-machine-check".to_string(),
        created_at: devkit_types::timeutil::iso8601_now(),
        devkit_version: "0.6.2".to_string(),
        manifest_revision: "test".to_string(),
        options: PlanOptions {
            concurrency: 2,
            mirror_preference: MirrorPreference::Huaweicloud,
            proxy: None,
            create_restore_point: false,
            dry_run: false,
        },
        items: vec![PlanItem {
            id: "git".to_string(),
            version: "2.47.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: devkit_types::manifest::InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: Vec::new(),
            state: PlanItemState::Pending,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: None,
            archive_path: None,
            download_attempts: None,
        }],
        summary: PlanSummary {
            total: 1,
            success: 0,
            failed: 0,
            skipped: 0,
            cancelled: 0,
        },
    };
    let tools: ToolMap = std::iter::once(("git".to_string(), minimal_tool("git", "git"))).collect();
    let report = run_preflight(PreflightInput {
        plan: &plan,
        tools: &tools,
        target_path: "%USERPROFILE%",
        max_probes: Some(0),
        available_tool_ids: None,
    })
    .await;

    println!("\n预检结果：ok={}（{} 项）", report.ok, report.checks.len());
    for check in &report.checks {
        println!("  [{:?}] {:<24} {}", check.level, check.id, check.message);
    }
    let blockers: Vec<_> = report
        .checks
        .iter()
        .filter(|c| c.level == PreflightLevel::Error)
        .collect();
    assert!(
        blockers.is_empty(),
        "本机（真实开发机）预检不应有 error 项：{blockers:?}"
    );
    assert!(report.ok);
    // 基础段齐备（TS 同款 id：os-version/arch/disk/network；admin 只在需要提权时出现）
    for expected_id in ["os-version", "arch", "disk", "network"] {
        assert!(
            report.checks.iter().any(|c| c.id == expected_id),
            "预检缺少 {expected_id} 项"
        );
    }
    assert!(!report.requires_admin);
}
