// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- import 形式无法让单文件分析的程序并入声明，此处必须用文件引用（见 MIGRATION-RUST.md 附录 E.4）
/// <reference path="../../../preload/index.d.ts" />
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
 * - R0 只接入 get_app_info / signal_ready；其余命令在对应 R 阶段接入后把
 *   notImplemented 换成 `invoke(...)`。未接入的命令把入参拼进错误信息，
 *   便于排查"UI 为什么点不动"，绝不静默假装成功。
 */
function notImplemented(command: string, args?: unknown[]): never {
  const shown = args?.filter((a) => a !== undefined && typeof a !== 'function')
  const detail = shown && shown.length > 0 ? `：${JSON.stringify(shown)}` : ''
  throw new Error(
    `devkit: 命令 ${command} 尚未接入（Rust 迁移中，见 MIGRATION-RUST.md §10）${detail}`
  )
}

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
    return notImplemented('list_manifests')
  },

  runDetection(request?: DetectRequest): Promise<DetectionResult[]> {
    return notImplemented('run_detection', [request])
  },

  getLocale(): Promise<Locale> {
    return notImplemented('get_locale')
  },

  setLocale(locale: Locale): Promise<Locale> {
    return notImplemented('set_locale', [locale])
  },

  tailLog(count?: number): Promise<LogEntry[]> {
    return notImplemented('tail_log', [count])
  },

  openLogDir(): Promise<boolean> {
    return notImplemented('open_log_dir')
  },

  async signalReady(): Promise<boolean> {
    return invoke<boolean>('signal_ready')
  },

  onLogLine(listener: (entry: LogEntry) => void): () => void {
    return subscribe<LogEntry>('log-line', listener)
  },

  prepareInstall(
    selections: PlanSelection[],
    dryRun?: boolean,
    availableToolIds?: string[]
  ): Promise<PlanPreparation> {
    return notImplemented('prepare_install', [selections, dryRun, availableToolIds])
  },

  startInstall(planId: string): Promise<StartInstallResult> {
    return notImplemented('start_install', [planId])
  },

  cancelInstall(): Promise<boolean> {
    return notImplemented('cancel_install')
  },

  getPendingPlan(): Promise<PendingPlanLoad> {
    return notImplemented('get_pending_plan')
  },

  discardPendingPlan(): Promise<boolean> {
    return notImplemented('discard_pending_plan')
  },

  resumeInstall(): Promise<StartInstallResult> {
    return notImplemented('resume_install')
  },

  exportInstallReport(): Promise<string | null> {
    return notImplemented('export_install_report')
  },

  listPresets(): Promise<Preset[]> {
    return notImplemented('list_presets')
  },

  savePreset(preset: unknown): Promise<Preset> {
    return notImplemented('save_preset', [preset])
  },

  deletePreset(id: string): Promise<boolean> {
    return notImplemented('delete_preset', [id])
  },

  importPreset(raw: unknown): Promise<Preset> {
    return notImplemented('import_preset', [raw])
  },

  getActivationSnapshot(): Promise<ActivationSnapshot> {
    return notImplemented('get_activation_snapshot')
  },

  activateVersion(request: ActivateRequest): Promise<ActivateResult> {
    return notImplemented('activate_version', [request])
  },

  deactivateTool(toolId: string): Promise<{ removed: string[]; error: string | null }> {
    return notImplemented('deactivate_tool', [toolId])
  },

  listInstalled(): Promise<InstalledTool[]> {
    return notImplemented('list_installed')
  },

  uninstallTool(request: UninstallRequest): Promise<UninstallResult> {
    return notImplemented('uninstall_tool', [request])
  },

  getSettings(): Promise<UserConfigView> {
    return notImplemented('get_settings')
  },

  saveSettings(patch: unknown): Promise<UserConfigView> {
    return notImplemented('save_settings', [patch])
  },

  applyMirrors(settings: MirrorSetting[]): Promise<MirrorApplyResult> {
    return notImplemented('apply_mirrors', [settings])
  },

  openExternal(url: string): Promise<boolean> {
    return notImplemented('open_external', [url])
  },

  getVscodeStatus(): Promise<VscodeStatus> {
    return notImplemented('get_vscode_status')
  },

  listVscodeExtensions(): Promise<VscodeExtension[]> {
    return notImplemented('list_vscode_extensions')
  },

  installVscodeExtensions(ids: string[]): Promise<VscodeInstallResult> {
    return notImplemented('install_vscode_extensions', [ids])
  },

  checkForUpdate(): Promise<UpdateInfo> {
    return notImplemented('check_for_update')
  },

  downloadUpdate(): Promise<DownloadUpdateResult> {
    return notImplemented('download_update')
  },

  installUpdate(filePath: string): Promise<boolean> {
    return notImplemented('install_update', [filePath])
  },

  exportProfile(request: ExportProfileRequest): Promise<ExportProfileResult> {
    return notImplemented('export_profile', [request])
  },

  importProfile(): Promise<ImportProfileResult> {
    return notImplemented('import_profile')
  },

  applyProfile(profile: EnvProfile, options: ApplyProfileOptions): Promise<ApplyProfileResult> {
    return notImplemented('apply_profile', [profile, options])
  },

  runDoctor(): Promise<DoctorReport> {
    return notImplemented('run_doctor')
  },

  applyDoctorFix(fixId: DoctorFixId): Promise<DoctorFixResult> {
    return notImplemented('apply_doctor_fix', [fixId])
  },

  getSystemConfig(): Promise<SystemConfigItem[]> {
    return notImplemented('get_system_config')
  },

  applySystemConfig(request: SystemConfigRequest): Promise<SystemConfigResult> {
    return notImplemented('apply_system_config', [request])
  },

  revertSystemConfig(request: SystemConfigRevertRequest): Promise<SystemConfigResult> {
    return notImplemented('revert_system_config', [request])
  },

  runHotUpdate(url: string): Promise<HotUpdateResultView> {
    return notImplemented('run_hot_update', [url])
  },

  clearManifestOverride(): Promise<number> {
    return notImplemented('clear_manifest_override')
  },

  packOffline(request: OfflinePackRequest): Promise<OfflinePackResult> {
    return notImplemented('pack_offline', [request])
  },

  importOfflinePack(packDir?: string): Promise<{
    ok: boolean
    imported: number
    missing: string[]
    entries: { toolId: string; version: string; fileName: string; sha256: string }[]
    error: string | null
  }> {
    return notImplemented('import_offline_pack', [packDir])
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
