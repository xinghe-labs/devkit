//! 下载器（对应 TS `core/downloader/index.ts`，SPEC FR-19）。
//!
//! 职责：按优先级依次尝试多个下载源，支持断点续传、SHA-256 强校验、镜像回退。
//! 镜像顺序由调用方（executor）根据用户的镜像偏好排好，这里只负责"按顺序试"。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::checksum::{sha256_file, short_hash};
use crate::http::{request_stream, HttpMethod, HttpRequestOptions};

/// 低于这个速度就换源（32 KB/s）；正常国内镜像都是 MB/s 级
pub const MIN_ACCEPTABLE_BYTES_PER_SEC: u64 = 32 * 1024;
/// 前 15 秒不计速度：大文件刚建立连接时可能有一段慢启动
pub const SPEED_GRACE_MS: u64 = 15_000;
/// 速度哨兵的检查间隔（与 TS 的 setInterval(4000) 一致；仅测试会调小）
const SPEED_CHECK_INTERVAL_MS: u64 = 4_000;

#[derive(Debug, Clone)]
pub struct DownloadSource {
    /// 便于日志与错误报告里指出是哪个源
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadPhase {
    Downloading,
    Verifying,
}

#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub source: String,
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct DownloadAttempt {
    pub source: String,
    pub url: String,
    pub error: String,
}

/// 下载进度回调（type_complexity lint 要求显式命名）
pub type ProgressCallback = Box<dyn Fn(&DownloadProgress) + Send + Sync>;
/// 阶段变化回调
pub type PhaseCallback = Box<dyn Fn(DownloadPhase, &str) + Send + Sync>;

pub struct DownloadRequest {
    /// 已按优先级排好的候选源，第一个是首选
    pub sources: Vec<DownloadSource>,
    /// 期望的 SHA-256（小写十六进制）
    pub sha256: String,
    pub size_bytes: Option<u64>,
    /// 最终落盘路径
    pub target_file: PathBuf,
    pub proxy: Option<String>,
    /// 等待响应头超时
    pub timeout_ms: Option<u64>,
    /// 无数据超时（不是总时长限制，大文件慢速下载不会被误杀）
    pub idle_timeout_ms: Option<u64>,
    /// 平均速度低于此值就换源（默认 32 KB/s）
    pub min_speed_bytes_per_sec: Option<u64>,
    /// 速度哨兵的宽限期（默认 15 秒，大文件慢启动不误杀）；单测会调小
    pub speed_grace_ms: Option<u64>,
    pub retries_per_source: Option<u32>,
    /// 仅测试用：允许 http:// 源。生产环境一律 https
    pub allow_insecure: bool,
    pub cancel: Option<CancellationToken>,
    pub on_progress: Option<ProgressCallback>,
    /// 阶段变化回调，供 executor 把 UI 状态从"下载中"切到"校验中"
    pub on_phase: Option<PhaseCallback>,
}

impl DownloadRequest {
    pub fn new(
        sources: Vec<DownloadSource>,
        sha256: impl Into<String>,
        target_file: impl Into<PathBuf>,
    ) -> Self {
        Self {
            sources,
            sha256: sha256.into(),
            size_bytes: None,
            target_file: target_file.into(),
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
        }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub ok: bool,
    pub file_path: Option<PathBuf>,
    pub attempts: Vec<DownloadAttempt>,
    pub bytes: u64,
    pub duration_ms: u128,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ResumeMeta {
    url: String,
    total: Option<u64>,
}

/// 源级别的失败：该镜像没有这个文件（未同步此版本）或拒绝访问。
/// 重试同一个源没有意义，应该直接换下一个源 —— 实测清华镜像就只到 v24.1.0，
/// 遇到新版本必然 404。
///
/// 源太慢：不是"连不上"，而是"连上了但慢到不可用"。
/// 为什么必须单独识别：实测 GitHub release 资产在国内有时会以 1~5 KB/s 的速度"慢慢滴"，
/// 连接正常、也不断流，所以空闲超时永远不会触发 —— 一个 10 MB 的包要下三个小时，
/// 而且会卡在那里挡住后面明明更快的镜像。把"平均速度长期低于阈值"当成可回退错误，
/// 是让镜像回退真正生效的关键一步（SPEC 风险表里"镜像速度差异巨大"那条）。
#[derive(Debug)]
enum Failure {
    SourceUnavailable(String),
    SlowSource(String),
    Cancelled,
    Other(String),
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Failure::SourceUnavailable(message)
            | Failure::SlowSource(message)
            | Failure::Other(message) => message.clone(),
            Failure::Cancelled => "下载已取消".to_string(),
        }
    }
}

/// 把"连接被掐断"这类底层报错翻译成用户能看懂的话
fn describe_stream_error(message: &str, received: u64, expected: Option<u64>) -> String {
    let lower = message.to_lowercase();
    const KEYS: [&str; 6] = [
        "aborted",
        "premature close",
        "econnreset",
        "socket hang up",
        "other side closed",
        "connection reset",
    ];
    if KEYS.iter().any(|key| lower.contains(key)) {
        let expected_part = expected
            .map(|value| format!("，期望 {value} 字节"))
            .unwrap_or_default();
        return format!("连接中断，下载不完整：已收到 {received} 字节{expected_part}（{message}）");
    }
    message.to_string()
}

async fn stat_size(file: &Path) -> Option<u64> {
    match tokio::fs::metadata(file).await {
        Ok(meta) if meta.is_file() => Some(meta.len()),
        _ => None,
    }
}

async fn read_resume_meta(file: &Path) -> Option<ResumeMeta> {
    let raw = tokio::fs::read_to_string(file).await.ok()?;
    serde_json::from_str(&raw).ok()
}

/// 从流写文件，返回写入后的总大小（base + received）。
///
/// 速度哨兵：过了宽限期还在爬，就换源（对齐 TS 的 setInterval(4000) 检查）。
/// pipe_to_file 的上下文打包（11 个参数超过 clippy 上限，且语义上属于同一次写入）
struct PipeCtx<'a> {
    file: &'a Path,
    append: bool,
    base_size: u64,
    expected_total: Option<u64>,
    idle_timeout: Duration,
    min_speed_bytes_per_sec: u64,
    speed_grace: Duration,
    speed_interval: Duration,
    on_progress: &'a (dyn Fn(u64) + Send + Sync),
    cancel: Option<&'a CancellationToken>,
}

