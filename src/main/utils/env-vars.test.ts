import { describe, expect, it } from 'vitest'
import { expandEnvVars, isAbsoluteWindowsPath } from './env-vars'

describe('expandEnvVars', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\屈\\AppData\\Local',
    SystemRoot: 'C:\\Windows'
  }

  it('展开变量', () => {
    expect(expandEnvVars('%ProgramFiles%\\nodejs\\node.exe', env)).toBe(
      'C:\\Program Files\\nodejs\\node.exe'
    )
  })

  it('变量名大小写不敏感（Windows 行为）', () => {
    expect(expandEnvVars('%programfiles%\\x', env)).toBe('C:\\Program Files\\x')
    expect(expandEnvVars('%PROGRAMFILES%\\x', env)).toBe('C:\\Program Files\\x')
  })

  it('中文用户名路径不被破坏（NFR-5）', () => {
    expect(expandEnvVars('%LOCALAPPDATA%\\pnpm\\pnpm.exe', env)).toBe(
      'C:\\Users\\屈\\AppData\\Local\\pnpm\\pnpm.exe'
    )
  })

  it('未知变量保留原文，便于日志定位', () => {
    expect(expandEnvVars('%NOT_DEFINED%\\x', env)).toBe('%NOT_DEFINED%\\x')
  })

  it('空值变量保留原文', () => {
    expect(expandEnvVars('%EMPTY%\\x', { EMPTY: '' })).toBe('%EMPTY%\\x')
  })

  it('无变量的字符串原样返回', () => {
    expect(expandEnvVars('C:\\plain\\path.exe', env)).toBe('C:\\plain\\path.exe')
  })
})

describe('isAbsoluteWindowsPath', () => {
  it('识别盘符路径与 UNC', () => {
    expect(isAbsoluteWindowsPath('C:\\a')).toBe(true)
    expect(isAbsoluteWindowsPath('d:/a')).toBe(true)
    expect(isAbsoluteWindowsPath('\\\\server\\share')).toBe(true)
  })

  it('相对路径与变量开头不算绝对路径', () => {
    expect(isAbsoluteWindowsPath('%ProgramFiles%\\a')).toBe(false)
    expect(isAbsoluteWindowsPath('a\\b')).toBe(false)
  })
})
