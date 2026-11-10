//! 提权助手脚本（镜像 `src/main/core/elevation/helper-script.ts`，SPEC §6.6）。
//!
//! 设计取舍：
//!  · **不整程序提权**：整程序以管理员运行时，拖拽、默认浏览器、用户目录都变了
//!  · **一次 UAC 干完所有事**：所有需要管理员的步骤打包，由**一个**提升后的
//!    PowerShell 进程顺序执行完
//!
//! ## 为什么不落盘（重要）
//!
//! 以前的做法是把助手脚本与作业文件写进 `%APPDATA%\devkit\elevation`，再让提权进程
//! 去读它们。**那是完整的提权漏洞**：那个目录**用户可写**，而提权进程会**执行**里面的
//! 脚本 —— 同机器上任何低权限进程都能在用户点 UAC 之前换掉内容，以管理员身份执行
//! 任意命令。
//!
//! 修法是**不经过文件**：助手脚本与作业数据一起内联进
//! `powershell -EncodedCommand <UTF-16LE base64>`，提权进程除了命令行什么都不读。
//! 结果文件落在用户可写目录，但带随机 nonce，主进程会校验。

use serde::{Deserialize, Serialize};

/// 一条提权作业里的单个步骤（镜像 TS ElevationStep）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ElevationJobStep {
    Exec {
        label: String,
        cmd: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "timeoutMs")]
        timeout_ms: Option<u64>,
        /// 执行前要求该文件（cmd）的 SHA-256 等于这个值。
        ///
        /// 为什么必须在提权进程里再算一次：安装包放在用户可写的 downloads 目录，
        /// 下载时校验过之后，低权限进程仍有机会把它换掉，再等用户为"devkit 安装"
        /// 点 UAC —— 那就是以管理员身份执行攻击者的二进制（安全审查 H3）。
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "verifySha256"
        )]
        verify_sha256: Option<String>,
    },
    #[serde(rename = "restore-point")]
    RestorePoint { label: String, description: String },
    #[serde(rename = "set-machine-path")]
    SetMachinePath {
        label: String,
        /// 完整的新 PATH 值（由调用方算好，助手只负责写）
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub label: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationJobOutcome {
    pub ok: bool,
    /// true = 本次确实走了提权路径（会弹 UAC）
    pub elevated: bool,
    /// 用户取消了 UAC 授权
    pub cancelled: bool,
    pub steps: Vec<StepResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 助手脚本（与 TS 版逐字一致 —— 提权脚本必须可读可审计）。
pub const ELEVATION_HELPER_SCRIPT: &str = r#"# devkit 提权助手（由 devkit 生成，可读可审计）
#
# 通过 -EncodedCommand 内联执行，**不从磁盘读任何东西**。
# 调用方需先注入这三个变量：$JobJson（作业 JSON 文本）、$ResultFile、$Nonce。
#
# 为什么不读文件：那个目录用户可写，而本脚本以管理员身份运行 ——
# 读用户可写的文件等于把管理员权限交给同机器上的任何低权限进程。

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Result($jobId, $ok, $steps, $error) {
  # nonce 由主进程随机生成并只通过命令行传进来。
  # 结果文件落在用户可写目录，带上它之后，主进程能识别出"这份结果不是本次作业写的"。
  $payload = @{ jobId = $jobId; nonce = $Nonce; ok = $ok; steps = $steps; error = $error } | ConvertTo-Json -Depth 6
  # 用不带 BOM 的 UTF-8：Node 的 JSON.parse 见到 BOM 会直接报 "Unexpected token"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ResultFile, $payload, $utf8NoBom)
}

$jobId = 'unknown'
$results = @()

try {
  $job = $JobJson | ConvertFrom-Json
  $jobId = [string]$job.jobId

  foreach ($step in $job.steps) {
    $label = [string]$step.label
    $stepOk = $false
    $exitCode = $null
    $stepError = $null

    try {
      if ($step.kind -eq 'set-machine-path') {
        # 刻意不用 setx：它在 1024 字符处静默截断，PATH 被写坏的历史残留就是这么来的。
        # 直接写注册表并保持 REG_EXPAND_SZ，最后广播 WM_SETTINGCHANGE。
        Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path -Value ([string]$step.value) -Type ExpandString -ErrorAction Stop
        $sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
        try {
          $t = Add-Type -MemberDefinition $sig -Name Win32SMT4 -Namespace DevkitNative -PassThru
          $out = [UIntPtr]::Zero
          $t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$out) | Out-Null
        } catch {}
        $stepOk = $true
      }
      elseif ($step.kind -eq 'restore-point') {
        # 系统还原点：只在启用了系统保护时可用；失败不算致命
        Checkpoint-Computer -Description ([string]$step.description) -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
        $stepOk = $true
      }
      else {
        if ($step.verifySha256) {
          $expected = ([string]$step.verifySha256).ToLower()
          # 用 .NET 直接算，不用 Get-FileHash：实测有机器上 PowerShell 5.1 里
          # Get-FileHash 不存在（Microsoft.PowerShell.Utility 不完整）。
          $sha = [System.Security.Cryptography.SHA256]::Create()
          $stream = [System.IO.File]::OpenRead([string]$step.cmd)
          try {
            $hashBytes = $sha.ComputeHash($stream)
          }
          finally {
            $stream.Dispose()
            $sha.Dispose()
          }
          $actual = (-join ($hashBytes | ForEach-Object { $_.ToString('x2') })).ToLower()

          if ($actual -ne $expected) {
            throw "安装包校验失败，已拒绝以管理员身份执行：期望 $expected，实际 $actual"
          }
        }

        $arguments = @()
        foreach ($a in $step.args) { $arguments += [string]$a }
        $timeoutSec = 1800
        if ($step.timeoutMs) { $timeoutSec = [int]([double]$step.timeoutMs / 1000) }

        $process = Start-Process -FilePath ([string]$step.cmd) -ArgumentList $arguments -PassThru -WindowStyle Hidden
        if (-not $process.WaitForExit($timeoutSec * 1000)) {
          try { $process.Kill() } catch {}
          $stepError = "步骤超时（${timeoutSec}s）"
        }
        else {
          $exitCode = $process.ExitCode
          $stepOk = ($exitCode -eq 0)
          if (-not $stepOk) { $stepError = "退出码 ${exitCode}" }
        }
      }
    }
    catch {
      $stepError = $_.Exception.Message
    }

    $results += @{ label = $label; ok = $stepOk; exitCode = $exitCode; error = $stepError }
  }

  $allOk = $true
  foreach ($r in $results) { if (-not $r.ok) { $allOk = $false } }
  Write-Result $jobId $allOk $results $null
}
catch {
  Write-Result $jobId $false $results $_.Exception.Message
  exit 1
}
"#;

/// 内联脚本的长度上限（Windows 命令行总长 32767；UTF-16LE+base64 约 2.67 倍体积）。
pub const MAX_ENCODED_COMMAND_CHARS: usize = 24_000;

/// PowerShell 单引号字符串：内部单引号写成两个
pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ElevatedJobPayload<'a> {
    pub job_id: &'a str,
    pub steps: &'a [ElevationJobStep],
    pub result_file: &'a str,
    pub nonce: &'a str,
}