async fn pipe_to_file(
    mut stream: crate::http::ByteStream,
    ctx: PipeCtx<'_>,
) -> Result<u64, Failure> {
    let PipeCtx {
        file,
        append,
        base_size,
        expected_total,
        idle_timeout,
        min_speed_bytes_per_sec,
        speed_grace,
        speed_interval,
        on_progress,
        cancel,
    } = ctx;
    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(file)
            .await
    } else {
        tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(file)
            .await
    }
    .map_err(|error| Failure::Other(format!("写入失败：{error}")))?;

    let started_at = Instant::now();
    let mut received: u64 = 0;
    let mut speed_tick = tokio::time::interval(speed_interval);
    speed_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::pin! {
            let cancelled = async {
                match cancel {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            };
        }
        tokio::select! {
            _ = &mut cancelled => return Err(Failure::Cancelled),
            _ = speed_tick.tick() => {
                let elapsed = started_at.elapsed();
                if elapsed < speed_grace {
                    continue;
                }
                let total = base_size + received;
                let speed = (total as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
                if speed < min_speed_bytes_per_sec {
                    return Err(Failure::SlowSource(format!(
                        "下载速度只有 {:.1} KB/s（低于 {:.0} KB/s），已放弃这个源",
                        speed as f64 / 1024.0,
                        min_speed_bytes_per_sec as f64 / 1024.0
                    )));
                }
            }
            chunk = tokio::time::timeout(idle_timeout, stream.next()) => {
                match chunk {
                    Err(_elapsed) => {
                        return Err(Failure::Other(format!(
                            "下载中断：{}ms 内没有收到任何数据",
                            idle_timeout.as_millis()
                        )));
                    }
                    Ok(None) => return Ok(base_size + received),
                    Ok(Some(Err(error))) => {
                        let message =
                            describe_stream_error(&error.to_string(), base_size + received, expected_total);
                        return Err(Failure::Other(message));
                    }
                    Ok(Some(Ok(bytes))) => {
                        // TS 语义对齐：abort 一旦触发立即终止（哪怕数据还在到达）
                        if cancel.is_some_and(|token| token.is_cancelled()) {
                            return Err(Failure::Cancelled);
                        }
                        file.write_all(&bytes)
                            .await
                            .map_err(|error| Failure::Other(format!("写入失败：{error}")))?;
                        received += bytes.len() as u64;
                        on_progress(base_size + received);
                        // 进度回调里也可能触发取消（如 UI 的取消按钮）
                        if cancel.is_some_and(|token| token.is_cancelled()) {
                            return Err(Failure::Cancelled);
                        }
                    }
                }
            }
        }
    }
}

