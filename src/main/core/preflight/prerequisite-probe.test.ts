import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionResult } from '@shared/types'

/** 这台"机器上"已经有什么 —— 由每个用例设置 */
let installedOnMachine = new Set<string>()
/** 哪些工具会报「装了但没生效」 */
let pathMissingOnMachine = new Set<string>()

const detectTool = vi.fn(
  async (tool: { id: string }): Promise<DetectionResult> => ({
    toolId: tool.id,
    status: installedOnMachine.has(tool.id)
      ? 'installed'
      : pathMissingOnMachine.has(tool.id)
        ? 'path-missing'
        : 'not-installed',
    installedVersion: installedOnMachine.has(tool.id) ? '1.0.0' : null,
    recommendedVersion: '1.0.0',
    versionMatches: true,
    evidence: null,
    error: null,
    durationMs: 0
  })
)

vi.mock('../detect', () => ({ detectTool: (tool: { id: string }) => detectTool(tool) }))

const { indexById } = await import('@shared/manifest')
const { runPreflight } = await import('./index')
const { makePlan, makeItem, makeTool } = await import('./test-fixtures')

const tools = indexById([
  makeTool('maven', 'Apache Maven', ['jdk-temurin']),
  makeTool('jdk-temurin', 'Eclipse Temurin JDK'),
  makeTool('ninja', 'Ninja')
])

const run = (items: { id: string; dependsOn: string[] }[], availableToolIds?: string[]) =>
  runPreflight({
    plan: makePlan(items.map((item) => makeItem(item.id, item.dependsOn))),
    tools,
    targetPath: 'C:\\',
    maxProbes: 0,
    availableToolIds: new Set(availableToolIds)
  })

beforeEach(() => {
  installedOnMachine = new Set<string>()
  pathMissingOnMachine = new Set<string>()
  detectTool.mockClear()
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
    const result = await run([{ id: 'maven', dependsOn: ['jdk-temurin'] }], [])

    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites')?.message).toContain(
      '前置依赖已满足'
    )
    expect(detectTool).toHaveBeenCalledTimes(1)
  })

  it('机器上确实没有 → 阻断（探测结果说了算）', async () => {
    const result = await run([{ id: 'maven', dependsOn: ['jdk-temurin'] }], [])

    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites:jdk-temurin')?.level).toBe(
      'error'
    )
  })

  it('渲染进程送来一份过期的"已装"列表也不会被带偏：两者取并集', async () => {
    // 送来说有、实际没有 → 仍然放行（宁可漏报也不误拦）。
    // 真正的兜底在安装阶段的 npm 前置检查与装完的自检。
    const result = await run([{ id: 'maven', dependsOn: ['jdk-temurin'] }], ['jdk-temurin'])
    expect(result.ok).toBe(true)
    // 既然渲染进程说有了，就不该再多花几百毫秒去探测
    expect(detectTool).not.toHaveBeenCalled()
  })

  it('**依赖已经在计划里要装了 → 不探测**（探测改变不了结论，白等几百毫秒）', async () => {
    const result = await run([
      { id: 'maven', dependsOn: ['jdk-temurin'] },
      { id: 'jdk-temurin', dependsOn: [] }
    ])

    expect(result.ok).toBe(true)
    expect(detectTool).not.toHaveBeenCalled()
  })

  it('没有依赖的工具不会触发任何探测', async () => {
    const result = await run([{ id: 'ninja', dependsOn: [] }])

    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites')?.message).toContain(
      '没有额外的前置依赖'
    )
    expect(detectTool).not.toHaveBeenCalled()
  })

  it('**装了但没生效（path-missing）不算"有"** —— 那正是 mvn 会失败的状态', async () => {
    // jdk-temurin 的 path-missing 只能来自注册表，含义是"装了但 java 不在 PATH 上"，
    // 也就是 `mvn -v` 报「JAVA_HOME ... not defined correctly」的那个状态。
    // 把它当成"有"就是漏拦。
    pathMissingOnMachine = new Set(['jdk-temurin'])
    const result = await run([{ id: 'maven', dependsOn: ['jdk-temurin'] }], [])

    expect(result.ok).toBe(false)
    const check = result.checks.find((item) => item.id === 'tool-prerequisites:jdk-temurin')
    expect(check?.level).toBe('error')
    // 但措辞要说清是"装了没生效"，而不是"没检测到" —— 两者用户要做的事不一样
    expect(check?.message).toContain('已经装在这台机器上')
    expect(check?.message).toContain('激活')
  })
})
