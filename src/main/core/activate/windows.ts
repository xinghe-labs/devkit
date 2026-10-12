import { execFile } from 'node:child_process'

/**
 * 用户环境变量读写（Windows）。
 *
 * 为什么不用 `setx`：setx 在 1024 字符处静默截断，而开发机的 PATH 经常远超这个长度，
 * 用一次就把用户环境写坏（SPEC §6.7 明确禁用）。
 *
 * 为什么不用 `[Environment]::GetEnvironmentVariable`：它会把 REG_EXPAND_SZ 里的
 * `%USERPROFILE%` 之类**展开**，写回去时用户的原始写法就丢了。这里改成直接读
 * `HKCU:\Environment` 的原始值，写回时显式声明为 ExpandString。
 *
 * 为什么用 -EncodedCommand：脚本里会出现中文路径（本机就是 C:\Users\张三），
 * 命令行传参要处理引号、转义、代码页三件事，任何一件错了都会静默写坏环境变量。
 * Base64 的 UTF-16LE 编码把这些全部绕开。
 */

export interface PowerShellResult {
  code: number | null
  stdout: string
  stderr: string
}

const PS_EXE = 'powershell.exe'

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 每个脚本开头都强制 UTF-8 输出，否则中文路径在 stdout 里会变成乱码 */
const PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$OutputEncoding = [System.Text.Encoding]::UTF8'
].join('; ')

export function runPowerShell(script: string, timeoutMs = 20_000): Promise<PowerShellResult> {
  const full = `${PRELUDE}; ${script}`
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(full)],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', ...(error && !stderr ? { stderr: error.message } : {}) })
      }
    )
  })
}

/** 广播 WM_SETTINGCHANGE，让已经打开的"资源管理器/终端"有机会感知到环境变量变化 */
const BROADCAST = `
$sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
try {
  $t = Add-Type -MemberDefinition $sig -Name Win32SMT -Namespace DevkitNative -PassThru
  $out = [UIntPtr]::Zero
  $t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$out) | Out-Null
} catch {}
`

/** 读用户 PATH 的**原始值**（不展开 %VAR%） */
export async function readUserPath(): Promise<string> {
  const result = await runPowerShell(
    `$v = (Get-ItemProperty -Path 'HKCU:\\Environment' -Name Path -ErrorAction SilentlyContinue).Path; if ($null -eq $v) { '' } else { $v }`
  )
  if (result.code !== 0) {
    throw new Error(`读取用户 PATH 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
  return result.stdout.replace(/\r?\n$/, '')
}

/** 读机器级 PATH 的**原始值**（只读，不需要管理员） */
export async function readMachinePath(): Promise<string> {
  const result = await runPowerShell(
    `$v = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name Path -ErrorAction SilentlyContinue).Path; if ($null -eq $v) { '' } else { $v }`
  )
  if (result.code !== 0) {
    throw new Error(`读取机器级 PATH 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
  return result.stdout.replace(/\r?\n$/, '')
}

/** 写用户 PATH（保持 REG_EXPAND_SZ 类型，不展开用户原有的 %VAR% 写法） */
export async function writeUserPath(value: string): Promise<void> {
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  const result = await runPowerShell(
    [
      `$bytes = [Convert]::FromBase64String('${encoded}')`,
      '$value = [System.Text.Encoding]::UTF8.GetString($bytes)',
      `if (-not (Test-Path 'HKCU:\\Environment')) { New-Item -Path 'HKCU:\\Environment' -Force | Out-Null }`,
      `Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $value -Type ExpandString`,
      BROADCAST
    ].join('; ')
  )
  if (result.code !== 0) {
    throw new Error(`写入用户 PATH 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
}

/** 读用户级环境变量原始值；不存在返回 null */
export async function readUserEnv(name: string): Promise<string | null> {
  if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) throw new Error(`环境变量名不合法：${name}`)
  const result = await runPowerShell(
    `$v = (Get-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'; if ($null -eq $v) { '__DEVKIT_ABSENT__' } else { $v }`
  )
  if (result.code !== 0) {
    throw new Error(`读取用户环境变量 ${name} 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
  const value = result.stdout.replace(/\r?\n$/, '')
  return value === '__DEVKIT_ABSENT__' ? null : value
}

/** 写用户级环境变量；value 为 null 表示删除该变量 */
export async function writeUserEnv(name: string, value: string | null): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) throw new Error(`环境变量名不合法：${name}`)

  const script =
    value === null
      ? [
          `Remove-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -ErrorAction SilentlyContinue`,
          BROADCAST
        ].join('; ')
      : [
          `$bytes = [Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')`,
          `$value = [System.Text.Encoding]::UTF8.GetString($bytes)`,
          `if (-not (Test-Path 'HKCU:\\Environment')) { New-Item -Path 'HKCU:\\Environment' -Force | Out-Null }`,
          `Set-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -Value $value -Type ExpandString`,
          BROADCAST
        ].join('; ')

  const result = await runPowerShell(script)
  if (result.code !== 0) {
    throw new Error(`写入用户环境变量 ${name} 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
}

/** 当前进程是否具备管理员权限（机器级安装需要） */
export async function isElevated(): Promise<boolean> {
  const result = await runPowerShell(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  )
  return result.stdout.trim().toLowerCase() === 'true'
}
