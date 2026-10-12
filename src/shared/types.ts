/**
 * 主进程与渲染进程共享的类型定义。
 * 这里只放「契约」，不放任何带副作用的代码 —— 两侧都会 import 它。
 */

/** 界面语言。新增语言时同时更新 LOCALES 与 LOCALE_FALLBACK_CHAIN。 */
export type Locale = 'zh-CN' | 'en-US'

export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US'] as const

export const DEFAULT_LOCALE: Locale = 'zh-CN'

/**
 * 多语言文案。manifest 里的 name / description / notes 用这个结构。
 * 允许缺语言，取值时由 localizedText() 按回退链兜底。
 */
export type LocalizedText = Partial<Record<Locale, string>> & Record<string, string | undefined>

/** 清单分类，决定左侧导航分组 */
export type ToolCategory =
  | 'runtime'
  | 'build'
  | 'database'
  | 'container'
  | 'editor'
  | 'ai'
  | 'tool'

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'runtime',
  'build',
  'database',
  'container',
  'editor',
  'ai',
  'tool'
] as const

/**
 * 许可证分级（见 SPEC §8），直接决定能否进离线包：
 * - L1 许可证明确允许再分发 → 可进离线包
 * - L2 可自动下载安装，但不得再分发 → 不进离线包
 * - L3 仅跳转官网，不自动安装
 */
export type LicenseTier = 'L1' | 'L2' | 'L3'

/**
 * 清单成熟度：
 * - detect-only：目前只能检测，安装信息（source/sha256/install）尚未补齐
 * - ready：可执行完整安装，Schema 会强制要求 source.sha256 与 install 模板
 *
 * 这个字段存在的意义是：不允许「看起来能装、实际装不了」的清单混进来。
 */
export type ManifestStatus = 'detect-only' | 'ready'

/**
 * 安装包类型。
 *
 * 每一种都对应一组**写死在代码里**的静默安装参数（见 core/templates），
 * 清单只能引用模板名，不能自定义命令行 —— 否则热更新通道就等于任意命令执行通道。
 *
 * - zip        压缩包，解压到版本目录
 * - msi        Windows Installer，走 msiexec /qn
 * - exe-nsis   NSIS 安装器（7-Zip 等），走 /S
 * - exe-inno   Inno Setup 安装器（VS Code 等），走 /VERYSILENT
 * - exe-7zsfx  7-Zip 自解压包（PortableGit 等），走 -o<dir> -y
 * - exe-custom 自带安装器（Python / rustup），参数由内置模板固定
 * - npm        npm 包（AI 编码 agent 这类只发 npm 的工具）：装进版本目录，不污染全局 npm
 */
export type InstallType = 'msi' | 'exe-nsis' | 'exe-inno' | 'exe-7zsfx' | 'exe-custom' | 'zip' | 'npm'

/**
 * 安装范围。必须逐项声明，不存在全局默认（见 SPEC §9）：
 * - user：装到用户目录，不需要管理员
 * - machine：装到 Program Files / 需要写系统注册表 / 装服务 → 需要提权
 */
export type InstallScope = 'user' | 'machine'

/** 注册表检测规则：按 Uninstall 项的 DisplayName 正则匹配 */
export interface RegistryDetectRule {
  hive: 'HKLM' | 'HKCU'
  /** 注册表视图，32 位程序在 64 位系统上写 WOW6432Node */
  view: '32' | '64'
  /** Uninstall 子键所在路径（不含 hive） */
  path: string
  /** 字段名 → 正则。全部命中才算匹配成功 */
  match: Record<string, string>
  /** 从哪个字段取版本号，默认 DisplayVersion */
  versionFrom?: string
}

export interface DetectCommandSpec {
  cmd: string
  args?: string[]
  /** 输出（stdout + stderr 合并）必须匹配此正则才算检测成功 */
  expectRegex?: string
}

/** 检测手段。按 commands → files → registry 的顺序尝试 */
export interface DetectSpec {
  commands?: DetectCommandSpec[]
  /** 文件路径，支持 %ProgramFiles% 等环境变量占位 */
  files?: string[]
  registry?: RegistryDetectRule[]
}

