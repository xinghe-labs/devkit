import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonFile } from '../../utils/fs'
import { createManifestValidator, validateManifests, type RawManifestFile } from './validate'

const manifestDir = resolve('resources/manifest')
const toolsDir = join(manifestDir, 'tools')
const validate = createManifestValidator(
  readJsonFile<object>(join(manifestDir, 'schema', 'tool.schema.json'))
)

function loadShipped(): RawManifestFile[] {
  return readdirSync(toolsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ file: name, data: readJsonFile(join(toolsDir, name)) }))
}

function makeTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    category: 'tool',
    tier: 'L1',
    status: 'detect-only',
    name: { 'zh-CN': '演示', 'en-US': 'Demo' },
    description: { 'zh-CN': '演示工具', 'en-US': 'Demo tool' },
    detect: { files: ['C:\\demo\\demo.exe'] },
    versions: [],
    ...overrides
  }
}

function check(data: unknown, file = 'demo.json') {
  return validateManifests([{ file, data }], validate)
}

describe('随包发布的清单', () => {
  it('全部通过 Schema 与语义校验', () => {
    const { errors } = validateManifests(loadShipped(), validate)
    expect(errors).toEqual([])
  })

  it('文件名与 id 一致，避免清单被放错位置后难以排查', () => {
    for (const entry of loadShipped()) {
      const id = (entry.data as { id: string }).id
      expect(`${id}.json`).toBe(entry.file)
    }
  })

  it('每个清单都至少声明一种检测手段', () => {
    const { tools } = validateManifests(loadShipped(), validate)
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      const methods = [
        tool.detect.commands?.length ?? 0,
        tool.detect.files?.length ?? 0,
        tool.detect.registry?.length ?? 0
      ]
      expect(methods.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
    }
  })

  it('依赖引用的工具都真实存在', () => {
    const { tools } = validateManifests(loadShipped(), validate)
    const ids = new Set(tools.map((tool) => tool.id))
    for (const tool of tools) {
      for (const version of tool.versions) {
        for (const dependency of version.dependsOn ?? []) {
          expect(ids.has(dependency), `${tool.id} 依赖 ${dependency}`).toBe(true)
        }
      }
    }
  })

  it('标记为 ready 的清单，版本信息必须完整', () => {
    const { tools } = validateManifests(loadShipped(), validate)
    for (const tool of tools.filter((item) => item.status === 'ready')) {
      expect(tool.versions.length).toBeGreaterThan(0)
      for (const version of tool.versions) {
        expect(version.source?.url).toBeTruthy()
        expect(version.source?.sha256).toBeTruthy()
        expect(version.install?.template).toBeTruthy()
      }
    }
  })
})

describe('Schema 结构约束', () => {
  it('接受最小合法清单', () => {
    const { tools, errors } = check(makeTool())
    expect(errors).toEqual([])
    expect(tools).toHaveLength(1)
  })

  it('拒绝缺少必填字段', () => {
    const { errors } = check({ id: 'demo' })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('拒绝非法的 id 格式', () => {
    expect(check(makeTool({ id: 'Demo Tool' })).errors.length).toBeGreaterThan(0)
    expect(check(makeTool({ id: 'A' })).errors.length).toBeGreaterThan(0)
  })

  it('拒绝未知字段（防止拼错字段名却静默生效）', () => {
    expect(check(makeTool({ unknownField: 1 })).errors.length).toBeGreaterThan(0)
  })

  it('拒绝 http 下载地址（NFR-1 只允许 https）', () => {
    const data = makeTool({
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'user',
          source: { url: 'http://example.com/a.exe' }
        }
      ]
    })
    expect(check(data).errors.length).toBeGreaterThan(0)
  })

  it('拒绝缺少 installScope 的版本（不存在全局默认）', () => {
    const data = makeTool({
      versions: [{ version: '1.0.0', channel: 'stable', arch: 'x64' }]
    })
    expect(check(data).errors.length).toBeGreaterThan(0)
  })

  it('拒绝非法日期格式', () => {
    const data = makeTool({
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'user',
          releaseDate: '2026/01/01'
        }
      ]
    })
    expect(check(data).errors.length).toBeGreaterThan(0)
  })

  it('拒绝含非法字符的安装模板名（防止清单自定义命令行）', () => {
    const data = makeTool({
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'machine',
          install: { type: 'msi', template: 'msi-silent; rm -rf /' }
        }
      ]
    })
    expect(check(data).errors.length).toBeGreaterThan(0)
  })

  it('拒绝只有一种语言之外的非法语言键', () => {
    expect(check(makeTool({ name: { chinese: '中文' } })).errors.length).toBeGreaterThan(0)
  })
})

describe('语义约束', () => {
  it('id 重复时报错并指向后一个文件', () => {
    const { errors } = validateManifests(
      [
        { file: 'a.json', data: makeTool({ id: 'dup' }) },
        { file: 'b.json', data: makeTool({ id: 'dup' }) }
      ],
      validate
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].file).toBe('b.json')
  })

  it('同一工具多个 recommended 版本时报错', () => {
    const data = makeTool({
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'user',
          recommended: true
        },
        {
          version: '2.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'user',
          recommended: true
        }
      ]
    })
    expect(check(data).errors.length).toBeGreaterThan(0)
  })

  it('status 为 ready 但没有版本时报错', () => {
    expect(check(makeTool({ status: 'ready', versions: [] })).errors.length).toBeGreaterThan(0)
  })

  it('status 为 ready 但缺少 sha256 时报错', () => {
    const data = makeTool({
      status: 'ready',
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'machine',
          source: { url: 'https://example.com/a.msi' },
          install: { type: 'msi', template: 'msi-silent' }
        }
      ]
    })
    const { errors } = check(data)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain('sha256')
  })

  it('status 为 ready 且信息完整时通过', () => {
    const data = makeTool({
      status: 'ready',
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'machine',
          source: { url: 'https://example.com/a.msi', sha256: 'a'.repeat(64) },
          install: { type: 'msi', template: 'msi-silent' }
        }
      ]
    })
    expect(check(data).errors).toEqual([])
  })

  it('detect-only 的清单允许没有任何版本', () => {
    expect(check(makeTool({ status: 'detect-only', versions: [] })).errors).toEqual([])
  })

  it('dependsOn 指向不存在的工具时报错', () => {
    const data = makeTool({
      versions: [
        {
          version: '1.0.0',
          channel: 'stable',
          arch: 'x64',
          installScope: 'machine',
          dependsOn: ['not-a-real-tool']
        }
      ]
    })
    const { errors } = check(data)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain('not-a-real-tool')
  })
})
