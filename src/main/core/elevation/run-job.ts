import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildElevatedScript,
  encodeForPowerShell,
  isElevated,
  makeJobId,
  makeNonce,
  MAX_ENCODED_COMMAND_CHARS,
  type ElevationOutcome,
  type ElevationStep,
  type StepResult
} from './helper-script'

/**
 * 执行一个提权作业（job）。
 *
 * ## 通信方式
 *
 * - 主进程 → 提权进程：**命令行**（`powershell -EncodedCommand`），不经过任何文件
 * - 提权进程 → 主进程：一个结果文件（用户可写目录，但带随机 nonce）
 *
 * ## 为什么主进程→提权进程不能走文件
 *
 * 那个目录（`%APPDATA%\devkit\elevation`）**用户可写**，而提权进程以管理员身份
 * 读取并执行它的内容。同机器上任何以当前用户身份运行的进程，只要在用户点 UAC 之前
 * 替换掉脚本或作业文件，就能拿到管理员权限 —— 而用户以为自己批准的是"devkit 装环境"。
 *
 * 根因是主进程与提权进程之间**没有可认证的通道**：主进程能写的东西攻击者也能写。
 * 所以只能不经过文件。
 *
 * ## 结果文件为什么可以留在磁盘上
 *
 * 伪造结果只能让主进程以为"步骤成功了"，**不能获得代码执行**。再加上 nonce 之后，
 * 预置一份结果文件也没用了。
 */

/** 命令行长度余量：还要装下 `Start-Process ... -ArgumentList @(...)` 这层包装 */
const HELPER_ARG_WRAPPER_CHARS = 200

export interface RunJobOptions {
  jobDir: string
  steps: ElevationStep[]
  /** 强制走非提权路径（单测与"本来就是管理员"的场景） */
  forceUnelevated?: boolean
  onLog?: (message: string) => void
}

/** PowerShell 单引号字符串：内部单引号要写成两个 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runPowerShell(
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        resolve({ code, stderr: `${stderr ?? ''}${error && !stderr ? error.message : ''}` })
      }
    )
  })
}

export async function runJob(options: RunJobOptions): Promise<ElevationOutcome> {
  const { jobDir, steps, onLog } = options
  const log = (message: string): void => onLog?.(message)

  if (steps.length === 0) {
    return { ok: true, elevated: false, cancelled: false, steps: [], error: null }
  }

  mkdirSync(jobDir, { recursive: true })

  const jobId = makeJobId()
  const nonce = makeNonce()
  const resultFile = join(jobDir, `result-${jobId}.json`)

  // 上一次中断留下的同名结果文件不可能存在（id 是随机的），但清一下更稳
  if (existsSync(resultFile)) rmSync(resultFile, { force: true })

  const script = buildElevatedScript({ jobId, nonce, resultFile, steps })
  const encoded = encodeForPowerShell(script)

  if (encoded.length > MAX_ENCODED_COMMAND_CHARS - HELPER_ARG_WRAPPER_CHARS) {
    const message =
      `提权作业太大，无法安全传递（编码后 ${encoded.length} 字符，上限约 ${MAX_ENCODED_COMMAND_CHARS}）。` +
      '请减少一次提权的步骤数后重试。'
    log(message)
    return { ok: false, elevated: false, cancelled: false, steps: [], error: message }
  }

  const alreadyAdmin = options.forceUnelevated !== true && (await isElevated())
  const elevated = !alreadyAdmin && options.forceUnelevated !== true

  if (elevated) {
    log(`需要管理员权限，正在请求一次授权（共 ${steps.length} 个步骤）…`)
    // 整个作业只弹一次 UAC，主进程等它跑完。
    // 用 -EncodedCommand 而不是 -File：提权进程不读磁盘上的任何脚本。
    const argumentList = ['-NoProfile', '-EncodedCommand', encoded].map(psQuote).join(',')
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(${argumentList})`

    const result = await runPowerShell(['-Command', command], 40 * 60 * 1000)
    if (result.code !== 0) {
      const cancelled = /canceled by the user|cancelled by the user|操作已被用户取消/i.test(
        result.stderr
      )
      const message = cancelled
        ? '用户取消了管理员授权，需要管理员权限的步骤没有执行'
        : `提权进程启动失败：${result.stderr.trim() || `退出码 ${result.code}`}`
      log(message)
      return { ok: false, elevated: true, cancelled, steps: [], error: message }
    }
  } else {
    log(alreadyAdmin ? '当前已是管理员，直接执行' : '非提权模式（测试）执行')
    const result = await runPowerShell(['-EncodedCommand', encoded], 40 * 60 * 1000)
    if (result.code !== 0 && !existsSync(resultFile)) {
      const message = `助手脚本执行失败：${result.stderr.trim() || `退出码 ${result.code}`}`
      log(message)
      return { ok: false, elevated: false, cancelled: false, steps: [], error: message }
    }
  }

  if (!existsSync(resultFile)) {
    const message = '提权进程没有写出结果文件（可能被杀软拦截或进程被中断）'
    log(message)
    return { ok: false, elevated, cancelled: false, steps: [], error: message }
  }

  try {
    // 双保险：万一某个 PowerShell 版本仍然写出 BOM，这里也要能读
    const raw = readFileSync(resultFile, 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as {
      jobId?: string
      nonce?: string
      ok?: boolean
      steps?: StepResult[]
      error?: string | null
    }

    // 结果文件在用户可写目录，所以要确认它确实是**本次**作业写的。
    // 伪造的结果只能骗到"成功"这个结论，拿不到代码执行 —— 但不能连这点都不查。
    if (parsed.nonce !== nonce || parsed.jobId !== jobId) {
      const message = '提权结果文件与本次作业不匹配（可能被其他进程写入），已忽略'
      log(message)
      return { ok: false, elevated, cancelled: false, steps: [], error: message }
    }

    const stepResults = Array.isArray(parsed.steps) ? parsed.steps : []
    for (const step of stepResults) {
      log(`${step.ok ? '✓' : '✗'} ${step.label}${step.error ? ` —— ${step.error}` : ''}`)
    }

    return {
      ok: parsed.ok === true,
      elevated,
      cancelled: false,
      steps: stepResults,
      error:
        parsed.ok === true
          ? null
          : (parsed.error ?? stepResults.find((step) => !step.ok)?.error ?? '提权步骤失败')
    }
  } catch (error) {
    const message = `提权结果文件无法解析：${(error as Error).message}`
    log(message)
    return { ok: false, elevated, cancelled: false, steps: [], error: message }
  }
}