/// 从单个源下载到 .part 文件，返回写入后的文件大小
async fn download_from_source(
    source: &DownloadSource,
    part_file: &Path,
    meta_file: &Path,
    request: &DownloadRequest,
) -> Result<u64, Failure> {
    let idle_timeout = Duration::from_millis(request.idle_timeout_ms.unwrap_or(30_000));

    // 断点续传：只有当侧车文件记录的 URL 与当前源一致时才敢续
    let mut base_size: u64 = 0;
    if let Some(meta) = read_resume_meta(meta_file).await {
        if meta.url == source.url {
            if let Some(size) = stat_size(part_file).await {
                if size > 0 && (meta.total.is_none() || Some(size) <= meta.total) {
                    base_size = size;
                }
            }
        }
    }
    if base_size == 0 {
        let _ = tokio::fs::remove_file(part_file).await;
    }

    let mut headers = Vec::new();
    if base_size > 0 {
        headers.push(("Range".to_string(), format!("bytes={base_size}-")));
    }

    if let Some(on_phase) = &request.on_phase {
        on_phase(DownloadPhase::Downloading, &source.name);
    }

    let response = request_stream(
        &source.url,
        &HttpRequestOptions {
            headers,
            method: HttpMethod::Get,
            proxy: request.proxy.clone(),
            timeout_ms: request.timeout_ms,
            cancel: request.cancel.clone(),
            allow_insecure: request.allow_insecure,
            ..Default::default()
        },
    )
    .await
    .map_err(|error| Failure::Other(error.message))?;

    // 把"源上没有这个文件"与"网络错误"区分开：前者说明该镜像没同步这个版本，
    // 应该直接换下一个源，而不是重试同一个源
    let status = response.status;
    if status == 404 || status == 410 {
        return Err(Failure::SourceUnavailable(format!(
            "该源没有这个文件（HTTP {status}），可能是镜像未同步此版本"
        )));
    }
    if status == 403 {
        return Err(Failure::SourceUnavailable(
            "该源拒绝访问（HTTP 403）".to_string(),
        ));
    }
    if status == 416 {
        let _ = tokio::fs::remove_file(part_file).await;
        return Err(Failure::Other(
            "断点位置已失效（HTTP 416），已丢弃断点，下次将重新下载".to_string(),
        ));
    }
    if status != 200 && status != 206 {
        return Err(Failure::Other(format!("HTTP {status}")));
    }

    // 只有 206 才证明服务器接受了 Range；返回 200 说明它忽略了 Range，得从头写
    let resuming = status == 206 && base_size > 0;
    if !resuming {
        base_size = 0;
    }

    let content_length = response
        .headers
        .get("content-length")
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let total = match content_length {
        Some(length) if length > 0 => {
            let body_length = if resuming { base_size + length } else { length };
            Some(body_length)
        }
        _ => request.size_bytes,
    };

    let on_progress = |received: u64| {
        if let Some(callback) = &request.on_progress {
            callback(&DownloadProgress {
                source: source.name.clone(),
                received,
                total,
            });
        }
    };

    let speed_grace = Duration::from_millis(request.speed_grace_ms.unwrap_or(SPEED_GRACE_MS));
    let speed_interval = Duration::from_millis(SPEED_CHECK_INTERVAL_MS);
    let written = pipe_to_file(
        response.stream,
        PipeCtx {
            file: part_file,
            append: resuming,
            base_size,
            expected_total: total,
            idle_timeout,
            min_speed_bytes_per_sec: request
                .min_speed_bytes_per_sec
                .unwrap_or(MIN_ACCEPTABLE_BYTES_PER_SEC),
            speed_grace,
            speed_interval,
            on_progress: &on_progress,
            cancel: request.cancel.as_ref(),
        },
    )
    .await?;

    let meta = ResumeMeta {
        url: source.url.clone(),
        total,
    };
    let meta_text = serde_json::to_string_pretty(&meta).expect("ResumeMeta 序列化不会失败");
    tokio::fs::write(meta_file, meta_text)
        .await
        .map_err(|error| Failure::Other(format!("写断点信息失败：{error}")))?;

    // 提前发现"下少了"：比对声明大小，避免把截断的文件送去校验
    if let Some(expected_size) = request.size_bytes {
        if written != expected_size {
            return Err(Failure::Other(format!(
                "文件大小不符：期望 {expected_size} 字节，实际 {written} 字节"
            )));
        }
    }

    log::info!(
        target: "download",
        "{} 下载完成：{} 字节（{}）",
        source.name,
        written,
        short_hash(Some(&request.sha256.to_lowercase()))
    );
    Ok(written)
}