/**
 * 安装参数。
 * 安全关键：`template` 只能引用 src/main/core/templates 里内置的白名单模板，
 * `params` 只能填模板声明过的占位符 —— 清单无权自定义命令行（见 SPEC FR-15 / NFR-1）。
 */
export interface InstallSpec {
  type: InstallType
  template: string
  params?: Record<string, string>
}

export interface UninstallSpec {
  type: 'registry' | 'custom' | 'none'
  template?: string
}

/**
 * 激活声明（FR-11）。
 *
 * 「安装 ≠ 激活」：安装只把文件放进版本目录；只有声明了 activate 的版本
 * 才会被真正接到用户环境里（PATH + 环境变量 + current 切换链接）。
 * 这样用户可以「先装好、先不接进 PATH」，也可以在多版本之间来回切。
 *
 * 路径里可用占位符：{installDir} {currentDir} {version} {toolId}
 * currentDir = %USERPROFILE%\.devkit\current\<linkName>（junction，指向当前激活的版本）
 */
export interface ActivateSpec {
  /** 需要加进用户 PATH 的目录（顺序即优先级） */
  pathEntries?: string[]
  /** 需要写入的用户级环境变量，例如 JAVA_HOME / GOROOT / CARGO_HOME */
  env?: Record<string, string>
  /** 切换链接名，默认等于 tool id */
  linkName?: string
}

export interface ToolVersionSpec {
  version: string
  channel: 'lts' | 'stable' | 'beta'
  /** 默认选中项；同一个工具最多一个为 true */
  recommended?: boolean
  arch: 'x64'
  /** ISO 日期 YYYY-MM-DD */
  releaseDate?: string
  sizeBytes?: number
  installScope: InstallScope
  requiresReboot?: boolean
  dependsOn?: string[]
  source?: { url: string; sha256?: string }
  mirrors?: { name: string; url: string }[]
  install?: InstallSpec
  uninstall?: UninstallSpec
  /** 激活声明；不写表示该版本装完不接进 PATH（只落在版本目录里） */
  activate?: ActivateSpec
  configure?: string[]
  verify?: DetectCommandSpec
}

export interface ToolManifest {
  id: string
  category: ToolCategory
  tier: LicenseTier
  status: ManifestStatus
  provider?: 'direct' | 'scoop' | 'winget'
  name: LocalizedText
  description: LocalizedText
  homepage?: string
  license?: { spdx: string; redistributable: boolean }
  detect: DetectSpec
  /** 允许为空数组：表示该工具目前只支持检测，版本信息待补齐 */
  versions: ToolVersionSpec[]
  notes?: LocalizedText
}

/**
 * 检测状态。语义（见 SPEC FR-1）：
 * - not-installed   没找到任何痕迹
 * - installed       命令可用，且主版本与推荐版本一致
 * - version-mismatch 命令可用，但主版本与推荐版本不同
 * - path-missing    文件/注册表存在，但命令跑不通 → 已装但 PATH 未生效
 * - error           检测过程本身出错（不是"没装"）
 */
export type DetectionStatus =
  'not-installed' | 'installed' | 'version-mismatch' | 'path-missing' | 'error'

export interface DetectionResult {
  toolId: string
  status: DetectionStatus
  installedVersion: string | null
  recommendedVersion: string | null
  /** 已装版本与推荐版本主版本号是否一致 */
  versionMatches: boolean
  /** 命中依据，例如 "command:node" / "file:C:\Program Files\nodejs\node.exe" */
  evidence: string | null
  error: string | null
  durationMs: number
}

export interface ManifestLoadError {
  file: string
  message: string
}

export interface ManifestLoadResult {
  tools: ToolManifest[]
  errors: ManifestLoadError[]
  /** builtin = 内置清单；remote = 热更新后的清单（M2 实现） */
  source: 'builtin' | 'remote'
  dir: string
  loadedAt: string
}

export interface AppInfo {
  version: string
  locale: Locale
  platform: string
  arch: string
  isPackaged: boolean
  manifestDir: string
  logDir: string
  logFile: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  /** ISO 时间戳 */
  ts: string
  level: LogLevel
  /** 产生日志的模块，例如 "manifest" / "detect" */
  scope: string
  message: string
}

