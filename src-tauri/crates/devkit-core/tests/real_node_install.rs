//! R2 真实安装验收（MIGRATION-RUST.md §R2：dry-run + 真实装一次 Node ZIP）。
//!
//! 手动触发（需要网络，走 npmmirror 国内镜像直连）：
//! ```text
//! cargo test -p devkit-core --test real_node_install -- --ignored --nocapture
//! ```
//!
//! 流程对齐 TS 时代的 M1a 人工验收路径：
//! 1. 取 npmmirror 的 SHASUMS256.txt 拿到官方 sha256（downloader 的 sha256 为空会校验失败）
//! 2. downloader 断点续传下载 node zip（重跑命中幂等缓存）
//! 3. dry-run：install_version 只预览命令行，不落盘
//! 4. 真实解压（zip_extract，strip=1）
//! 5. 自检：解压出的 node.exe --version 应输出 v24.21.0（「安装 ≠ 激活」：用 {installDir} 指向刚装的那份）

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use devkit_core::downloader::{download_file, DownloadRequest, DownloadSource};
use devkit_core::exec::{run_command, RunOptions};
use devkit_core::zip_extract::ExtractOptions;
use tokio_util::sync::CancellationToken;

const NODE_VERSION: &str = "v24.21.0";
const MIRROR_BASE: &str = "https://registry.npmmirror.com/-/binary/node";

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("devkit-r2-real-install")
}

