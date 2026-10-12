import { describe, expect, it } from 'vitest'
import {
  condaBlock,
  condarcHasConflicts,
  minimalMavenSettings,
  minimalNugetConfig,
  upsertDockerRegistryMirrors,
  upsertIniSectionValue,
  upsertIniValue,
  upsertMarkedBlock,
  upsertMavenMirror,
  upsertNugetSource
} from './mirrors'

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

describe('带标记的代码块（gradle / cargo 用）', () => {
  it('文件为空时插入标记块', () => {
    const result = upsertMarkedBlock('', 'allprojects { }')
    expect(result).toContain('# devkit-begin')
    expect(result).toContain('allprojects { }')
    expect(result).toContain('# devkit-end')
  })

  it('已有标记块时原地替换，不重复追加', () => {
    const first = upsertMarkedBlock('// user line\n', 'old-block')
    const second = upsertMarkedBlock(first, 'new-block')
    expect(second).toContain('new-block')
    expect(second).not.toContain('old-block')
    expect(second.split('# devkit-begin')).toHaveLength(2)
    expect(second).toContain('// user line')
  })

  it('传 null 时只移除标记块，保留用户自己的内容', () => {
    const content = upsertMarkedBlock('// user line\n', 'block')
    const cleaned = upsertMarkedBlock(content, null)
    expect(cleaned).not.toContain('# devkit-begin')
    expect(cleaned).not.toContain('block')
    expect(cleaned).toContain('// user line')
  })

  it('没有标记块时传 null 是空操作', () => {
    expect(upsertMarkedBlock('// user line\n', null)).toBe('// user line\n')
  })
})

describe('Maven settings.xml 镜像条目', () => {
  const URL = 'https://maven.aliyun.com/repository/public'

  it('已有 <mirrors> 时插入到里面', () => {
    const input = '<?xml version="1.0"?>\n<settings>\n  <mirrors>\n  </mirrors>\n</settings>\n'
    const result = upsertMavenMirror(input, URL)
    expect(result).toContain('<id>devkit-central</id>')
    expect(result).toContain(URL)
    expect(result).toContain('<mirrorOf>central</mirrorOf>')
    // 结构没有被破坏
    expect(result.match(/<mirrors>/g)).toHaveLength(1)
  })

  it('自闭合的 <mirrors/> 也能处理', () => {
    const result = upsertMavenMirror('<settings><mirrors/></settings>', URL)
    expect(result).toContain('<mirrors>')
    expect(result).toContain('</mirrors>')
    expect(result).toContain(URL)
  })

  it('没有 <mirrors> 时插到 </settings> 之前', () => {
    const result = upsertMavenMirror('<settings>\n</settings>\n', URL)
    expect(result).toContain('<mirrors>')
    expect(result.indexOf('<mirrors>')).toBeLessThan(result.indexOf('</settings>'))
  })

  it('重复应用是幂等的（不会插第二条）', () => {
    const once = upsertMavenMirror('<settings>\n</settings>\n', URL)
    const twice = upsertMavenMirror(once, URL)
    expect(twice.match(/<id>devkit-central<\/id>/g)).toHaveLength(1)
  })

  it('传 null 时移除条目，并把空的 <mirrors> 一起收掉', () => {
    const applied = upsertMavenMirror('<settings>\n</settings>\n', URL)
    const removed = upsertMavenMirror(applied, null)
    expect(removed).not.toContain('devkit-central')
    expect(removed).not.toContain('<mirrors>')
    expect(removed).toContain('</settings>')
  })

  it('保留用户已有的其它 mirror 条目', () => {
    const input = [
      '<settings>',
      '  <mirrors>',
      '    <mirror>',
      '      <id>company-internal</id>',
      '      <url>https://nexus.corp/repository/maven-public/</url>',
      '      <mirrorOf>*</mirrorOf>',
      '    </mirror>',
      '  </mirrors>',
      '</settings>'
    ].join('\n')
    const result = upsertMavenMirror(input, URL)
    expect(result).toContain('company-internal')
    expect(result).toContain('devkit-central')
  })

  it('结构无法识别时抛错而不是写坏文件', () => {
    expect(() => upsertMavenMirror('this is not xml', URL)).toThrow(/无法安全插入/)
  })

  it('生成的最小 settings.xml 是合法结构', () => {
    const minimal = minimalMavenSettings(URL)
    expect(minimal).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(minimal.match(/<mirrors>/g)).toHaveLength(1)
    expect(minimal.match(/<\/mirrors>/g)).toHaveLength(1)
    expect(minimal).toContain(URL)
  })
})

