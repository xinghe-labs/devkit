//! 最小 HTTPS 客户端（对应 TS `core/downloader/http.ts`）。
//!
//! TS 版用 node:https + CONNECT 隧道自写；Rust 侧等价物是 reqwest（rustls）。
//! 语义必须逐条保留：
//! - 重定向自己控制（Policy::none），才能执行「拒绝 https → http 降级」检查；
//! - 超时语义 = 等待响应头的超时（不是整个 body 的时长，大文件慢速下载不能被误杀）；
//! - 代理只支持 `http://`（本地代理软件的常见形态，CONNECT 隧道）；
//! - `allow_insecure` 仅测试用：允许 `http://` 源与 http 重定向。生产一律 https。

use std::collections::HashMap;
use std::time::Duration;

use futures::Stream;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct HttpError {
    pub message: String,
    pub status: Option<u16>,
}

impl HttpError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HttpRequestOptions {
    pub headers: Vec<(String, String)>,
    /// 预检探测源可达性时用 HEAD，避免真下载
    pub method: HttpMethod,
    /// 形如 http://127.0.0.1:7890。只支持 http 代理（CONNECT 隧道）
    pub proxy: Option<String>,
    /// 等待响应头的超时（毫秒）
    pub timeout_ms: Option<u64>,
    pub cancel: Option<CancellationToken>,
    pub max_redirects: Option<usize>,
    /// 仅测试用：允许 http:// 地址与 http 重定向。生产环境一律 https
    pub allow_insecure: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HttpMethod {
    #[default]
    Get,
    Head,
}

pub type ByteStream = std::pin::Pin<Box<dyn Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;

pub struct StreamResponse {
    pub status: u16,
    /// 小写键名（对齐 Node `IncomingMessage.headers`）
    pub headers: HashMap<String, String>,
    pub stream: ByteStream,
    /// 跟随重定向后的最终 URL
    pub final_url: String,
}

impl std::fmt::Debug for StreamResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StreamResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("final_url", &self.final_url)
            .finish()
    }
}

/// 是否允许跟随这个重定向。
///
/// 抽成纯函数是为了能单测：https → http 的降级跟随会让「能改 http 响应的人」
/// 替换掉下载内容与热更新索引（安全审查 M1）。生产环境一律不允许降级。
pub fn should_follow_redirect(
    current: &reqwest::Url,
    next: &reqwest::Url,
    allow_insecure: bool,
) -> bool {
    if allow_insecure {
        return true;
    }
    if current.scheme() == "https" && next.scheme() != "https" {
        return false;
    }
    next.scheme() == "https" || current.scheme() == next.scheme()
}

fn build_client(
    options: &HttpRequestOptions,
    timeout_ms: u64,
) -> Result<reqwest::Client, HttpError> {
    let mut builder = reqwest::Client::builder()
        // 重定向由本模块的循环控制（要做降级检查与次数上限）
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(timeout_ms))
        .no_proxy();

    if let Some(proxy) = &options.proxy {
        let proxy_url = reqwest::Url::parse(proxy)
            .map_err(|error| HttpError::new(format!("代理地址不合法：{error}")))?;
        if proxy_url.scheme() != "http" {
            return Err(HttpError::new(format!(
                "暂不支持 {} 代理，请使用 http:// 代理",
                proxy_url.scheme()
            )));
        }
        let configured = reqwest::Proxy::http(proxy_url)
            .map_err(|error| HttpError::new(format!("代理配置失败：{error}")))?;
        builder = builder.proxy(configured);
    }

    builder
        .build()
        .map_err(|error| HttpError::new(format!("HTTP 客户端构建失败：{error}")))
}

