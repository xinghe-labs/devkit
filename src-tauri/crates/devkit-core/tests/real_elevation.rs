//! 真机提权探针（#[ignore]，需要显式运行）。
//!
//! 非提权路径（force_unelevated）走完整作业链路：内联脚本 → powershell 执行 →
//! 结果文件 → nonce 校验 → 步骤结果解析。不会写注册表、不会弹 UAC。
//! 运行：cargo test -p devkit-core --test real_elevation -- --ignored --nocapture

use devkit_core::elevation::{run_job, ElevationJobStep, RunJobOptions};

#[tokio::test]
#[ignore = "真机探针：启动真实 powershell 作业（非提权），需要显式运行"]
async fn real_elevation_non_elevated_job() {
    let job_dir =
        std::env::temp_dir().join(format!("devkit-elevation-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&job_dir);

    let steps = vec![
        ElevationJobStep::Exec {
            label: "成功步骤（cmd /c exit 0）".to_string(),
            cmd: "cmd.exe".to_string(),
            args: vec!["/c".to_string(), "exit 0".to_string()],
            timeout_ms: Some(30_000),
            verify_sha256: None,
        },
        ElevationJobStep::Exec {
            label: "失败步骤（cmd /c exit 7）".to_string(),
            cmd: "cmd.exe".to_string(),
            args: vec!["/c".to_string(), "exit 7".to_string()],
            timeout_ms: Some(30_000),
            verify_sha256: None,
        },
    ];

    let outcome = run_job(&RunJobOptions {
        job_dir: &job_dir,
        steps: &steps,
        force_unelevated: true,
    })
    .await;

    // 整体失败（有一个步骤 exit 7），但两个步骤都有结果
    assert!(
        !outcome.ok,
        "包含 exit 7 步骤，整体必须失败：{:?}",
        outcome.error
    );
    assert!(!outcome.elevated, "force_unelevated 不应走提权");
    assert_eq!(outcome.steps.len(), 2);
    assert!(outcome.steps[0].ok, "步骤 1 应成功：{:?}", outcome.steps[0]);
    assert!(!outcome.steps[1].ok, "步骤 2 应失败（exit 7）");
    assert_eq!(outcome.steps[1].exit_code, Some(7));
    println!(
        "提权作业（非提权路径）探针：ok={}，steps={:?}",
        outcome.ok,
        outcome
            .steps
            .iter()
            .map(|s| (s.label.as_str(), s.ok))
            .collect::<Vec<_>>()
    );

    // 结果文件确实写了（nonce 校验通过才走到这一步）
    let files: Vec<_> = std::fs::read_dir(&job_dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        files.iter().any(|name| name.starts_with("result-")),
        "应有结果文件：{files:?}"
    );
}
