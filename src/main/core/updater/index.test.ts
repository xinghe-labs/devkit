import { describe, expect, it } from 'vitest'
import { parseLatestYml, parseUpdateIndex } from './index'

describe('electron-builder latest.yml 解析', () => {
  it('取出 version / path / url', () => {
    const yml = ['version: 0.2.0', 'files:', '  - url: devkit-0.2.0-portable.exe', 'path: devkit Setup 0.2.0.exe', 'sha512: abc', ''].join('\n')
    const parsed = parseLatestYml(yml)
    expect(parsed.version).toBe('0.2.0')
    expect(parsed.path).toBe('devkit Setup 0.2.0.exe')
  })

  it('忽略无关行与带引号的值', () => {
    const parsed = parseLatestYml(['releaseDate: "2026-10-12"', "version: '0.3.0'"].join('\n'))
    expect(parsed.version).toBe('0.3.0')
  })
})

describe('更新索引解析', () => {
  const SOURCE = 'https://example.com/devkit/latest.json'

  it('解析 JSON 索引，并把相对下载地址补成绝对地址', () => {
    const parsed = parseUpdateIndex(
      JSON.stringify({ version: '0.4.0', url: 'devkit-0.4.0-portable.exe', notes: '修了几个 bug' }),
      SOURCE
    )
    expect(parsed.version).toBe('0.4.0')
    expect(parsed.downloadUrl).toBe('https://example.com/devkit/devkit-0.4.0-portable.exe')
    expect(parsed.notes).toBe('修了几个 bug')
  })

  it('解析 latest.yml 形式的更新源', () => {
    const parsed = parseUpdateIndex(
      ['version: v0.5.0', 'path: devkit Setup 0.5.0.exe', ''].join('\n'),
      'https://example.com/devkit/latest.yml'
    )
    expect(parsed.version).toBe('0.5.0')
    expect(parsed.downloadUrl).toBe('https://example.com/devkit/devkit%20Setup%200.5.0.exe')
  })

  it('坏内容返回空值而不是抛错', () => {
    expect(parseUpdateIndex('{ not json', SOURCE).version).toBeNull()
    expect(parseUpdateIndex('whatever: 1', SOURCE).version).toBeNull()
  })
})