/// 把作业数据与助手脚本拼成一段可内联执行的 PowerShell。
///
/// 作业 JSON 用**单引号 here-string**（`@'...'@`）包住：它是字面量，不插值，
/// 所以 JSON 里的 `$` 不会被 PowerShell 展开。
pub fn build_elevated_script(payload: &ElevatedJobPayload<'_>) -> String {
    let job = serde_json::json!({
        "jobId": payload.job_id,
        "steps": payload.steps,
    });
    let json = serde_json::to_string_pretty(&job).unwrap_or_default();

    format!(
        "$JobJson = @'\n{}\n'@\n$ResultFile = {}\n$Nonce = {}\n{}",
        json,
        ps_quote(payload.result_file),
        ps_quote(payload.nonce),
        ELEVATION_HELPER_SCRIPT
    )
}

/// base64 编码（RFC 4648 标准 alphabet，带 padding）
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

/// 编码成 `powershell -EncodedCommand` 要的 UTF-16LE base64
pub fn encode_for_power_shell(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64_encode(&utf16)
}

/// 当前进程是否已经是管理员
pub async fn is_elevated() -> bool {
    let result = crate::exec::run_command(
        "powershell.exe",
        &[
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)".to_string(),
        ],
        &crate::exec::RunOptions {
            timeout_ms: Some(15_000),
            ..Default::default()
        },
    )
    .await;
    if result.code != Some(0) {
        return false;
    }
    result.stdout.trim().eq_ignore_ascii_case("true")
}

/// 作业 id（**必须随机**：以前是秒级时间戳，可预测 —— 低权限进程可以提前把同名
/// 文件放好。现在不经过文件，随机 id 主要是让结果文件不可预置）。
pub fn make_job_id() -> Result<String, String> {
    let bytes = devkit_sys::random::random_bytes(16)?;
    // UUID v4 形状：time_low-time_mid-time_hi_and_version-clock_seq-node
    let mut id = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            id.push('-');
        }
        let mut byte = *byte;
        if index == 6 {
            byte = (byte & 0x0F) | 0x40; // version 4
        }
        if index == 8 {
            byte = (byte & 0x3F) | 0x80; // variant 10xx
        }
        id.push_str(&format!("{byte:02x}"));
    }
    Ok(id)
}

