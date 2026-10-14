import { describe, expect, it } from 'vitest'
import type { InstalledProgram } from '../detect/registry-parse'
import { findUninstallEntry, planUninstall, splitWindowsCommand } from './registry'

/**
 * 机器级 MSI（7-Zip 是唯一一个）会在注册表留一条卸载记录。
 * devkit 原来的卸载只删版本目录，于是「应用和功能」里留下一条幽灵条目。
 *
 * 这里测的是"怎么从注册表记录推导出该执行什么"，不涉及真的卸载。
 */

function program(overrides: Partial<InstalledProgram> = {}): InstalledProgram {
  return {
    hive: 'HKLM',
    view: '64',
    keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{23170F69-40C1-2702-2604-000001000000}',
    fields: { DisplayName: '7-Zip 26.04 (x64)', DisplayVersion: '26.04' },
    ...overrides
  }
}

describe('splitWindowsCommand', () => {
  it('带引号的路径整体保留（这是 UninstallString 最常见的形态）', () => {
    expect(splitWindowsCommand('"C:\\Program Files\\Foo\\uninst.exe" /S')).toEqual([
      'C:\\Program Files\\Foo\\uninst.exe',
      '/S'
    ])
  })

  it('不带引号时按空白切', () => {
    expect(splitWindowsCommand('MsiExec.exe /I{GUID}')).toEqual(['MsiExec.exe', '/I{GUID}'])
  })

  it('多余空白不会产生空参数', () => {
    expect(splitWindowsCommand('  a   b  ')).toEqual(['a', 'b'])
  })

  it('空串返回空数组', () => {
    expect(splitWindowsCommand('')).toEqual([])
  })
})

describe('findUninstallEntry', () => {
  const rules = [
    {
      hive: 'HKLM' as const,
      view: '64' as const,
      path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      match: { DisplayName: '^7-Zip' }
    }
  ]

  it('按 DisplayName 正则命中', () => {
    expect(findUninstallEntry(rules, [program()])?.fields.DisplayName).toBe('7-Zip 26.04 (x64)')
  })

  it('名字不匹配就不算命中', () => {
    expect(
      findUninstallEntry(rules, [program({ fields: { DisplayName: 'Notepad++' } })])
    ).toBeNull()
  })

  it('hive / view 不匹配不算命中', () => {
    expect(findUninstallEntry(rules, [program({ hive: 'HKCU' })])).toBeNull()
    expect(findUninstallEntry(rules, [program({ view: '32' })])).toBeNull()
  })

  it('路径不匹配不算命中', () => {
    expect(
      findUninstallEntry(rules, [program({ keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Other\\{X}' })])
    ).toBeNull()
  })

  it('没有规则或没有程序时返回 null', () => {
    expect(findUninstallEntry(undefined, [program()])).toBeNull()
    expect(findUninstallEntry(rules, [])).toBeNull()
  })
})

describe('planUninstall', () => {
  it('**键名是 GUID → 走 msiexec /x**（比解析 UninstallString 可靠）', () => {
    const plan = planUninstall(program())
    expect(plan?.kind).toBe('msi')
    expect(plan?.cmd).toBe('msiexec.exe')
    expect(plan?.args).toEqual([
      '/x',
      '{23170F69-40C1-2702-2604-000001000000}',
      '/qn',
      '/norestart'
    ])
  })

  it('非 MSI 时优先用 QuietUninstallString', () => {
    const plan = planUninstall(
      program({
        keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Foo',
        fields: {
          DisplayName: 'Foo',
          UninstallString: '"C:\\Foo\\uninst.exe" /prompt',
          QuietUninstallString: '"C:\\Foo\\uninst.exe" /quiet'
        }
      })
    )
    expect(plan?.kind).toBe('exe')
    expect(plan?.args).toEqual(['/quiet'])
  })

  it('没有 QuietUninstallString 时回退到 UninstallString', () => {
    const plan = planUninstall(
      program({
        keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Foo',
        fields: { DisplayName: 'Foo', UninstallString: '"C:\\Foo\\uninst.exe" /S' }
      })
    )
    expect(plan?.args).toEqual(['/S'])
  })

  it('**既不是 MSI 也没有 UninstallString → 返回 null**（调用方据此报错，而不是瞎删）', () => {
    const plan = planUninstall(
      program({
        keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Foo',
        fields: { DisplayName: 'Foo' }
      })
    )
    expect(plan).toBeNull()
  })

  it('displayName 缺失时用 keyPath 兜底（日志与提示要能指到东西）', () => {
    const plan = planUninstall(program({ fields: {} }))
    expect(plan?.displayName).toContain('Uninstall')
  })
})
