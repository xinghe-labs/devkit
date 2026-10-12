import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELEVATION_HELPER_SCRIPT, isElevated, makeJobId, type ElevationOutcome, type ElevationStep, type StepResult } from './helper-script'

/**
 * 执行一个提权作业（job）。
 *
 * 通信方式只有两个文件：
 *   job-<id>.json    主进程 → 提权进程（要执行什么）
 *   result-<id>.json 提权进程 → 主进程（执行结果）
 * 提权进程退出后主进程才读结果，因此不存在"读到写了一半的 JSON"的问题。
 */

const HELPER_NAME = 'devkit-elevate.ps1'

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

function runPowerShell(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
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
  const helperPath = join(jobDir, HELPER_NAME)

  // 脚本内容变了就重写，保证用户审计到的是当前真正执行的那份
  //
  // **必须带 UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按系统 ANSI 代码页
  // （中文系统上是 cp936）解码，脚本里的中文注释与错误文案会直接变成乱码并导致语法错误
  // （实测报“表达式或语句中包含意外的标记”）。加上 BOM 后 5.1 与 7.x 都能正确识别 UTF-8。
  const BOM = '\ufeff'
  const scriptContent = `${BOM}${ELEVATION_HELPER_SCRIPT}`
  const existing = existsSync(helperPath) ? readFileSync(helperPath, 'utf8') : ''
  if (existing !== scriptContent) {
    writeFileSync(helperPath, scriptContent, 'utf8')
  }

  const jobId = makeJobId()
  const jobFile = join(jobDir, `job-${jobId}.json`)
  const resultFile = join(jobDir, `result-${jobId}.json`)

  writeFileSync(jobFile, JSON.stringify({ jobId, steps }, null, 2), 'utf8')

  const alreadyAdmin = options.forceUnelevated !== true && (await isElevated())
  const elevated = !alreadyAdmin && options.forceUnelevated !== true

  const helperArgs = [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-JobFile',
    jobFile,
    '-ResultFile',
    resultFile
  ]

  if (elevated) {
    log(`需要管理员权限，正在请求一次授权（共 ${steps.length} 个步骤）…`)
    // Start-Process -Verb RunAs -Wait：整个作业只弹一次 UAC，主进程等它跑完
    const argumentList = ['-NoProfile', ...helperArgs].map(psQuote).join(',')
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(${argumentList})`

    const result = await runPowerShell(['-Command', command], 40 * 60 * 1000)
    if (result.code !== 0) {
      const cancelled = /canceled by the user|cancelled by the user|操作已被用户取消/i.test(result.stderr)
      const message = cancelled
        ? '用户取消了管理员授权，需要管理员权限的步骤没有执行'
        : `提权进程启动失败：${result.stderr.trim() || `退出码 ${result.code}`}`
      log(message)
      return { ok: false, elevated: true, cancelled, steps: [], error: message }
    }
  } else {
    log(alreadyAdmin ? '当前已是管理员，直接执行' : '非提权模式（测试）执行')
    const result = await runPowerShell(helperArgs, 40 * 60 * 1000)
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
    const parsed = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^﻿/, '')) as {
      ok?: boolean
      steps?: StepResult[]
      error?: string | null
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
      error: parsed.ok === true ? null : (parsed.error ?? stepResults.find((step) => !step.ok)?.error ?? '提权步骤失败')
    }
  } catch (error) {
    const message = `提权结果文件无法解析：${(error as Error).message}`
    log(message)
    return { ok: false, elevated, cancelled: false, steps: [], error: message }
  }
}
