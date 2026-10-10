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
export type ToolCategory = 'runtime' | 'build' | 'database' | 'container' | 'editor' | 'tool'

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'runtime',
  'build',
  'database',
  'container',
  'editor',
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

/** 安装包类型 */
export type InstallType = 'msi' | 'exe-nsis' | 'exe-inno' | 'zip'

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
}

export interface PlanOptions {
  concurrency: number
  mirrorPreference: MirrorPreference
  proxy: string | null
  createRestorePoint: boolean
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
