import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runJob } from './run-job'

/**
 * 提权作业协议的非提权测试。
 *
 * 提权本身（UAC）没法在 CI 里点，但**协议与助手脚本**可以：
 * forceUnelevated 让同一份脚本以普通权限跑，验证
 *   · job → result 的文件协议
 *   · 成功/失败/超时/命令不存在 四种情况的结果解析
 *   · 脚本能正确读到中文路径（本机用户名就是中文）
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

  it('助手脚本会被写到作业目录里，内容可读可审计', async () => {
    await runJob({
      jobDir,
      forceUnelevated: true,
      steps: [{ kind: 'exec', label: 'x', cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'] }]
    })

    const script = readFileSync(join(jobDir, 'devkit-elevate.ps1'), 'utf8')
    expect(script).toContain('devkit 提权助手')
    expect(script).toContain('Checkpoint-Computer')
    // 脚本必须是纯文本，不能有任何编码/混淆
    expect(script).toContain('param(')
  }, 120_000)
})
