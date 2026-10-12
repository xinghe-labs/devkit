import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import { indexById } from '@shared/manifest'
import { IPC } from '@shared/ipc'
import type {
  ActivateRequest,
  ActivateResult,
  ActivationSnapshot,
  AppInfo,
  DetectionResult,
  HotUpdateResultView,
  InstalledTool,
  Locale,
  LogEntry,
  ManifestLoadResult,
  MirrorApplyResult,
  MirrorSetting,
  OfflinePackRequest,
  OfflinePackResult,
  PendingPlanLoad,
  PlanPreparation,
  Preset,
  StartInstallResult,
  SystemConfigId,
  SystemConfigItem,
  SystemConfigResult,
  UninstallRequest,
  UpdateInfo,
  UninstallResult,
  UserConfigView
} from '@shared/types'
import { activateVersion, deactivateTool, getSnapshot } from '../core/activate'
import { applyMirrors } from '../core/config/mirrors'
import { detectAll } from '../core/detect'
import {
  cancelInstall,
  discardPendingPlan,
  getCurrentPlan,
  getPendingPlan,
  prepareInstall,
  resumeInstall,
  startInstall
} from '../core/executor/service'
import { loadManifests } from '../core/manifest'
import { importOfflinePack, packOffline } from '../core/offline'
import { clearUserManifests, runHotUpdate } from '../core/hotupdate'
import { applySystemConfig, getSystemConfigStatus } from '../core/systemconfig'
import { checkForUpdate } from '../core/updater'
import { deleteUserPreset, importPreset, listPresets, saveUserPreset } from '../core/presets'
import { renderPlanReport } from '../core/report/markdown'
import { logger } from '../core/report/logger'
import { getRendererErrors } from '../core/report/renderer-errors'
import { runSmokeCapture } from '../core/report/smoke'
import { getConfigView, getLocale, loadConfig, saveConfigView, setLocale } from '../core/settings'
import { listInstalledWithSize, uninstallVersion } from '../core/uninstall'
import { getDownloadDir, getLogDir, getManifestDir, getOfflineDir } from '../utils/app-paths'
import {
  asBoundedInt,
  asBoolean,
  asNonEmptyString,
  asOptionalObject,
  asOptionalStringArray,
  asPlanSelections,
  asToolId
} from './validate'

type Handler<Args extends unknown[], Result> = (
  event: IpcMainInvokeEvent,
  ...args: Args
) => Result | Promise<Result>

/**
 * 统一包装 handler：捕获异常 → 写日志 → 抛出可读错误给渲染进程。
 * 未包装的异常在渲染进程侧只会看到 "Error invoking remote method"，无法排查。
 */
function handle<Args extends unknown[], Result>(
  channel: string,
  handler: Handler<Args, Result>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as Args))
    } catch (error) {
      const message = (error as Error).message
      logger.error('ipc', `通道 ${channel} 执行失败：${message}`)
      throw new Error(message, { cause: error })
    }
  })
}