/// 按优先级依次尝试多个下载源，成功返回校验通过的最终文件路径。
pub async fn download_file(request: &DownloadRequest) -> DownloadResult {
    let started_at = Instant::now();
    let expected = request.sha256.to_lowercase();
    let mut attempts: Vec<DownloadAttempt> = Vec::new();
    let part_file: PathBuf = format!("{}.part", request.target_file.display()).into();
    let meta_file: PathBuf = format!("{}.part.json", request.target_file.display()).into();
    // TS: Math.max(1, request.retriesPerSource ?? 2) —— 传 0 也至少试一次
    let retries = request.retries_per_source.unwrap_or(2).max(1) as usize;
    let cancelled_now = || {
        request
            .cancel
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
    };

    let failed = |attempts: Vec<DownloadAttempt>, error: String| DownloadResult {
        ok: false,
        file_path: None,
        attempts,
        bytes: 0,
        duration_ms: started_at.elapsed().as_millis(),
        sha256: None,
        error: Some(error),
    };

    if request.sources.is_empty() {
        return failed(attempts, "没有可用的下载源".to_string());
    }

    for source in &request.sources {
        match reqwest::Url::parse(&source.url) {
            Ok(url) if url.scheme() == "https" => {}
            Ok(_url) if request.allow_insecure => {}
            Ok(url) => {
                return failed(attempts, format!("拒绝非 https 下载地址：{url}"));
            }
            Err(error) => {
                return failed(
                    attempts,
                    format!("下载地址不合法：{}（{error}）", source.url),
                );
            }
        }
    }

    if let Some(parent) = request.target_file.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return failed(attempts, format!("创建下载目录失败：{error}"));
        }
    }

    // 幂等（NFR-2）：目标文件已存在且校验通过就直接复用，不重复下载
    if let Some(existing_size) = stat_size(&request.target_file).await {
        match sha256_file(&request.target_file) {
            Ok(existing_hash) if existing_hash == expected => {
                log::info!(
                    target: "download",
                    "目标文件已存在且校验通过，跳过下载：{}",
                    request.target_file.display()
                );
                return DownloadResult {
                    ok: true,
                    file_path: Some(request.target_file.clone()),
                    attempts,
                    bytes: existing_size,
                    duration_ms: started_at.elapsed().as_millis(),
                    sha256: Some(existing_hash),
                    error: None,
                };
            }
            Ok(existing_hash) => {
                log::warn!(
                    target: "download",
                    "目标文件已存在但校验不通过，将重新下载：{}",
                    request.target_file.display()
                );
                log::debug!(target: "download", "existing={existing_hash} expected={expected}");
                let _ = tokio::fs::remove_file(&request.target_file).await;
            }
            Err(error) => {
                log::warn!(target: "download", "无法读取已存在的目标文件：{error}");
                let _ = tokio::fs::remove_file(&request.target_file).await;
            }
        }
    }

    for source in &request.sources {
        for attempt_number in 1..=retries {
            if cancelled_now() {
                return failed(attempts, "已取消".to_string());
            }

            let label = if attempt_number > 1 {
                format!("{}（第 {attempt_number} 次）", source.name)
            } else {
                source.name.clone()
            };
            log::info!(target: "download", "开始从 {label} 下载：{}", source.url);

            let outcome = download_from_source(source, &part_file, &meta_file, request).await;
            match outcome {
                Ok(bytes) => {
                    if let Some(on_phase) = &request.on_phase {
                        on_phase(DownloadPhase::Verifying, &source.name);
                    }
                    let actual = match sha256_file(&part_file) {
                        Ok(hash) => hash,
                        Err(error) => {
                            attempts.push(DownloadAttempt {
                                source: source.name.clone(),
                                url: source.url.clone(),
                                error: format!("读取下载文件失败：{error}"),
                            });
                            continue;
                        }
                    };
                    if actual != expected {
                        let _ = tokio::fs::remove_file(&part_file).await;
                        let _ = tokio::fs::remove_file(&meta_file).await;
                        let message = format!(
                            "SHA-256 校验失败：期望 {}，实际 {}",
                            short_hash(Some(&expected)),
                            short_hash(Some(&actual))
                        );
                        attempts.push(DownloadAttempt {
                            source: source.name.clone(),
                            url: source.url.clone(),
                            error: message.clone(),
                        });
                        log::warn!(target: "download", "{label} 失败：{message}");
                        continue;
                    }

                    // 校验通过才改名到最终路径 —— 未校验的文件永远不出现在最终位置上
                    if let Err(error) = tokio::fs::rename(&part_file, &request.target_file).await {
                        return failed(attempts, format!("落盘失败：{error}"));
                    }
                    let _ = tokio::fs::remove_file(&meta_file).await;
                    log::info!(target: "download", "校验通过并落盘：{}", request.target_file.display());
                    return DownloadResult {
                        ok: true,
                        file_path: Some(request.target_file.clone()),
                        attempts,
                        bytes,
                        duration_ms: started_at.elapsed().as_millis(),
                        sha256: Some(actual),
                        error: None,
                    };
                }
                Err(failure) => {
                    let message = failure.message();
                    attempts.push(DownloadAttempt {
                        source: source.name.clone(),
                        url: source.url.clone(),
                        error: message.clone(),
                    });
                    log::warn!(target: "download", "{label} 失败：{message}");
                    if cancelled_now() {
                        return failed(attempts, "已取消".to_string());
                    }
                    // 源级别的问题（镜像没同步 / 拒绝访问 / 慢到不可用）重试无意义，直接换下一个源
                    if matches!(
                        failure,
                        Failure::SourceUnavailable(_) | Failure::SlowSource(_)
                    ) {
                        break;
                    }
                }
            }
        }
    }

    failed(
        attempts.clone(),
        if attempts.is_empty() {
            "没有可用的下载源".to_string()
        } else {
            format!(
                "所有下载源都失败了。最后一次错误：{}",
                attempts.last().expect("非空已检查").error
            )
        },
    )
}