/// 每次作业一个一次性随机值，写在结果里由主进程校验
pub fn make_nonce() -> Result<String, String> {
    devkit_sys::random::random_hex(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn encode_for_power_shell_is_utf16le_base64() {
        // "A" = 0x0041 LE → 41 00 → base64("A\0") = "QQA="
        assert_eq!(encode_for_power_shell("A"), "QQA=");
        // 解码回原文
        let script = "$ResultFile = 'C:\\x y\\result.json'\n$Nonce = 'abc'";
        let encoded = encode_for_power_shell(script);
        // Rust 端自解码验证
        let decoded: Vec<u8> = base64_decode(&encoded).unwrap();
        let units: Vec<u16> = decoded
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), script);
    }

    fn base64_decode(input: &str) -> Option<Vec<u8>> {
        const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let bytes: Vec<u8> = input
            .bytes()
            .filter(|b| *b != b'=')
            .map(|b| ALPHABET.find(b as char).unwrap() as u8)
            .collect();
        for chunk in bytes.chunks(4) {
            let mut triple = 0u32;
            for (i, &v) in chunk.iter().enumerate() {
                triple |= (v as u32) << (18 - 6 * i);
            }
            out.push((triple >> 16) as u8);
            if chunk.len() > 2 {
                out.push((triple >> 8) as u8);
            }
            if chunk.len() > 3 {
                out.push(triple as u8);
            }
        }
        Some(out)
    }

    #[test]
    fn job_id_is_uuid_v4_shape_and_random() {
        let a = make_job_id().unwrap();
        let b = make_job_id().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(
            (
                parts[0].len(),
                parts[1].len(),
                parts[2].len(),
                parts[3].len(),
                parts[4].len()
            ),
            (8, 4, 4, 4, 12)
        );
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        // version 4：第 3 段首字符是 '4'
        assert!(parts[2].starts_with('4'));
        // variant：第 4 段首字符 ∈ [89ab]
        assert!("89ab".contains(&parts[3][..1]));
    }

    #[test]
    fn nonce_is_64_hex_chars() {
        let nonce = make_nonce().unwrap();
        assert_eq!(nonce.len(), 64);
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn helper_script_contains_security_critical_lines() {
        // 逐字审计锚点：这些行是安全不变式的实现（§6.5）
        assert!(ELEVATION_HELPER_SCRIPT.contains("不从磁盘读任何东西"));
        assert!(ELEVATION_HELPER_SCRIPT.contains("Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name Path -Value ([string]$step.value) -Type ExpandString"));
        assert!(ELEVATION_HELPER_SCRIPT.contains("安装包校验失败，已拒绝以管理员身份执行"));
        assert!(ELEVATION_HELPER_SCRIPT.contains("[System.Security.Cryptography.SHA256]::Create()"));
        assert!(ELEVATION_HELPER_SCRIPT.contains("UTF8Encoding($false)"));
        // 单引号 here-string 包 JSON
        let script = build_elevated_script(&ElevatedJobPayload {
            job_id: "test-id",
            steps: &[],
            result_file: r"C:\x\result.json",
            nonce: "abc",
        });
        assert!(script.starts_with("$JobJson = @'"));
        assert!(script.contains("'@\n$ResultFile = 'C:\\x\\result.json'\n$Nonce = 'abc'"));
    }

    #[test]
    fn job_steps_serialize_with_ts_tags() {
        let steps = vec![
            ElevationJobStep::Exec {
                label: "安装".to_string(),
                cmd: "msiexec.exe".to_string(),
                args: vec!["/x".to_string()],
                timeout_ms: Some(1_800_000),
                verify_sha256: Some("deadbeef".to_string()),
            },
            ElevationJobStep::RestorePoint {
                label: "创建系统还原点".to_string(),
                description: "devkit".to_string(),
            },
            ElevationJobStep::SetMachinePath {
                label: "写入机器级 PATH".to_string(),
                value: "C:\\Windows".to_string(),
            },
        ];
        let json = serde_json::to_value(&steps).unwrap();
        assert_eq!(json[0]["kind"], "exec");
        assert_eq!(json[0]["verifySha256"], "deadbeef");
        assert_eq!(json[0]["timeoutMs"], 1800000);
        assert_eq!(json[1]["kind"], "restore-point");
        assert_eq!(json[2]["kind"], "set-machine-path");
        // 双向
        let parsed: Vec<ElevationJobStep> = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, steps);
    }
}
