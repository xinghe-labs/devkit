import { beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
vi.mock('../../utils/exec', () => ({
  runCommand: (...args: unknown[]) => runCommand(...args)
}))

const { isMissingValueError, readRegDword, regDeleteArgs, regDwordAddArgs, toPsPath, toRegPath } =
  await import('./registry')

const BS = String.fromCharCode(92)

/**
 * 这组测试存在的原因是一个**真实缺陷**：
 *
 * 清单里的注册表路径为了可读性写成 PowerShell 风格 `HKLM:\SYSTEM\...`（带冒号），
 * 写路径当时显式 `.replace(/^HKLM:\\/, 'HKLM\\')` 去掉了冒号，
 * **读路径漏了** —— 于是 `reg query` 每次都以「无效参数」失败（退出码 1），
 * `readRegistryValue` 永远返回 null，界面上长路径与开发者模式永远显示
 * 「读不到（可能需要管理员）」，**即使它们其实是开着的**。
 *
 * 实测证据（本机）：
 *   reg query "HKLM:\SOFTWARE\..."  → code=1 「无效参数」
 *   reg query "HKLM\SOFTWARE\..."   → code=0 读到值
 */
describe('注册表路径写法（读路径 bug 的回归测试）', () => {
  it('把 PowerShell 风格转成 reg.exe 认的写法', () => {
    expect(toRegPath(`HKLM:${BS}SYSTEM${BS}CurrentControlSet`)).toBe(
      `HKLM${BS}SYSTEM${BS}CurrentControlSet`
    )
    expect(toRegPath(`HKCU:${BS}Software${BS}Test`)).toBe(`HKCU${BS}Software${BS}Test`)
  })

  it('已经是 reg.exe 写法时不重复处理（幂等）', () => {
    const already = `HKLM${BS}SYSTEM${BS}Control`
    expect(toRegPath(already)).toBe(already)
    expect(toRegPath(toRegPath(`HKLM:${BS}SYSTEM`))).toBe(`HKLM${BS}SYSTEM`)
  })

  it('大小写不敏感', () => {
    expect(toRegPath(`hklm:${BS}SYSTEM`)).toBe(`HKLM${BS}SYSTEM`)
  })

  it('转回来只用于展示', () => {
    expect(toPsPath(`HKLM${BS}SYSTEM`)).toBe(`HKLM:${BS}SYSTEM`)
  })

  it('写路径生成的参数必须是 reg.exe 写法，绝不能带冒号', () => {
    const args = regDwordAddArgs(`HKLM:${BS}SYSTEM${BS}Control`, 'LongPathsEnabled', 1)
    expect(args[0]).toBe('add')
    expect(args[1]).toBe(`HKLM${BS}SYSTEM${BS}Control`)
    expect(args[1]).not.toContain(':')
    expect(args).toEqual(['add', `HKLM${BS}SYSTEM${BS}Control`, '/v', 'LongPathsEnabled', '/t', 'REG_DWORD', '/d', '1', '/f'])
  })

  it('删除参数同样不能带冒号', () => {
    const args = regDeleteArgs(`HKLM:${BS}SOFTWARE${BS}X`, 'Value')
    expect(args).toEqual(['delete', `HKLM${BS}SOFTWARE${BS}X`, '/v', 'Value', '/f'])
  })
})

describe('readRegDword：必须区分「值不存在」与「值为 0」', () => {
  beforeEach(() => {
    runCommand.mockReset()
  })

  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', spawnError: null })
  const fail = (stderr = '') => ({ code: 1, stdout: '', stderr, spawnError: null })

  it('值为 0 → valueExists=true, value=0（不是"不存在"）', async () => {
    runCommand
      .mockResolvedValueOnce(ok('HKEY_LOCAL_MACHINE\\...')) // 键存在
      .mockResolvedValueOnce(ok('    LongPathsEnabled    REG_DWORD    0x0'))

    const result = await readRegDword(`HKLM:${BS}SYSTEM${BS}Control`, 'LongPathsEnabled')
    expect(result).toEqual({ keyExists: true, valueExists: true, value: 0 })
  })

  it('值为 1 → value=1', async () => {
    runCommand
      .mockResolvedValueOnce(ok('key'))
      .mockResolvedValueOnce(ok('    AllowDevelopmentWithoutDevLicense    REG_DWORD    0x1'))

    const result = await readRegDword(`HKLM:${BS}X`, 'AllowDevelopmentWithoutDevLicense')
    expect(result.value).toBe(1)
  })

  it('键在、值不在 → valueExists=false（还原时要删值）', async () => {
    runCommand.mockResolvedValueOnce(ok('key')).mockResolvedValueOnce(fail('找不到'))

    const result = await readRegDword(`HKLM:${BS}X`, 'Missing')
    expect(result).toEqual({ keyExists: true, valueExists: false, value: null })
  })

  it('键都不在 → keyExists=false（备份不了，调用方应拒绝改动）', async () => {
    runCommand.mockResolvedValueOnce(fail('找不到')).mockResolvedValueOnce(fail('找不到'))

    const result = await readRegDword(`HKLM:${BS}NoSuchKey`, 'X')
    expect(result).toEqual({ keyExists: false, valueExists: false, value: null })
  })

  it('值存在但不是 REG_DWORD → 不当成数字猜，返回 null', async () => {
    runCommand
      .mockResolvedValueOnce(ok('key'))
      .mockResolvedValueOnce(ok('    SomeValue    REG_SZ    hello'))

    const result = await readRegDword(`HKLM:${BS}X`, 'SomeValue')
    expect(result).toEqual({ keyExists: true, valueExists: true, value: null })
  })

  it('十六进制要按 16 进制解析（0x10 = 16，不是 10）', async () => {
    runCommand
      .mockResolvedValueOnce(ok('key'))
      .mockResolvedValueOnce(ok('    V    REG_DWORD    0x10'))
    expect((await readRegDword(`HKLM:${BS}X`, 'V')).value).toBe(16)
  })

  it('传给 reg.exe 的 path 一定不含冒号', async () => {
    runCommand.mockResolvedValue(ok('    V    REG_DWORD    0x1'))
    await readRegDword(`HKLM:${BS}SYSTEM${BS}Control`, 'V')

    const paths = runCommand.mock.calls.map((call) => (call[1] as string[])[1])
    expect(paths.every((path) => !path.includes(':'))).toBe(true)
  })
})

describe('isMissingValueError', () => {
  it('认出中英文的「找不到」', () => {
    expect(isMissingValueError('错误: 系统找不到指定的注册表项或值。')).toBe(true)
    expect(isMissingValueError('ERROR: The system was unable to find the specified registry key or value.')).toBe(true)
    expect(isMissingValueError('错误: 无效参数')).toBe(false)
  })
})
