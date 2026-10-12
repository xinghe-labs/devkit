import { execFile } from 'node:child_process'

/**
 * 提权助手（SPEC §6.6）。
 *
 * 设计取舍：
 *  · **不整程序提权**：整程序以管理员运行时，拖拽、默认浏览器、用户目录都变了，
 *    而且用户会在每次启动时看到 UAC，安全争议也大。
 *  · **一次 UAC 干完所有事**：把所有需要管理员的步骤打包成一个 job 文件，
 *    由**一个**提升后的 PowerShell 进程顺序执行完，再写结果文件。
 *    对比"每项单独提权"，装 3 个 MSI 从弹 3 次 UAC 变成弹 1 次。
 *  · **提权进程与主进程不共享任何状态**：只通过两个文件（job / result）通信。
 *    job 内容全部由代码生成（安装模板 + 还原点），清单无权直接写入。
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
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File devkit-elevate.ps1 -JobFile <path> -ResultFile <path>
param(
  [Parameter(Mandatory=$true)][string]$JobFile,
  [Parameter(Mandatory=$true)][string]$ResultFile
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Result($jobId, $ok, $steps, $error) {
  $payload = @{ jobId = $jobId; ok = $ok; steps = $steps; error = $error } | ConvertTo-Json -Depth 6
  # 用不带 BOM 的 UTF-8：Node 的 JSON.parse 见到 BOM 会直接报 "Unexpected token"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ResultFile, $payload, $utf8NoBom)
}

$jobId = 'unknown'
$results = @()

try {
  $job = Get-Content -Path $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
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

export function makeJobId(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}
