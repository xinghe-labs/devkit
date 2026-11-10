// window.devkit 的全局类型声明在 devkit-global.d.ts（R7 起，preload 已删）
import type {
  ActivateRequest,
  ActivateResult,
  ActivationSnapshot,
  AppInfo,
  DetectRequest,
  DetectionResult,
  DoctorFixId,
  DoctorFixResult,
  ApplyProfileOptions,
  ApplyProfileResult,
  DoctorReport,
  DownloadUpdateResult,
  EnvProfile,
  ExportProfileRequest,
  ExportProfileResult,
  ImportProfileResult,
  InstallProgressEvent,
  InstalledTool,
  Locale,
  LogEntry,
  HotUpdateResultView,
  ManifestLoadResult,
  MirrorApplyResult,
  MirrorSetting,
  OfflinePackRequest,
  OfflinePackResult,
  PendingPlanLoad,
  PlanPreparation,
  PlanSelection,
  Preset,
  StartInstallResult,
  SystemConfigItem,
  SystemConfigRequest,
  SystemConfigRevertRequest,
  SystemConfigResult,
  UninstallRequest,
  UpdateInfo,
  VscodeExtension,
  VscodeInstallResult,
  VscodeStatus,
  UninstallResult,
  UserConfigView
} from '@shared/types'
import type { DevkitApi } from '@shared/api'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * Tauri 适配层：实现与 preload 完全相同的 `DevkitApi` 契约（MIGRATION-RUST.md §7）。
 *
 * - `window.devkit` 不存在（即 tauri dev / tauri 产物）时由 main.tsx 安装本适配层；
 *   Electron 调试模式下 preload 已注入原实现，适配层不覆盖。
 * - 契约不变：改 `src/shared/api.ts` 编译器会同时报错两边。
 * - R5 已全量接入：每个方法对应一个 Rust `#[tauri::command]`（src-tauri/src/main.rs）。
 */

