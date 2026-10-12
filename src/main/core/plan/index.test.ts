import { describe, expect, it } from 'vitest'
import type { PlanItem, PlanOptions, ToolManifest, ToolVersionSpec } from '@shared/types'
import { buildPlan, makePlanId, PlanBuildFailure, summarize, topologicalSort } from './index'

const OPTIONS: PlanOptions = {
  concurrency: 1,
  mirrorPreference: 'official',
  proxy: null,
  createRestorePoint: false,
  dryRun: false
}

const VERSIONS_ROOT = 'C:\\Users\\屈\\.devkit\\versions'

function installableVersion(version: string, overrides: Partial<ToolVersionSpec> = {}): ToolVersionSpec {
  return {
    version,
    channel: 'stable',
    arch: 'x64',
    installScope: 'user',
    source: { url: `https://example.com/${version}.zip`, sha256: 'a'.repeat(64) },
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    ...overrides
  }
}

function makeTool(id: string, versions: ToolVersionSpec[], overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id,
    category: 'tool',
    tier: 'L1',
    status: 'ready',
    name: { 'zh-CN': id, 'en-US': id },
    description: { 'zh-CN': id, 'en-US': id },
    detect: { files: [`C:\\${id}.exe`] },
    versions,
    ...overrides
  }
}

function build(input: { selections: { toolId: string; version?: string }[]; tools: ToolManifest[] }) {
  return buildPlan({
    selections: input.selections,
    tools: input.tools,
    options: OPTIONS,
    devkitVersion: '0.1.0',
    manifestRevision: '2026-10-10',
    versionsRoot: VERSIONS_ROOT
  })
}

describe('buildPlan', () => {
  it('按选择生成计划并算好安装目录', () => {
    const tools = [makeTool('nodejs', [installableVersion('24.21.0', { recommended: true })])]
    const plan = build({ selections: [{ toolId: 'nodejs' }], tools })

    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].version).toBe('24.21.0')
    expect(plan.items[0].installDir).toBe(`${VERSIONS_ROOT}\\nodejs\\24.21.0`)
    expect(plan.items[0].state).toBe('pending')
    expect(plan.summary).toEqual({ total: 1, success: 0, failed: 0, skipped: 0, cancelled: 0 })
  })

  it('尊重用户指定的版本而不是推荐版本', () => {
    const tools = [
      makeTool('nodejs', [
        installableVersion('24.21.0', { recommended: true }),
        installableVersion('24.20.0')
      ])
    ]
    const plan = build({ selections: [{ toolId: 'nodejs', version: '24.20.0' }], tools })
    expect(plan.items[0].version).toBe('24.20.0')
  })

  it('重复勾选同一个工具只生成一项', () => {
    const tools = [makeTool('nodejs', [installableVersion('24.21.0')])]
    const plan = build(
      { selections: [{ toolId: 'nodejs' }, { toolId: 'nodejs' }], tools }
    )
    expect(plan.items).toHaveLength(1)
  })

  it('requiresAdmin 由 installScope 推导', () => {
    const tools = [
      makeTool('pg', [installableVersion('16.0', { installScope: 'machine' })])
    ]
    const plan = build({ selections: [{ toolId: 'pg' }], tools })
    expect(plan.items[0].requiresAdmin).toBe(true)
  })

  it('清单里没有的工具会被拒绝', () => {
    expect(() => build({ selections: [{ toolId: 'nope' }], tools: [] })).toThrow(PlanBuildFailure)
  })

  it('安装信息未补齐的项会被拒绝，并说明原因', () => {
    const tools = [
      makeTool(
        'cmake',
        [{ version: '3.30.0', channel: 'stable', arch: 'x64', installScope: 'user' }],
        { status: 'detect-only' }
      )
    ]
    try {
      build({ selections: [{ toolId: 'cmake' }], tools })
      expect.unreachable('应该抛出 PlanBuildFailure')
    } catch (error) {
      expect(error).toBeInstanceOf(PlanBuildFailure)
      expect((error as PlanBuildFailure).problems[0].reason).toContain('尚未补齐')
    }
  })

  it('没有任何版本的项会被拒绝', () => {
    const tools = [makeTool('cmake', [], { status: 'detect-only' })]
    try {
      build({ selections: [{ toolId: 'cmake' }], tools })
      expect.unreachable('应该抛出 PlanBuildFailure')
    } catch (error) {
      expect((error as PlanBuildFailure).problems[0].reason).toContain('没有可安装的版本')
    }
  })

  it('模板名写错会在构建阶段就被拦下', () => {
    const tools = [
      makeTool('nodejs', [
        installableVersion('24.21.0', {
          install: { type: 'zip', template: 'no-such-template' }
        })
      ])
    ]
    try {
      build({ selections: [{ toolId: 'nodejs' }], tools })
      expect.unreachable('应该抛出 PlanBuildFailure')
    } catch (error) {
      expect((error as PlanBuildFailure).problems[0].reason).toContain('未知的安装模板')
    }
  })

  it('一个都没选时报错', () => {
    expect(() => build({ selections: [], tools: [] })).toThrow(/没有选择任何可安装的项/)
  })
})

describe('依赖排序', () => {
  it('被依赖的排在前面（即使勾选顺序相反）', () => {
    const tools = [
      makeTool('docker', [installableVersion('1.0', { dependsOn: ['wsl2'] })]),
      makeTool('wsl2', [installableVersion('2.0')])
    ]
    const plan = build({ selections: [{ toolId: 'docker' }, { toolId: 'wsl2' }], tools })
    expect(plan.items.map((item) => item.id)).toEqual(['wsl2', 'docker'])
  })

  it('出现依赖环时抛错而不是死循环', () => {
    const items = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] }
    ] as unknown as PlanItem[]
    expect(() => topologicalSort(items)).toThrow(/依赖出现环/)
  })

  it('依赖不在本次计划里时不报错（排序只管计划内）', () => {
    const items = [{ id: 'a', dependsOn: ['not-selected'] }] as unknown as PlanItem[]
    expect(topologicalSort(items).map((item) => item.id)).toEqual(['a'])
  })
})

describe('summarize / makePlanId', () => {
  it('按状态计数', () => {
    const items = [
      { state: 'success' },
      { state: 'success' },
      { state: 'failed' },
      { state: 'skipped' },
      { state: 'pending' }
    ] as unknown as PlanItem[]
    expect(summarize(items)).toEqual({
      total: 5,
      success: 2,
      failed: 1,
      skipped: 1,
      cancelled: 0
    })
  })

  it('planId 形如 时间戳-随机，且两次不重复', () => {
    const first = makePlanId(new Date(2026, 9, 10, 15, 30, 0))
    expect(first).toMatch(/^20261010-153000-[0-9a-f]{4}$/)
    expect(first).not.toBe(makePlanId(new Date(2026, 9, 10, 15, 30, 0)))
  })
})