/** 检测请求载荷 */
export interface DetectRequest {
  /** 不传或传空数组 = 检测全部 */
  toolIds?: string[]
}

/* ------------------------------------------------------------------ */
/* 安装计划（SPEC §7.4）                                                */
/* ------------------------------------------------------------------ */

/** 镜像偏好。决定下载时哪个源排第一，其余按清单顺序排在其后 */
export type MirrorPreference = 'official' | 'huaweicloud' | 'aliyun' | 'tuna' | 'ustc'

export const MIRROR_PREFERENCES: readonly MirrorPreference[] = [
  'official',
  'huaweicloud',
  'aliyun',
  'tuna',
  'ustc'
] as const

export type PlanItemState =
  | 'pending'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'checking'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface PlanItem {
  id: string
  version: string
  tier: LicenseTier
  installScope: InstallScope
  requiresAdmin: boolean
  requiresReboot: boolean
  dependsOn: string[]
  state: PlanItemState
  attempts: number
  error: string | null
  /** 成功后的说明，例如"已安装，跳过" */
  note: string | null
  startedAt: string | null
  finishedAt: string | null
  /** 实际安装目录，自检与卸载要用 */
  installDir: string | null
  /** 下载产物路径 */
  archivePath: string | null
  /**
   * 下载尝试记录（含失败的源与原因）。
   * 调研里"失败不可诊断"是核心抱怨之一：用户要能一眼看到
   * "试过哪几个源、每个源为什么失败、重试了几次"，而不是只看到一句"下载失败"。
   */
  downloadAttempts?: { source: string; url: string; error: string }[]
}

export interface PlanOptions {
  concurrency: number
  mirrorPreference: MirrorPreference
  proxy: string | null
  createRestorePoint: boolean
  /** 只演练：不执行安装器、不激活，只把命令行算出来（虚拟机验收前的干跑） */
  dryRun: boolean
}

export interface PlanSummary {
  total: number
  success: number
  failed: number
  skipped: number
  cancelled: number
}

export interface InstallPlan {
  schemaVersion: 1
  planId: string
  createdAt: string
  devkitVersion: string
  manifestRevision: string
  options: PlanOptions
  items: PlanItem[]
  summary: PlanSummary
}

/** 用户在选择页的勾选结果 */
export interface PlanSelection {
  toolId: string
  version?: string
}

export interface PlanBuildError {
  toolId: string
  reason: string
}

/** 预检结果（FR-18） */
export interface PreflightCheck {
  id: string
  level: 'ok' | 'warn' | 'error'
  message: string
}

export interface PreflightResult {
  /** 无 error 级问题则为 true */
  ok: boolean
  checks: PreflightCheck[]
  totalDownloadBytes: number
  requiresAdmin: boolean
}

/** install:prepare 的返回：计划 + 预检 + 构建期发现的问题 */
export interface PlanPreparation {
  plan: InstallPlan
  preflight: PreflightResult
  problems: PlanBuildError[]
}

export interface InstallProgressDetail {
  received?: number
  total?: number | null
  source?: string
}

/** 主进程 → 渲染进程 推送的进度 */
export interface InstallProgressEvent {
  plan: InstallPlan
  /** 正在处理的项目 id */
  currentItemId: string | null
  detail: InstallProgressDetail | null
}

/** pending.json 的读取结果（FR-17） */
export type PendingPlanLoad =
  | { status: 'none' }
  | { status: 'ok'; plan: InstallPlan }
  | { status: 'invalid'; reason: string }

export interface StartInstallResult {
  started: boolean
  error?: string
}

/* ------------------------------------------------------------------ */
/* 预设方案（FR-3）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 预设 = 一组勾选结果，可导出成 JSON 在另一台机器导入复现。
 * 内置预设 builtin=true，不可删除；用户预设存到 %APPDATA%\devkit\presets\。
 */
export interface Preset {
  id: string
  name: LocalizedText
  description: LocalizedText
  builtin: boolean
  tools: PlanSelection[]
}

/* ------------------------------------------------------------------ */
/* 激活状态（FR-11）                                                    */
/* ------------------------------------------------------------------ */