/** 同步订阅推送通道：listen 是异步的，返回的取消函数兜住竞态（先订阅后取消也不泄漏）。 */
function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<T>(event, (e) => listener(e.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

export const tauriAdapter: DevkitApi = {
  async getAppInfo(): Promise<AppInfo> {
    return invoke<AppInfo>('get_app_info')
  },

  listManifests(): Promise<ManifestLoadResult> {
    return invoke('list_manifests')
  },

  runDetection(request?: DetectRequest): Promise<DetectionResult[]> {
    return invoke('run_detection', { request: request ?? null })
  },

  getLocale(): Promise<Locale> {
    return invoke('get_locale')
  },

  setLocale(locale: Locale): Promise<Locale> {
    return invoke('set_locale', { value: locale })
  },

  tailLog(count?: number): Promise<LogEntry[]> {
    return invoke('tail_log', { count: count ?? null })
  },

  openLogDir(): Promise<boolean> {
    return invoke('open_log_dir')
  },

  async signalReady(): Promise<boolean> {
    return invoke<boolean>('signal_ready')
  },

  onLogLine(listener: (entry: LogEntry) => void): () => void {
    return subscribe<LogEntry>('log-line', listener)
  },

  prepareInstall(selections: PlanSelection[], dryRun?: boolean): Promise<PlanPreparation> {
    return invoke('prepare_install', { selections, dryRun: dryRun ?? null })
  },

  startInstall(planId: string): Promise<StartInstallResult> {
    return invoke('start_install', { planId })
  },

  cancelInstall(): Promise<boolean> {
    return invoke('cancel_install')
  },

  getPendingPlan(): Promise<PendingPlanLoad> {
    return invoke('get_pending_plan')
  },

  discardPendingPlan(): Promise<boolean> {
    return invoke('discard_pending_plan')
  },

  resumeInstall(): Promise<StartInstallResult> {
    return invoke('resume_install')
  },

  exportInstallReport(): Promise<string | null> {
    return invoke('export_install_report')
  },

  listPresets(): Promise<Preset[]> {
    return invoke('list_presets')
  },

  savePreset(preset: unknown): Promise<Preset> {
    return invoke('save_preset', { preset: preset ?? null })
  },

  deletePreset(id: string): Promise<boolean> {
    return invoke('delete_preset', { id })
  },

  importPreset(raw: unknown): Promise<Preset> {
    return invoke('import_preset', { raw: raw ?? null })
  },

  getActivationSnapshot(): Promise<ActivationSnapshot> {
    return invoke('get_activation_snapshot')
  },

  activateVersion(request: ActivateRequest): Promise<ActivateResult> {
    return invoke('activate_version', { request })
  },

  deactivateTool(toolId: string): Promise<{ removed: string[]; error: string | null }> {
    return invoke('deactivate_tool', { toolId })
  },

  listInstalled(): Promise<InstalledTool[]> {
    return invoke('list_installed')
  },

  uninstallTool(request: UninstallRequest): Promise<UninstallResult> {
    return invoke('uninstall_tool', { request })
  },

  getSettings(): Promise<UserConfigView> {
    return invoke('get_settings')
  },

  saveSettings(patch: unknown): Promise<UserConfigView> {
    return invoke('save_settings', { patch: patch ?? null })
  },

  applyMirrors(settings: MirrorSetting[]): Promise<MirrorApplyResult> {
    return invoke('apply_mirrors', { settings })
  },

  openExternal(url: string): Promise<boolean> {
    return invoke('open_external', { url })
  },

  getVscodeStatus(): Promise<VscodeStatus> {
    return invoke('get_vscode_status')
  },

  listVscodeExtensions(): Promise<VscodeExtension[]> {
    return invoke('list_vscode_extensions')
  },

  installVscodeExtensions(ids: string[]): Promise<VscodeInstallResult> {
    return invoke('install_vscode_extensions', { ids })
  },

  checkForUpdate(): Promise<UpdateInfo> {
    return invoke('check_for_update')
  },

  downloadUpdate(): Promise<DownloadUpdateResult> {
    return invoke('download_update')
  },

  installUpdate(filePath: string): Promise<boolean> {
    return invoke('install_update', { filePath })
  },

  exportProfile(request: ExportProfileRequest): Promise<ExportProfileResult> {
    return invoke('export_profile', { request: request ?? null })
  },

  importProfile(): Promise<ImportProfileResult> {
    return invoke('import_profile')
  },

  applyProfile(profile: EnvProfile, options: ApplyProfileOptions): Promise<ApplyProfileResult> {
    return invoke('apply_profile_command', { profile, options })
  },

  runDoctor(): Promise<DoctorReport> {
    return invoke('run_doctor')
  },

  applyDoctorFix(fixId: DoctorFixId): Promise<DoctorFixResult> {
    return invoke('apply_doctor_fix', { fixId })
  },

  getSystemConfig(): Promise<SystemConfigItem[]> {
    return invoke('get_system_config')
  },

  applySystemConfig(request: SystemConfigRequest): Promise<SystemConfigResult> {
    return invoke('apply_system_config', { request })
  },

  revertSystemConfig(request: SystemConfigRevertRequest): Promise<SystemConfigResult> {
    return invoke('revert_system_config', { request })
  },

  runHotUpdate(url: string): Promise<HotUpdateResultView> {
    return invoke('run_hot_update', { url })
  },

  clearManifestOverride(): Promise<number> {
    return invoke('clear_manifest_override')
  },

  packOffline(request: OfflinePackRequest): Promise<OfflinePackResult> {
    return invoke('pack_offline', { request: request ?? null })
  },

  importOfflinePack(packDir?: string): Promise<{
    ok: boolean
    imported: number
    missing: string[]
    entries: { toolId: string; version: string; fileName: string; sha256: string }[]
    error: string | null
  }> {
    return invoke('import_offline_pack', { packDir: packDir ?? null })
  },

  onInstallProgress(listener: (event: InstallProgressEvent) => void): () => void {
    return subscribe<InstallProgressEvent>('install-progress', listener)
  }
}

/**
 * 仅当 `window.devkit` 不存在时安装适配层——Electron 调试模式下 preload 已注入
 * 原实现，不得覆盖（附录 E.4 第 4 步）。
 */
export const installTauriBridge = (): void => {
  if (typeof window !== 'undefined' && window.devkit) return
  window.devkit = tauriAdapter
}
