//! 清单校验 CLI（镜像 `scripts/check-manifest.ts`，FR-12 的维护侧入口）。
//!
//! 用途：本地 `cargo run -p devkit-manifest --bin manifest-check`，
//! 以及 CI 里阻断不合格清单合并（R7 起 release.yml / ci.yml 改调这里）。
//! 与 GUI 共用同一套校验（`devkit-manifest::validate`），不存在第二套规则。

use std::path::{Path, PathBuf};

fn fail(message: &str) -> ! {
    eprintln!("\n✖ {message}\n");
    std::process::exit(1);
}

/// 从仓库根解析清单目录：优先 `<cwd>/resources/manifest`，
/// 找不到就按 `<cwd>/../resources/manifest`（在 src-tauri 里跑时）再试。
fn manifest_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    let direct = cwd.join("resources/manifest");
    if direct.join("tools").is_dir() {
        return direct;
    }
    let up = cwd.join("../resources/manifest");
    if up.join("tools").is_dir() {
        return up;
    }
    fail(&format!(
        "找不到清单目录：{} 或 {}（请在仓库根或 src-tauri 下运行）",
        direct.display(),
        up.display()
    ));
}

fn read_manifest_files(
    tools_dir: &Path,
) -> (
    Vec<devkit_manifest::ManifestFileInput>,
    Vec<(String, String)>,
) {
    let mut inputs = Vec::new();
    let mut read_errors = Vec::new();
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(entries) => entries,
        Err(error) => fail(&format!(
            "无法读取清单目录 {}：{error}",
            tools_dir.display()
        )),
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    for name in names {
        match std::fs::read_to_string(tools_dir.join(&name)) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(data) => inputs.push(devkit_manifest::ManifestFileInput { file: name, data }),
                Err(error) => read_errors.push((name, error.to_string())),
            },
            Err(error) => read_errors.push((name, error.to_string())),
        }
    }
    (inputs, read_errors)
}

fn main() {
    let dir = manifest_dir();
    let tools_dir = dir.join("tools");
    let (inputs, read_errors) = read_manifest_files(&tools_dir);

    let checked = devkit_manifest::validate_manifest_files(&inputs);
    let all_errors: Vec<(String, String)> = read_errors
        .into_iter()
        .chain(
            checked
                .errors
                .iter()
                .map(|error| (error.file.clone(), error.message.clone())),
        )
        .collect();

    let ready = checked
        .tools
        .iter()
        .filter(|tool| tool.status == devkit_types::manifest::ManifestStatus::Ready)
        .count();
    let detect_only = checked
        .tools
        .iter()
        .filter(|tool| tool.status == devkit_types::manifest::ManifestStatus::DetectOnly)
        .count();
    let missing_versions: Vec<&str> = checked
        .tools
        .iter()
        .filter(|tool| tool.versions.is_empty())
        .map(|tool| tool.id.as_str())
        .collect();
    let missing_sha: Vec<String> = checked
        .tools
        .iter()
        .flat_map(|tool| {
            tool.versions
                .iter()
                .filter(|version| {
                    version
                        .source
                        .as_ref()
                        .and_then(|source| source.sha256.as_deref())
                        .map(|sha| sha.is_empty())
                        .unwrap_or(true)
                })
                .map(|version| format!("{}@{}", tool.id, version.version))
        })
        .collect();

    println!("清单校验结果");
    println!("{}", "─".repeat(60));
    println!("目录            {}", dir.display());
    println!("文件总数        {}", inputs.len());
    println!("通过校验        {}", checked.tools.len());
    println!("  ├ ready       {ready}（安装信息完整）");
    println!("  └ detect-only {detect_only}（仅支持检测）");
    println!("校验失败        {}", all_errors.len());

    if !missing_versions.is_empty() {
        println!("\n尚无版本信息的清单（{}）：", missing_versions.len());
        for id in &missing_versions {
            println!("  · {id}");
        }
    }

    if !missing_sha.is_empty() {
        println!(
            "\n已声明版本但缺少 SHA-256 的条目（{}）：",
            missing_sha.len()
        );
        for item in &missing_sha {
            println!("  · {item}");
        }
    }

    if !all_errors.is_empty() {
        println!("\n失败详情：");
        for (file, message) in &all_errors {
            println!("  ✖ {file}\n      {message}");
        }
        fail(&format!("{} 个清单未通过校验", all_errors.len()));
    }

    println!("\n✔ 全部清单通过 JSON Schema 与语义校验");
}