describe('conda .condarc', () => {
  it('生成标准的多通道块', () => {
    const block = condaBlock('https://mirrors.tuna.tsinghua.edu.cn/anaconda/')
    expect(block).toContain('channels:\n  - defaults')
    expect(block).toContain('https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main')
    expect(block).toContain('https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/r')
    expect(block).toContain('show_channel_urls: true')
    // 结尾斜杠不能导致双斜杠
    expect(block).not.toContain('anaconda//pkgs')
  })

  it('识别用户已经定义过 channels（避免 YAML 同名键重复）', () => {
    expect(condarcHasConflicts('channels:\n  - conda-forge\n')).toBe(true)
    expect(condarcHasConflicts('default_channels:\n  - https://x/pkgs/main\n')).toBe(true)
    expect(condarcHasConflicts('show_channel_urls: true\n')).toBe(false)
    expect(condarcHasConflicts('')).toBe(false)
  })

  it('自己写进去的块不会被当成冲突（可重复应用）', () => {
    const applied = upsertMarkedBlock('', condaBlock('https://mirror/anaconda'))
    expect(condarcHasConflicts(applied)).toBe(false)
  })
})

describe('NuGet.Config 包源', () => {
  const URL = 'https://mirrors.huaweicloud.com/repository/nuget/v3/index.json'

  it('已有 <packageSources> 时插入', () => {
    const result = upsertNugetSource('<configuration>\n  <packageSources>\n  </packageSources>\n</configuration>', URL)
    expect(result).toContain('key="devkit"')
    expect(result).toContain(URL)
    expect(result.match(/<packageSources>/g)).toHaveLength(1)
  })

  it('重复应用是幂等的', () => {
    const once = upsertNugetSource('<configuration>\n</configuration>', URL)
    const twice = upsertNugetSource(once, URL)
    expect(twice.match(/key="devkit"/g)).toHaveLength(1)
  })

  it('移除后不留下空标签', () => {
    const applied = upsertNugetSource('<configuration>\n</configuration>', URL)
    const removed = upsertNugetSource(applied, null)
    expect(removed).not.toContain('devkit')
    expect(removed).not.toContain('<packageSources>')
  })

  it('结构不可识别时抛错', () => {
    expect(() => upsertNugetSource('not xml', URL)).toThrow(/无法安全插入/)
  })

  it('最小配置是合法结构', () => {
    const minimal = minimalNugetConfig(URL)
    expect(minimal).toContain('<?xml version="1.0" encoding="utf-8"?>')
    expect(minimal.match(/<packageSources>/g)).toHaveLength(1)
    expect(minimal.match(/<\/packageSources>/g)).toHaveLength(1)
  })
})

describe('Docker daemon.json', () => {
  it('空文件时写出 registry-mirrors', () => {
    const result = upsertDockerRegistryMirrors('', 'https://docker.mirrors.ustc.edu.cn')
    expect(JSON.parse(result)).toEqual({ 'registry-mirrors': ['https://docker.mirrors.ustc.edu.cn'] })
  })

  it('保留用户已有的其它键', () => {
    const input = JSON.stringify({ 'data-root': 'D:\\docker', debug: true }, null, 2)
    const parsed = JSON.parse(upsertDockerRegistryMirrors(input, 'https://mirror'))
    expect(parsed['data-root']).toBe('D:\\docker')
    expect(parsed.debug).toBe(true)
    expect(parsed['registry-mirrors']).toEqual(['https://mirror'])
  })

  it('移除时只删 registry-mirrors', () => {
    const input = JSON.stringify({ 'registry-mirrors': ['https://a'], debug: true })
    const parsed = JSON.parse(upsertDockerRegistryMirrors(input, null))
    expect(parsed['registry-mirrors']).toBeUndefined()
    expect(parsed.debug).toBe(true)
  })

  it('文件不是合法 JSON 时拒绝修改（而不是覆盖掉用户的配置）', () => {
    expect(() => upsertDockerRegistryMirrors('{ not json', 'https://mirror')).toThrow(/不是合法 JSON/)
  })
})
