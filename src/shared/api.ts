import type {
  ActivateRequest,
  ActivateResult,
  ActivationSnapshot,
  AppInfo,
  DetectRequest,
  DetectionResult,
  DoctorFixId,
  DoctorFixResult,
  DoctorReport,
  DownloadUpdateResult,
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
  SystemConfigResult,
  UninstallRequest,
  UpdateInfo,
  VscodeExtension,
  VscodeInstallResult,
  VscodeStatus,
  UninstallResult,
  UserConfigView
} from './types'

/**
 * 预加载脚本暴露给渲染进程的 API 契约。
 * 主进程侧的实现与渲染进程侧的调用都以此为准，改这里编译器会同时报错两边。
 */
export interface DevkitApi {
  /** 应用与运行环境信息 */
  getAppInfo(): Promise<AppInfo>

  /** 读取清单（含校验错误列表） */
  listManifests(): Promise<ManifestLoadResult>

  /** 执行环境检测；不传 toolIds 表示全部 */
  runDetection(request?: DetectRequest): Promise<DetectionResult[]>

  getLocale(): Promise<Locale>
  setLocale(locale: Locale): Promise<Locale>

  /** 读取最近 count 条日志（渲染进程挂载时回填历史） */
  tailLog(count?: number): Promise<LogEntry[]>
  /** 在系统文件管理器中打开日志目录 */
  openLogDir(): Promise<boolean>

  /** 通知主进程渲染进程已挂载完成 */
  signalReady(): Promise<boolean>

  /** 订阅实时日志，返回取消订阅函数 */
  onLogLine(listener: (entry: LogEntry) => void): () => void

  /** 构建安装计划并跑预检（不执行任何安装）；dryRun=true 时只演练命令行 */
  prepareInstall(selections: PlanSelection[], dryRun?: boolean): Promise<PlanPreparation>
  /** 开始执行安装；进度通过 onInstallProgress 推送 */
  startInstall(planId: string): Promise<StartInstallResult>
  cancelInstall(): Promise<boolean>

  /** 读取上次未完成的计划（FR-17） */
  getPendingPlan(): Promise<PendingPlanLoad>
  discardPendingPlan(): Promise<boolean>
  /** 续跑上次未完成的计划 */
  resumeInstall(): Promise<StartInstallResult>

  /** 导出安装报告为 Markdown；返回保存路径，用户取消则返回 null */
  exportInstallReport(): Promise<string | null>

  /* ---------------- 预设方案（FR-3） ---------------- */
  listPresets(): Promise<Preset[]>
  savePreset(preset: unknown): Promise<Preset>
  deletePreset(id: string): Promise<boolean>
  importPreset(raw: unknown): Promise<Preset>

  /* ---------------- 激活与版本切换（FR-11） ---------------- */
  getActivationSnapshot(): Promise<ActivationSnapshot>
  activateVersion(request: ActivateRequest): Promise<ActivateResult>
  deactivateTool(toolId: string): Promise<{ removed: string[]; error: string | null }>

  /* ---------------- 已安装项与卸载（FR-16） ---------------- */
  listInstalled(): Promise<InstalledTool[]>
  uninstallTool(request: UninstallRequest): Promise<UninstallResult>

  /* ---------------- 设置与镜像源 ---------------- */
  getSettings(): Promise<UserConfigView>
  saveSettings(patch: unknown): Promise<UserConfigView>
  applyMirrors(settings: MirrorSetting[]): Promise<MirrorApplyResult>

  /** 用系统浏览器打开一个 https 链接（只接受 https） */
  openExternal(url: string): Promise<boolean>

  /* ---------------- VS Code 插件（FR-7） ---------------- */
  getVscodeStatus(): Promise<VscodeStatus>
  listVscodeExtensions(): Promise<VscodeExtension[]>
  installVscodeExtensions(ids: string[]): Promise<VscodeInstallResult>

  /* ---------------- 更新检查与半自动升级（FR-13） ---------------- */
  checkForUpdate(): Promise<UpdateInfo>
  /** 下载更新包到本地并校验 SHA-256（校验不过会丢弃，不会拿去安装） */
  downloadUpdate(): Promise<DownloadUpdateResult>
  /** 拉起已下载的安装包（只允许 devkit 自己下载目录下的 exe） */
  installUpdate(filePath: string): Promise<boolean>

  /* ---------------- 环境体检（FR-21） ---------------- */
  /** 跑一次体检（只读，不改任何东西） */
  runDoctor(): Promise<DoctorReport>
  /** 执行一条修复；会先备份 */
  applyDoctorFix(fixId: DoctorFixId): Promise<DoctorFixResult>

  /* ---------------- 系统配置（FR-6） ---------------- */
  getSystemConfig(): Promise<SystemConfigItem[]>
  applySystemConfig(request: SystemConfigRequest): Promise<SystemConfigResult>

  /* ---------------- 清单热更新（FR-15） ---------------- */
  runHotUpdate(url: string): Promise<HotUpdateResultView>
  clearManifestOverride(): Promise<number>

  /* ---------------- 离线包（FR-12） ---------------- */
  packOffline(request: OfflinePackRequest): Promise<OfflinePackResult>
  importOfflinePack(packDir?: string): Promise<{
    ok: boolean
    imported: number
    missing: string[]
    entries: { toolId: string; version: string; fileName: string; sha256: string }[]
    error: string | null
  }>

  /** 订阅安装进度，返回取消订阅函数 */
  onInstallProgress(listener: (event: InstallProgressEvent) => void): () => void
}
