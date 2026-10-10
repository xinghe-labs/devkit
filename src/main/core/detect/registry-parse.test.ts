import { describe, expect, it } from 'vitest'
import { parseRegQueryOutput } from './registry-parse'

/** 样本按 `reg query <key> /s` 的真实排版构造：键名顶格，值缩进，空行分隔条目 */
const SAMPLE = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A1B2C3}',
  '    DisplayName    REG_SZ    Node.js',
  '    DisplayVersion    REG_SZ    22.12.0',
  '    UninstallString    REG_SZ    MsiExec.exe /X{A1B2C3}',
  '    Publisher    REG_SZ    OpenJS Foundation',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip',
  '    DisplayName    REG_SZ    7-Zip 24.09 (x64)',
  '    DisplayVersion    REG_SZ    24.09',
  '    InstallLocation    REG_SZ    C:\\Program Files\\7-Zip\\',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Empty',
  '    NoDisplayName    REG_SZ    something',
  ''
].join('\r\n')

describe('parseRegQueryOutput', () => {
  const programs = parseRegQueryOutput(SAMPLE, 'HKLM', '64')

  it('按条目切分并保留全部字段', () => {
    expect(programs).toHaveLength(3)
    expect(programs[0].fields.DisplayName).toBe('Node.js')
    expect(programs[0].fields.DisplayVersion).toBe('22.12.0')
    expect(programs[0].fields.Publisher).toBe('OpenJS Foundation')
  })

  it('保留完整键路径，卸载功能（FR-16）要用', () => {
    expect(programs[0].keyPath).toBe(
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A1B2C3}'
    )
  })

  it('写入调用方传入的 hive 与 view', () => {
    for (const program of programs) {
      expect(program.hive).toBe('HKLM')
      expect(program.view).toBe('64')
    }
  })

  it('DisplayName 里的括号与空格原样保留', () => {
    expect(programs[1].fields.DisplayName).toBe('7-Zip 24.09 (x64)')
  })

  it('值里的路径不被截断', () => {
    expect(programs[1].fields.InstallLocation).toBe('C:\\Program Files\\7-Zip\\')
  })

  it('没有值字段的条目也会被解析出来，由调用方决定是否过滤', () => {
    expect(programs[2].fields.DisplayName).toBeUndefined()
    expect(programs[2].fields.NoDisplayName).toBe('something')
  })

  it('空输出返回空数组', () => {
    expect(parseRegQueryOutput('', 'HKLM', '64')).toEqual([])
    expect(parseRegQueryOutput('ERROR: 系统找不到指定的注册表项或值。', 'HKLM', '64')).toEqual([])
  })

  it('只有键名没有值时不会产生条目', () => {
    const onlyKey = 'HKEY_CURRENT_USER\\SOFTWARE\\Foo\\Bar'
    expect(parseRegQueryOutput(onlyKey, 'HKCU', '64')).toEqual([])
  })
})
