import { runCommand } from '../../utils/exec'

/**
 * 注册表读写（统一路径写法）。
 *
 * **踩过的坑**：`reg.exe` 只认 `HKLM\SYSTEM\...`，
 * 而 `HKLM:\SYSTEM\...`（带冒号）是 **PowerShell** 的注册表提供程序写法。
 * 清单里为了可读性一直写成 PowerShell 风格，写路径当时显式去掉了冒号，
 * 读路径漏了 —— 结果 `reg query` 每次都以「无效参数」失败（退出码 1），
 * `readRegistryValue` 永远返回 null，界面上长路径与开发者模式永远显示
 * 「读不到（可能需要管理员）」，**即使它们其实是开着的**。
 *
 * 所以这里把所有转换收在一处，读和写共用，杜绝再漏一次。
 */

/** PowerShell 风格 → reg.exe 风格：`HKLM:\A\B` → `HKLM\A\B` */
export function toRegPath(path: string): string {
  return path.replace(/^HKLM:\\/i, 'HKLM\\').replace(/^HKCU:\\/i, 'HKCU\\')
}

/** 反方向，仅用于日志/展示 */
export function toPsPath(path: string): string {
  return path.replace(/^HKLM\\/i, 'HKLM:\\').replace(/^HKCU\\/i, 'HKCU:\\')
}

export interface RegistryRead {
  /** 键本身是否存在 */
  keyExists: boolean
  /** 值是否存在 —— 这是备份「原本不存在」与「原本为 0」的关键区分 */
  valueExists: boolean
  value: number | null
}

/**
 * 读一个 REG_DWORD。
 *
 * 刻意分两次查：先确认键存在，再确认值存在。
 * 只查值的话，「值不存在」与「键不存在」返回的是同一句话，区分不开，
 * 而备份恰恰必须区分「原本不存在」和「原本为 0」。
 */
export async function readRegDword(path: string, name: string): Promise<RegistryRead> {
  const regPath = toRegPath(path)

  const key = await runCommand('reg.exe', ['query', regPath], { timeoutMs: 15_000 })
  const keyExists = key.code === 0

  const entry = await runCommand('reg.exe', ['query', regPath, '/v', name], { timeoutMs: 15_000 })
  if (entry.code !== 0) {
    return { keyExists, valueExists: false, value: null }
  }

  const match = entry.stdout.match(new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i'))
  if (!match) {
    // 值存在但不是 REG_DWORD（例如 REG_SZ）—— 当作读不到，不要猜
    return { keyExists, valueExists: true, value: null }
  }

  const value = Number.parseInt(match[1], 16)
  return { keyExists, valueExists: true, value: Number.isFinite(value) ? value : null }
}

/** 写一个 REG_DWORD（需要管理员，调用方负责提权） */
export function regDwordAddArgs(path: string, name: string, value: number): string[] {
  return ['add', toRegPath(path), '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f']
}

/** 删除一个值（需要管理员）。用 /f 避免交互式确认 */
export function regDeleteArgs(path: string, name: string): string[] {
  return ['delete', toRegPath(path), '/v', name, '/f']
}

/**
 * 键不存在时 `reg delete` 会失败。
 * 还原一个「原本不存在」的值时，失败是**预期结果**（说明本来就是干净的），
 * 所以这个判断要单独拿出来，不能让调用方把两种情况混为一谈。
 */
export function isMissingValueError(stderr: string): boolean {
  return /找不到|cannot find|unable to find/i.test(stderr)
}