#[tokio::test]
#[ignore = "真实网络下载，手动触发：cargo test -p devkit-core --test real_node_install -- --ignored --nocapture"]
async fn real_install_node_zip_end_to_end() {
    let dir = work_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();

    // 1. 官方 SHASUMS256.txt → zip 的 sha256
    let shasums_url = format!("{MIRROR_BASE}/{NODE_VERSION}/SHASUMS256.txt");
    let client = reqwest::Client::new();
    let shasums = client
        .get(&shasums_url)
        .send()
        .await
        .expect("SHASUMS256.txt 下载失败")
        .text()
        .await
        .expect("SHASUMS256.txt 读取失败");
    let zip_name = format!("node-{NODE_VERSION}-win-x64.zip");
    let sha256 = shasums
        .lines()
        .find(|line| line.ends_with(&format!("*{zip_name}")) || line.ends_with(&zip_name))
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or_else(|| panic!("SHASUMS256.txt 里找不到 {zip_name}"))
        .to_lowercase();
    println!("sha256({zip_name}) = {sha256}");

    // 2. 下载（幂等：重跑且校验通过则跳过）
    let zip_path = dir.join(&zip_name);
    let result = download_file(&DownloadRequest {
        sources: vec![DownloadSource {
            name: "npmmirror".to_string(),
            url: format!("{MIRROR_BASE}/{NODE_VERSION}/{zip_name}"),
        }],
        sha256: sha256.clone(),
        size_bytes: None,
        target_file: zip_path.clone(),
        proxy: None,
        timeout_ms: None,
        idle_timeout_ms: None,
        min_speed_bytes_per_sec: None,
        speed_grace_ms: None,
        retries_per_source: None,
        allow_insecure: false,
        cancel: None,
        on_progress: None,
        on_phase: None,
    })
    .await;
    assert!(result.ok, "下载失败：{:?}", result.error);
    println!(
        "下载完成：{} 字节，耗时 {}ms",
        result.bytes, result.duration_ms
    );

    // 3. dry-run：只预览命令行，不落盘
    use devkit_core::direct::{install_version, CommandLog, InstallRequest};
    use devkit_types::locale::LocalizedText;
    use devkit_types::manifest::{
        Arch, InstallScope, InstallSpec, InstallType, LicenseTier, ManifestStatus, SourceSpec,
        ToolCategory, ToolVersionSpec, VersionChannel,
    };

    let names = |zh: &str, en: &str| -> LocalizedText {
        [(zh.to_string(), "zh-CN"), (en.to_string(), "en-US")]
            .iter()
            .map(|(v, k)| (k.to_string(), v.clone()))
            .collect()
    };
    let version_spec = ToolVersionSpec {
        version: NODE_VERSION.trim_start_matches('v').to_string(),
        channel: VersionChannel::Lts,
        recommended: Some(true),
        arch: Arch::X64,
        release_date: None,
        size_bytes: None,
        install_scope: InstallScope::User,
        requires_reboot: None,
        depends_on: None,
        source: Some(SourceSpec {
            url: format!("{MIRROR_BASE}/{NODE_VERSION}/{zip_name}"),
            sha256: Some(sha256),
        }),
        mirrors: None,
        install: Some(InstallSpec {
            install_type: InstallType::Zip,
            template: "zip-into-version-dir".to_string(),
            params: Some(
                [("stripComponents".to_string(), "1".to_string())]
                    .into_iter()
                    .collect(),
            ),
        }),
        uninstall: None,
        activate: None,
        configure: None,
        verify: None,
    };
    let tool = devkit_types::manifest::ToolManifest {
        id: "nodejs".to_string(),
        category: ToolCategory::Runtime,
        tier: LicenseTier::L1,
        status: ManifestStatus::Ready,
        provider: None,
        name: names("Node.js", "Node.js"),
        description: names("JavaScript 运行时", "JavaScript runtime"),
        homepage: None,
        license: None,
        detect: Default::default(),
        versions: vec![version_spec.clone()],
        notes: None,
    };

    let dry_run_dir = dir.join("dry-run-install");
    let commands: Arc<Mutex<Vec<CommandLog>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = commands.clone();
    let dry_outcome = install_version(&InstallRequest {
        tool: tool.clone(),
        version: version_spec.clone(),
        install_dir: dry_run_dir.clone(),
        archive_path: zip_path.clone(),
        log_file: dir.join("dry-run.log"),
        dry_run: true,
        npm_cmd: "npm.cmd".to_string(),
        run_elevated: None,
        path_hooks: None,
        cancel: None,
        on_progress: None,
        on_command: Some(Arc::new(move |log: &CommandLog| {
            captured.lock().unwrap().push(log.clone());
        })),
    })
    .await
    .expect("dry-run 不应失败");
    assert!(dry_outcome.dry_run);
    assert_eq!(dry_outcome.files, 0);
    assert!(!dry_run_dir.exists(), "dry-run 不应创建安装目录");
    // zip 模板没有安装器命令（TS：buildCommand 不存在 → preview null，不回调）
    assert!(
        commands.lock().unwrap().is_empty(),
        "zip 模板 dry-run 无安装器命令预览"
    );
    assert!(
        dry_outcome.log_file.is_none(),
        "preview 为空时 log_file 也为 None（对齐 TS）"
    );
    println!("dry-run 通过：zip 模板无安装器命令，未落盘任何文件");

    // 4. 真实解压（对齐 plan 的 zip-into-version-dir + stripComponents=1）
    let install_dir = dir.join("versions").join("nodejs").join("24.21.0");
    let extract = devkit_core::zip_extract::extract_zip(ExtractOptions {
        zip_file: zip_path.clone(),
        dest_dir: install_dir.clone(),
        strip_components: 1,
        on_progress: None,
        cancel: Some(CancellationToken::new()),
    })
    .await
    .expect("解压失败");
    println!("解压：{} 个文件 / {} 字节", extract.files, extract.bytes);
    assert!(extract.files > 100, "Node zip 不止 100 个文件");

    // 5. 自检（「安装 ≠ 激活」：绝对路径指向刚装的那份，不碰 PATH）
    let node_exe = install_dir.join("node.exe");
    assert!(node_exe.exists(), "应存在 {node_exe:?}");
    let verify = run_command(
        &node_exe.display().to_string(),
        &["--version".to_string()],
        &RunOptions {
            cwd: None,
            timeout_ms: Some(15_000),
            env: None,
            cancel: None,
        },
    )
    .await;
    assert!(verify.spawn_error.is_none(), "{:?}", verify.spawn_error);
    let output = verify.stdout.trim();
    assert_eq!(
        output, NODE_VERSION,
        "自检输出不符：stdout={output:?} stderr={:?}",
        verify.stderr
    );
    println!("自检通过：node.exe --version → {output}");

    // 清理（保留 zip 供幂等复跑；解压目录删掉）
    let _ = tokio::fs::remove_dir_all(dir.join("versions")).await;
    let _ = tokio::fs::remove_dir_all(dir.join("dry-run-install")).await;
}
