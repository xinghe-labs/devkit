import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
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
 * 两条硬性约定：
 *  1. **单项失败不中断整体** —— 记下错误继续下一项，最后汇总
 *  2. **依赖未成功则跳过** —— 而不是带着半成品硬跑
 *
 * M1a 只实现串行执行：并行安装的收益主要在 MSI/EXE 场景，而那属于 M1b。
 */

export interface RunPlanOptions {
  plan: InstallPlan
  tools: Map<string, ToolManifest>
  downloadDir: string
  signal: AbortSignal
  onUpdate: (event: InstallProgressEvent) => void
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

  const version_ = extractVersion(output)
  return { ok: true, detail: `自检通过${version_ ? `：${firstLine}` : ''}` }
}

async function runItem(context: {
  item: PlanItem
  tool: ToolManifest
  version: ToolVersionSpec
  plan: InstallPlan
  downloadDir: string
  signal: AbortSignal
  emit: Emit
}): Promise<void> {
  const { item, tool, version, plan, downloadDir, signal, emit } = context

  // 0. 幂等（NFR-2）：目录已存在且自检通过，就不重复下载安装
  if (item.installDir && existsSync(item.installDir)) {
    const verify = await runVerify(item, version)
    if (verify.ok) {
      item.state = 'success'
      item.note = `已安装，跳过（${verify.detail}）`
      item.finishedAt = new Date().toISOString()
      logger.info('executor', `${item.id} 已安装且自检通过，跳过`)
      emit(item.id)
      return
    }
    logger.warn('executor', `${item.id} 目录已存在但自检未通过，将重新安装：${verify.detail}`)
  }

  // 1. 下载（含 SHA-256 校验与镜像回退）
  const sources = orderDownloadSources(version, plan.options.mirrorPreference)
  if (sources.length === 0) throw new Error('清单没有给出任何下载源')

  const fileName = basename(new URL(sources[0].url).pathname)
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

  if (!download.ok) throw new Error(download.error ?? '下载失败')

  // 2. 安装
  item.state = 'installing'
  emit(item.id)
  const outcome = await installVersion({
    tool,
    version,
    installDir: item.installDir ?? '',
    archivePath,
    signal,
    onProgress: (files) => emit(item.id, { received: files, total: null })
  })
  logger.info('executor', `${item.id} 安装完成：${outcome.files} 个文件 → ${outcome.installDir}`)

  // 3. 自检 —— 自检不过等于失败，即使解压过程毫无问题
  item.state = 'checking'
  emit(item.id)
  const verify = await runVerify(item, version)
  if (!verify.ok) throw new Error(`自检未通过：${verify.detail}`)

  item.state = 'success'
  item.note = verify.detail
  item.finishedAt = new Date().toISOString()
  emit(item.id)
}

export async function runPlan(options: RunPlanOptions): Promise<InstallPlan> {
  const { plan, tools, downloadDir, signal, onUpdate } = options

  const emit: Emit = (currentItemId, detail = null) => {
    plan.summary = summarize(plan.items)
    onUpdate({ plan, currentItemId, detail: detail ?? null })
  }

  savePendingPlan(plan)
  emit(null)

  const startedAt = Date.now()

  for (const item of plan.items) {
    if (signal.aborted) {
      if (item.state === 'pending') {
        item.state = 'cancelled'
        item.note = '用户取消'
      }
      continue
    }

    // 已经处于终态的项（例如续跑时上次已成功）直接跳过
    if (item.state === 'success' || item.state === 'skipped' || item.state === 'cancelled') continue

    const tool = tools.get(item.id)
    if (!tool) {
      markFailed(item, '清单里找不到这个工具')
      emit(item.id)
      continue
    }

    const version = findVersion(tool, item.version)
    if (!version) {
      markFailed(item, `清单里找不到版本 ${item.version}`)
      emit(item.id)
      continue
    }

    // 依赖未成功的项直接跳过，而不是带着半成品硬跑
    const blocked = item.dependsOn.filter((dependency) => {
      const dependencyItem = plan.items.find((entry) => entry.id === dependency)
      return !dependencyItem || dependencyItem.state !== 'success'
    })
    if (blocked.length > 0) {
      item.state = 'skipped'
      item.note = `依赖未成功：${blocked.join('、')}`
      item.finishedAt = new Date().toISOString()
      logger.warn('executor', `${item.id} 已跳过：${item.note}`)
      emit(item.id)
      continue
    }

    item.startedAt = new Date().toISOString()
    item.attempts += 1
    logger.info('executor', `开始处理 ${item.id}@${item.version}`)

    try {
      await runItem({ item, tool, version, plan, downloadDir, signal, emit })
    } catch (error) {
      // 单项失败不中断整体
      markFailed(item, (error as Error).message)
      logger.error('executor', `${item.id} 失败：${item.error}`)
      emit(item.id)
    }
  }

  plan.summary = summarize(plan.items)
  const remaining = unfinishedItems(plan)

  if (remaining.length === 0) {
    clearPendingPlan()
    logger.info(
      'executor',
      `安装流程结束：成功 ${plan.summary.success}，失败 ${plan.summary.failed}，跳过 ${plan.summary.skipped}，` +
        `取消 ${plan.summary.cancelled}，耗时 ${Date.now() - startedAt}ms`
    )
  } else {
    savePendingPlan(plan)
    logger.warn('executor', `安装流程结束，仍有 ${remaining.length} 项未完成，已保留 pending.json 供续跑`)
  }

  emit(null)
  return plan
}
