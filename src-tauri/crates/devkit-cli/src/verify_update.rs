//! `devkit-cli verify-update`（镜像 `scripts/verify-update.ts`，依赖网络，不进 CI）。
//!
//! 验证更新下载链路的三个行为：
//!  0. 索引没给 SHA-256 → **直接拒绝**（Rust 版加严：TS 版放行并告警，
//!     Rust 版把"更新包没校验和"视为不可接受，见 updater.rs 注释）
//!  1. 哈希正确 → 落盘、verified=true
//!  2. 哈希错误 → **文件被丢弃**、verified=false、不返回路径
//!
//! 用一个真实的小文件（npmmirror 上的 npm 包）当"更新包"，
//! 因为 downloadUpdate 只关心 https + 哈希，不关心扩展名。

use std::path::PathBuf;

const TARGET_DIR: &str = "D:\\AgentWork\\tmp\\update-verify";
const URL: &str = "https://registry.npmmirror.com/cowsay/-/cowsay-1.6.0.tgz";

fn clean_dir(path: &PathBuf) {
    let _ = std::fs::remove_dir_all(path);
    let _ = std::fs::create_dir_all(path);
}

pub(crate) fn run(_args: &[String]) -> i32 {
    let rt = tokio::runtime::Runtime::new().expect("创建 tokio runtime 失败");
    rt.block_on(async_main())
}

async fn async_main() -> i32 {
    let target_dir = PathBuf::from(TARGET_DIR);
    clean_dir(&target_dir);

    // 先拿到这个文件的真实哈希（用同一套 http 客户端下载一次来算；
    // 不能借道 download_update —— 它对缺 SHA-256 的请求直接拒绝）。
    println!("步骤 0：索引没给 SHA-256 → download_update 必须直接拒绝");
    let refused =
        devkit_core::updater::download_update(&devkit_core::updater::DownloadUpdateParams {
            url: URL,
            sha256: None,
            target_dir: &target_dir.join("refused"),
            proxy: None,
        })
        .await;
    println!("  ok={} error={:?}", refused.ok, refused.error);
    if refused.ok || refused.verified.is_some() {
        eprintln!("用例 0 失败：缺 SHA-256 却放行了");
        return 1;
    }

    println!("\n步骤 1：先下载一次，算出真实 SHA-256");
    let real_hash = match download_raw(URL, &target_dir.join("probe")).await {
        Ok(hash) => hash,
        Err(error) => {
            eprintln!("探测下载失败：{error}");
            return 1;
        }
    };
    println!("  SHA-256 = {real_hash}");

    // 用例 A：哈希正确
    println!("\n步骤 2：哈希正确 → 应落盘且 verified=true");
    let good = devkit_core::updater::download_update(&devkit_core::updater::DownloadUpdateParams {
        url: URL,
        sha256: Some(real_hash.clone()),
        target_dir: &target_dir.join("good"),
        proxy: None,
    })
    .await;
    println!(
        "  ok={} verified={:?} bytes={}",
        good.ok, good.verified, good.bytes
    );
    println!("  filePath={:?}", good.file_path);
    let good_exists = good
        .file_path
        .as_ref()
        .map(|path| std::path::Path::new(path).exists())
        .unwrap_or(false);
    println!("  文件存在={good_exists}");
    if !good.ok || good.verified != Some(true) || !good_exists {
        eprintln!("用例 A 失败：哈希正确却没落盘");
        return 1;
    }

    // 用例 B：哈希错误
    println!("\n步骤 3：哈希错误 → 必须丢弃，不能留下文件");
    let bad = devkit_core::updater::download_update(&devkit_core::updater::DownloadUpdateParams {
        url: URL,
        sha256: Some("f".repeat(64)),
        target_dir: &target_dir.join("bad"),
        proxy: None,
    })
    .await;
    println!("  ok={} verified={:?}", bad.ok, bad.verified);
    println!("  error={:?}", bad.error);
    let bad_dir = target_dir.join("bad");
    let leftovers = std::fs::read_dir(&bad_dir)
        .map(|entries| entries.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    println!("  残留文件数={leftovers}（应为 0）");
    if bad.ok || bad.verified != Some(false) || leftovers > 0 {
        eprintln!("用例 B 失败：校验失败却留下了文件");
        return 1;
    }

    println!("\n全部通过：缺哈希直接拒绝；哈希正确才落盘，哈希错误一律丢弃。");
    let _ = std::fs::remove_dir_all(&target_dir);
    0
}

/// 裸下载（不走 download_update 的校验门禁），返回落盘文件的 SHA-256。
async fn download_raw(url: &str, target_dir: &std::path::Path) -> Result<String, String> {
    use futures::StreamExt;
    let _ = std::fs::create_dir_all(target_dir);
    let file_name = url.rsplit('/').next().unwrap_or("probe.bin");
    let path = target_dir.join(file_name);

    let response = devkit_core::http::request_stream(
        url,
        &devkit_core::http::HttpRequestOptions {
            headers: Vec::new(),
            method: devkit_core::http::HttpMethod::Get,
            proxy: None,
            timeout_ms: Some(30_000),
            cancel: None,
            max_redirects: None,
            allow_insecure: false,
        },
    )
    .await
    .map_err(|error| error.message)?;

    if response.status != 200 {
        return Err(format!("下载失败：HTTP {}", response.status));
    }
    let mut file =
        std::fs::File::create(&path).map_err(|error| format!("创建文件失败：{error}"))?;
    use std::io::Write;
    let mut stream = response.stream;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("写文件失败：{error}"))?;
    }
    file.flush().map_err(|error| format!("刷盘失败：{error}"))?;
    devkit_core::checksum::sha256_file(&path).map_err(|error| format!("计算哈希失败：{error}"))
}
