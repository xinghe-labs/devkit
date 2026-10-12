import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type {
  InstallPlan,
  PendingPlanLoad,
  PlanBuildError,
  PlanItem,
  PlanOptions,
  PlanSelection,
  PlanSummary,
  ToolManifest
} from '@shared/types'
import { pickRecommendedVersion } from '@shared/manifest'
import { fileExists, readJsonFile, writeJsonFile } from '../../utils/fs'
import { getPendingPlanFile } from '../../utils/app-paths'
import { isInstallableVersion } from '../installer/placeholders'
import { logger } from '../report/logger'
import { resolveInstallTemplate, TemplateError } from '../templates'

/**
 * 安装计划的构建与持久化（SPEC §7.4）。
 *
 * 这个模块只做两件事：把"用户勾了什么"变成一份可执行的计划，以及把计划写进 pending.json
 * 供重启后续跑（FR-17）。实际执行在 executor 里。
 */

export class PlanBuildFailure extends Error {
  readonly problems: PlanBuildError[]

  constructor(problems: PlanBuildError[]) {
    const detail = problems.map((item) => `${item.toolId}：${item.reason}`).join('；')
    super(`有 ${problems.length} 项无法安装 —— ${detail}`)
    this.name = 'PlanBuildFailure'
    this.problems = problems
  }
}

export interface BuildPlanParams {
  selections: PlanSelection[]
  tools: ToolManifest[]
  options: PlanOptions
  devkitVersion: string
  manifestRevision: string
  /** 版本目录根：%USERPROFILE%\.devkit\versions */
  versionsRoot: string
}

export function makePlanId(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

/**
 * 依赖排序：被依赖的排在前面。
 * 出现环时抛错而不是死循环 —— 清单写错了要让人看到，不能悄悄跳过。
 */
export function topologicalSort(items: PlanItem[]): PlanItem[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const sorted: PlanItem[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (item: PlanItem): void => {
    if (visited.has(item.id)) return
    if (visiting.has(item.id)) {
      throw new Error(`依赖出现环：${[...visiting, item.id].join(' → ')}`)
    }
    visiting.add(item.id)
    for (const dependency of item.dependsOn) {
      const dependencyItem = byId.get(dependency)
      if (dependencyItem) visit(dependencyItem)
    }
    visiting.delete(item.id)
    visited.add(item.id)
    sorted.push(item)
  }

  for (const item of items) visit(item)
  return sorted
}

export function summarize(items: PlanItem[]): PlanSummary {
  const count = (state: PlanItem['state']): number =>
    items.filter((item) => item.state === state).length
  return {
    total: items.length,
    success: count('success'),
    failed: count('failed'),
    skipped: count('skipped'),
    cancelled: count('cancelled')
  }
}

export function buildPlan(params: BuildPlanParams): InstallPlan {
  const { selections, tools, options, versionsRoot } = params
  const byId = new Map(tools.map((tool) => [tool.id, tool]))
  const problems: PlanBuildError[] = []
  const items: PlanItem[] = []
  const seen = new Set<string>()

  for (const selection of selections) {
    if (seen.has(selection.toolId)) continue
    seen.add(selection.toolId)

    const tool = byId.get(selection.toolId)
    if (!tool) {
      problems.push({ toolId: selection.toolId, reason: '清单里没有这个工具' })
      continue
    }

    const version = selection.version
      ? tool.versions.find((item) => item.version === selection.version)
      : pickRecommendedVersion(tool)

    if (!version) {
      problems.push({
        toolId: tool.id,
        reason: selection.version
          ? `清单里没有版本 ${selection.version}`
          : '清单里没有可安装的版本'
      })
      continue
    }

    if (!isInstallableVersion(version)) {
      problems.push({
        toolId: tool.id,
        reason: `版本 ${version.version} 的安装信息尚未补齐（清单状态：${tool.status}）`
      })
      continue
    }

    try {
      // 提前解析模板：模板名写错、参数不合规都应该在这里就暴露，而不是跑到一半才失败
      resolveInstallTemplate(version.install)
    } catch (error) {
      problems.push({
        toolId: tool.id,
        reason: error instanceof TemplateError ? error.message : String(error)
      })
      continue
    }

    // 纵深防御：即使清单/Schema/热更新三处都被绕过，这里也拦一次。
    // 版本号里的 ".." 会让 join 归一化掉路径段，把安装目录指到 versions 根目录甚至更外面。
    const installDir = join(versionsRoot, tool.id, version.version)
    const relativePath = relative(versionsRoot, installDir)
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      problems.push({
        toolId: tool.id,
        reason: `版本号 ${version.version} 会让安装目录落到版本根目录之外（${installDir}），已拒绝`
      })
      continue
    }

    items.push({
      id: tool.id,
      version: version.version,
      tier: tool.tier,
      installScope: version.installScope,
      requiresAdmin: version.installScope === 'machine',
      requiresReboot: version.requiresReboot === true,
      dependsOn: version.dependsOn ?? [],
      state: 'pending',
      attempts: 0,
      error: null,
      note: null,
      startedAt: null,
      finishedAt: null,
      installDir,
      archivePath: null,
      downloadAttempts: []
    })
  }

  if (problems.length > 0) throw new PlanBuildFailure(problems)
  if (items.length === 0) throw new PlanBuildFailure([{ toolId: '-', reason: '没有选择任何可安装的项' }])

  const sorted = topologicalSort(items)

  return {
    schemaVersion: 1,
    planId: makePlanId(),
    createdAt: new Date().toISOString(),
    devkitVersion: params.devkitVersion,
    manifestRevision: params.manifestRevision,
    options,
    items: sorted,
    summary: summarize(sorted)
  }
}

/* ------------------------------------------------------------------ */
/* pending.json：重启后续跑（FR-17）                                    */
/* ------------------------------------------------------------------ */

function looksLikePlan(value: unknown): value is InstallPlan {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Partial<InstallPlan>
  return (
    plan.schemaVersion === 1 &&
    typeof plan.planId === 'string' &&
    plan.planId.length > 0 &&
    Array.isArray(plan.items) &&
    plan.items.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as PlanItem).id === 'string' &&
        typeof (item as PlanItem).state === 'string'
    )
  )
}

