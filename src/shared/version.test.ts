import { describe, expect, it } from 'vitest'
import { compareVersions, extractVersion, parseVersion, sameMajor } from './version'

describe('parseVersion', () => {
  it('解析常见格式', () => {
    expect(parseVersion('v22.23.2')).toEqual([22, 23, 2])
    expect(parseVersion('3.13.15')).toEqual([3, 13, 15])
    expect(parseVersion('21')).toEqual([21])
  })

  it('忽略版本号后面的后缀（后缀里的数字不算版本段）', () => {
    expect(parseVersion('2.47.1.windows.2')).toEqual([2, 47, 1])
  })

  it('无版本号时返回空数组', () => {
    expect(parseVersion('')).toEqual([])
    expect(parseVersion(null)).toEqual([])
    expect(parseVersion(undefined)).toEqual([])
  })
})

describe('extractVersion 从命令输出里抽版本', () => {
  it('处理 node -v', () => {
    expect(extractVersion('v22.23.2\n')).toBe('22.23.2')
  })

  it('处理 git --version', () => {
    expect(extractVersion('git version 2.47.1.windows.2')).toBe('2.47.1.windows.2')
  })

  it('处理 java -version（输出在 stderr，含引号）', () => {
    const output = 'openjdk version "21.0.2" 2024-01-16\nOpenJDK Runtime Environment'
    expect(extractVersion(output)).toBe('21.0.2')
  })

  it('处理 python --version', () => {
    expect(extractVersion('Python 3.13.15')).toBe('3.13.15')
  })

  it('处理 psql --version', () => {
    expect(extractVersion('psql (PostgreSQL) 16.1')).toBe('16.1')
  })

  it('抽不到时返回 null', () => {
    expect(extractVersion('command not found')).toBeNull()
    expect(extractVersion('')).toBeNull()
    expect(extractVersion(null)).toBeNull()
  })
})

describe('sameMajor 主版本比较', () => {
  it('同主版本、补丁号不同算一致（不打扰用户）', () => {
    expect(sameMajor('22.23.2', '22.12.0')).toBe(true)
  })

  it('次要版本不同仍算同主版本（刻意的宽松规则，见 version.ts 注释）', () => {
    expect(sameMajor('3.13.15', '3.14.8')).toBe(true)
  })

  it('主版本不同才算不一致', () => {
    expect(sameMajor('22.23.2', '24.21.0')).toBe(false)
    expect(sameMajor('3.13.15', '2.7.18')).toBe(false)
  })

  it('任一侧解析失败时返回 true，宁可漏报不误报', () => {
    expect(sameMajor(null, '22.12.0')).toBe(true)
    expect(sameMajor('22.12.0', null)).toBe(true)
    expect(sameMajor('abc', '22.12.0')).toBe(true)
  })
})

describe('compareVersions', () => {
  it('逐段比较', () => {
    expect(compareVersions('22.12.0', '22.9.0')).toBe(1)
    expect(compareVersions('22.9.0', '22.12.0')).toBe(-1)
    expect(compareVersions('22.12.0', '22.12.0')).toBe(0)
  })

  it('缺失段按 0 处理', () => {
    expect(compareVersions('22', '22.0.0')).toBe(0)
    expect(compareVersions('22.1', '22')).toBe(1)
  })
})
