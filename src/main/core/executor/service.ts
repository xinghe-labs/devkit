import { app } from 'electron'
import { indexById } from '@shared/manifest'
import type {
  ActivateSpec,
  InstallPlan,
  ToolManifest,
  InstallProgressEvent,
  PendingPlanLoad,
  PlanOptions,
  PlanPreparation,
  PlanSelection,
  StartInstallResult
} from '@shared/types'
import { activateVersion } from '../activate'
import { createRestorePoint, runElevated, toExecStep } from '../elevation'
import { getDownloadDir, getLogDir, getVersionsRoot } from '../../utils/app-paths'
import { loadManifests } from '../manifest'
import { buildPlan, clearPendingPlan, loadPendingPlan } from '../plan'
import { runPreflight } from '../preflight'
import { loadConfig } from '../settings'
import { logger } from '../report/logger'
import { runPlan, type ActivateOutcome } from './index'

/**
 * 安装服务：持有当前计划与取消控制器，向 IPC 层暴露"准备 / 开始 / 取消"三个动作。
 *
 * 计划留在主进程而不是来回传给渲染进程 —— 渲染进程只需拿到 planId，
 * 避免它有机会篡改即将执行的计划（渲染进程理论上不可信）。
 */

let currentPlan: InstallPlan | null = null
let controller: AbortController | null = null
let listener: ((event: InstallProgressEvent) => void) | null = null

export function setInstallProgressListener(next: ((event: InstallProgressEvent) => void) | null): void {
  listener = next
}

export function isInstalling(): boolean {
  return controller !== null
}

function buildOptions(): PlanOptions {
  const config = loadConfig()
  return {
    concurrency: config.concurrency,
    mirrorPreference: config.mirrorPreference,
    proxy: config.proxy,
    createRestorePoint: config.createRestorePoint,
    dryRun: false
  }
}

/** 执行器需要的"安装成功后激活"回调：由主进程提供，脚本模式不提供 */
const activateHook = async (
  item: { id: string; version: string; installDir: string | null },
  version: { activate?: ActivateSpec },
  tool?: ToolManifest
): Promise<ActivateOutcome> => {
  if (!version.activate || !item.installDir) {
    return { ok: true, note: null, error: null }
  }
  const result = await activateVersion({
    toolId: item.id,
    version: item.version,
    installDir: item.installDir,
    spec: version.activate,
    // 用清单里的检测命令做"新终端验证"：那正是用户会在终端里敲的那条
    verifySpec: tool?.detect.commands?.[0]
  })
  return { ok: result.ok, note: result.note, error: result.error }
}

export async function prepareInstall(
  selections: PlanSelection[],
  dryRun = false
): Promise<PlanPreparation> {
  const manifests = loadManifests()
  const tools = manifests.tools
  const versionsRoot = getVersionsRoot()

  const plan = buildPlan({
    selections,
    tools,
    options: { ...buildOptions(), dryRun },
    devkitVersion: app.getVersion(),
    manifestRevision: manifests.loadedAt.slice(0, 10),
    versionsRoot
  })

  const preflight = await runPreflight({
    plan,
    tools: indexById(tools),
    targetPath: versionsRoot
  })

  currentPlan = plan
  logger.info('install', `已准备安装计划 ${plan.planId}：共 ${plan.items.length} 项`)
  return { plan, preflight, problems: [] }
}

export function startInstall(planId: string): StartInstallResult {
  if (!currentPlan) return { started: false, error: '没有待执行的安装计划，请重新选择' }
  if (currentPlan.planId !== planId) {
    return { started: false, error: '计划已失效（可能是应用重启过），请重新选择' }
  }
  if (controller) return { started: false, error: '已有安装任务正在进行中' }

  const activeController = new AbortController()
  controller = activeController

  const plan = currentPlan
  const { tools } = loadManifests()
  const config = loadConfig()

  void (async () => {
    // 安装前还原点（FR-10）：只在确实有机器级安装、且用户开了开关时才做
    if (config.createRestorePoint && plan.items.some((item) => item.requiresAdmin)) {
      logger.info('install', '安装前创建系统还原点')
      const restore = await createRestorePoint((message) => logger.info('elevation', message))
      if (!restore.ok) {
        // 还原点失败不阻断安装：它是锦上添花，而且很多机器根本没开系统保护
        logger.warn('install', `创建还原点失败（继续安装）：${restore.error}`)
      }
    }

    return runPlan({
      plan,
      tools: indexById(tools),
      downloadDir: getDownloadDir(),
      logDir: getLogDir(),
      signal: activeController.signal,
      dryRun: plan.options.dryRun,
      activate: config.activateAfterInstall ? activateHook : undefined,
      runElevatedCommand: async (label, command) => {
        const outcome = await runElevated([toExecStep(label, { ...command, requiresAdmin: true })], (message) =>
          logger.info('elevation', message)
        )
        if (!outcome.ok) {
          throw new Error(
            outcome.cancelled
              ? '用户取消了管理员授权，机器级安装未执行'
              : `提权安装失败：${outcome.error ?? '未知原因'}`
          )
        }
      },
      onUpdate: (event) => listener?.(event)
    })
  })()
    .then((finished) => {
      logger.info(
        'install',
        `计划 ${finished.planId} 执行完毕：成功 ${finished.summary.success}，失败 ${finished.summary.failed}`
      )
    })
    .catch((error: unknown) => {
      logger.error('install', `安装流程异常终止：${(error as Error).message}`)
      listener?.({ plan, currentItemId: null, detail: null })
    })
    .finally(() => {
      controller = null
    })

  return { started: true }
}

export function cancelInstall(): boolean {
  if (!controller) return false
  logger.warn('install', '用户请求取消安装')
  controller.abort()
  return true
}

export function getPendingPlan(): PendingPlanLoad {
  return loadPendingPlan()
}

export function discardPendingPlan(): void {
  clearPendingPlan()
  logger.info('install', '用户放弃了上次未完成的安装计划')
}

/** 续跑：把 pending 计划接过来当作当前计划 */
export function adoptPendingPlan(plan: InstallPlan): void {
  currentPlan = plan
}

/**
 * 续跑上次未完成的安装（FR-17）。
 * 应用重启后 currentPlan 是空的，所以要先把 pending.json 读出来接管。
 */
export function resumeInstall(): StartInstallResult {
  if (controller) return { started: false, error: '已有安装任务正在进行中' }

  const pending = loadPendingPlan()
  if (pending.status === 'none') return { started: false, error: '没有可继续的安装计划' }
  if (pending.status === 'invalid') {
    return { started: false, error: `上次的安装计划已失效：${pending.reason}` }
  }

  adoptPendingPlan(pending.plan)
  logger.info('install', `续跑安装计划 ${pending.plan.planId}`)
  return startInstall(pending.plan.planId)
}

/** 导出报告时用：拿到当前计划与清单索引 */
export function getCurrentPlan(): InstallPlan | null {
  return currentPlan
}
