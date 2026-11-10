//! 真机体检探针（#[ignore]，需要显式运行）。
//!
//! 只读：读注册表、读文件系统、跑 where.exe、读系统配置状态。
//! 运行：cargo test -p devkit-core --test real_doctor -- --ignored --nocapture

use devkit_core::activate::index::UserEnvIo;
use devkit_core::activate::machine_path::read_machine_path_raw;
use devkit_core::doctor::{run_doctor, DoctorInputs};
use std::collections::HashMap;

#[tokio::test]
#[ignore = "真机探针：读真实注册表与 PATH，需要显式运行"]
async fn real_doctor_probe() {
    let read_user = || devkit_core::activate::index::RealUserEnvIo.read_path();
    let read_machine = || {
        let handle = std::thread::spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(read_machine_path_raw())
        });
        handle.join().unwrap()
    };
    let resolve = |cmd: &str| -> Vec<String> {
        let output = std::process::Command::new("where.exe").arg(cmd).output();
        match output {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect(),
            _ => Vec::new(),
        }
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    let inputs = DoctorInputs {
        read_user_path: &read_user,
        read_machine_path: &read_machine,
        resolve_command: &resolve,
        env,
        exists: &|path| std::path::Path::new(path).exists(),
    };

    let report = run_doctor(&inputs).await;

    // 基本形状：体检报告必须有 devkit-state 条目，且 user/machine 视图非空
    assert!(report.findings.iter().any(|item| item.id == "devkit-state"));
    assert!(
        !report.user_path.entries.is_empty() || !report.machine_path.entries.is_empty(),
        "至少一个 PATH 视图应有条目"
    );
    println!(
        "体检摘要：{:?}（findings={} 条）",
        report.summary,
        report.findings.len()
    );
    for finding in &report.findings {
        println!(
            "[{:?}] {} —— {}",
            finding.level,
            finding.id,
            finding.evidence.first().cloned().unwrap_or_default()
        );
    }
}
