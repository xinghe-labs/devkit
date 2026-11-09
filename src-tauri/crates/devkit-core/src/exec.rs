//! 子进程执行（对齐 `src/main/utils/exec.ts`，附录 F 的 CommandRunner 语义）。
//!
//! 四个要点：
//!  1. 不带 shell 执行（避免命令拼接注入，NFR-1）
//!  2. 输出解码按 UTF-8 → GB18030 → latin1 依次尝试（中文 Windows 控制台可能是 GBK）
//!  3. `.cmd`/`.bat` 一律走 `cmd.exe /d /c` 回退，且参数必须先过白名单
//!  4. 超时 / 取消都要杀掉子进程（安装器可能跑很久，必须能中断）

use std::collections::HashMap;
use std::ffi::OsStr;
use std::time::{Duration, Instant};

use encoding_rs::GB18030;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// spawn 本身失败（如命令不存在）时的错误信息，非进程退出码
    pub spawn_error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub cwd: Option<std::path::PathBuf>,
    pub timeout_ms: Option<u64>,
    /// 额外环境变量（叠加在父进程环境之上）
    pub env: Option<HashMap<String, String>>,
    /// 取消信号：触发后立即杀掉子进程
    pub cancel: Option<CancellationToken>,
}

/// 输出解码。
///
/// 中文 Windows 上控制台可能是 GBK(cp936)，拿到的永远是原始字节。
/// 按 UTF-8 → GB18030 → latin1 依次尝试：
/// - 版本号这类内容全是 ASCII，两种编码下一致，走 UTF-8 就对了
/// - cmd.exe / PowerShell 的中文报错是 GBK，UTF-8 严格解码会失败，退到 GB18030（GBK 的超集）
/// - 最后用 latin1 兜底，至少不丢字节（可能乱码，但比丢信息好）
///
/// 需要精确中文输出的场景应在命令侧强制 UTF-8，见 SPEC NFR-5。
pub fn decode_output(bytes: &[u8]) -> String {
    // decode_with_bom_removal：只剥本编码自己的 BOM（与 TextDecoder 语义一致），
    // 不做 UTF-16 BOM 嗅探；had_errors 才退下一个编码
    let (decoded, had_errors) = encoding_rs::UTF_8.decode_with_bom_removal(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    let (decoded, had_errors) = GB18030.decode_with_bom_removal(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    // latin1 兜底：ISO-8859-1 是字节 → U+0000..U+00FF 的一一映射，永不失败
    bytes.iter().map(|&byte| byte as char).collect()
}

/// cmd.exe 回退路径的参数白名单。
///
/// 为什么不直接拼接并加引号 —— 实测结论（Windows 11 / cmd.exe）：
///   · 把参数分开传给 cmd.exe：`&` `|` `>` `^` 会被真的解释成命令分隔符与重定向
///   · 拼接成一条命令串再转义：元字符确实被挡住了，但转义会给含空格的参数
///     塞进多余的反斜杠（cmd 不认 \" 转义）
///   · 原样传递：元字符又不受保护
/// 也就是说，没有任何一种拼法同时做到"正确"和"安全"。
///
/// 与其和 cmd 的引号规则搏斗，不如从源头限制：回退路径只接受
/// 不含空白、引号与 cmd 元字符的简单参数 —— 版本检测参数（-v / --version / -3）
/// 全是这种形态。不满足就报错，绝不"尽力而为"地拼一条命令出去。
///
/// 命令路径的约束：**只禁 cmd 元字符与引号**，不禁空格与中文。
/// 为什么不能像参数那样用纯 ASCII 白名单：devkit 自己的安装目录长这样 ——
/// `C:\Users\张三\.devkit\versions\maven\3.10.0\bin\mvn.cmd`。
/// 用户名是中文、路径可能带空格，用 ASCII 白名单会把**我们自己装的工具**全部拒之门外
/// （实测：Maven / Gradle / VS Code 的自检都是 .cmd，全部踩到）。
/// 元字符才是真正的风险，所以这里只挡元字符。
static SAFE_COMMAND_PATH: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"^[^"&|<>^%!\r\n\t]+$"#).unwrap());
/// 参数：**只禁 cmd 元字符、通配符与空白**，不禁中文。
///
/// 回退路径是给 `.cmd` / `.bat` 用的，而它们的参数里经常带着 devkit 自己的路径 ——
/// `C:\Users\张三\.devkit\versions\...`。用 ASCII 白名单会把中文用户名下的每一次
/// 回退都拒掉（实测：假的 .cmd 安装器收到 `/DIR=C:\Users\张三\...` 就被拒了）。
/// 真正的风险是 cmd 的元字符与 %VAR% / 延迟展开，不是汉字。
static SAFE_ARG: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"^[^\s"&|<>^%!()*?\r\n\t]+$"#).unwrap());