/** devkit 管理的一次激活记录，用于精确回滚（不靠猜 PATH 里哪条是脏数据） */
export interface ActivationRecord {
  toolId: string
  version: string
  linkName: string
  /** %USERPROFILE%\.devkit\current\<linkName> */
  linkPath: string
  /** junction 指向的真实版本目录 */
  target: string
  pathEntries: string[]
  env: Record<string, string>
  activatedAt: string
}

/** 激活总览，设置页与「已安装」页要展示 */
export interface ActivationSnapshot {
  records: ActivationRecord[]
  /** %USERPROFILE%\.devkit\bin（预留给未来的 shim） */
  binDir: string
  /** 当前用户 PATH 的完整值（只读展示，不含密码等敏感信息） */
  userPath: string
  /** PATH 备份文件路径；null 表示还没备份过 */
  backupFile: string | null
  /** PATH 里所有 devkit 管理的条目 */
  managedPathEntries: string[]
}

/** 切换（激活）某个版本 */
export interface ActivateRequest {
  toolId: string
  version: string
}

export interface ActivateResult {
  ok: boolean
  record: ActivationRecord | null
  /** 需要用户重新打开终端才能生效的提示 */
  note: string | null
  error: string | null
}

/* ------------------------------------------------------------------ */
/* 已安装项与卸载（FR-16）                                              */
/* ------------------------------------------------------------------ */

export interface InstalledTool {
  toolId: string
  version: string
  installDir: string
  /** 目录实际占用字节数 */
  sizeBytes: number
  /** 目录创建时间（近似安装时间） */
  installedAt: string | null
  /** 该版本当前是否是 current 链接指向的版本 */
  active: boolean
  /** 该版本是否声明了可激活 */
  activatable: boolean
}

export interface UninstallRequest {
  toolId: string
  version: string
}

export interface UninstallResult {
  ok: boolean
  /** 实际删掉的内容说明 */
  removed: string[]
  error: string | null
}

/* ------------------------------------------------------------------ */
/* 用户配置（FR-5 / FR-6）                                              */
/* ------------------------------------------------------------------ */

/** 可一键切换的国内镜像目标。只包含"用写配置文件就能生效、不需要先装好某个工具"的目标 */
export type MirrorTarget = 'npm' | 'pip' | 'go' | 'maven' | 'gradle' | 'cargo' | 'conda' | 'nuget' | 'docker'

export const MIRROR_TARGETS: readonly MirrorTarget[] = [
  'npm',
  'pip',
  'go',
  'maven',
  'gradle',
  'cargo',
  'conda',
  'nuget',
  'docker'
] as const

/**
 * 镜像地址允许的形状。
 *
 * 刻意用白名单字符集而不是「排除危险字符」：镜像地址会被写进 .npmrc / pip.ini /
 * settings.xml / init.gradle / config.toml / .condarc / daemon.json 七种格式里，
 * 黑名单漏一个字符就是一次配置注入（安全审查 H2）。
 * 只保留 URL 里真正会用到的字符，连单引号、双引号、反斜杠、换行、$ 和花括号都不给。
 */
export const MIRROR_URL_PATTERN = /^https:\/\/[A-Za-z0-9._~:/@!*,=+-]{3,200}$/

/** 单个镜像目标的取值；url 为空表示用官方源 */
export interface MirrorSetting {
  target: MirrorTarget
  enabled: boolean
  url: string
}

/** 镜像写入结果 */
/* ------------------------------------------------------------------ */
/* 环境档案 / 换机迁移（FR-22）                                         */
/* ------------------------------------------------------------------ */

/**
 * 环境档案：把"这台机器上的开发环境长什么样"收成一份可带走的 JSON。
 *
 * **不含任何密钥**：环境变量走白名单（只收 JAVA_HOME 这类路径变量），
 * 不读 .npmrc 的 auth token、不碰 SSH 私钥、不碰 git credential。
 * git 身份默认不带（那算个人信息），要带得显式勾选。
 */
