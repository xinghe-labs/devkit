import { contextBridge, ipcRenderer } from 'electron'
import type { DevkitApi } from '@shared/api'
import { IPC } from '@shared/ipc'
import type {
  ActivateRequest,
  DetectRequest,
  InstallProgressEvent,
  Locale,
  LogEntry,
  MirrorSetting,
  OfflinePackRequest,
  PlanSelection,
  SystemConfigRequest,
  UninstallRequest
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

  prepareInstall: (selections: PlanSelection[], dryRun = false) =>
    ipcRenderer.invoke(IPC.installPrepare, { selections, dryRun }),

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
  },

  /* ---------------- 预设方案 ---------------- */
  listPresets: () => ipcRenderer.invoke(IPC.presetList),
  savePreset: (preset: unknown) => ipcRenderer.invoke(IPC.presetSave, preset),
  deletePreset: (id: string) => ipcRenderer.invoke(IPC.presetDelete, id),
  importPreset: (raw: unknown) => ipcRenderer.invoke(IPC.presetImport, raw),

  /* ---------------- 激活与版本切换 ---------------- */
  getActivationSnapshot: () => ipcRenderer.invoke(IPC.activateSnapshot),
  activateVersion: (request: ActivateRequest) => ipcRenderer.invoke(IPC.activateApply, request),
  deactivateTool: (toolId: string) => ipcRenderer.invoke(IPC.activateRemove, toolId),

  /* ---------------- 已安装项与卸载 ---------------- */
  listInstalled: () => ipcRenderer.invoke(IPC.installedList),
  uninstallTool: (request: UninstallRequest) => ipcRenderer.invoke(IPC.uninstallRun, request),

  /* ---------------- 设置与镜像源 ---------------- */
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (patch: unknown) => ipcRenderer.invoke(IPC.settingsSave, patch),
  applyMirrors: (settings: MirrorSetting[]) => ipcRenderer.invoke(IPC.mirrorsApply, settings),

  openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url),

  /* ---------------- 更新检查 ---------------- */
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),

  /* ---------------- 系统配置 ---------------- */
  getSystemConfig: () => ipcRenderer.invoke(IPC.systemStatus),
  applySystemConfig: (request: SystemConfigRequest) => ipcRenderer.invoke(IPC.systemApply, request),

  /* ---------------- 清单热更新 ---------------- */
  runHotUpdate: (url: string) => ipcRenderer.invoke(IPC.manifestHotUpdate, url),
  clearManifestOverride: () => ipcRenderer.invoke(IPC.manifestClearOverride),

  /* ---------------- 离线包 ---------------- */
  packOffline: (request: OfflinePackRequest) => ipcRenderer.invoke(IPC.offlinePack, request),
  importOfflinePack: (packDir?: string) => ipcRenderer.invoke(IPC.offlineImport, { packDir })
}

contextBridge.exposeInMainWorld('devkit', api)
