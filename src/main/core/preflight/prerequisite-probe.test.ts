import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionResult } from '@shared/types'

/** 这台"机器上"已经有什么 —— 由每个用例设置 */
let installedOnMachine = new Set<string>()

vi.mock('../detect', () => ({
  detectTool: async (tool: { id: string }): Promise<DetectionResult> => ({
    toolId: tool.id,
    status: installedOnMachine.has(tool.id) ? 'installed' : 'not-installed',
    installedVersion: installedOnMachine.has(tool.id) ? '1.0.0' : null,
    recommendedVersion: '1.0.0',
    versionMatches: true,
    evidence: null,
    error: null,
    durationMs: 0
  })
}))

const { indexById } = await import('@shared/manifest')
const { runPreflight } = await import('./index')
const { makePlan, makeItem, makeTool } = await import('./test-fixtures')

const tools = indexById([
  makeTool('maven', 'Apache Maven', ['jdk-temurin']),
  makeTool('jdk-temurin', 'Eclipse Temurin JDK'),
  makeTool('ninja', 'Ninja')
])

const run = (ids: string[], availableToolIds?: string[]) =>
  runPreflight({
    plan: makePlan(ids.map((id) => makeItem(id, id === 'maven' ? ['jdk-temurin'] : []))),
    tools,
    targetPath: 'C:\\',
    maxProbes: 0,
    availableToolIds: new Set(availableToolIds)
  })

beforeEach(() => {
  installedOnMachine = new Set<string>()
})

/**
 * 预检会**自己探测**一遍前置依赖，而不是只信渲染进程送来的那份列表。
 *
 * 原因：这台机器上完整检测（含注册表扫描）要 7 秒多，用户完全可能在那之前就点了安装。
 * 那时送来的列表是空的，「本机早有 JDK、这次只想装 Maven」就会被误拦 ——
 * 而这恰恰是我们最不想看到的假阳性（用户一旦被误拦就不再信任这个检查）。
 */
describe('预检自己探测前置依赖（不依赖渲染进程的检测时机）', () => {
  it('**availableToolIds 是空的，但机器上确实有 JDK → 放行**', async () => {
    installedOnMachine = new Set(['jdk-temurin'])
    const result = await run(['maven'], [])

    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites')?.message).toContain(
      '前置依赖已满足'
    )
  })

  it('机器上确实没有 → 阻断（探测结果说了算）', async () => {
    installedOnMachine = new Set()
    const result = await run(['maven'], [])

    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites:jdk-temurin')?.level).toBe(
      'error'
    )
  })

  it('渲染进程送来一份过期的"已装"列表也不会被带偏：探测优先，两者取并集', async () => {
    // 送来说有，实际没有 → 仍然按"有"放行（宁可漏报也不误拦），
    // 真正的兜底在安装阶段的 npm/JVM 前置检查与自检
    installedOnMachine = new Set()
    const result = await run(['maven'], ['jdk-temurin'])
    expect(result.ok).toBe(true)
  })

  it('没有依赖的工具不会触发任何探测', async () => {
    const result = await run(['ninja'], [])
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites')?.message).toContain(
      '没有额外的前置依赖'
    )
  })
})
