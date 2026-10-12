import { create } from 'zustand'
import type {
  ActivationSnapshot,
  HotUpdateResultView,
  InstalledTool,
  OfflinePackResult,
  Preset,
  ApplyProfileOptions,
  DoctorFixId,
  DoctorReport,
  EnvProfile,
  ExportProfileRequest,
  ExportProfileResult,
  ImportProfileResult,
  SystemConfigItem,
  SystemConfigId,
  SystemConfigRequest,
  UpdateInfo,
  UserConfigView,
  VscodeExtension,
  VscodeInstallResult,
  VscodeStatus
} from '@shared/types'

/**
 * 「管理」类状态的单一入口：设置、预设、已安装、激活、离线包。
 *
 * 单独开一个 store 而不是塞进 app-store，是因为这些操作都会**改机器状态**
 * （写 PATH、删目录、改镜像配置），跟"读清单 + 跑检测"这种只读流程混在一起
 * 很容易出现"刷新检测时顺手把设置也重置了"这类 bug。
 */

export type NoticeKind = 'success' | 'error' | 'info' | 'warning'

export interface Notice {
  kind: NoticeKind
  text: string
}

interface ManageState {
  settings: UserConfigView | null
  presets: Preset[]
  installed: InstalledTool[]
  activation: ActivationSnapshot | null
  offlineResult: OfflinePackResult | null
  hotUpdateResult: HotUpdateResultView | null
  systemConfig: SystemConfigItem[]
  doctorOpen: boolean
  doctorReport: DoctorReport | null
  doctorRunning: boolean
  doctorFixing: boolean
  profileOpen: boolean
  exportedProfile: ExportProfileResult | null
  importedProfile: ImportProfileResult | null
  updateInfo: UpdateInfo | null
  /** 已下载好的更新包路径；null = 还没下载 */
  updateFilePath: string | null
  /** 更新包是否正在下载 */
  updateDownloading: boolean
  vscodeOpen: boolean
  vscodeStatus: VscodeStatus | null
  vscodeExtensions: VscodeExtension[]
  vscodeResult: VscodeInstallResult | null

  settingsOpen: boolean
  installedOpen: boolean
  busy: boolean
  notice: Notice | null

  setNotice: (notice: Notice | null) => void
  openSettings: (open: boolean) => void
  openInstalled: (open: boolean) => void

  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<UserConfigView>) => Promise<void>
  applyMirrors: () => Promise<void>

  loadPresets: () => Promise<void>
  savePreset: (name: string, selections: { toolId: string; version?: string }[]) => Promise<void>
  deletePreset: (id: string) => Promise<void>
  importPreset: (raw: unknown) => Promise<void>

  loadInstalled: () => Promise<void>
  uninstall: (toolId: string, version: string) => Promise<void>
  activate: (toolId: string, version: string) => Promise<void>
  deactivate: (toolId: string) => Promise<void>

  packOffline: (toolIds: string[]) => Promise<void>
  importOfflinePack: () => Promise<void>
  runHotUpdate: (url: string) => Promise<void>
  clearManifestOverride: () => Promise<void>

  openProfile: (open: boolean) => void
  exportProfile: (request: ExportProfileRequest) => Promise<void>
  importProfile: () => Promise<void>
  applyProfile: (profile: EnvProfile, options: ApplyProfileOptions) => Promise<void>

  openDoctor: (open: boolean) => void
  runDoctor: () => Promise<void>
  applyDoctorFix: (fixId: DoctorFixId) => Promise<void>

  loadSystemConfig: () => Promise<void>
  applySystemConfig: (request: SystemConfigRequest) => Promise<void>
  /** 还原某一项到 devkit 改动之前（没有备份记录会被拒绝） */
  revertSystemConfig: (id: SystemConfigId) => Promise<void>

  checkUpdate: () => Promise<void>
  /** 下载更新包（校验 SHA-256）并直接拉起安装程序 */
  downloadAndInstallUpdate: () => Promise<void>

  openVscode: (open: boolean) => void
  loadVscode: () => Promise<void>
  installExtensions: (ids: string[]) => Promise<void>
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Electron 的 IPC 错误前缀在界面上没有意义，去掉它只留下真正的原因
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

