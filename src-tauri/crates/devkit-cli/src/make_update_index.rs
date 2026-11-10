//! `devkit-cli make-update-index`（镜像 `scripts/make-update-index.ts`，FR-13）。
//!
//! 生成更新索引 release/latest.json：更新检查（devkit-core updater）拉这个文件，
//! 比较版本号后把下载地址交给用户（横幅 → 一键下载 → SHA-256 校验 → 拉起安装包）。
//!
//! TS 版只认 electron-builder 的固定产物名；Rust 版扫描目录里的
//! `*-setup.exe`（NSIS）与可选的 `*portable*.exe`，对 tauri bundler 的
//! `<productName>_<version>_x64-setup.exe` 命名同样适用。
//!
//! 产物名不含空格：带空格的 URL 会被上传工具/浏览器改写（TS 版同规则）。

use crate::{manifest_dir, utc_now_iso};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Options {
    dir: PathBuf,
    version: String,
    runtime: Option<String>,
    notes: String,
}

fn parse_args(args: &[String]) -> Options {
    let mut options = Options {
        dir: PathBuf::from("release"),
        version: env!("CARGO_PKG_VERSION").to_string(),
        runtime: Some("tauri".to_string()),
        notes: "见 GitHub Release 说明".to_string(),
    };
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        match flag {
            "--dir" => {
                index += 1;
                options.dir =
                    PathBuf::from(args.get(index).map(String::as_str).unwrap_or("release"));
            }
            "--version" => {
                index += 1;
                if let Some(value) = args.get(index) {
                    options.version = value.clone();
                }
            }
            "--runtime" => {
                index += 1;
                options.runtime = args.get(index).cloned();
            }
            "--no-runtime" => options.runtime = None,
            "--notes" => {
                index += 1;
                if let Some(value) = args.get(index) {
                    options.notes = value.clone();
                }
            }
            other => {
                eprintln!(
                    "未知参数：{other}（支持 --dir/--version/--runtime/--no-runtime/--notes）"
                );
                std::process::exit(2);
            }
        }
        index += 1;
    }
    options
}

/// 在目录里找安装包产物。返回 (setup, portable)。
/// 在目录里找安装包产物。返回 (setup, portable)；找不到 setup 时返回 Err。
fn find_artifacts(dir: &Path, version: &str) -> Result<(String, Option<String>), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("无法读取产物目录 {}：{error}", dir.display()))?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();

    let exes: Vec<String> = names
        .iter()
        .filter(|name| name.to_lowercase().ends_with(".exe"))
        .cloned()
        .collect();
    let setup = exes
        .iter()
        .find(|name| name.to_lowercase().ends_with("-setup.exe"));
    let portable = exes
        .iter()
        .find(|name| {
            let lower = name.to_lowercase();
            lower.contains("portable") && lower.ends_with(".exe")
        })
        .or_else(|| {
            exes.iter()
                .find(|name| *name == &format!("devkit-{version}-portable.exe"))
        });

    let Some(setup) = setup else {
        let listing = if exes.is_empty() {
            "（没有 exe）".to_string()
        } else {
            exes.iter()
                .map(|n| n.as_str())
                .collect::<Vec<_>>()
                .join("、")
        };
        return Err(format!(
            "在 {} 里找不到 *-setup.exe，请先构建安装包（cargo tauri build）。当前目录里有：{}",
            dir.display(),
            listing
        ));
    };
    Ok(((*setup).clone(), portable.map(|name| (*name).clone())))
}

pub(crate) fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    let _ = manifest_dir(); // 与其他子命令一致：要求在仓库布局下运行
    let dir = options.dir.clone();
    let (setup, portable) = find_artifacts(&dir, &options.version).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1);
    });

    let mut checksums = BTreeMap::new();
    let mut sizes = BTreeMap::new();
    for name in std::iter::once(&setup).chain(portable.iter()) {
        let path = dir.join(name);
        let hash = devkit_core::checksum::sha256_file(&path).unwrap_or_else(|error| {
            eprintln!("计算 {name} 的 SHA-256 失败：{error}");
            std::process::exit(1);
        });
        let size = std::fs::metadata(&path)
            .map(|meta| meta.len())
            .unwrap_or_else(|error| {
                eprintln!("读取 {name} 体积失败：{error}");
                std::process::exit(1);
            });
        checksums.insert(name.clone(), hash);
        sizes.insert(name.clone(), size);
    }

    let mut files = vec![setup.clone()];
    if let Some(portable) = &portable {
        files.push(portable.clone());
    }

    let mut index = serde_json::Map::new();
    index.insert(
        "version".to_string(),
        serde_json::Value::String(options.version.clone()),
    );
    index.insert(
        "releasedAt".to_string(),
        serde_json::Value::String(utc_now_iso()),
    );
    index.insert("url".to_string(), serde_json::Value::String(setup.clone()));
    index.insert(
        "files".to_string(),
        serde_json::Value::Array(
            files
                .iter()
                .map(|name| serde_json::Value::String(name.clone()))
                .collect(),
        ),
    );
    index.insert(
        "checksums".to_string(),
        serde_json::Value::Object(
            checksums
                .into_iter()
                .map(|(name, hash)| (name, serde_json::Value::String(hash)))
                .collect(),
        ),
    );
    index.insert(
        "sizes".to_string(),
        serde_json::Value::Object(
            sizes
                .into_iter()
                .map(|(name, size)| (name, serde_json::Value::Number(size.into())))
                .collect(),
        ),
    );
    index.insert(
        "notes".to_string(),
        serde_json::Value::String(options.notes.clone()),
    );
    if let Some(runtime) = &options.runtime {
        // 供灰度判断：旧 TS 客户端会忽略未知字段，新客户端据此识别运行时
        index.insert(
            "runtime".to_string(),
            serde_json::Value::String(runtime.clone()),
        );
    }

    let target = dir.join("latest.json");
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(index))
        .expect("latest.json 序列化不会失败");
    std::fs::write(&target, format!("{text}\n")).unwrap_or_else(|error| {
        eprintln!("写入 {} 失败：{error}", target.display());
        std::process::exit(1);
    });

    println!("已生成 {}", target.display());
    println!("  version  {}", options.version);
    println!("  url      {setup}");
    let setup_hash = dir.join(&setup);
    if let Ok(hash) = devkit_core::checksum::sha256_file(&setup_hash) {
        println!("  sha256   {}…", &hash[..16.min(hash.len())]);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_artifacts_prefers_setup_and_portable() {
        let dir = std::env::temp_dir().join(format!("devkit-cli-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("devkit_1.0.0_x64-setup.exe"), b"x").unwrap();
        std::fs::write(dir.join("devkit-1.0.0-portable.exe"), b"x").unwrap();
        std::fs::write(dir.join("latest.json"), b"{}").unwrap();

        let (setup, portable) = find_artifacts(&dir, "1.0.0").expect("应找到产物");
        assert_eq!(setup, "devkit_1.0.0_x64-setup.exe");
        assert_eq!(portable.as_deref(), Some("devkit-1.0.0-portable.exe"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_artifacts_missing_setup_is_error() {
        let dir = std::env::temp_dir().join(format!("devkit-cli-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let result = find_artifacts(&dir, "9.9.9");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
