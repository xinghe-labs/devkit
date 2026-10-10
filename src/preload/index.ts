import { contextBridge, ipcRenderer } from 'electron'
import type { DevkitApi } from '@shared/api'
import { IPC } from '@shared/ipc'
import type {
  DetectRequest,
  InstallProgressEvent,
  Locale,
  LogEntry,
  PlanSelection
} from '@shared/types'

/**
 * 预加载脚本。
 *
 * 这里只做一件事：把白名单通道包装成类型化方法挂到 window.devkit。
 * 不暴露 ipcRenderer 本体、不暴露任意通道调用能力、不开 nodeIntegration。
 */
const api: DevkitApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),

  listManifests: () => ipcRenderer.invoke(IPC.manifestList),

  runDetection: (request: DetectRequest = {}) => ipcRenderer.invoke(IPC.detectRun, request),

  getLocale: () => ipcRenderer.invoke(IPC.localeGet),

  setLocale: (locale: Locale) => ipcRenderer.invoke(IPC.localeSet, locale),

  tailLog: (count = 500) => ipcRenderer.invoke(IPC.logTail, count),

  openLogDir: () => ipcRenderer.invoke(IPC.logOpenDir),

  signalReady: () => ipcRenderer.invoke(IPC.rendererReady),

  onLogLine: (listener: (entry: LogEntry) => void) => {
    const handler = (_event: unknown, entry: LogEntry): void => listener(entry)
    ipcRenderer.on(IPC.logLine, handler)
    return () => {
      ipcRenderer.off(IPC.logLine, handler)
    }
  },

  prepareInstall: (selections: PlanSelection[]) =>
    ipcRenderer.invoke(IPC.installPrepare, { selections }),

  startInstall: (planId: string) => ipcRenderer.invoke(IPC.installStart, planId),

  cancelInstall: () => ipcRenderer.invoke(IPC.installCancel),

  getPendingPlan: () => ipcRenderer.invoke(IPC.installPending),

  discardPendingPlan: () => ipcRenderer.invoke(IPC.installDiscardPending),

  resumeInstall: () => ipcRenderer.invoke(IPC.installResume),

  exportInstallReport: () => ipcRenderer.invoke(IPC.installExportReport),

  onInstallProgress: (listener: (event: InstallProgressEvent) => void) => {
    const handler = (_event: unknown, payload: InstallProgressEvent): void => listener(payload)
    ipcRenderer.on(IPC.installProgress, handler)
    return () => {
      ipcRenderer.off(IPC.installProgress, handler)
    }
  }
}

contextBridge.exposeInMainWorld('devkit', api)