export interface EnvProfile {
  schemaVersion: 1
  createdAt: string
  devkitVersion: string
  /** 来源机器信息（不含用户名） */
  machine: { platform: string; arch: string; osRelease: string }
  detected: { toolId: string; status: DetectionStatus; version: string | null }[]
  installed: { toolId: string; version: string; activated: boolean }[]
  /** 用户 PATH 里的自定义条目（已排除系统自带与 devkit 管理的） */
  userPathExtra: string[]
  env: Record<string, string>
  mirrors: { target: string; url: string | null }[]
  git: { userName: string | null; userEmail: string | null }
  vscodeExtensions: string[]
  /** 目标机器上要装什么；可以直接喂给现有的安装流程 */
  selections: PlanSelection[]
}

export type ProfileToolState = 'missing' | 'version-differs' | 'already-present' | 'installed-by-devkit'

export interface ProfileDiffEntry {
  toolId: string
  name: LocalizedText | null
  wantedVersion: string | null
  currentVersion: string | null
  state: ProfileToolState
}

export interface ProfileDiff {
  tools: ProfileDiffEntry[]
  missingPathEntries: string[]
  envToRestore: Record<string, string>
  vscodeExtensions: string[]
  summary: {
    toInstall: number
    alreadyPresent: number
    pathEntries: number
    envVars: number
  }
}

export interface ApplyProfileOptions {
  restoreUserPath: boolean
  restoreEnv: boolean
  restoreMirrors: boolean
  restoreGit: boolean
}

export interface ApplyProfileResult {
  ok: boolean
  changed: string[]
  /** 需要安装的工具（交给现有安装流程，不在这里装） */
  selections: PlanSelection[]
  error: string | null
}

export interface ExportProfileRequest {
  includeGitIdentity: boolean
}

export interface ExportProfileResult {
  ok: boolean
  filePath: string | null
  profile: EnvProfile | null
  error: string | null
}

export interface ImportProfileResult {
  ok: boolean
  filePath: string | null
  profile: EnvProfile | null
  /** 档案里有什么（给用户先看清再决定） */
  description: string[]
  diff: ProfileDiff | null
  error: string | null
}

/* ------------------------------------------------------------------ */
/* 环境体检（FR-21）                                                    */
/* ------------------------------------------------------------------ */

export type DoctorLevel = 'ok' | 'warn' | 'error'
export type DoctorCategory = 'path' | 'env' | 'command' | 'devkit' | 'system'

/** 可以一键修复的项；其余只能给建议（改之前一律先备份） */
export type DoctorFixId = 'clean-user-path' | 'clean-machine-path' | 'prune-devkit-state'

export interface DoctorFix {
  id: DoctorFixId
  label: LocalizedText
  /** user = 直接改；machine = 需要管理员（走提权助手） */
  scope: 'user' | 'machine'
}

export interface DoctorFinding {
  id: string
  level: DoctorLevel
  category: DoctorCategory
  title: LocalizedText
  detail: LocalizedText
  /** 具体证据：哪一条、值是什么。不能只给一句"环境有问题" */
  evidence: string[]
  fix: DoctorFix | null
}

export type PathEntryKind = 'ok' | 'missing' | 'unexpanded-var' | 'malformed' | 'duplicate'

export interface PathEntryView {
  index: number
  raw: string
  kind: PathEntryKind
  reason: string | null
  duplicateOf: number | null
}

export interface PathAnalysisView {
  entries: PathEntryView[]
  /** 清理后的建议值（只删重复与无效条目，顺序不动） */
  suggested: string
  changed: boolean
  counts: Record<PathEntryKind, number>
}

export interface DoctorReport {
  ranAt: string
  findings: DoctorFinding[]
  summary: { ok: number; warn: number; error: number }
  userPath: PathAnalysisView
  machinePath: PathAnalysisView
}

export interface DoctorFixResult {
  ok: boolean
  /** 实际做了什么（逐条列出被移除的东西） */
  changed: string[]
  /** 改动前的备份文件 */
  backupFile: string | null
  error: string | null
}

/* ------------------------------------------------------------------ */
/* 系统配置（FR-6）                                                     */
/* ------------------------------------------------------------------ */

export type SystemConfigId =
  | 'git-identity'
  | 'powershell-policy'
  | 'long-paths'
  | 'developer-mode'
  | 'ssh-key'

