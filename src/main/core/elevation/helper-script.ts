import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'

/**
 * 提权助手（SPEC §6.6）。
 *
 * 设计取舍：
 *  · **不整程序提权**：整程序以管理员运行时，拖拽、默认浏览器、用户目录都变了，
 *    而且用户会在每次启动时看到 UAC，安全争议也大。
 *  · **一次 UAC 干完所有事**：把所有需要管理员的步骤打包，由**一个**提升后的
 *    PowerShell 进程顺序执行完。对比"每项单独提权"，装 3 个 MSI 从弹 3 次 UAC 变成 1 次。
 *
 * ## 为什么不落盘（重要）
 *
 * 以前的做法是把助手脚本 `devkit-elevate.ps1` 与作业文件 `job-<id>.json` 写进
 * `%APPDATA%\devkit\elevation`，再让提权进程去读它们。**那是完整的提权漏洞**：
 *
 * - 那个目录**用户可写**，而提权进程会**执行**里面的脚本
 * - 作业文件名只精确到秒，可预测；内容也只有用户级权限保护
 *
 * 于是同机器上任何以当前用户身份运行的进程，只要在用户点 UAC 之前把脚本或作业文件
 * 换成自己的内容，就能**以管理员身份执行任意命令**。用户以为自己批准的是"devkit 装环境"。
 *
 * 根因是：主进程与提权进程之间**没有可认证的通道** —— 主进程能写的东西，攻击者同样能写。
 * 所以唯一的修法是**不经过文件**：助手脚本与作业数据一起内联进
 * `powershell -EncodedCommand <UTF-16LE base64>`，提权进程除了命令行什么都不读。
 *
 * 结果文件仍然落在用户可写目录（主进程要能读它），但**伪造结果只能骗到"成功"这个结论，
 * 不能获得代码执行** —— 而且现在带随机 nonce，主进程会校验。
 *
 * 本模块不 import electron，方便在单测里直接跑（非提升路径）。
 */

export type ElevationStep =
  | {
      kind: 'exec'
      label: string
      cmd: string
      args: string[]
      timeoutMs?: number
      /**
       * 执行前要求该文件（step.cmd）的 SHA-256 等于这个值。
       *
       * 为什么必须在提权进程里再算一次：安装包放在用户可写的 %APPDATA%\devkit\downloads，
       * 下载时校验过一次之后，同机器上的低权限进程仍有机会把它换掉，再等用户为"devkit 安装"
       * 点 UAC —— 那就是以管理员身份执行攻击者的二进制（安全审查 H3）。
       */
      verifySha256?: string
    }
  | {
      kind: 'restore-point'
      label: string
      description: string
    }
  | {
      kind: 'set-machine-path'
      label: string
      /** 完整的新 PATH 值（由调用方算好，助手只负责写） */
      value: string
    }

export interface StepResult {
  label: string
  ok: boolean
  exitCode: number | null
  error: string | null
}

export interface ElevationOutcome {
  ok: boolean
  /** true = 本次确实走了提权路径（会弹 UAC） */
  elevated: boolean
  /** 用户取消了 UAC 授权 */
  cancelled: boolean
  steps: StepResult[]
  error: string | null
}

/**
 * 助手脚本。
 *
 * 刻意不混淆、不加密：提权脚本必须可读可审计 —— 一个"看不懂但要求管理员权限"的
 * 二进制会被杀软和用户同时拒绝（SPEC 风险表里已经点名了这条）。
 */
export const ELEVATION_HELPER_SCRIPT = `# devkit 提权助手（由 devkit 生成，可读可审计）
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
        # 注意：PowerShell 的反引号续行不能出现在这个 TS 模板字符串里（会把它截断），所以写成一行
        Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name Path -Value ([string]$step.value) -Type ExpandString -ErrorAction Stop
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
          # Get-FileHash 不存在（Microsoft.PowerShell.Utility 不完整），
          # 而校验失败会导致所有机器级安装都装不上 —— 不能依赖这个 cmdlet。
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
          $stepError = "步骤超时（\${timeoutSec}s）"
        }
        else {
          $exitCode = $process.ExitCode
          $stepOk = ($exitCode -eq 0)
          if (-not $stepOk) { $stepError = "退出码 \${exitCode}" }
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
`

/**
 * 内联脚本的长度上限。
 *
 * Windows 的命令行总长上限是 32767 字符，而 `-EncodedCommand` 用 UTF-16LE + base64，
 * 体积约是原文的 2.67 倍。这里留足余量（含 `Start-Process` 那层包装），
 * 超了就**明确报错**而不是让 Windows 去截断 —— 被截断的 PowerShell 脚本行为不可预测。
 */
export const MAX_ENCODED_COMMAND_CHARS = 24_000

/** PowerShell 单引号字符串：内部单引号写成两个 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export interface ElevatedJobPayload {
  jobId: string
  nonce: string
  resultFile: string
  steps: ElevationStep[]
}

/**
 * 把作业数据与助手脚本拼成一段可内联执行的 PowerShell。
 *
 * 作业 JSON 用**单引号 here-string**（`@'...'@`）包住：它是字面量，不插值，
 * 所以 JSON 里的 `$` 不会被 PowerShell 展开。
 */
export function buildElevatedScript(payload: ElevatedJobPayload): string {
  const json = JSON.stringify({ jobId: payload.jobId, steps: payload.steps }, null, 2)

  return [
    `$JobJson = @'`,
    json,
    `'@`,
    `$ResultFile = ${psQuote(payload.resultFile)}`,
    `$Nonce = ${psQuote(payload.nonce)}`,
    ELEVATION_HELPER_SCRIPT
  ].join('\n')
}

/** 编码成 `powershell -EncodedCommand` 要的 UTF-16LE base64 */
export function encodeForPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 当前进程是否已经是管理员 */
export function isElevated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error) resolve(false)
        else resolve(stdout.trim().toLowerCase() === 'true')
      }
    )
  })
}

/**
 * 作业 id 与 nonce。
 *
 * **必须是随机的，不能用时间戳。** 以前是 `YYYYMMDD-HHMMSS`，秒级可预测 ——
 * 低权限进程可以提前把同名文件放好。现在既然不再经过文件，随机 id 主要是为了
 * 让结果文件不可预置；nonce 则让主进程能识别结果是不是本次作业写的。
 */
export function makeJobId(): string {
  return randomUUID()
}

/** 每次作业一个一次性随机值，写在结果里由主进程校验 */
export function makeNonce(): string {
  return randomBytes(32).toString('hex')
}