export const useManageStore = create<ManageState>()((set, get) => ({
  settings: null,
  presets: [],
  installed: [],
  activation: null,
  offlineResult: null,
  hotUpdateResult: null,
  systemConfig: [],
  doctorOpen: false,
  doctorReport: null,
  doctorRunning: false,
  doctorFixing: false,
  profileOpen: false,
  exportedProfile: null,
  importedProfile: null,
  updateInfo: null,
  updateFilePath: null,
  updateDownloading: false,
  vscodeOpen: false,
  vscodeStatus: null,
  vscodeExtensions: [],
  vscodeResult: null,
  settingsOpen: false,
  installedOpen: false,
  busy: false,
  notice: null,

  setNotice: (notice) => set({ notice }),
  openSettings: (open) => set({ settingsOpen: open }),
  openInstalled: (open) => {
    set({ installedOpen: open })
    if (open) void get().loadInstalled()
  },

  loadSettings: async () => {
    try {
      const settings = await window.devkit.getSettings()
      set({ settings })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  saveSettings: async (patch) => {
    set({ busy: true })
    try {
      const settings = await window.devkit.saveSettings(patch)
      set({ settings, notice: { kind: 'success', text: '设置已保存' } })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  applyMirrors: async () => {
    const settings = get().settings
    if (!settings) return

    set({ busy: true })
    try {
      const result = await window.devkit.applyMirrors(settings.mirrors)
      if (!result.ok) throw new Error(result.error ?? '应用镜像配置失败')
      set({
        notice: {
          kind: result.changed.length > 0 ? 'success' : 'info',
          text:
            result.changed.length > 0
              ? result.changed.join('；')
              : '没有需要改动的镜像配置'
        }
      })
      await get().loadSettings()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  loadPresets: async () => {
    try {
      set({ presets: await window.devkit.listPresets() })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  savePreset: async (name, selections) => {
    if (selections.length === 0) {
      set({ notice: { kind: 'warning', text: '请先勾选要保存的软件' } })
      return
    }
    try {
      const preset = await window.devkit.savePreset({
        id: `my-${Date.now().toString(36)}`,
        name: { 'zh-CN': name, 'en-US': name },
        description: {
          'zh-CN': `我保存的预设（${selections.length} 项）`,
          'en-US': `My preset (${selections.length} items)`
        },
        tools: selections
      })
      await get().loadPresets()
      set({ notice: { kind: 'success', text: `已保存预设「${preset.name['zh-CN'] ?? preset.id}」` } })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  deletePreset: async (id) => {
    try {
      await window.devkit.deletePreset(id)
      await get().loadPresets()
      set({ notice: { kind: 'success', text: '预设已删除' } })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  importPreset: async (raw) => {
    try {
      const preset = await window.devkit.importPreset(raw)
      await get().loadPresets()
      set({ notice: { kind: 'success', text: `已导入预设「${preset.id}」` } })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  loadInstalled: async () => {
    try {
      const [installed, activation] = await Promise.all([
        window.devkit.listInstalled(),
        window.devkit.getActivationSnapshot()
      ])
      set({ installed, activation })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  uninstall: async (toolId, version) => {
    set({ busy: true })
    try {
      const result = await window.devkit.uninstallTool({ toolId, version })
      if (!result.ok) throw new Error(result.error ?? '卸载失败')
      set({ notice: { kind: 'success', text: `已卸载 ${toolId}@${version}` } })
      await get().loadInstalled()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  activate: async (toolId, version) => {
    set({ busy: true })
    try {
      const result = await window.devkit.activateVersion({ toolId, version })
      if (!result.ok) throw new Error(result.error ?? '激活失败')
      set({ notice: { kind: 'success', text: result.note ?? '已激活' } })
      await get().loadInstalled()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  deactivate: async (toolId) => {
    set({ busy: true })
    try {
      const result = await window.devkit.deactivateTool(toolId)
      if (result.error) throw new Error(result.error)
      set({
        notice: {
          kind: 'success',
          text: result.removed.length > 0 ? `已取消激活：${result.removed.join('；')}` : '该工具本来就没激活'
        }
      })
      await get().loadInstalled()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  packOffline: async (toolIds) => {
    set({ busy: true, offlineResult: null })
    try {
      const result = await window.devkit.packOffline({ toolIds })
      set({
        offlineResult: result,
        notice: result.ok
          ? {
              kind: result.skipped.length > 0 ? 'warning' : 'success',
              text:
                `离线包已生成：${result.packDir}（${result.fileCount} 个文件）` +
                // 许可证分级导致的排除必须说出来，不能让用户以为"少打包了但没人告诉我"
                (result.skipped.length > 0
                  ? `；${result.skipped.length} 项因许可证分级未打包：${result.skipped
                      .map((item) => `${item.id}(${item.tier})`)
                      .join('、')}`
                  : '')
            }
          : { kind: 'error', text: result.error ?? '生成离线包失败' }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  importOfflinePack: async () => {
    set({ busy: true })
    try {
      const result = await window.devkit.importOfflinePack()
      if (!result.ok) throw new Error(result.error ?? '导入失败')
      set({
        notice: {
          kind: result.missing.length > 0 ? 'warning' : 'success',
          text:
            `已导入 ${result.imported} 个文件到下载缓存` +
            (result.missing.length > 0 ? `；${result.missing.length} 个文件缺失或校验失败` : '')
        }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  runHotUpdate: async (url) => {
    set({ busy: true, hotUpdateResult: null })
    try {
      const result = await window.devkit.runHotUpdate(url)
      set({
        hotUpdateResult: result,
        notice: result.ok
          ? {
              kind: result.applied > 0 ? 'success' : 'info',
              text: `清单更新：拉取 ${result.fetched} 个，应用 ${result.applied} 个，拒绝 ${result.rejected.length} 个`
            }
          : { kind: 'error', text: result.error ?? '清单更新失败' }
      })
      if (result.applied > 0) await get().loadSettings()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  clearManifestOverride: async () => {
    set({ busy: true })
    try {
      const removed = await window.devkit.clearManifestOverride()
      set({
        hotUpdateResult: null,
        notice: { kind: 'success', text: `已清除 ${removed} 个热更新覆盖，重启后回到内置清单` }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  openProfile: (open) => set({ profileOpen: open }),

  exportProfile: async (request) => {
    set({ busy: true, exportedProfile: null })
    try {
      const result = await window.devkit.exportProfile(request)
      set({
        exportedProfile: result,
        notice: result.ok
          ? { kind: 'success', text: `环境档案已导出：${result.filePath}` }
          : result.error === '已取消'
            ? null
            : { kind: 'error', text: result.error ?? '导出失败' }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  importProfile: async () => {
    set({ busy: true, importedProfile: null })
    try {
      const result = await window.devkit.importProfile()
      if (!result.ok && result.error === '已取消') return
      set({ importedProfile: result })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  applyProfile: async (profile, options) => {
    set({ busy: true })
    try {
      const result = await window.devkit.applyProfile(profile, options)
      if (!result.ok) throw new Error(result.error ?? '恢复失败')
      set({
        notice: {
          kind: result.changed.length > 0 ? 'success' : 'info',
          text:
            result.changed.length > 0
              ? `已恢复 ${result.changed.length} 项：${result.changed.slice(0, 3).join('；')}${result.changed.length > 3 ? ' …' : ''}`
              : '没有需要恢复的内容'
        }
      })
      await get().loadInstalled()
      await get().loadSettings()
      await get().runDoctor()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  openDoctor: (open) => set({ doctorOpen: open }),

  runDoctor: async () => {
    set({ doctorRunning: true })
    try {
      const report = await window.devkit.runDoctor()
      set({ doctorReport: report })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ doctorRunning: false })
    }
  },

  applyDoctorFix: async (fixId) => {
    set({ doctorFixing: true })
    try {
      const result = await window.devkit.applyDoctorFix(fixId)
      if (!result.ok) throw new Error(result.error ?? '修复失败')

      set({
        notice: {
          kind: result.changed.length > 0 ? 'success' : 'info',
          text:
            result.changed.length > 0
              ? `已修复 ${result.changed.length} 项${result.backupFile ? `；原文备份在 ${result.backupFile}` : ''}`
              : '没有需要修改的内容'
        }
      })
      // 修完立刻重跑体检，让用户看到结果，而不是靠猜
      await get().runDoctor()
      await get().loadInstalled()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ doctorFixing: false })
    }
  },

  loadSystemConfig: async () => {
    try {
      set({ systemConfig: await window.devkit.getSystemConfig() })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  openVscode: (open) => set({ vscodeOpen: open }),

  loadVscode: async () => {
    try {
      const [status, extensions] = await Promise.all([
        window.devkit.getVscodeStatus(),
        window.devkit.listVscodeExtensions()
      ])
      set({ vscodeStatus: status, vscodeExtensions: extensions })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    }
  },

  installExtensions: async (ids) => {
    set({ busy: true, vscodeResult: null })
    try {
      const result = await window.devkit.installVscodeExtensions(ids)
      set({
        vscodeResult: result,
        notice: result.error
          ? { kind: 'error', text: result.error }
          : {
              kind: result.failed.length > 0 ? 'warning' : 'success',
              text: `插件安装完成：成功 ${result.installed.length}，失败 ${result.failed.length}`
            }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  checkUpdate: async () => {
    set({ busy: true, updateInfo: null })
    try {
      const info = await window.devkit.checkForUpdate()
      set({ updateInfo: info })
      set({
        notice: info.error
          ? { kind: 'warning', text: info.error }
          : info.hasUpdate
            ? { kind: 'success', text: `发现新版本 ${info.latestVersion}` }
            : { kind: 'info', text: `已是最新版本（${info.currentVersion}）` }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  downloadAndInstallUpdate: async () => {
    const info = get().updateInfo
    if (!info?.hasUpdate) {
      set({ notice: { kind: 'info', text: '当前没有可安装的更新' } })
      return
    }

    set({ updateDownloading: true, updateFilePath: null })
    try {
      const result = await window.devkit.downloadUpdate()
      if (!result.ok || !result.filePath) {
        throw new Error(result.error ?? '下载更新包失败')
      }

      set({ updateFilePath: result.filePath })
      await window.devkit.installUpdate(result.filePath)

      set({
        notice: {
          kind: 'success',
          text:
            '安装包已打开，请按提示完成安装（devkit 会在安装完成后关闭）。' +
            (result.verified === false ? ' 注意：更新源未提供校验和，本次未做完整性校验。' : '')
        }
      })
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ updateDownloading: false })
    }
  },

  applySystemConfig: async (request) => {
    set({ busy: true })
    try {
      const result = await window.devkit.applySystemConfig(request)
      if (!result.ok) throw new Error(result.error ?? '应用失败')
      set({
        notice: {
          kind: 'success',
          text: `${request.id} 已配置：${result.detail ?? '完成'}`
        }
      })
      await get().loadSystemConfig()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  },

  revertSystemConfig: async (id) => {
    set({ busy: true })
    try {
      const result = await window.devkit.revertSystemConfig({ id })
      if (!result.ok) throw new Error(result.error ?? '还原失败')
      set({
        notice: {
          kind: 'success',
          text: `${id} 已还原：${result.detail ?? '完成'}`
        }
      })
      await get().loadSystemConfig()
      // 体检会读这些系统项，顺带刷新，免得两处显示不一致
      await get().runDoctor()
    } catch (error) {
      set({ notice: { kind: 'error', text: describeError(error) } })
    } finally {
      set({ busy: false })
    }
  }
}))
