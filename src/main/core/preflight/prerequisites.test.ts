import { describe, expect, it } from 'vitest'
import { indexById } from '@shared/manifest'
import type { InstallPlan } from '@shared/types'
import { makeItem, makePlan, makeTool } from './test-fixtures'
import { runPreflight } from './index'

/**
 * 工具间的**隐藏前置依赖**。
 *
 * 这类问题只在干净机器上暴露，所以一直没被发现：
 *  · 选了 Maven 没选 JDK → 下载解压都成功，然后 `mvn -v` 报
 *    「JAVA_HOME environment variable is not defined correctly」（实测复现过）
 *  · 选了 Claude Code 没选 Node → `npm install` 根本跑不起来
 *
 * 用户看到的是一句和"该一起装 JDK"毫无关系的报错，而预检当时是全绿的。
 */

const maven = makeTool('maven', 'Apache Maven', ['jdk-temurin'])
const jdk = makeTool('jdk-temurin', 'Eclipse Temurin JDK')
const tools = indexById([maven, jdk])

const preflight = (plan: InstallPlan, availableToolIds?: string[]) =>
  runPreflight({ plan, tools, targetPath: 'C:\\', maxProbes: 0, availableToolIds: new Set(availableToolIds) })

describe('预检：工具间的前置依赖', () => {
  it('**选了 Maven 却没选 JDK、机器上也没有 → 阻断，并说清该补哪一个**', async () => {
    const result = await preflight(makePlan([makeItem('maven', ['jdk-temurin'])]))

    expect(result.ok).toBe(false)
    const check = result.checks.find((item) => item.id === 'tool-prerequisites:jdk-temurin')
    expect(check?.level).toBe('error')
    // 消息必须同时点出"谁需要"和"缺什么"，否则用户不知道该动哪个
    expect(check?.message).toContain('Apache Maven')
    expect(check?.message).toContain('Eclipse Temurin JDK')
    expect(check?.message).toContain('一起勾选')
  })

  it('依赖一起选了 → 通过', async () => {
    const plan = makePlan([makeItem('maven', ['jdk-temurin']), makeItem('jdk-temurin', [])])
    const result = await preflight(plan)

    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites')?.level).toBe('ok')
  })

  it('**机器上已经有 JDK（只是这次没勾）→ 通过** —— 否则就是最烦人的假阳性', async () => {
    // 场景：本机早装了 JDK，这次只想装个 Maven。
    // 如果只看"计划里有没有"，这里会被误拦，用户立刻就不信任这个检查了。
    const result = await preflight(makePlan([makeItem('maven', ['jdk-temurin'])]), ['jdk-temurin'])

    expect(result.ok).toBe(true)
    expect(result.checks.some((item) => item.level === 'error')).toBe(false)
  })

  it('没有任何依赖时给一条明确的 ok，而不是静默省略', async () => {
    const result = await preflight(makePlan([makeItem('ninja', [])]))
    const check = result.checks.find((item) => item.id === 'tool-prerequisites')
    expect(check?.level).toBe('ok')
    expect(check?.message).toContain('没有额外的前置依赖')
  })

  it('多个工具等同一个依赖时合并成一条（不刷屏）', async () => {
    const claude = makeTool('claude-code', 'Claude Code', ['nodejs'])
    const gemini = makeTool('gemini-cli', 'Gemini CLI', ['nodejs'])
    const node = makeTool('nodejs', 'Node.js')

    const result = await runPreflight({
      plan: makePlan([makeItem('claude-code', ['nodejs']), makeItem('gemini-cli', ['nodejs'])]),
      tools: indexById([claude, gemini, node]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    const errors = result.checks.filter((item) => item.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Claude Code')
    expect(errors[0].message).toContain('Gemini CLI')
    expect(errors[0].message).toContain('Node.js')
  })

  it('缺两个不同的依赖时给出两条，各自说清', async () => {
    const result = await runPreflight({
      plan: makePlan([makeItem('maven', ['jdk-temurin']), makeItem('claude-code', ['nodejs'])]),
      tools: indexById([maven, jdk, makeTool('claude-code', 'Claude Code', ['nodejs']), makeTool('nodejs', 'Node.js')]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    expect(result.checks.filter((item) => item.level === 'error')).toHaveLength(2)
    expect(result.ok).toBe(false)
  })

  it('**依赖不是 devkit 能装的 → 只 warn，不给死胡同**', async () => {
    // 给 error 的话 UI 会禁用开始按钮（InstallFlow 的 disabled={!preflight.ok}），
    // 而"回到选择界面勾选它"这条指引用户根本执行不了 ——
    // 勾了只会让 buildPlan 抛「清单里没有可安装的版本」。所以只能降级成 warn。
    const weird = makeTool('x', 'X', ['nonexistent'])
    const result = await runPreflight({
      plan: makePlan([makeItem('x', ['nonexistent'])]),
      tools: indexById([weird]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    expect(result.ok).toBe(true)
    const check = result.checks.find((item) => item.id === 'tool-prerequisites:nonexistent')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('nonexistent')
    expect(check?.message).toContain('装不了')
  })

  it('detect-only 的工具（没有可安装版本）当依赖时也只 warn', async () => {
    // 真实场景：SPEC 自己举过「docker-desktop 依赖 wsl2」，
    // 而 wsl2.json 是 status=detect-only、versions=[]。这条路径必须是 warn。
    const docker = makeTool('docker-desktop', 'Docker Desktop', ['wsl2'])
    const wsl2 = { ...makeTool('wsl2', 'WSL2'), status: 'detect-only' as const, versions: [] }

    const result = await runPreflight({
      plan: makePlan([makeItem('docker-desktop', ['wsl2'])]),
      tools: indexById([docker, wsl2]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.id === 'tool-prerequisites:wsl2')?.level).toBe('warn')
  })
})

describe('预检：devkit 装不了的前置（假成功防治）', () => {
  const rust = makeTool('rust', 'Rust')

  it('**选了 Rust → 提示还需要 MSVC 生成工具，且只是 warn 不阻断**', async () => {
    // 不提示的话就是假成功：rustc --version 正常、自检通过，
    // 用户第一次 cargo build 才撞上 linker link.exe not found。
    const result = await runPreflight({
      plan: makePlan([makeItem('rust', [])]),
      tools: indexById([rust]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    const check = result.checks.find((item) => item.id === 'external-requirement:rust')
    expect(check?.level).toBe('warn')
    expect(check?.message).toContain('MSVC')
    expect(check?.message).toContain('link.exe')
    // 不阻断：MSVC 缺失不影响 rustc 本身，装还是要让他装
    expect(result.ok).toBe(true)
  })

  it('没选 Rust 就不提示', async () => {
    const result = await preflight(makePlan([makeItem('ninja', [])]))
    expect(result.checks.some((item) => item.id.startsWith('external-requirement:'))).toBe(false)
  })
})
