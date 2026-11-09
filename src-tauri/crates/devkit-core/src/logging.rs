//! 日志器（镜像 `src/main/core/report/logger.ts`，决策 D5：手写 ~80 行，不用 tracing）。
//!
//! 同时落文件（UTF-8 append）与推送给渲染进程（broadcast 通道）。
//! 内存环形缓冲 3000 条，`tail(count)` 只读缓冲（不读文件，附录 C.2）。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use devkit_types::update::{LogEntry, LogLevel};
use tokio::sync::broadcast;

const LEVEL_LABEL: fn(LogLevel) -> &'static str = |level| match level {
    LogLevel::Debug => "DEBUG",
    LogLevel::Info => "INFO ",
    LogLevel::Warn => "WARN ",
    LogLevel::Error => "ERROR",
};

const MAX_BUFFER: usize = 3000;

struct Inner {
    file: Option<Mutex<File>>,
    path: PathBuf,
    buffer: Mutex<VecDeque<LogEntry>>,
    sender: broadcast::Sender<LogEntry>,
}

/// 日志器。通过 [`global`] 拿单例；`init` 由 app 启动时注入日志目录（不依赖 Tauri）。
pub struct Logger {
    inner: OnceLock<Inner>,
}

impl Logger {
    // const fn 而非 derive(Default)：Logger 用 OnceLock 延迟初始化，global() 才是唯一入口
    #[allow(clippy::new_without_default)]
    pub const fn new() -> Self {
        Self {
            inner: OnceLock::new(),
        }
    }

    /// 初始化：确保目录存在，打开 `<logDir>/<timestampSlug>.log`（append）。
    /// 返回日志文件全路径。重复调用是空操作（返回当前文件）。
    pub fn init(&self, log_dir: &Path) -> String {
        if let Some(existing) = self.inner.get() {
            return existing.path.to_string_lossy().into_owned();
        }
        let _ = std::fs::create_dir_all(log_dir);
        let path = log_dir.join(format!("{}.log", timestamp_slug()));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let (sender, _) = broadcast::channel(256);
        let inner = Inner {
            file: file.map(Mutex::new),
            path,
            buffer: Mutex::new(VecDeque::with_capacity(MAX_BUFFER)),
            sender,
        };
        let opened = inner.path.to_string_lossy().into_owned();
        let _ = self.inner.set(inner);
        opened
    }

    /// 当前日志文件路径（未 init 时为空串）。
    pub fn current_file(&self) -> String {
        self.inner
            .get()
            .map(|inner| inner.path.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn write(&self, level: LogLevel, scope: &str, message: &str) -> LogEntry {
        let entry = LogEntry {
            ts: devkit_types::timeutil::iso8601_now(),
            level,
            scope: scope.to_string(),
            message: message.to_string(),
        };
        if let Some(inner) = self.inner.get() {
            // 环形缓冲（3000 条）
            if let Ok(mut buffer) = inner.buffer.lock() {
                buffer.push_back(entry.clone());
                while buffer.len() > MAX_BUFFER {
                    buffer.pop_front();
                }
            }
            // 落盘（append；写失败不 panic —— 日志不能反过来弄挂安装流程）
            if let Some(file) = &inner.file {
                if let Ok(mut handle) = file.lock() {
                    let line = format!(
                        "[{}] [{}] [{}] {}\n",
                        entry.ts,
                        LEVEL_LABEL(level),
                        scope,
                        message
                    );
                    let _ = handle.write_all(line.as_bytes());
                }
            }
            // 实时推送（没有订阅者时 send 返回 Err，忽略）
            let _ = inner.sender.send(entry.clone());
        }
        entry
    }

    pub fn log(&self, level: LogLevel, scope: &str, message: &str) {
        self.write(level, scope, message);
    }

    pub fn debug(&self, scope: &str, message: &str) {
        self.write(LogLevel::Debug, scope, message);
    }

    pub fn info(&self, scope: &str, message: &str) {
        self.write(LogLevel::Info, scope, message);
    }

    pub fn warn(&self, scope: &str, message: &str) {
        self.write(LogLevel::Warn, scope, message);
    }

    pub fn error(&self, scope: &str, message: &str) {
        self.write(LogLevel::Error, scope, message);
    }

    /// 读取最近 n 条（渲染进程启动时回填历史日志用）。
    pub fn tail(&self, count: usize) -> Vec<LogEntry> {
        let Some(inner) = self.inner.get() else {
            return Vec::new();
        };
        let Ok(buffer) = inner.buffer.lock() else {
            return Vec::new();
        };
        let size = count.min(buffer.len());
        buffer.iter().skip(buffer.len() - size).cloned().collect()
    }

    /// 订阅新日志（`log-line` 推送源）。返回接收端；每个接收端独立。
    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.inner
            .get()
            .map(|inner| inner.sender.subscribe())
            .expect("logger 未初始化就订阅 —— 先 init()")
    }
}

/// 全局日志器单例（对齐 TS `export const logger`）。
pub fn global() -> &'static Logger {
    static LOGGER: Logger = Logger::new();
    &LOGGER
}