/// 发起 GET/HEAD 请求并返回响应流，自动跟随重定向。调用方负责消费或丢弃返回的 stream。
pub async fn request_stream(
    raw_url: &str,
    options: &HttpRequestOptions,
) -> Result<StreamResponse, HttpError> {
    let timeout_ms = options.timeout_ms.unwrap_or(30_000);
    let max_redirects = options.max_redirects.unwrap_or(5);
    let mut current = reqwest::Url::parse(raw_url)
        .map_err(|error| HttpError::new(format!("下载地址不合法：{error}")))?;

    for hop in 0..=max_redirects {
        if let Some(cancel) = &options.cancel {
            if cancel.is_cancelled() {
                return Err(HttpError::new("请求已取消"));
            }
        }

        let client = build_client(options, timeout_ms)?;
        let method = match options.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Head => reqwest::Method::HEAD,
        };
        let mut request = client.request(method, current.clone());
        for (key, value) in &options.headers {
            request = request.header(key, value);
        }
        // 对齐 TS：Connection: close（reqwest 自带连接池管理，此处无需复刻，但保留语义等价的头）
        request = request.header("connection", "close");

        let cancel = options.cancel.clone();
        let wait = tokio::time::timeout(Duration::from_millis(timeout_ms), request.send());
        let response = match wait.await {
            Ok(result) => result,
            Err(_elapsed) => {
                return Err(HttpError::new(format!("等待响应超时（{timeout_ms}ms）")));
            }
        };

        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                if let Some(cancel) = &cancel {
                    if cancel.is_cancelled() {
                        return Err(HttpError::new("请求已取消"));
                    }
                }
                return Err(HttpError::new(format!("请求失败：{error}")));
            }
        };

        let status = response.status().as_u16();
        let mut headers: HashMap<String, String> = HashMap::new();
        for (name, value) in response.headers().iter() {
            let key = name.as_str().to_ascii_lowercase();
            let value = value.to_str().unwrap_or("").to_string();
            headers
                .entry(key)
                .and_modify(|existing| {
                    // 多个同名头合并（Node 的 headers.location 等也如此展示）
                    if !existing.is_empty() {
                        existing.push_str(", ");
                    }
                    existing.push_str(&value);
                })
                .or_insert(value);
        }

        let location = headers.get("location").cloned();
        let is_redirect = (300..400).contains(&status) && location.is_some();
        if !is_redirect {
            // 立刻读出 body 流（reqwest 的 bytes_stream），response 返回后仍可消费
            let stream = response.bytes_stream();
            return Ok(StreamResponse {
                status,
                headers,
                stream: Box::pin(stream),
                final_url: current.to_string(),
            });
        }

        // 跟随重定向：先释放当前连接，避免 socket 泄漏（body 直接丢弃）
        let _ = response.chunk().await;
        drop(response);
        if hop == max_redirects {
            return Err(HttpError {
                message: format!("重定向次数超过上限（{max_redirects}）"),
                status: Some(status),
            });
        }

        let next = current
            .join(location.as_deref().unwrap_or(""))
            .map_err(|error| HttpError::new(format!("重定向地址不合法：{error}")))?;
        if !should_follow_redirect(&current, &next, options.allow_insecure) {
            return Err(HttpError::new(format!(
                "拒绝跟随降级到 {} 的重定向：{next}",
                next.scheme()
            )));
        }
        current = next;
    }

    Err(HttpError::new("重定向处理异常"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> reqwest::Url {
        reqwest::Url::parse(value).unwrap()
    }

    #[test]
    fn rejects_https_to_http_downgrade() {
        assert!(!should_follow_redirect(
            &url("https://a.example.com/x"),
            &url("http://a.example.com/x"),
            false
        ));
        assert!(should_follow_redirect(
            &url("https://a.example.com/x"),
            &url("https://b.example.com/y"),
            false
        ));
        assert!(should_follow_redirect(
            &url("https://a.example.com/x"),
            &url("http://b.example.com/y"),
            true
        ));
    }

    #[tokio::test]
    async fn rejects_non_http_proxy_scheme() {
        let options = HttpRequestOptions {
            proxy: Some("socks5://127.0.0.1:1080".to_string()),
            ..Default::default()
        };
        let error = request_stream("https://example.com/file", &options)
            .await
            .expect_err("socks 代理应被拒绝");
        assert!(
            error.message.contains("暂不支持 socks5 代理"),
            "{}",
            error.message
        );
    }
}