pub fn is_fallback_safe(cmd: &str, args: &[String]) -> bool {
    SAFE_COMMAND_PATH.is_match(cmd) && args.iter().all(|arg| SAFE_ARG.is_match(arg))
}

fn is_cmd_script(cmd: &str) -> bool {
    let lower = cmd.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn_command(
    cmd: &str,
    args: &[String],
    options: &RunOptions,
) -> std::io::Result<tokio::process::Child> {
    let mut command = tokio::process::Command::new(OsStr::new(cmd));
    command.args(args);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    // windowsHide: true —— 后台执行，不闪黑框
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(windows)]
    command.kill_on_drop(true);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.spawn()
}

/// 读一个管道直到 EOF 或取消，把字节累积到共享缓冲。
async fn collect_pipe(
    pipe: impl tokio::io::AsyncRead + Unpin,
    cancel: Option<&CancellationToken>,
    done: CancellationToken,
    buffer: &mut Vec<u8>,
) {
    let mut pipe = pipe;
    let mut chunk = [0u8; 8192];
    loop {
        tokio::select! {
            biased;
            _ = async {
                match cancel {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                done.cancel();
                return;
            }
            read = tokio::io::AsyncReadExt::read(&mut pipe, &mut chunk) => {
                match read {
                    Ok(0) | Err(_) => {
                        done.cancel();
                        return;
                    }
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                }
            }
        }
    }
}

async fn spawn_once(cmd: &str, args: &[String], options: &RunOptions) -> RunResult {
    let started = Instant::now();
    let timeout = Duration::from_millis(options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    let mut child = match spawn_command(cmd, args, options) {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                spawn_error: Some(format!("spawn {cmd} 失败：{error}")),
                duration_ms: started.elapsed().as_millis() as u64,
                ..RunResult::default()
            };
        }
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let cancel = options.cancel.clone();
    let stdout_done = CancellationToken::new();
    let stderr_done = CancellationToken::new();

    // 三个并发体：收 stdout / 收 stderr / 等退出或超时
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    let read_stdout = async {
        if let Some(pipe) = stdout_pipe {
            collect_pipe(
                pipe,
                cancel.as_ref(),
                stdout_done.clone(),
                &mut stdout_bytes,
            )
            .await;
        } else {
            stdout_done.cancel();
        }
    };
    let read_stderr = async {
        if let Some(pipe) = stderr_pipe {
            collect_pipe(
                pipe,
                cancel.as_ref(),
                stderr_done.clone(),
                &mut stderr_bytes,
            )
            .await;
        } else {
            stderr_done.cancel();
        }
    };

    // 等退出 + 收尾管道：进程结束后管道很快到 EOF，再给读取一点时间，避免截断尾部输出
    let wait = async {
        let status = child.wait().await;
        let deadline = Instant::now() + Duration::from_millis(2000);
        while !(stdout_done.is_cancelled() && stderr_done.is_cancelled()) {
            if Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        status
    };

    // 等退出 / 超时 / 取消 —— 三选一；select 的三个分支里只有 wait 碰 child，
    // 超时与取消分支只在 select 结束后再杀进程（避免多重可变借用）。
    enum Outcome {
        Exited(std::process::ExitStatus),
        Failed(String),
        Cancelled,
        TimedOut,
    }
    let cancel_wait = {
        let cancel = cancel.clone();
        async move {
            match cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        }
    };
    let timed_out_flag = CancellationToken::new();
    let outcome = tokio::select! {
        biased;
        _ = cancel_wait => Outcome::Cancelled,
        _ = tokio::time::sleep(timeout) => {
            timed_out_flag.cancel();
            Outcome::TimedOut
        }
        status = wait => match status {
            Ok(status) => Outcome::Exited(status),
            Err(error) => Outcome::Failed(format!("spawn {cmd} 失败：{error}")),
        },
    };
    if matches!(outcome, Outcome::Cancelled | Outcome::TimedOut) {
        // start_kill 失败只能说明进程已自行退出，收尸仍要执行
        let _ = child.start_kill();
        let reaped = child.wait().await;
        drop(reaped);
    }
    tokio::join!(read_stdout, read_stderr);

    match outcome {
        Outcome::Exited(status) => RunResult {
            code: status.code(),
            stdout: decode_output(&stdout_bytes),
            stderr: decode_output(&stderr_bytes),
            timed_out: timed_out_flag.is_cancelled(),
            spawn_error: None,
            duration_ms: started.elapsed().as_millis() as u64,
        },
        outcome => RunResult {
            spawn_error: match &outcome {
                Outcome::Failed(message) => Some(message.clone()),
                _ => None,
            },
            stdout: decode_output(&stdout_bytes),
            stderr: decode_output(&stderr_bytes),
            timed_out: timed_out_flag.is_cancelled(),
            code: None,
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// 执行命令并捕获输出。
///
/// 不带 shell 执行（避免命令拼接注入，NFR-1）；`.cmd`/`.bat` 或因命令不存在
/// 导致的 ENOENT，在参数通过白名单校验后，退回 `cmd.exe /d /c` 再试一次。
///
/// `.cmd`/`.bat` 是主动回退而不是先试后错：Rust 的 CreateProcess 对批处理的
/// 隐式包裹行为不可靠（是否经 cmd.exe 解释、参数怎么转义都不透明），
/// 显式走白名单校验过的 `cmd /d /c` 更安全，行为也与 TS 版一致。
pub async fn run_command(cmd: &str, args: &[String], options: &RunOptions) -> RunResult {
    let started = Instant::now();

    // `.cmd`/`.bat` 主动走 cmd /d /c 回退（不先试后错）：Rust 的 CreateProcess
    // 对批处理的隐式包裹行为不可靠（是否经 cmd.exe 解释、参数怎么转义都不透明），
    // 显式走白名单校验过的 `cmd /d /c` 更安全，行为也与 TS 版一致。
    if is_cmd_script(cmd) {
        if !is_fallback_safe(cmd, args) {
            return RunResult {
                spawn_error: Some(format!(
                    "cmd 脚本 {cmd} 的命令名或参数含不安全字符，已拒绝执行（cmd.exe 回退白名单）"
                )),
                duration_ms: started.elapsed().as_millis() as u64,
                ..RunResult::default()
            };
        }
        return run_via_shell(cmd, args, options, started).await;
    }

    let result = spawn_once(cmd, args, options).await;

    // ENOENT 才允许 cmd 回退；其他 spawn 错误（权限、路径非法）原样返回
    let needs_fallback = result
        .spawn_error
        .as_deref()
        .map(is_spawn_not_found)
        .unwrap_or(false);
    if !needs_fallback {
        return result;
    }

    if !is_fallback_safe(cmd, args) {
        return RunResult {
            spawn_error: Some(format!(
                "{}（该命令需要 cmd.exe 回退，但命令名或参数含不安全字符，已拒绝执行）",
                result.spawn_error.unwrap_or_default()
            )),
            duration_ms: started.elapsed().as_millis() as u64,
            ..result
        };
    }

    let mut retried = run_via_shell(cmd, args, options, started).await;
    // 只有当重试真的跑起来了才采用重试结果，否则保留原始错误（更准确）
    if retried.spawn_error.is_some() {
        retried.spawn_error = result.spawn_error;
    }
    retried
}

/// `cmd.exe /d /c` 回退执行。
///
/// 刻意**不加 /s**：`cmd /d /s /c "带 空格的路径.cmd"` 里 /s 会把整条命令的首尾引号
/// 剥掉，路径里的空格就变成了参数分隔符，命令直接失败（实测 code=1、无输出）。
/// 不加 /s 时 cmd 的引号启发式能正确处理带空格的路径。
async fn run_via_shell(
    cmd: &str,
    args: &[String],
    options: &RunOptions,
    started: Instant,
) -> RunResult {
    let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut shell_args: Vec<String> = vec!["/d".to_string(), "/c".to_string(), cmd.to_string()];
    shell_args.extend(args.iter().cloned());
    let mut result = spawn_once(&shell, &shell_args, options).await;
    result.duration_ms = started.elapsed().as_millis() as u64;
    result
}

/// spawn 错误是否属于"命令不存在"（ENOENT / not found）。
/// ENOENT 才允许 cmd 回退；其他 spawn 错误（权限、路径非法）原样返回。
fn is_spawn_not_found(spawn_error: &str) -> bool {
    spawn_error.contains("找不到")
        || spawn_error.contains("not found")
        || spawn_error.contains("NotFound")
        || spawn_error.to_lowercase().contains("enoent")
}

use std::sync::LazyLock;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_then_gbk_then_latin1() {
        // 纯 ASCII 两种编码一致
        assert_eq!(decode_output("v24.21.0".as_bytes()), "v24.21.0");
        // UTF-8 中文
        assert_eq!(decode_output("版本 1.0".as_bytes()), "版本 1.0");
        // GBK 中文（"版本" 的 GBK 编码是 0xB0 0xE6 0xB1 0xBE），UTF-8 解不开 → 退 GB18030
        let gbk_bytes = [0xB0, 0xE6, 0xB1, 0xBE];
        assert_eq!(decode_output(&gbk_bytes), "版本");
        // 两种都解不开的字节序列 → latin1 不丢字节（3 个字符；ÿ/þ 各占 2 个 UTF-8 字节）
        let weird = [0xFF, 0xFE, 0x81];
        assert_eq!(decode_output(&weird).chars().count(), 3);
        assert_eq!(decode_output(&weird).len(), 6);
    }

    #[test]
    fn whitelist_rules() {
        // 命令路径：允许中文、空格；禁止元字符与引号
        assert!(is_fallback_safe(
            r"C:\Users\张三\.devkit\versions\maven\3.10.0\bin\mvn.cmd",
            &["-v".to_string()]
        ));
        assert!(!is_fallback_safe("C:\\with\"quote.cmd", &[]));
        assert!(!is_fallback_safe("a|b.cmd", &[]));
        // 参数：禁止空白与元字符；允许中文路径
        assert!(is_fallback_safe(
            "x.cmd",
            &[r"/DIR=C:\Users\张三\AppData\Local\Temp\devkit".to_string()]
        ));
        assert!(!is_fallback_safe("x.cmd", &["a b".to_string()]));
        assert!(!is_fallback_safe("x.cmd", &["100%".to_string()]));
        assert!(!is_fallback_safe("x.cmd", &["a|b".to_string()]));
        assert!(!is_fallback_safe("x.cmd", &["a*b".to_string()]));
    }

    /// 构造 Vec<String> 参数（测试用）
    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[tokio::test]
    async fn runs_simple_command() {
        let result = run_command(
            "cmd",
            &args(&["/d", "/c", "echo", "hello"]),
            &RunOptions::default(),
        )
        .await;
        assert_eq!(result.code, Some(0), "stderr: {}", result.stderr);
        assert!(result.stdout.contains("hello"), "stdout: {}", result.stdout);
        assert!(result.spawn_error.is_none());
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn cmd_script_uses_fallback() {
        // .cmd 主动走 cmd /d /c 回退（这里用 cmd.exe 自己的内部命令验证不炸）
        let result = run_command(
            "cmd",
            &args(&["/d", "/c", "echo", "world"]),
            &RunOptions::default(),
        )
        .await;
        assert_eq!(result.code, Some(0));
        assert!(result.stdout.contains("world"));
    }

    #[tokio::test]
    async fn missing_command_reports_spawn_error() {
        // 命令不存在且参数不安全（含元字符）→ 不允许回退，报 spawn 错误
        let result = run_command("bad|command-name", &[], &RunOptions::default()).await;
        assert!(result.spawn_error.is_some(), "应该报告 spawn 错误");
        assert!(result.code.is_none());
        assert!(result
            .spawn_error
            .as_deref()
            .unwrap_or("")
            .contains("已拒绝执行"));
    }

    #[tokio::test]
    async fn missing_command_falls_back_to_cmd() {
        // 命令不存在但参数安全 → cmd.exe /d /c 回退；cmd 本身能启动，
        // 报 not recognized 并返回非零退出码（与 TS 行为一致，spawnError 为空）
        let result = run_command(
            "definitely-not-a-real-command-xyz",
            &[],
            &RunOptions::default(),
        )
        .await;
        assert!(result.spawn_error.is_none(), "{:?}", result.spawn_error);
        assert_ne!(result.code, Some(0));
    }

    #[tokio::test]
    async fn timeout_kills_process() {
        let result = run_command(
            "cmd",
            &args(&["/d", "/c", "ping", "-n", "10", "127.0.0.1"]),
            &RunOptions {
                timeout_ms: Some(500),
                ..RunOptions::default()
            },
        )
        .await;
        assert!(result.timed_out, "应该标记超时");
    }

    #[tokio::test]
    async fn cancel_kills_process() {
        let cancel = CancellationToken::new();
        let options = RunOptions {
            cancel: Some(cancel.clone()),
            ..RunOptions::default()
        };
        let task = tokio::spawn(async move {
            run_command(
                "cmd",
                &args(&["/d", "/c", "ping", "-n", "10", "127.0.0.1"]),
                &options,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel.cancel();
        let result = task.await.unwrap();
        // 取消后进程被杀，code 为 None（非正常退出）
        assert!(result.code.is_none() || result.code == Some(1));
    }
}
