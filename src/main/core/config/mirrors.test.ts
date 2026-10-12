import { describe, expect, it } from 'vitest'
import { upsertIniSectionValue, upsertIniValue } from './mirrors'

describe('npmrc 行级编辑', () => {
  it('没有 registry 行时追加', () => {
    const result = upsertIniValue('', 'registry', 'https://registry.npmmirror.com')
    expect(result).toBe('registry=https://registry.npmmirror.com\n')
  })

  it('已有 registry 行时原地替换，保留其它行', () => {
    const input = ['//registry.npmjs.org/:_authToken=secret', 'registry=https://registry.npmjs.org', 'strict-ssl=false', ''].join('\n')
    const result = upsertIniValue(input, 'registry', 'https://registry.npmmirror.com')
    expect(result).toContain('//registry.npmjs.org/:_authToken=secret')
    expect(result).toContain('strict-ssl=false')
    expect(result).toContain('registry=https://registry.npmmirror.com')
    expect(result).not.toContain('registry=https://registry.npmjs.org')
    // 只替换一处，不能把 token 行也改掉
    expect(result.split('\n').filter((line) => line.startsWith('registry='))).toHaveLength(1)
  })

  it('大小写不敏感地识别已有的键', () => {
    const result = upsertIniValue('Registry = https://a\n', 'registry', 'https://b')
    expect(result).toBe('registry=https://b\n')
  })
})

describe('pip.ini 段级编辑', () => {
  it('没有 [global] 段时创建', () => {
    const result = upsertIniSectionValue('', 'global', 'index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple')
    expect(result).toContain('[global]')
    expect(result).toContain('index-url = https://pypi.tuna.tsinghua.edu.cn/simple')
  })

  it('已有 [global] 段时只在段内替换，不动其它段', () => {
    const input = ['[global]', 'index-url = https://pypi.org/simple', 'timeout = 60', '', '[install]', 'index-url = https://other/simple', ''].join('\n')
    const result = upsertIniSectionValue(input, 'global', 'index-url', 'https://mirror/simple')

    expect(result).toContain('index-url = https://mirror/simple')
    expect(result).toContain('timeout = 60')
    // [install] 段里的同名键不能被误改
    expect(result).toContain('[install]\nindex-url = https://other/simple')
  })

  it('[global] 段存在但没有该键时插入到段首', () => {
    const input = ['[global]', 'timeout = 60', ''].join('\n')
    const result = upsertIniSectionValue(input, 'global', 'index-url', 'https://mirror/simple')
    expect(result.split('\n')[1]).toBe('index-url = https://mirror/simple')
  })
})
