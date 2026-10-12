import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolManifest } from '@shared/types'
import { INSTALL_TEMPLATES } from '../templates'
import { listBuiltinPresets as builtinPresets } from '../presets'

/**
 * AI 类清单的**跨清单不变量**。
 *
 * 单个清单的 Schema 校验只能保证"结构合法"，保证不了"这一批清单彼此自洽"：
 * 例如 npm 装的工具必须声明 binName、verify 必须指向那个 bin、必须声明 activate
 * （否则装完用户根本用不了）。这些约束只有把整批清单读出来才能检查。
 */
function loadManifests(): ToolManifest[] {
  const dir = resolve(process.cwd(), 'resources', 'manifest', 'tools')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as ToolManifest)
}

const manifests = loadManifests()
const aiTools = manifests.filter((tool) => tool.category === 'ai')
const npmVersions = manifests.flatMap((tool) =>
  tool.versions
    .filter((version) => version.install?.type === 'npm')
    .map((version) => ({ tool, version }))
)

describe('AI 类清单', () => {
  it('至少覆盖到主要几家（不是只加了一两个凑数）', () => {
    expect(aiTools.length).toBeGreaterThanOrEqual(6)
    const ids = aiTools.map((tool) => tool.id)
    expect(ids).toContain('claude-code')
    expect(ids).toContain('codex')
    expect(ids).toContain('opencode')
  })

  it('每个 AI 工具都必须能激活（否则装完用户敲不到命令）', () => {
    for (const tool of aiTools) {
      for (const version of tool.versions) {
        expect(version.activate, `${tool.id}@${version.version} 没有 activate`).toBeTruthy()
        expect(
          version.activate?.pathEntries?.some((entry) => entry.includes('{currentDir}')),
          `${tool.id} 的 activate 没有指向 {currentDir}`
        ).toBe(true)
      }
    }
  })

  it('每个 AI 工具都必须有自检命令', () => {
    for (const tool of aiTools) {
      for (const version of tool.versions) {
        expect(version.verify, `${tool.id}@${version.version} 没有 verify`).toBeTruthy()
      }
    }
  })

  it('npm 装的 AI 工具必须是 L2（第三方发行物，不进离线包）', () => {
    for (const { tool } of npmVersions) {
      expect(tool.tier, `${tool.id} 用 npm 装却不是 L2`).toBe('L2')
    }
  })

  it('有独立二进制的 AI 工具走直链模型（L1 + zip 模板）', () => {
    const native = aiTools.filter((tool) =>
      tool.versions.some((version) => version.install?.type === 'zip')
    )
    expect(native.length).toBeGreaterThanOrEqual(2)
    for (const tool of native) {
      expect(tool.tier, `${tool.id} 有官方二进制却标成了非 L1`).toBe('L1')
    }
  })

  it('npm 类清单的供应链说明必须写清楚（不能假装和直链 + SHA-256 等价）', () => {
    for (const { tool } of npmVersions) {
      const note = `${tool.notes?.['zh-CN'] ?? ''}${tool.notes?.['en-US'] ?? ''}`
      expect(note, `${tool.id} 的 notes 没有说明 npm 的供应链差异`).toMatch(
        /npm 在安装时|resolves that package's dependencies|不在 devkit 的校验范围/
      )
    }
  })
})

describe('npm 类清单的技术不变量', () => {
  it('install.template 必须是 npm 模板，且带 binName', () => {
    expect(npmVersions.length).toBeGreaterThanOrEqual(4)
    for (const { tool, version } of npmVersions) {
      expect(version.install?.template).toBe('npm-global-into-version-dir')
      expect(version.install?.params?.binName, `${tool.id} 缺 binName`).toBeTruthy()
    }
  })

  it('verify 必须指向 binName 对应的 .cmd（Windows 上 npm 装出来的是 .cmd）', () => {
    for (const { tool, version } of npmVersions) {
      const binName = version.install?.params?.binName ?? ''
      expect(version.verify?.cmd, `${tool.id} 的 verify 与 binName 不匹配`).toContain(
        `${binName}.cmd`
      )
      expect(version.verify?.cmd).toContain('{installDir}')
    }
  })

  it('模板表里确实有 npm 模板，且类型是 npm', () => {
    expect(INSTALL_TEMPLATES['npm-global-into-version-dir']?.type).toBe('npm')
  })

  it('每个版本都有 https 的下载地址与 64 位十六进制 SHA-256', () => {
    for (const { tool, version } of npmVersions) {
      expect(version.source?.url, `${tool.id} 缺下载地址`).toMatch(/^https:\/\//)
      expect(version.source?.sha256, `${tool.id} 的 SHA-256 不合法`).toMatch(/^[a-f0-9]{64}$/)
      expect(version.sizeBytes, `${tool.id} 缺体积`).toBeGreaterThan(0)
    }
  })

  it('至少有一个镜像回退（npm registry 直连在国内不稳）', () => {
    for (const { tool, version } of npmVersions) {
      expect((version.mirrors ?? []).length, `${tool.id} 没有任何镜像`).toBeGreaterThan(0)
      for (const mirror of version.mirrors ?? []) {
        expect(mirror.url).toMatch(/^https:\/\//)
      }
    }
  })
})

describe('AI 预设', () => {
  it('内置预设里有「AI 编码」，且它引用的工具都真实存在', () => {
    // 预设的引用完整性在 presets/index.test.ts 里已整体校验；
    // 这里额外钉住「必须有这么一套 AI 预设」这个产品事实。
    const known = new Set(manifests.map((tool) => tool.id))
    const aiPreset = builtinPresets().find((preset) => preset.id === 'ai')
    expect(aiPreset, '内置预设里没有 id=ai 的那一套').toBeTruthy()
    for (const selection of aiPreset!.tools) {
      expect(known.has(selection.toolId), `AI 预设引用了不存在的工具 ${selection.toolId}`).toBe(true)
    }
    // 至少要包含一个 AI agent，否则这套预设名不副实
    const aiIds = new Set(aiTools.map((tool) => tool.id))
    expect(aiPreset!.tools.some((selection) => aiIds.has(selection.toolId))).toBe(true)
  })
})
