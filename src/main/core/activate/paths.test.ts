import { describe, expect, it } from 'vitest'
import {
  ActivateSpecError,
  buildActivateEntries,
  hasPathEntry,
  normalizePathEntry,
  prependPathEntries,
  removePathEntries,
  renderActivatePath,
  splitPath
} from './paths'

const VARS = {
  installDir: 'C:\\Users\\屈\\.devkit\\versions\\jdk-temurin\\21.0.12.1',
  currentDir: 'C:\\Users\\屈\\.devkit\\current\\jdk-temurin',
  version: '21.0.12.1',
  toolId: 'jdk-temurin'
}

describe('激活占位符', () => {
  it('展开四个受支持的占位符', () => {
    expect(renderActivatePath('{currentDir}\\bin', VARS)).toBe(
      'C:\\Users\\屈\\.devkit\\current\\jdk-temurin\\bin'
    )
    expect(renderActivatePath('{installDir}', VARS)).toBe(VARS.installDir)
    expect(renderActivatePath('{toolId}-{version}', VARS)).toBe('jdk-temurin-21.0.12.1')
  })

  it('未知占位符直接报错，不静默放行', () => {
    expect(() => renderActivatePath('{evil}', VARS)).toThrow(ActivateSpecError)
  })

  it('buildActivateEntries 展开 pathEntries 与 env，并给出默认 linkName', () => {
    const entries = buildActivateEntries(
      { pathEntries: ['{currentDir}\\bin'], env: { JAVA_HOME: '{currentDir}' } },
      VARS
    )
    expect(entries.linkName).toBe('jdk-temurin')
    expect(entries.pathEntries).toEqual(['C:\\Users\\屈\\.devkit\\current\\jdk-temurin\\bin'])
    expect(entries.env.JAVA_HOME).toBe('C:\\Users\\屈\\.devkit\\current\\jdk-temurin')
  })

  it('拒绝非法环境变量名与含分号的路径', () => {
    expect(() => buildActivateEntries({ env: { 'bad-name': 'x' } }, VARS)).toThrow(ActivateSpecError)
    expect(() => buildActivateEntries({ pathEntries: ['a;b'] }, VARS)).toThrow(/分号/)
  })
})

describe('PATH 处理', () => {
  it('splitPath 丢掉空段', () => {
    expect(splitPath('a;;b;')).toEqual(['a', 'b'])
    expect(splitPath('')).toEqual([])
  })

  it('normalizePathEntry 大小写与尾随反斜杠不敏感', () => {
    expect(normalizePathEntry('C:\\Foo\\')).toBe(normalizePathEntry('c:\\foo'))
  })

  it('prependPathEntries 把新条目放到最前，其余顺序不变', () => {
    const result = prependPathEntries('C:\\Windows;C:\\Tools', ['D:\\devkit\\bin'])
    expect(result.value).toBe('D:\\devkit\\bin;C:\\Windows;C:\\Tools')
    expect(result.added).toEqual(['D:\\devkit\\bin'])
  })

  it('prependPathEntries 不产生重复项，但会把已有条目提到最前', () => {
    const result = prependPathEntries('C:\\Windows;C:\\devkit\\bin;C:\\Tools', ['C:\\devkit\\bin'])
    expect(result.value).toBe('C:\\devkit\\bin;C:\\Windows;C:\\Tools')
    expect(result.added).toEqual([])
    expect(result.alreadyPresent).toEqual(['C:\\devkit\\bin'])
  })

  it('prependPathEntries 对同一批条目内部去重', () => {
    const result = prependPathEntries('', ['a', 'A\\', 'b'])
    expect(result.value).toBe('a;b')
  })

  it('removePathEntries 只移除指定条目，且大小写/尾随斜杠不敏感', () => {
    const result = removePathEntries('A;c:\\devkit\\bin\\;B', ['C:\\DEVKIT\\BIN'])
    expect(result).toBe('A;B')
  })

  it('中文路径与含空格路径都能正确处理', () => {
    const entries = ['C:\\Users\\屈\\.devkit\\current\\nodejs', 'C:\\Program Files\\devkit\\bin']
    const merged = prependPathEntries('C:\\Windows', entries)
    expect(merged.value).toBe(`${entries[0]};${entries[1]};C:\\Windows`)
    expect(hasPathEntry(merged.value, 'c:\\users\\屈\\.devkit\\current\\nodejs\\')).toBe(true)

    const removed = removePathEntries(merged.value, entries)
    expect(removed).toBe('C:\\Windows')
  })

  it('反复激活/取消激活不会留下残留条目（幂等）', () => {
    const entries = ['C:\\devkit\\bin']
    let path = 'C:\\Windows'

    for (let i = 0; i < 5; i += 1) {
      path = prependPathEntries(path, entries).value
      expect(splitPath(path).filter((item) => item === 'C:\\devkit\\bin')).toHaveLength(1)
      path = removePathEntries(path, entries)
      expect(path).toBe('C:\\Windows')
    }
  })

  it('超长 PATH 不会被截断（setx 的 1024 字符陷阱）', () => {
    const long = Array.from({ length: 200 }, (_, index) => `C:\\very\\long\\path\\segment\\${index}`)
    const original = long.join(';')
    const merged = prependPathEntries(original, ['C:\\devkit\\bin'])
    expect(merged.value.length).toBeGreaterThan(1024)
    expect(merged.value.endsWith(original)).toBe(true)
    expect(removePathEntries(merged.value, ['C:\\devkit\\bin'])).toBe(original)
  })
})