/// 生成 "20261010-043000" 形式的时间戳，用于日志文件名。
///
/// 偏离记录：TS `timestampSlug()` 用**本地时区**；Rust 复用 plan.rs 的 UTC civil 算法。
/// 文件名只求唯一与可读，不影响任何功能语义。
pub fn timestamp_slug() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let iso = devkit_types::timeutil::iso8601_from_unix(now.as_secs() as i64, 0);
    // "2026-10-10T04:30:00.000Z" → "20261010-043000"
    let cleaned: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    // cleaned = YYYYMMDDHHMMSSmmm；毫秒固定 3 位，取前 14 位
    cleaned[..14]
        .chars()
        .take(8)
        .chain(['-'])
        .chain(cleaned[8..14].chars())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("devkit-logging-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn writes_to_file_and_buffer_and_channel() {
        let logger = Logger::new();
        let path = logger.init(&temp_dir("basic"));
        assert!(Path::new(&path).exists(), "init 即建文件");

        let mut rx = logger.subscribe();

        logger.info("settings", "界面语言切换为 zh-CN");
        logger.warn("detect", "注册表扫描失败");
        logger.error("ipc", "通道执行失败");

        let entries = logger.tail(10);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].level, LogLevel::Info);
        assert_eq!(entries[0].scope, "settings");
        assert_eq!(entries[0].message, "界面语言切换为 zh-CN");
        assert_eq!(entries[2].level, LogLevel::Error);

        // 实时推送
        let received = rx.try_recv().expect("应有实时推送");
        assert_eq!(received.message, "界面语言切换为 zh-CN");

        // 文件内容：行格式 `[ts] [LEVEL ] [scope] message`
        let body = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("[INFO ] [settings] 界面语言切换为 zh-CN"));
        assert!(lines[1].contains("[WARN ] [detect]"));
        assert!(lines[2].contains("[ERROR] [ipc]"));
    }

    #[test]
    fn ring_buffer_caps_at_3000() {
        let logger = Logger::new();
        logger.init(&temp_dir("ring"));
        for i in 0..3100 {
            logger.debug("ring", &format!("line {i}"));
        }
        let entries = logger.tail(3000);
        assert_eq!(entries.len(), 3000);
        assert_eq!(entries[0].message, "line 100", "最旧的 100 条被挤出");
        assert_eq!(entries[2999].message, "line 3099");
        // tail 超量请求被截断
        assert_eq!(logger.tail(5000).len(), 3000);
    }

    #[test]
    fn tail_before_init_is_empty() {
        let logger = Logger::new();
        assert!(logger.tail(10).is_empty());
        assert_eq!(logger.current_file(), "");
    }

    #[test]
    fn global_logger_is_singleton() {
        let first = global().init(&temp_dir("global"));
        let second = global().init(&temp_dir("global-again"));
        assert_eq!(first, second, "重复 init 不换文件");
        assert_eq!(global().current_file(), first);
    }

    #[test]
    fn slow_subscriber_does_not_block_logging() {
        let logger = Logger::new();
        logger.init(&temp_dir("broadcast"));
        let rx = logger.subscribe();
        drop(rx); // 没有订阅者也不能报错
        logger.info("app", "no listener");
        // 堵满通道的接收端也不阻塞（broadcast 满了 send 只是 Err）
        let held = logger.subscribe();
        std::mem::forget(held);
        for i in 0..400 {
            logger.info("app", &format!("flood {i}"));
        }
        assert!(logger.tail(1).len() == 1);
    }

    #[test]
    fn timestamp_slug_shape() {
        let slug = timestamp_slug();
        assert_eq!(slug.len(), 15, "YYYYMMDD-HHMMSS：{slug}");
        assert!(slug[..8].chars().all(|c| c.is_ascii_digit()));
        assert!(slug.as_bytes()[8] == b'-');
        assert!(slug[9..].chars().all(|c| c.is_ascii_digit()));
        let _ = Arc::new(());
    }
}
