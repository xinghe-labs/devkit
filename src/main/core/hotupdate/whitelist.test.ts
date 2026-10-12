import { describe, expect, it } from 'vitest'
import type { ToolManifest } from '@shared/types'
import { HOT_UPDATE_ALLOWED_KEYS, mergeHotUpdate } from './whitelist'

function localManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: 'nodejs',
    category: 'runtime',
    tier: 'L1',
    status: 'ready',
    provider: 'direct',
    name: { 'zh-CN': 'Node.js', 'en-US': 'Node.js' },
    description: { 'zh-CN': '运行时', 'en-US': 'Runtime' },
    homepage: 'https://nodejs.org',
    license: { spdx: 'MIT', redistributable: true },
    detect: {
      commands: [{ cmd: 'node', args: ['-v'], expectRegex: 'v\\d+' }],
      files: ['%ProgramFiles%\\nodejs\\node.exe']
    },
    versions: [
      {
        version: '24.21.0',
        channel: 'lts',
        recommended: true,
        arch: 'x64',
        installScope: 'user',
        source: { url: 'https://nodejs.org/dist/v24.21.0/node.zip', sha256: 'a'.repeat(64) },
        install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
        activate: { pathEntries: ['{currentDir}'] },
        verify: { cmd: '{installDir}\\node.exe', args: ['-v'], expectRegex: 'v24\\.' }
      }
    ],
    ...overrides
  }
}

const HASH = 'b'.repeat(64)

describe('清单热更新字段白名单（FR-15）', () => {
  it('白名单里没有 detect / install / activate', () => {
    expect(HOT_UPDATE_ALLOWED_KEYS).not.toContain('detect')
    expect(HOT_UPDATE_ALLOWED_KEYS).not.toContain('install')
    expect(HOT_UPDATE_ALLOWED_KEYS).not.toContain('activate')
    expect(HOT_UPDATE_ALLOWED_KEYS).not.toContain('verify')
  })

  it('接受白名单字段（版本号、地址、校验和、体积、镜像）', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          recommended: true,
          arch: 'x64',
          releaseDate: '2026-10-01',
          sizeBytes: 12345,
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH },
          mirrors: [{ name: 'huaweicloud', url: 'https://mirrors.huaweicloud.com/node.zip' }]
        }
      ]
    })

    expect(result.accepted).toBe(1)
    const version = result.manifest.versions[0]
    expect(version.version).toBe('24.22.0')
    expect(version.source?.sha256).toBe(HASH)
    expect(version.sizeBytes).toBe(12345)
    expect(version.releaseDate).toBe('2026-10-01')
    expect(version.mirrors?.[0].name).toBe('huaweicloud')
  })

  it('远程改 install / activate / verify 一律无效（继承本地）', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH },
          // 这三个字段如果生效，热更新通道就等于任意命令执行通道
          install: { type: 'msi', template: 'msi-install', params: { properties: 'X=1' } },
          activate: { pathEntries: ['{currentDir}'], env: { EVIL: 'C:\\evil.exe' } },
          verify: { cmd: 'C:\\evil.exe', args: [] },
          detect: { commands: [{ cmd: 'node' }] }
        }
      ]
    })

    const version = result.manifest.versions[0]
    expect(version.install?.template).toBe('zip-into-version-dir')
    expect(version.install?.params?.stripComponents).toBe('1')
    expect(version.activate?.env).toBeUndefined()
    expect(version.verify?.cmd).toBe('{installDir}\\node.exe')
    expect(result.manifest.detect.commands?.[0].expectRegex).toBe('v\\d+')

    // 被忽略的字段要有记录，不能静默吞掉
    const reasons = result.rejected.join('\n')
    expect(reasons).toContain('install')
    expect(reasons).toContain('activate')
    expect(reasons).toContain('verify')
    expect(reasons).toContain('detect')
  })

  it('拒绝非 https 下载地址', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'http://evil.example.com/node.zip', sha256: HASH }
        }
      ]
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected.join()).toContain('https')
  })

  it('拒绝缺失或格式错误的 SHA-256（没有校验和的版本不允许下发）', () => {
    for (const sha256 of [undefined, '', 'not-a-hash', 'a'.repeat(63)]) {
      const result = mergeHotUpdate(localManifest(), {
        id: 'nodejs',
        versions: [
          {
            version: '24.22.0',
            channel: 'lts',
            installScope: 'user',
            source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256 }
          }
        ]
      })
      expect(result.accepted, `sha256=${String(sha256)}`).toBe(0)
    }
  })

  it('拒绝缺少 installScope 的版本', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH }
        }
      ]
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected.join()).toContain('installScope')
  })

  it('拒绝 id 不匹配与结构不对的远程条目', () => {
    expect(mergeHotUpdate(localManifest(), { id: 'other', versions: [] }).accepted).toBe(0)
    expect(mergeHotUpdate(localManifest(), { id: 'nodejs' }).accepted).toBe(0)
    expect(mergeHotUpdate(localManifest(), null).accepted).toBe(0)
    expect(mergeHotUpdate(localManifest(), 'nope').accepted).toBe(0)
  })

  it('本地没有可继承的安装模板时整条拒绝', () => {
    const bare = localManifest({
      versions: [
        {
          version: '24.21.0',
          channel: 'lts',
          recommended: true,
          arch: 'x64',
          installScope: 'user'
        }
      ]
    })
    const result = mergeHotUpdate(bare, {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH }
        }
      ]
    })
    expect(result.accepted).toBe(0)
    expect(result.rejected.join()).toContain('没有可继承的安装模板')
  })

  it('最多只保留一个 recommended', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          recommended: true,
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/a.zip', sha256: HASH }
        },
        {
          version: '24.23.0',
          channel: 'lts',
          recommended: true,
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.23.0/b.zip', sha256: HASH }
        }
      ]
    })
    expect(result.manifest.versions.filter((version) => version.recommended)).toHaveLength(1)
    expect(result.rejected.join()).toContain('recommended')
  })

  it('远程没标 recommended 时沿用本地的推荐版本号', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.21.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.21.0/node.zip', sha256: HASH }
        },
        {
          version: '24.22.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH }
        }
      ]
    })
    expect(result.manifest.versions.find((version) => version.recommended)?.version).toBe('24.21.0')
  })

  it('镜像条目必须是 https', () => {
    const result = mergeHotUpdate(localManifest(), {
      id: 'nodejs',
      versions: [
        {
          version: '24.22.0',
          channel: 'lts',
          installScope: 'user',
          source: { url: 'https://nodejs.org/dist/v24.22.0/node.zip', sha256: HASH },
          mirrors: [
            { name: 'bad', url: 'http://mirror.example.com/node.zip' },
            { name: 'good', url: 'https://mirror.example.com/node.zip' }
          ]
        }
      ]
    })
    expect(result.manifest.versions[0].mirrors).toHaveLength(1)
    expect(result.manifest.versions[0].mirrors?.[0].name).toBe('good')
  })
})