export function savePendingPlan(plan: InstallPlan): void {
  try {
    writeJsonFile(getPendingPlanFile(), plan)
  } catch (error) {
    // 续跑是锦上添花，写不进去不能影响安装本身
    logger.warn('plan', `写入 pending.json 失败：${(error as Error).message}`)
  }
}

export function loadPendingPlan(): PendingPlanLoad {
  try {
    const file = getPendingPlanFile()
    if (!fileExists(file)) return { status: 'none' }

    const raw = readJsonFile(file)
    if (!looksLikePlan(raw)) {
      logger.warn('plan', 'pending.json 结构不匹配，已忽略')
      return { status: 'invalid', reason: '计划文件格式不匹配' }
    }
    return { status: 'ok', plan: raw }
  } catch (error) {
    const reason = (error as Error).message
    logger.warn('plan', `读取 pending.json 失败：${reason}`)
    return { status: 'invalid', reason }
  }
}

/**
 * 删除 pending.json。
 * 整个函数体都在 try 里 —— 续跑是锦上添花，它失败绝不能让已经成功的安装流程报错
 * （在无 electron 运行时的环境里 getPendingPlanFile() 本身就会抛）。
 */
export function clearPendingPlan(): void {
  try {
    rmSync(getPendingPlanFile(), { force: true })
  } catch (error) {
    logger.warn('plan', `清理 pending.json 失败：${(error as Error).message}`)
  }
}

/** 未完成（非终态）的项 */
export function unfinishedItems(plan: InstallPlan): PlanItem[] {
  const terminal = new Set<PlanItem['state']>(['success', 'skipped', 'cancelled'])
  return plan.items.filter((item) => !terminal.has(item.state))
}