function buildAppInfo(): AppInfo {
  return {
    version: app.getVersion(),
    locale: getLocale(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    manifestDir: getManifestDir(),
    logDir: getLogDir(),
    logFile: logger.currentFile,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown'
  }
}

export function registerIpcHandlers(): void {
  handle(IPC.appInfo, (): AppInfo => buildAppInfo())

  handle(IPC.manifestList, (): ManifestLoadResult => loadManifests())

  handle(IPC.detectRun, async (_event, payload: unknown): Promise<DetectionResult[]> => {
    const request = asOptionalObject(payload, 'detect 请求')
    const toolIds = asOptionalStringArray(request.toolIds, 'toolIds')

    const { tools } = loadManifests()
    const targets = toolIds.length === 0 ? tools : tools.filter((tool) => toolIds.includes(tool.id))

    logger.info('detect', `开始检测 ${targets.length} 个工具`)
    return detectAll(targets)
  })

  handle(IPC.localeGet, (): Locale => getLocale())

  handle(IPC.localeSet, (_event, value: unknown): Locale => setLocale(value))

  handle(IPC.logTail, (_event, count: unknown): LogEntry[] =>
    logger.tail(asBoundedInt(count, 'count', 500, 1, 3000))
  )

  handle(IPC.logOpenDir, async (): Promise<boolean> => {
    const message = await shell.openPath(getLogDir())
    return message === ''
  })

  handle(IPC.rendererReady, (): boolean => {
    logger.info('app', '渲染进程已挂载，IPC 链路（渲染 → 预加载 → 主进程）已打通')

    // CI / 无人值守冒烟：启动到渲染就绪后自动退出，用日志与退出码判定成败
    if (process.env.DEVKIT_SMOKE === '1') {
      const delay = Number(process.env.DEVKIT_SMOKE_DELAY_MS ?? 12000)
      logger.info('app', `DEVKIT_SMOKE 已启用，${delay}ms 后自动退出`)
      setTimeout(
        () => {
          void (async () => {
            const shot = await runSmokeCapture(process.env.DEVKIT_SMOKE_SHOT)
            if (shot) logger.info('app', `冒烟截图已保存：${shot}`)

            const rendererErrors = getRendererErrors()
            if (rendererErrors.length > 0) {
              logger.error('app', `冒烟失败：渲染进程报了 ${rendererErrors.length} 个错误`)
              for (const message of rendererErrors.slice(0, 10)) logger.error('app', `  · ${message}`)
              app.exit(1)
              return
            }
            logger.info('app', '冒烟通过：界面已渲染且渲染进程无报错')
            app.exit(0)
          })()
        },
        Number.isFinite(delay) ? delay : 12000
      )
    }
    return true
  })

  handle(IPC.installPrepare, async (_event, payload: unknown): Promise<PlanPreparation> => {
    const request = asOptionalObject(payload, 'install 请求')
    const selections = asPlanSelections(request.selections, 'selections')
    const dryRun = asBoolean(request.dryRun, 'dryRun', false)
    return prepareInstall(selections, dryRun)
  })

  handle(IPC.installStart, (_event, planId: unknown): StartInstallResult =>
    startInstall(asNonEmptyString(planId, 'planId'))
  )

  handle(IPC.installCancel, (): boolean => cancelInstall())

  handle(IPC.installPending, (): PendingPlanLoad => getPendingPlan())

  handle(IPC.installDiscardPending, (): boolean => {
    discardPendingPlan()
    return true
  })

  handle(IPC.installResume, (): StartInstallResult => resumeInstall())

  handle(IPC.installExportReport, async (): Promise<string | null> => {
    const plan = getCurrentPlan()
    if (!plan) throw new Error('还没有可导出的安装报告')

    const markdown = renderPlanReport(plan, indexById(loadManifests().tools), getLocale())
    const result = await dialog.showSaveDialog({
      title: '导出安装报告',
      defaultPath: `devkit-report-${plan.planId}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })

    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, markdown, 'utf8')
    logger.info('report', `安装报告已导出：${result.filePath}`)
    return result.filePath
  })

  /* ---------------- 预设方案（FR-3） ---------------- */

  handle(IPC.presetList, (): Preset[] => listPresets())

  handle(IPC.presetSave, (_event, payload: unknown): Preset => saveUserPreset(payload))

  handle(IPC.presetDelete, (_event, id: unknown): boolean => deleteUserPreset(asToolId(id, 'presetId')))

  handle(IPC.presetImport, (_event, payload: unknown): Preset => importPreset(payload))

  /* ---------------- 激活与版本切换（FR-11） ---------------- */

  handle(IPC.activateSnapshot, (): Promise<ActivationSnapshot> => getSnapshot())

  handle(IPC.activateApply, async (_event, payload: unknown): Promise<ActivateResult> => {
    const request = asOptionalObject(payload, 'activate 请求')
    const toolId = asToolId(request.toolId, 'toolId')
    const version = asNonEmptyString(request.version, 'version', 40)

    const { tools } = loadManifests()
    const tool = tools.find((item) => item.id === toolId)
    if (!tool) throw new Error(`清单里没有这个工具：${toolId}`)

    const spec = tool.versions.find((item) => item.version === version)
    if (!spec) throw new Error(`清单里没有版本 ${version}`)
    if (!spec.activate) {
      throw new Error(`${toolId}@${version} 没有声明激活方式，装好后请手动配置 PATH`)
    }

    const installed = await listInstalledWithSize(tools)
    const target = installed.find((item) => item.toolId === toolId && item.version === version)
    if (!target) throw new Error(`${toolId}@${version} 还没装到 devkit 的版本目录里`)

    const activateRequest: ActivateRequest = { toolId, version }
    logger.info('activate', `请求激活 ${activateRequest.toolId}@${activateRequest.version}`)
    return activateVersion({
      toolId,
      version,
      installDir: target.installDir,
      spec: spec.activate,
      // 用清单里的检测命令做"新终端验证"：写进 PATH 不等于生效
      verifySpec: tool.detect.commands?.[0]
    })
  })

  handle(IPC.activateRemove, async (_event, toolId: unknown) => {
    const id = asToolId(toolId, 'toolId')
    return deactivateTool(id)
  })

  /* ---------------- 已安装项与卸载（FR-16） ---------------- */

  handle(IPC.installedList, async (): Promise<InstalledTool[]> => {
    const { tools } = loadManifests()
    return listInstalledWithSize(tools)
  })

  handle(IPC.uninstallRun, async (_event, payload: unknown): Promise<UninstallResult> => {
    const request = asOptionalObject(payload, 'uninstall 请求')
    const toolId = asToolId(request.toolId, 'toolId')
    const version = asNonEmptyString(request.version, 'version', 40)
    const uninstallRequest: UninstallRequest = { toolId, version }
    return uninstallVersion(uninstallRequest.toolId, uninstallRequest.version)
  })

  /* ---------------- 设置与镜像源 ---------------- */

  handle(IPC.settingsGet, (): UserConfigView => getConfigView())

  handle(IPC.settingsSave, (_event, payload: unknown): UserConfigView =>
    saveConfigView(payload)
  )

  handle(IPC.mirrorsApply, (_event, payload: unknown): MirrorApplyResult => {
    const list = Array.isArray(payload) ? payload : []
    const settings: MirrorSetting[] = list
      .filter(
        (item): item is MirrorSetting =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as MirrorSetting).target === 'string' &&
          typeof (item as MirrorSetting).enabled === 'boolean' &&
          typeof (item as MirrorSetting).url === 'string'
      )
      .map((item) => ({ target: item.target, enabled: item.enabled, url: item.url }))

    const result = applyMirrors(settings)
    if (result.ok) saveConfigView({ mirrors: settings })
    return result
  })

  handle(IPC.appOpenExternal, async (_event, url: unknown): Promise<boolean> => {
    const target = asNonEmptyString(url, 'url', 2000)
    // 只允许 https：file:// 或自定义协议会把"打开链接"变成"执行本地东西"
    if (!/^https:\/\//i.test(target)) throw new Error('只允许打开 https 链接')
    await shell.openExternal(target)
    logger.info('app', `已在系统浏览器打开：${target}`)
    return true
  })

  /* ---------------- 更新检查（FR-13） ---------------- */

  handle(IPC.updateCheck, async (): Promise<UpdateInfo> => {
    const config = loadConfig()
    if (!config.updateFeedUrl) {
      return {
        hasUpdate: false,
        currentVersion: app.getVersion(),
        latestVersion: null,
        downloadUrl: null,
        notes: null,
        error: '还没有配置更新源（设置 → 关于 → 更新源）'
      }
    }
    return checkForUpdate({
      feedUrl: config.updateFeedUrl,
      currentVersion: app.getVersion(),
      proxy: config.proxy
    })
  })

  /* ---------------- 系统配置（FR-6） ---------------- */

  handle(IPC.systemStatus, (): Promise<SystemConfigItem[]> => getSystemConfigStatus())

  handle(IPC.systemApply, async (_event, payload: unknown): Promise<SystemConfigResult> => {
    const request = asOptionalObject(payload, 'system 请求')
    const id = asNonEmptyString(request.id, 'id', 40) as SystemConfigId
    const gitName = typeof request.gitName === 'string' ? request.gitName : undefined
    const gitEmail = typeof request.gitEmail === 'string' ? request.gitEmail : undefined
    return applySystemConfig({ id, gitName, gitEmail })
  })

  /* ---------------- 清单热更新（FR-15） ---------------- */

  handle(IPC.manifestHotUpdate, async (_event, url: unknown): Promise<HotUpdateResultView> => {
    const target = asNonEmptyString(url, 'url', 500)
    const { tools } = loadManifests()
    const result = await runHotUpdate({ url: target, tools, proxy: loadConfig().proxy })
    return result
  })

  handle(IPC.manifestClearOverride, (): number => clearUserManifests())

  /* ---------------- 离线包（FR-12） ---------------- */

  handle(IPC.offlinePack, async (_event, payload: unknown): Promise<OfflinePackResult> => {
    const request = asOptionalObject(payload, 'offline 请求') as unknown as OfflinePackRequest
    const toolIds = asOptionalStringArray(request.toolIds, 'toolIds')
    if (toolIds.length === 0) throw new Error('请至少选择一个要打进离线包的软件')

    let outputDir = typeof request.outputDir === 'string' ? request.outputDir : null
    if (!outputDir) {
      const picked = await dialog.showOpenDialog({
        title: '选择离线包输出目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, packDir: null, fileCount: 0, totalBytes: 0, error: '已取消' }
      }
      outputDir = picked.filePaths[0]
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const packDir = `${outputDir}\\devkit-offline-${stamp}`
    const { tools } = loadManifests()
    const config = loadConfig()

    return packOffline({
      toolIds,
      tools: indexById(tools),
      packDir,
      downloadDir: getDownloadDir(),
      devkitVersion: app.getVersion(),
      mirrorPreference: config.mirrorPreference,
      proxy: config.proxy
    })
  })

  handle(IPC.offlineImport, async (_event, payload: unknown) => {
    const request = asOptionalObject(payload, 'offline 导入请求')
    let packDir = typeof request.packDir === 'string' ? request.packDir : null
    if (!packDir) {
      const picked = await dialog.showOpenDialog({
        title: '选择离线包目录',
        defaultPath: getOfflineDir(),
        properties: ['openDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, imported: 0, missing: [], entries: [], error: '已取消' }
      }
      packDir = picked.filePaths[0]
    }
    return importOfflinePack(packDir, getDownloadDir())
  })
}
