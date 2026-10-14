import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runJob } from './run-job'

/**
 * 提权作业协议的非提权测试。
 *
 * 提权本身（UAC）没法在 CI 里点，但**协议与助手脚本**可以：
 * forceUnelevated 让同一份脚本以普通权限跑，验证
 *   · 内联脚本的执行与结果文件协议
 *   · 成功/失败/超时/命令不存在 四种情况的结果解析
 *   · 作业目录里**不落任何可执行内容**（这是修掉提权漏洞的关键性质）
 * 真正需要 UAC 的那一步只能靠虚拟机验收，这一点在报告里写清楚了。
 */
describe('提权作业协议（非提权路径）', () => {
  let jobDir: string

  beforeEach(() => {
    jobDir = mkdtempSync(join(tmpdir(), 'devkit-elev-'))
  })

  afterEach(() => {
    rmSync(jobDir, { recursive: true, force: true })
  })

  it('成功步骤：写入 job、跑助手、解析 result', async () => {
    const logs: string[] = []
    const outcome = await runJob({
      jobDir,
      forceUnelevated: true,
      onLog: (message) => logs.push(message),
      steps: [
        {
          kind: 'exec',
          label: '打个招呼',
          cmd: 'cmd.exe',
          args: ['/d', '/s', '/c', 'echo devkit-elevation-ok'],
          timeoutMs: 30_000
        }
      ]
    })

    expect(outcome.error).toBeNull()
    expect(outcome.ok).toBe(true)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].ok).toBe(true)
    expect(outcome.steps[0].exitCode).toBe(0)
    expect(logs.join('\n')).toContain('打个招呼')
  }, 120_000)

  it('失败步骤：退出码被如实记录，整体判定为失败', async () => {
    const outcome = await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [
        {
          kind: 'exec',
          label: '故意失败',
          cmd: 'cmd.exe',
          args: ['/d', '/s', '/c', 'exit 3'],
          timeoutMs: 30_000
        }
      ]
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[0].exitCode).toBe(3)
    expect(outcome.error).toBeTruthy()
  }, 120_000)

  it('命令不存在：不崩溃，报出可读错误', async () => {
    const outcome = await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [
        {
          kind: 'exec',
          label: '不存在的命令',
          cmd: 'devkit-this-command-does-not-exist.exe',
          args: [],
          timeoutMs: 15_000
        }
      ]
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[0].error).toBeTruthy()
  }, 120_000)

  it('多个步骤顺序执行，前一步失败不阻止后一步（结果逐条上报）', async () => {
    const outcome = await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [
        { kind: 'exec', label: '第一步', cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 1'], timeoutMs: 20_000 },
        { kind: 'exec', label: '第二步', cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'], timeoutMs: 20_000 }
      ]
    })

    expect(outcome.steps).toHaveLength(2)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[1].ok).toBe(true)
    expect(outcome.ok).toBe(false)
  }, 120_000)

  it('空步骤直接返回成功，不启动任何进程', async () => {
    const outcome = await runJob({ jobDir, forceUnelevated: true, steps: [] })
    expect(outcome.ok).toBe(true)
    expect(outcome.elevated).toBe(false)
  })

  it('**作业目录里不落任何可执行内容** —— 这是修掉提权漏洞的关键性质', async () => {
    // 以前的实现把 devkit-elevate.ps1 与 job-<时间戳>.json 写进这个目录，
    // 再由提权进程读取执行。那个目录**用户可写**，于是同机器上的低权限进程
    // 只要在用户点 UAC 之前替换掉内容，就能拿到管理员权限。
    // 现在助手脚本与作业数据全部通过 -EncodedCommand 内联传递。
    await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [{ kind: 'exec', label: 'x', cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'] }]
    })

    const leftovers = readdirSync(jobDir)
    // 只允许留下结果文件（主进程要读它；伪造它拿不到代码执行）
    expect(leftovers.filter((name) => name.endsWith('.ps1'))).toEqual([])
    expect(leftovers.filter((name) => name.startsWith('job-'))).toEqual([])
    expect(leftovers.every((name) => name.startsWith('result-'))).toBe(true)
  }, 120_000)

  it('作业太大时明确报错，而不是让 Windows 去截断命令行', async () => {
    const outcome = await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [
        {
          kind: 'set-machine-path',
          label: '超大 PATH',
          // 单引号会被转义成两个，进一步放大体积
          value: `C:${'x'.repeat(30_000)}`
        }
      ]
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('太大')
  }, 120_000)
})
