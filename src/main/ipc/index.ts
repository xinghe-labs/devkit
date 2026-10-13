import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { indexById } from '@shared/manifest'
import { IPC } from '@shared/ipc'
import { MIRROR_TARGETS, MIRROR_URL_PATTERN, type MirrorTarget } from '@shared/types'
import type {
  ActivateRequest,
  ActivateResult,
  ActivationSnapshot,
  AppInfo,
  DetectionResult,
  DoctorFixId,
  DoctorFixResult,
  ApplyProfileResult,
  DoctorReport,
  DownloadUpdateResult,
  ExportProfileResult,
  ImportProfileResult,
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
  VscodeExtension,
  VscodeInstallResult,
  VscodeStatus,
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
import { collectProfile, defaultProfileFileName, describeProfile, diffProfile, sanitizeProfile } from '../core/profile'
import { applyProfile } from '../core/profile'
import { runDoctor } from '../core/doctor'
import { applyDoctorFix } from '../core/doctor/fix'
import { applySystemConfig, getSystemConfigStatus, revertSystemConfig } from '../core/systemconfig'

/** 系统配置项的显式白名单（还原会改注册表，不接受渲染进程传任意值） */
const SYSTEM_CONFIG_IDS: SystemConfigId[] = [
  'git-identity',
  'powershell-policy',
  'long-paths',
  'developer-mode',
  'ssh-key',
  'machine-path'
]
import { checkForUpdate, downloadUpdate } from '../core/updater'
import { getVscodeStatus, installVscodeExtensions, listVscodeExtensions } from '../core/vscode'
import { deleteUserPreset, importPreset, listPresets, saveUserPreset } from '../core/presets'
import { renderPlanReport } from '../core/report/markdown'
import { logger } from '../core/report/logger'
import { getRendererErrors } from '../core/report/renderer-errors'
import { runSmokeCapture } from '../core/report/smoke'
import { getConfigView, getLocale, loadConfig, saveConfigView, setLocale } from '../core/settings'
import { listInstalledWithSize, uninstallVersion } from '../core/uninstall'
import {
  getDownloadDir,
  getLogDir,
  getManifestDir,
  getOfflineDir,
  getUpdateDir
} from '../utils/app-paths'
import {
  asBoundedInt,
  IpcValidationError,
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
    // 机器上已可用的工具：用来判定前置依赖是否已被满足，
    // 避免「本机早有 JDK、这次只想装 Maven」被误判成缺依赖
    const availableToolIds = asOptionalStringArray(request.availableToolIds, 'availableToolIds')
    return prepareInstall(selections, dryRun, availableToolIds)
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
    const settings: MirrorSetting[] = list.map((item) => {
      if (typeof item !== 'object' || item === null) {
        throw new IpcValidationError('mirrors 的元素必须是对象')
      }
      const record = item as Partial<MirrorSetting>

      if (!MIRROR_TARGETS.includes(record.target as MirrorTarget)) {
        throw new IpcValidationError(`未知的镜像目标：${String(record.target)}`)
      }
      if (typeof record.enabled !== 'boolean') {
        throw new IpcValidationError('mirrors 的 enabled 必须是布尔值')
      }
      const url = typeof record.url === 'string' ? record.url.trim() : ''
      if (url !== '' && !MIRROR_URL_PATTERN.test(url)) {
        // 这里必须挡住：地址会被拼进 gradle/cargo 的可执行配置文件（安全审查 H2）
        throw new IpcValidationError(`镜像地址不合法：${JSON.stringify(url.slice(0, 80))}`)
      }

      return { target: record.target as MirrorTarget, enabled: record.enabled, url }
    })

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

  /**
   * 下载更新包并校验 SHA-256。
   *
   * 刻意不让渲染进程传 URL：URL 由主进程自己重新查一次更新源拿到，
   * 否则渲染进程被注入后可以让我们去下载任意地址、再拉起执行。
   */
  handle(IPC.updateDownload, async (): Promise<DownloadUpdateResult> => {
    const config = loadConfig()
    if (!config.updateFeedUrl) throw new Error('还没有配置更新源')

    const info = await checkForUpdate({
      feedUrl: config.updateFeedUrl,
      currentVersion: app.getVersion(),
      proxy: config.proxy
    })
    if (!info.hasUpdate || !info.downloadUrl) {
      throw new Error(info.error ?? '当前没有可下载的更新包')
    }

    logger.info('updater', `开始下载更新包：${info.latestVersion} → ${info.downloadUrl}`)
    return downloadUpdate({
      url: info.downloadUrl,
      sha256: info.downloadSha256,
      targetDir: getUpdateDir(),
      proxy: config.proxy
    })
  })

  /**
   * 拉起已下载的安装包。
   *
   * 安全边界：**只允许拉起 devkit 自己下载目录下的 .exe**。
   * 否则渲染进程被注入后，「打开更新包」就等于一条任意程序执行通道。
   */
  handle(IPC.updateInstall, async (_event, filePath: unknown): Promise<boolean> => {
    const target = asNonEmptyString(filePath, 'filePath', 1000)
    const updateDir = getUpdateDir()
    const normalized = resolve(target)
    if (!normalized.toLowerCase().startsWith(updateDir.toLowerCase())) {
      throw new Error(`只能安装 devkit 自己下载的更新包（${updateDir} 之内）`)
    }
    if (!/\.exe$/i.test(normalized)) throw new Error('更新包必须是 .exe')

    const message = await shell.openPath(normalized)
    if (message !== '') throw new Error(`无法拉起安装包：${message}`)
    logger.info('updater', `已拉起安装包：${normalized}`)
    return true
  })

  /* ---------------- VS Code 插件（FR-7） ---------------- */

  handle(IPC.vscodeStatus, (): Promise<VscodeStatus> => getVscodeStatus())

  handle(IPC.vscodeList, (): VscodeExtension[] => listVscodeExtensions())

  handle(IPC.vscodeInstall, async (_event, payload: unknown): Promise<VscodeInstallResult> => {
    const ids = asOptionalStringArray(payload, 'extensionIds', 100)
    return installVscodeExtensions(ids)
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
        downloadSha256: null,
        sizeBytes: null,
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

  /* ---------------- 环境档案 / 换机迁移（FR-22） ---------------- */

  handle(IPC.profileExport, async (_event, payload: unknown): Promise<ExportProfileResult> => {
    const request = asOptionalObject(payload, 'profile 导出请求')
    const includeGitIdentity = asBoolean(request.includeGitIdentity, 'includeGitIdentity', false)

    const manifests = loadManifests()
    const detections = await detectAll(manifests.tools)
    const installed = await listInstalledWithSize(manifests.tools)

    const profile = await collectProfile(
      {
        tools: manifests.tools,
        detections,
        installed,
        mirrors: loadConfig().mirrors
      },
      { includeGitIdentity }
    )

    // 传了 filePath 就直接写（脚本化迁移用），否则弹保存对话框
    let target =
      typeof request.filePath === 'string' && request.filePath.trim() !== ''
        ? request.filePath.trim()
        : null

    if (target) {
      if (!isAbsolute(target)) throw new IpcValidationError('档案输出路径必须是绝对路径')
    } else {
      const picked = await dialog.showSaveDialog({
        title: '导出环境档案',
        defaultPath: defaultProfileFileName(),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (picked.canceled || !picked.filePath) {
        return { ok: false, filePath: null, profile: null, error: '已取消' }
      }
      target = picked.filePath
    }

    await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    logger.info('profile', `环境档案已导出：${target}`)
    return { ok: true, filePath: target, profile, error: null }
  })

  handle(IPC.profileImport, async (): Promise<ImportProfileResult> => {
    const picked = await dialog.showOpenDialog({
      title: '导入环境档案',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, filePath: null, profile: null, description: [], diff: null, error: '已取消' }
    }

    const filePath = picked.filePaths[0]
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      // 别人给的档案不能直接信：走一遍白名单清洗
      const profile = sanitizeProfile(raw)

      const manifests = loadManifests()
      const detections = await detectAll(manifests.tools)
      const installed = await listInstalledWithSize(manifests.tools)

      const diff = await diffProfile(profile, {
        tools: manifests.tools,
        detections,
        installed
      })

      logger.info('profile', `环境档案已导入：${filePath}`)
      return {
        ok: true,
        filePath,
        profile,
        description: describeProfile(profile),
        diff,
        error: null
      }
    } catch (error) {
      const message = (error as Error).message
      logger.warn('profile', `导入档案失败：${message}`)
      return { ok: false, filePath, profile: null, description: [], diff: null, error: message }
    }
  })

  handle(IPC.profileApply, async (_event, payload: unknown): Promise<ApplyProfileResult> => {
    const request = asOptionalObject(payload, 'profile 恢复请求')
    const profile = sanitizeProfile(request.profile)
    const options = asOptionalObject(request.options, 'options')

    return applyProfile(profile, {
      restoreUserPath: asBoolean(options.restoreUserPath, 'restoreUserPath', false),
      restoreEnv: asBoolean(options.restoreEnv, 'restoreEnv', false),
      restoreMirrors: asBoolean(options.restoreMirrors, 'restoreMirrors', false),
      restoreGit: asBoolean(options.restoreGit, 'restoreGit', false)
    })
  })

  /* ---------------- 环境体检（FR-21） ---------------- */

  handle(IPC.doctorRun, (): Promise<DoctorReport> => runDoctor())

  handle(IPC.doctorFix, async (_event, payload: unknown): Promise<DoctorFixResult> => {
    const fixId = asNonEmptyString(payload, 'fixId', 40)
    const allowed: DoctorFixId[] = ['clean-user-path', 'clean-machine-path', 'prune-devkit-state']
    if (!allowed.includes(fixId as DoctorFixId)) {
      throw new IpcValidationError(`未知的修复项：${fixId}`)
    }
    return applyDoctorFix(fixId as DoctorFixId)
  })

  /* ---------------- 系统配置（FR-6） ---------------- */

  handle(IPC.systemStatus, (): Promise<SystemConfigItem[]> => getSystemConfigStatus())

  handle(IPC.systemApply, async (_event, payload: unknown): Promise<SystemConfigResult> => {
    const request = asOptionalObject(payload, 'system 请求')
    const id = asNonEmptyString(request.id, 'id', 40) as SystemConfigId
    const gitName = typeof request.gitName === 'string' ? request.gitName : undefined
    const gitEmail = typeof request.gitEmail === 'string' ? request.gitEmail : undefined
    const machinePathMode =
      request.machinePathMode === 'add' || request.machinePathMode === 'remove'
        ? request.machinePathMode
        : undefined
    return applySystemConfig({ id, gitName, gitEmail, machinePathMode })
  })

  handle(IPC.systemRevert, async (_event, payload: unknown): Promise<SystemConfigResult> => {
    const request = asOptionalObject(payload, 'system 还原请求')
    const id = asNonEmptyString(request.id, 'id', 40)
    // 显式白名单：还原会改注册表，不能让渲染进程传任意字符串进来
    if (!SYSTEM_CONFIG_IDS.includes(id as SystemConfigId)) {
      throw new IpcValidationError(`不支持的系统配置项：${id}`)
    }
    return revertSystemConfig(id as SystemConfigId)
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
        return { ok: false, packDir: null, fileCount: 0, totalBytes: 0, skipped: [], error: '已取消' }
      }
      outputDir = picked.filePaths[0]
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    // 用 path.join 而不是手拼分隔符：用户选的目录可能带尾随分隔符，也可能是相对路径
    const packDir = join(outputDir, `devkit-offline-${stamp}`)
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
    // 只接受绝对路径：相对路径会按主进程的 cwd 解析，渲染进程等于能指定任意位置
    if (packDir && !isAbsolute(packDir)) {
      throw new IpcValidationError(`离线包目录必须是绝对路径：${packDir}`)
    }
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
