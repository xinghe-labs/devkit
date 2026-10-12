import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { URL } from 'node:url'
import type {
  InstallPlan,
  InstallProgressEvent,
  PlanItem,
  ToolManifest,
  ToolVersionSpec
} from '@shared/types'
import { orderDownloadSources } from '@shared/manifest'
import { extractVersion } from '@shared/version'
import { runCommand } from '../../utils/exec'
import { downloadFile } from '../downloader'
import { substitutePlaceholders } from '../installer/placeholders'
import { clearPendingPlan, savePendingPlan, summarize, unfinishedItems } from '../plan'
import { installVersion } from '../providers/direct'
import { logger } from '../report/logger'

/**
 * 安装执行器（SPEC FR-4 的状态机）。
 *
 * 四条硬性约定：
 *  1. **单项失败不中断整体** —— 记下错误继续下一项，最后汇总
 *  2. **依赖未成功则跳过** —— 而不是带着半成品硬跑
 *  3. **机器级安装串行** —— MSI/服务类安装互斥，并发只会互相踩
 *  4. **安装 ≠ 激活** —— 安装只落版本目录；激活由注入的 activate 回调负责，
 *     这样不开界面跑脚本（scripts/install-tool.ts）时不会误改用户 PATH
 */

export interface ActivateOutcome {
  ok: boolean
  note: string | null
  error: string | null
}

export interface RunPlanOptions {
  plan: InstallPlan
  tools: Map<string, ToolManifest>
  downloadDir: string
  /** 安装器日志目录（%APPDATA%\devkit\logs） */
  logDir: string
  signal: AbortSignal
  onUpdate: (event: InstallProgressEvent) => void
  /** 只演练：不执行安装器、不激活，只把命令行算出来 */
  dryRun?: boolean
  /** 安装成功后激活该版本；不传表示不激活 */
  activate?: (item: PlanItem, version: ToolVersionSpec, tool: ToolManifest) => Promise<ActivateOutcome>
  /** 需要管理员的安装命令交给它执行（提权助手）；不传则直接执行 */
  runElevatedCommand?: (
    label: string,
    command: { cmd: string; args: string[] },
    verifySha256?: string
  ) => Promise<void>
}

type Emit = (currentItemId: string | null, detail?: InstallProgressEvent['detail']) => void

function markFailed(item: PlanItem, message: string): void {
  item.state = 'failed'
  item.error = message
  item.finishedAt = new Date().toISOString()
}

function findVersion(tool: ToolManifest, version: string): ToolVersionSpec | null {
  return tool.versions.find((entry) => entry.version === version) ?? null
}

/** 串行互斥锁：机器级安装（MSI/服务）必须一个一个来 */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * 运行清单里的自检命令。
 * 注意用 {installDir} 占位符指向刚装进去的那一份，而不是 PATH 上本来那一份 ——
 * 否则装了 Node 24 却跑到 Node 22，会得到假阳性（SPEC「安装 ≠ 激活」）。
 */
async function runVerify(
  item: PlanItem,
  version: ToolVersionSpec
): Promise<{ ok: boolean; detail: string }> {
  const spec = version.verify
  if (!spec) return { ok: true, detail: '清单未定义自检命令' }
  if (!item.installDir) return { ok: false, detail: '没有安装目录，无法自检' }

  const vars = { installDir: item.installDir, version: item.version, toolId: item.id }

  let cmd: string
  let args: string[]
  try {
    cmd = substitutePlaceholders(spec.cmd, vars)
    args = (spec.args ?? []).map((arg) => substitutePlaceholders(arg, vars))
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }

  if (!existsSync(cmd)) {
    return { ok: false, detail: `自检目标不存在：${cmd}` }
  }

  const result = await runCommand(cmd, args, { timeoutMs: 15_000 })
  if (result.spawnError) {
    return { ok: false, detail: `自检命令无法执行：${result.spawnError}` }
  }

  const output = `${result.stdout}\n${result.stderr}`.trim()
  const firstLine = output.split(/\r?\n/)[0] ?? ''

  if (spec.expectRegex) {
    let pattern: RegExp
    try {
      pattern = new RegExp(spec.expectRegex, 'i')
    } catch (error) {
      return { ok: false, detail: `自检正则非法：${(error as Error).message}` }
    }
    if (!pattern.test(output)) {
      return { ok: false, detail: `自检输出不符合预期（${spec.expectRegex}）：${firstLine}` }
    }
  } else if (result.code !== 0) {
    return { ok: false, detail: `自检命令退出码 ${result.code}：${firstLine}` }
  }

  const detected = extractVersion(output)
  return { ok: true, detail: `自检通过${detected ? `：${firstLine}` : ''}` }
}