// ---------------------------------------------------------------------------
// 测试用手写 HTTP/1.1 服务器：够模拟 200/206/404/302 与"发了半个包就装死"，
// 不引入额外依赖（reqwest 客户端对响应帧的要求只有 Content-Length framing）。
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_server {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Clone)]
    pub struct TestResponse {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
        /// 发完 body 后保持连接多少毫秒再关（模拟"连上了但慢到不可用"）
        pub stall_ms: u64,
    }

    impl TestResponse {
        #[allow(dead_code)] // 部分用例直接构造完整响应，simple 留作快速构造
        pub fn simple(status: u16, body: Vec<u8>) -> Self {
            Self {
                status,
                headers: vec![],
                body,
                stall_ms: 0,
            }
        }
    }

    pub struct TestRequest {
        #[allow(dead_code)] // 当前用例只按 header 路由；path 保留给后续用例
        pub path: String,
        pub headers: HashMap<String, String>,
    }

    pub type Handler = Arc<dyn Fn(TestRequest) -> TestResponse + Send + Sync>;

    async fn read_request(stream: &mut TcpStream) -> Option<TestRequest> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buffer);
        let mut lines = text.split("\r\n");
        let request_line = lines.next()?;
        let path = request_line.split_whitespace().nth(1)?.to_string();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        Some(TestRequest { path, headers })
    }

    /// 启动一次性测试服务器，返回 (端口, 停止句柄)。
    pub async fn spawn(handler: Handler) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定测试端口");
        let port = listener.local_addr().expect("取端口").port();
        let handle = tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let handler = handler.clone();
                tokio::spawn(async move {
                    if let Some(request) = read_request(&mut stream).await {
                        let response = handler(request);
                        let status_text = match response.status {
                            200 => "200 OK",
                            206 => "206 Partial Content",
                            302 => "302 Found",
                            403 => "403 Forbidden",
                            404 => "404 Not Found",
                            410 => "410 Gone",
                            416 => "416 Range Not Satisfiable",
                            _ => "500 Internal Server Error",
                        };
                        let mut head = format!("HTTP/1.1 {status_text}\r\n");
                        for (key, value) in &response.headers {
                            head.push_str(&format!("{key}: {value}\r\n"));
                        }
                        if !response
                            .headers
                            .iter()
                            .any(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        {
                            head.push_str(&format!("content-length: {}\r\n", response.body.len()));
                        }
                        head.push_str("connection: close\r\n\r\n");
                        let _ = stream.write_all(head.as_bytes()).await;
                        let _ = stream.write_all(&response.body).await;
                        let _ = stream.flush().await;
                        if response.stall_ms > 0 {
                            tokio::time::sleep(Duration::from_millis(response.stall_ms)).await;
                        }
                        let _ = stream.shutdown().await;
                    }
                });
            }
        });
        (port, handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncReadExt;

    use test_server::{spawn, Handler, TestRequest, TestResponse};

    async fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devkit-dl-{}-{}", tag, std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.expect("建临时目录");
        dir
    }

    #[tokio::test]
    async fn downloads_and_verifies() {
        let body = b"devkit-payload".to_vec();
        let server_body = body.clone();
        let expected_hex = hex::encode(sha2::Sha256::digest(&body));
        let (port, server) = spawn(Arc::new(move |_request| TestResponse {
            status: 200,
            headers: vec![],
            body: server_body.clone(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("basic").await;
        let target = dir.join("pkg.zip");

        let request = DownloadRequest {
            allow_insecure: true,
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                expected_hex.clone(),
                target.clone(),
            )
        };
        let result = download_file(&request).await;
        server.abort();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.bytes, body.len() as u64);
        assert_eq!(result.sha256.as_deref(), Some(expected_hex.as_str()));
        let on_disk = tokio::fs::read(&target).await.expect("文件应存在");
        assert_eq!(on_disk, body);
        assert!(
            !target.with_extension("zip.part").exists(),
            ".part 应已改名"
        );
    }

    #[tokio::test]
    async fn falls_back_to_next_source_on_404() {
        let body = b"from-mirror".to_vec();
        let expected_hex = hex::encode(sha2::Sha256::digest(&body));
        let (bad_port, bad_server) = spawn(Arc::new(|_request| TestResponse {
            status: 404,
            headers: vec![],
            body: b"nope".to_vec(),
            stall_ms: 0,
        }))
        .await;
        let (good_port, good_server) = spawn(Arc::new(move |_request| TestResponse {
            status: 200,
            headers: vec![],
            body: body.clone(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("fallback").await;
        let target = dir.join("pkg.zip");

        let request = DownloadRequest {
            allow_insecure: true,
            retries_per_source: Some(1),
            ..DownloadRequest::new(
                vec![
                    DownloadSource {
                        name: "bad".to_string(),
                        url: format!("http://127.0.0.1:{bad_port}/file"),
                    },
                    DownloadSource {
                        name: "good".to_string(),
                        url: format!("http://127.0.0.1:{good_port}/file"),
                    },
                ],
                expected_hex,
                target,
            )
        };
        let result = download_file(&request).await;
        bad_server.abort();
        good_server.abort();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(
            result.attempts.len(),
            1,
            "404 源不应重试：{:?}",
            result.attempts
        );
        assert_eq!(result.attempts[0].source, "bad");
        assert!(result.attempts[0].error.contains("HTTP 404"));
    }

    #[tokio::test]
    async fn resumes_from_partial_with_range() {
        let full: Vec<u8> = (0u8..=255).cycle().take(1024).collect();
        let handler_full = full.clone();
        let expected_hex = hex::encode(sha2::Sha256::digest(&full));
        let already_have = 300u64;
        let handler: Handler = Arc::new(move |request: TestRequest| {
            let full = handler_full.clone();
            let start: u64 = request
                .headers
                .get("range")
                .and_then(|value| value.trim_start_matches("bytes=").parse().ok())
                .unwrap_or(0);
            if start == 0 {
                TestResponse {
                    status: 200,
                    headers: vec![("content-length".to_string(), full.len().to_string())],
                    body: full,
                    stall_ms: 0,
                }
            } else {
                TestResponse {
                    status: 206,
                    headers: vec![(
                        "content-range".to_string(),
                        format!("bytes {start}-1023/1024"),
                    )],
                    body: full[start as usize..].to_vec(),
                    stall_ms: 0,
                }
            }
        });
        let (port, server) = spawn(handler).await;
        let dir = temp_dir("resume").await;
        let target = dir.join("pkg.zip");
        let part = dir.join("pkg.zip.part");

        // 预置断点：300 字节 + 侧车 meta（url 与当前源一致才允许续传）
        tokio::fs::write(&part, &full[..already_have as usize])
            .await
            .expect("写 part");
        let meta = serde_json::json!({
            "url": format!("http://127.0.0.1:{port}/file"),
            "total": 1024u64
        });
        tokio::fs::write(
            dir.join("pkg.zip.part.json"),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .await
        .expect("写 meta");

        let progress_seen = Arc::new(Mutex::new(Vec::new()));
        let progress_sink = progress_seen.clone();
        let request = DownloadRequest {
            allow_insecure: true,
            on_progress: Some(Box::new(move |progress| {
                progress_sink.lock().unwrap().push(progress.received);
            })),
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                expected_hex,
                target.clone(),
            )
        };
        let result = download_file(&request).await;
        server.abort();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.bytes, 1024, "总字节数应包含断点前的 300 字节");
        let on_disk = tokio::fs::read(&target).await.expect("文件应存在");
        assert_eq!(on_disk, full, "续传结果应与完整内容一致");
        let seen = progress_seen.lock().unwrap();
        assert!(
            seen.first().copied().unwrap_or(0) >= already_have,
            "进度应从断点位置起算：{:?}",
            seen.first()
        );
    }

    #[tokio::test]
    async fn discards_part_when_server_ignores_range() {
        let full = vec![7u8; 512];
        let server_body = full.clone();
        let expected_hex = hex::encode(sha2::Sha256::digest(&full));
        let (port, server) = spawn(Arc::new(move |_request| TestResponse {
            status: 200,
            headers: vec![],
            body: server_body.clone(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("ignore-range").await;
        let target = dir.join("pkg.zip");
        // 断点存在但服务器返回 200（忽略 Range）→ 必须从头写
        tokio::fs::write(dir.join("pkg.zip.part"), vec![9u8; 100])
            .await
            .expect("写 part");
        let request = DownloadRequest {
            allow_insecure: true,
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                expected_hex,
                target.clone(),
            )
        };
        let result = download_file(&request).await;
        server.abort();
        assert!(result.ok, "{:?}", result.error);
        let on_disk = tokio::fs::read(&target).await.expect("文件应存在");
        assert_eq!(on_disk, full, "200 响应应覆盖整个文件而不是拼接");
    }

    #[tokio::test]
    async fn retries_then_fails_on_checksum_mismatch() {
        let (port, server) = spawn(Arc::new(|_request| TestResponse {
            status: 200,
            headers: vec![],
            body: b"corrupted".to_vec(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("sha").await;
        let target = dir.join("pkg.zip");
        let request = DownloadRequest {
            allow_insecure: true,
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                hex::encode(sha2::Sha256::digest(b"expected")),
                target,
            )
        };
        let result = download_file(&request).await;
        server.abort();
        assert!(!result.ok);
        assert_eq!(
            result.attempts.len(),
            2,
            "默认重试 2 次：{:?}",
            result.attempts
        );
        assert!(result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("SHA-256 校验失败"));
        assert!(
            !dir.join("pkg.zip.part").exists(),
            "校验失败后 .part 应被清理"
        );
    }

    #[tokio::test]
    async fn size_mismatch_fails_before_verify() {
        let (port, server) = spawn(Arc::new(|_request| TestResponse {
            status: 200,
            headers: vec![],
            body: b"short".to_vec(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("size").await;
        let target = dir.join("pkg.zip");
        let mut request = DownloadRequest {
            allow_insecure: true,
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                hex::encode([0u8; 32]),
                target,
            )
        };
        // 直接声明 size_bytes = 100（服务器只给 5 字节）→ 大小检查先于校验失败
        request.size_bytes = Some(100);
        let result = download_file(&request).await;
        server.abort();
        assert!(!result.ok);
        assert!(
            result
                .error
                .as_deref()
                .unwrap_or("")
                .contains("文件大小不符"),
            "{}",
            result.error.unwrap_or_default()
        );
    }

    #[tokio::test]
    async fn slow_source_switches_to_faster_mirror() {
        let body = b"fast".to_vec();
        let expected_hex = hex::encode(sha2::Sha256::digest(&body));
        // 慢源：声明 1 MB 但只发 1 字节然后持住连接 —— 只有速度哨兵能识别这种情况
        let slow_response = TestResponse {
            status: 200,
            headers: vec![("content-length".to_string(), "1048576".to_string())],
            body: vec![b'x'],
            stall_ms: 15_000,
        };
        let (slow_port, slow_server) = spawn(Arc::new(move |_request| slow_response.clone())).await;
        let (fast_port, fast_server) = spawn(Arc::new(move |_request| TestResponse {
            status: 200,
            headers: vec![],
            body: body.clone(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("slow").await;
        let target = dir.join("pkg.zip");
        let request = DownloadRequest {
            allow_insecure: true,
            retries_per_source: Some(1),
            // 速度哨兵：宽限 200ms（检查间隔仍为生产值 4s，首次判定约 4 秒后触发）
            speed_grace_ms: Some(200),
            ..DownloadRequest::new(
                vec![
                    DownloadSource {
                        name: "slow".to_string(),
                        url: format!("http://127.0.0.1:{slow_port}/file"),
                    },
                    DownloadSource {
                        name: "fast".to_string(),
                        url: format!("http://127.0.0.1:{fast_port}/file"),
                    },
                ],
                expected_hex,
                target,
            )
        };
        let result = download_file(&request).await;
        slow_server.abort();
        fast_server.abort();
        assert!(result.ok, "{:?}", result.error);
        assert!(result
            .attempts
            .iter()
            .any(|attempt| attempt.source == "slow"));
        assert!(result.attempts.iter().any(|attempt| {
            attempt.source == "slow" && attempt.error.contains("下载速度只有")
        }));
    }

    #[tokio::test]
    async fn idle_timeout_triggers() {
        // 接到请求后不回响应、保持连接的"哑"服务器（响应头都等不到 → 空闲/超时路径）
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let silent_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 512];
                    // 读完请求头后故意不回应，保持连接
                    let _ = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buffer))
                        .await;
                    tokio::time::sleep(Duration::from_secs(10)).await;
                });
            }
        });

        let dir = temp_dir("idle").await;
        let target = dir.join("pkg.zip");
        let request = DownloadRequest {
            allow_insecure: true,
            idle_timeout_ms: Some(500),
            timeout_ms: Some(2_000),
            retries_per_source: Some(1),
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "silent".to_string(),
                    url: format!("http://127.0.0.1:{silent_port}/file"),
                }],
                hex::encode([0u8; 32]),
                target,
            )
        };
        let result = download_file(&request).await;
        assert!(!result.ok);
        assert!(
            result
                .error
                .as_deref()
                .unwrap_or("")
                .contains("所有下载源都失败了"),
            "{}",
            result.error.unwrap_or_default()
        );
    }

    #[tokio::test]
    async fn cancellation_aborts_download() {
        let body = b"cancel-me".to_vec();
        let server_body = body.clone();
        let expected_hex = hex::encode(sha2::Sha256::digest(&body));
        let (port, server) = spawn(Arc::new(move |_request| TestResponse {
            status: 200,
            headers: vec![],
            body: server_body.clone(),
            stall_ms: 0,
        }))
        .await;
        let dir = temp_dir("cancel").await;
        let target = dir.join("pkg.zip");
        let cancel = CancellationToken::new();
        let cancel_for_trigger = cancel.clone();
        let request = DownloadRequest {
            allow_insecure: true,
            on_progress: Some(Box::new(move |_progress| {
                cancel_for_trigger.cancel();
            })),
            cancel: Some(cancel),
            ..DownloadRequest::new(
                vec![DownloadSource {
                    name: "test".to_string(),
                    url: format!("http://127.0.0.1:{port}/file"),
                }],
                expected_hex,
                target,
            )
        };
        let result = download_file(&request).await;
        server.abort();
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("已取消"));
    }

    #[tokio::test]
    async fn rejects_non_https_sources() {
        let dir = temp_dir("https").await;
        let request = DownloadRequest::new(
            vec![DownloadSource {
                name: "insecure".to_string(),
                url: "http://example.com/file".to_string(),
            }],
            hex::encode([0u8; 32]),
            dir.join("pkg.zip"),
        );
        let result = download_file(&request).await;
        assert!(!result.ok);
        assert!(
            result
                .error
                .as_deref()
                .unwrap_or("")
                .contains("拒绝非 https 下载地址"),
            "{}",
            result.error.unwrap_or_default()
        );
    }

    #[tokio::test]
    async fn reuses_existing_verified_file() {
        let body = b"already-here".to_vec();
        let expected_hex = hex::encode(sha2::Sha256::digest(&body));
        let dir = temp_dir("reuse").await;
        let target = dir.join("pkg.zip");
        tokio::fs::write(&target, &body)
            .await
            .expect("预置目标文件");
        let request = DownloadRequest::new(
            vec![DownloadSource {
                name: "never".to_string(),
                url: "https://127.0.0.1:1/file".to_string(),
            }],
            expected_hex,
            target.clone(),
        );
        let result = download_file(&request).await;
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.bytes, body.len() as u64);
    }
}