export interface SystemConfigItem {
  id: SystemConfigId
  label: LocalizedText
  /** true = 需要管理员（会弹一次 UAC） */
  requiresAdmin: boolean
  configured: boolean
  /** 当前状态的可读描述，例如 "张三 <a@b.com>" 或 "未启用" */
  detail: string
  hint: LocalizedText
  /** 这一项是否被 devkit 改过（有备份记录） */
  devkitModified: boolean
  /** 备份时间；没有备份则为 null */
  backupAt: string | null
  /** 是否提供还原。SSH 私钥恒为 false —— 删私钥是破坏性操作 */
  revertible: boolean
}

export interface SystemConfigRevertRequest {
  id: SystemConfigId
}

export interface SystemConfigRequest {
  id: SystemConfigId
  gitName?: string
  gitEmail?: string
}

export interface SystemConfigResult {
  ok: boolean
  detail: string | null
  error: string | null
  requiresAdmin: boolean
}

/* ------------------------------------------------------------------ */
/* VS Code 插件（FR-7）                                                 */
/* ------------------------------------------------------------------ */

export type VscodeCategory =
  | 'ai'
  | 'frontend'
  | 'java'
  | 'python'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'general'

export interface VscodeExtension {
  id: string
  category: VscodeCategory
  name: LocalizedText
  description: LocalizedText
}

export interface VscodeStatus {
  available: boolean
  version: string | null
  codePath: string | null
  detail: string
}

export interface VscodeInstallResult {
  ok: boolean
  installed: string[]
  failed: { id: string; error: string }[]
  error: string | null
}

/** 更新包下载结果（FR-13） */
export interface DownloadUpdateResult {
  ok: boolean
  filePath: string | null
  bytes: number
  /** 实际校验结果；索引里没给哈希时为 null */
  verified: boolean | null
  error: string | null
}

/** 更新检查结果（FR-13） */
export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  /** 期望的 SHA-256（来自更新索引；没有就为 null，下载时不强校验但会告警） */
  downloadSha256: string | null
  sizeBytes: number | null
  notes: string | null
  error: string | null
}

/** 清单热更新结果（FR-15） */
export interface HotUpdateResultView {
  ok: boolean
  fetched: number
  applied: number
  rejected: { id: string; reason: string }[]
  updated: { id: string; versions: string[] }[]
  error: string | null
}

export interface MirrorApplyResult {
  ok: boolean
  changed: string[]
  backupFiles: string[]
  error: string | null
}

export interface UserConfigView {
  locale: Locale
  autoUpdate: boolean
  manifestHotUpdate: boolean
  /** 清单热更新索引地址（https）；null 表示未配置，功能关闭 */
  manifestHotUpdateUrl: string | null
  /** 更新检查源（latest.json / latest.yml）；null 表示未配置 */
  updateFeedUrl: string | null
  concurrency: number
  createRestorePoint: boolean
  mirrorPreference: MirrorPreference
  proxy: string | null
  /** 安装成功后自动激活（写用户 PATH 与环境变量） */
  activateAfterInstall: boolean
  /** 安装成功后自动写 npm/pip/git 镜像源 */
  configureMirrors: boolean
  mirrors: MirrorSetting[]
  /** 是否已备份过用户 PATH */
  pathBackupFile: string | null
  /**
   * 批量产物（版本目录 / 下载缓存 / 切换链接）的根目录。
   * null = 用默认值 %USERPROFILE%\.devkit；改成别的盘可避免系统盘被塞满。
   */
  dataRoot: string | null
  /** 实际生效的根目录（已解析过环境变量与默认值） */
  effectiveDataRoot: string
  /** 这个根目录是从哪来的 */
  dataRootSource: 'env' | 'config' | 'default'
}

/* ------------------------------------------------------------------ */
/* 离线包（FR-12）                                                      */
/* ------------------------------------------------------------------ */

export interface OfflinePackRequest {
  toolIds: string[]
  /** 目标目录，用户通过保存对话框选 */
  outputDir?: string
}

export interface OfflinePackResult {
  ok: boolean
  packDir: string | null
  fileCount: number
  totalBytes: number
  /**
   * 因为许可证分级被排除的项（L2/L3 不得再分发，SPEC §8）。
   * 必须让用户看到"为什么少了几个"，而不是悄悄少打包。
   */
  skipped: { id: string; tier: LicenseTier; reason: string }[]
  error: string | null
}