async function runItem(context: {
  item: PlanItem
  tool: ToolManifest
  version: ToolVersionSpec
  plan: InstallPlan
  downloadDir: string
  logDir: string
  dryRun: boolean
  signal: AbortSignal
  emit: Emit
  activate?: RunPlanOptions['activate']
  runElevatedCommand?: RunPlanOptions['runElevatedCommand']
}): Promise<void> {
  const { item, tool, version, plan, downloadDir, logDir, dryRun, signal, emit, activate } = context

  // 0. 幂等（NFR-2）：目录已存在且自检通过，就不重复下载安装
  if (item.installDir && existsSync(item.installDir)) {
    const verify = await runVerify(item, version)
    if (verify.ok) {
      item.state = 'success'
      item.note = `已安装，跳过（${verify.detail}）`
      item.finishedAt = new Date().toISOString()
      logger.info('executor', `${item.id} 已安装且自检通过，跳过`)
      if (activate && version.activate) {
        const result = await activate(item, version, tool)
        if (!result.ok) logger.warn('executor', `${item.id} 已安装但激活失败：${result.error}`)
      }
      emit(item.id)
      return
    }
    logger.warn('executor', `${item.id} 目录已存在但自检未通过，将重新安装：${verify.detail}`)
  }

  // 1. 下载（含 SHA-256 校验与镜像回退）
  const sources = orderDownloadSources(version, plan.options.mirrorPreference)
  if (sources.length === 0) throw new Error('清单没有给出任何下载源')

  const urlFileName = basename(new URL(sources[0].url).pathname)
  // VS Code 的下载地址以 /stable 结尾，取出来没有扩展名。Windows 主要按扩展名决定怎么执行，
  // 一个叫 `vscode-1.141.0-stable` 的文件能被跑起来纯属运气 —— 这里显式补上。
  const fileName =
    urlFileName.includes('.') || version.install?.type === 'zip'
      ? urlFileName
      : `${urlFileName}.exe`
  const archivePath = join(downloadDir, `${item.id}-${item.version}-${fileName}`)
  item.archivePath = archivePath

  item.state = 'downloading'
  emit(item.id, { received: 0, total: version.sizeBytes ?? null, source: sources[0].name })

  const download = await downloadFile({
    sources,
    sha256: version.source?.sha256 ?? '',
    sizeBytes: version.sizeBytes,
    targetFile: archivePath,
    proxy: plan.options.proxy,
    signal,
    onProgress: (progress) =>
      emit(item.id, { received: progress.received, total: progress.total, source: progress.source }),
    onPhase: (phase) => {
      item.state = phase
      emit(item.id)
    }
  })

  // 无论成功失败都把尝试记录留下来，报告里要展示"试过哪些源、各自为什么失败"
  item.downloadAttempts = download.attempts

  if (!download.ok) throw new Error(download.error ?? '下载失败')

  // 2. 安装
  item.state = 'installing'
  emit(item.id)
  const logFile = join(logDir, `installer-${item.id}-${item.version}.log`)
  const outcome = await installVersion({
    tool,
    version,
    installDir: item.installDir ?? '',
    archivePath,
    logFile,
    dryRun,
    signal,
    onProgress: (files) => emit(item.id, { received: files, total: null }),
    onCommand: (command) =>
      logger.info(
        'executor',
        `[dry-run] ${item.id} 将执行：${command.cmd} ${command.args
          .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
          .join(' ')}`
      ),
    runElevatedCommand: context.runElevatedCommand
      ? (command) =>
          context.runElevatedCommand!(
            `安装 ${item.id}@${item.version}`,
            command,
            version.source?.sha256
          )
      : undefined
  })
  logger.info(
    'executor',
    `${item.id} 安装完成：${outcome.files} 个文件 / ${outcome.bytes} 字节 → ${outcome.installDir}`
  )

  if (dryRun) {
    item.state = 'success'
    item.note = '干跑模式：只演练命令行，未真正安装'
    item.finishedAt = new Date().toISOString()
    emit(item.id)
    return
  }

  // 3. 自检 —— 自检不过等于失败，即使解压过程毫无问题
  item.state = 'checking'
  emit(item.id)
  const verify = await runVerify(item, version)
  if (!verify.ok) throw new Error(`自检未通过：${verify.detail}`)

  // 4. 激活（可选）：把这份安装接到用户 PATH / 环境变量里
  let note = verify.detail
  if (activate && version.activate) {
    const activated = await activate(item, version, tool)
    if (activated.ok) {
      note = `${verify.detail}；${activated.note ?? '已激活'}`
    } else {
      // 激活失败不算安装失败：文件已经装好且自检通过，用户仍可手动用绝对路径
      note = `${verify.detail}；激活失败：${activated.error ?? '未知原因'}`
      logger.warn('executor', `${item.id} 激活失败：${activated.error}`)
    }
  }

  item.state = 'success'
  item.note = note
  item.finishedAt = new Date().toISOString()
  emit(item.id)
}

