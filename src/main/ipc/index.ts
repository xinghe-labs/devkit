import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppInfo, DetectionResult, Locale, LogEntry, ManifestLoadResult } from '@shared/types'
import { detectAll } from '../core/detect'
import { loadManifests } from '../core/manifest'
import { logger } from '../core/report/logger'
import { getLocale, setLocale } from '../core/settings'
import { getLogDir, getManifestDir } from '../utils/app-paths'
import { asBoundedInt, asOptionalObject, asOptionalStringArray } from './validate'

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

    // CI / 无人值守冒烟：启动到渲染就绪后自动退出，用日志判定成败
    if (process.env.DEVKIT_SMOKE === '1') {
      const delay = Number(process.env.DEVKIT_SMOKE_DELAY_MS ?? 12000)
      logger.info('app', `DEVKIT_SMOKE 已启用，${delay}ms 后自动退出`)
      setTimeout(() => app.quit(), Number.isFinite(delay) ? delay : 12000)
    }
    return true
  })
}