export async function runPlan(options: RunPlanOptions): Promise<InstallPlan> {
  const { plan, tools, downloadDir, logDir, signal, onUpdate } = options
  const dryRun = options.dryRun === true
  const concurrency = Math.min(3, Math.max(1, plan.options.concurrency))

  const emit: Emit = (currentItemId, detail = null) => {
    plan.summary = summarize(plan.items)
    onUpdate({ plan, currentItemId, detail: detail ?? null })
  }

  savePendingPlan(plan)
  emit(null)

  const startedAt = Date.now()
  const adminMutex = new Mutex()

  const remaining = new Map(plan.items.map((item) => [item.id, item]))
  const inPlan = new Set(remaining.keys())
  const finished = new Set<string>()
  const succeeded = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()

  const runOne = async (item: PlanItem): Promise<void> => {
    const tool = tools.get(item.id)
    if (!tool) {
      markFailed(item, '清单里找不到这个工具')
      emit(item.id)
      return
    }
    const version = findVersion(tool, item.version)
    if (!version) {
      markFailed(item, `清单里找不到版本 ${item.version}`)
      emit(item.id)
      return
    }

    item.startedAt = new Date().toISOString()
    item.attempts += 1
    logger.info('executor', `开始处理 ${item.id}@${item.version}`)

    try {
      await runItem({
        item,
        tool,
        version,
        plan,
        downloadDir,
        logDir,
        dryRun,
        signal,
        emit,
        activate: options.activate,
        runElevatedCommand: options.runElevatedCommand
      })
    } catch (error) {
      // 单项失败不中断整体
      markFailed(item, (error as Error).message)
      logger.error('executor', `${item.id} 失败：${item.error}`)
      emit(item.id)
    }
  }

  /**
   * 扫描一遍待办：能起的起，依赖已失败的直接跳过。
   * 返回 true 表示这一轮改变了状态（需要重新扫描）。
   */
  const startReady = (): boolean => {
    let changed = false

    for (const item of [...remaining.values()]) {
      if (inFlight.size >= concurrency) break

      const deps = item.dependsOn.filter((dependency) => inPlan.has(dependency))
      if (deps.some((dependency) => !finished.has(dependency))) continue

      const blocked = deps.filter((dependency) => !succeeded.has(dependency))
      if (blocked.length > 0) {
        item.state = 'skipped'
        item.note = `依赖未成功：${blocked.join('、')}`
        item.finishedAt = new Date().toISOString()
        remaining.delete(item.id)
        finished.add(item.id)
        logger.warn('executor', `${item.id} 已跳过：${item.note}`)
        emit(item.id)
        changed = true
        continue
      }

      if (signal.aborted) {
        item.state = 'cancelled'
        item.note = '用户取消'
        item.finishedAt = new Date().toISOString()
        remaining.delete(item.id)
        finished.add(item.id)
        emit(item.id)
        changed = true
        continue
      }

      remaining.delete(item.id)
      const task = (
        item.requiresAdmin ? adminMutex.run(() => runOne(item)) : runOne(item)
      )
        .catch((error: unknown) => {
          markFailed(item, (error as Error).message)
          emit(item.id)
        })
        .finally(() => {
          inFlight.delete(item.id)
          finished.add(item.id)
          if (item.state === 'success') succeeded.add(item.id)
        })

      inFlight.set(item.id, task)
      changed = true
    }

    return changed
  }

  while (remaining.size > 0 || inFlight.size > 0) {
    startReady()

    if (inFlight.size === 0) {
      if (remaining.size === 0) break
      // 没有在跑的任务、也起不来新的 —— 只可能是依赖环；标记掉，别死循环
      for (const item of remaining.values()) {
        item.state = 'skipped'
        item.note = '依赖无法满足（可能存在依赖环）'
        item.finishedAt = new Date().toISOString()
        emit(item.id)
      }
      remaining.clear()
      break
    }

    await Promise.race(inFlight.values())
  }

  plan.summary = summarize(plan.items)
  const remainingItems = unfinishedItems(plan)

  if (remainingItems.length === 0) {
    clearPendingPlan()
    logger.info(
      'executor',
      `安装流程结束：成功 ${plan.summary.success}，失败 ${plan.summary.failed}，跳过 ${plan.summary.skipped}，` +
        `取消 ${plan.summary.cancelled}，耗时 ${Date.now() - startedAt}ms`
    )
  } else {
    savePendingPlan(plan)
    logger.warn('executor', `安装流程结束，仍有 ${remainingItems.length} 项未完成，已保留 pending.json 供续跑`)
  }

  emit(null)
  return plan
}
