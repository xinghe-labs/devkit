import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { arch as osArch, release as osRelease } from 'node:os'
import { MIRROR_TARGETS } from '@shared/types'
import type {
  DetectionResult,
  EnvProfile,
  InstalledTool,
  MirrorSetting,
  MirrorTarget,
  PlanSelection,
  ProfileDiff,
  ProfileDiffEntry,
  ToolManifest
} from '@shared/types'
import { runCommand } from '../../utils/exec'
import { readCurrentMirrors, applyMirrors } from '../config/mirrors'
import { readActivationState } from '../activate'
import { readUserEnv, readUserPath, writeUserEnv, writeUserPath } from '../activate/windows'
import { analyzePath, normalizeEntry } from '../doctor/paths'
import { logger } from '../report/logger'

/**
 * 环境档案 / 换机迁移（FR-22）。
 *
 * 核心判断：**重装系统最痛的从来不是"装软件"，而是"恢复成原来那样"** ——
 * PATH 里的自定义条目、JAVA_HOME、镜像源、git 身份、VS Code 插件，
 * 这些东西 winget export 全都不含（devkit 的市场调研里就收录了 winget #3044 这类 issue）。
 *
 * 三条安全底线：
 *  1. **档案里绝不含任何密钥**。环境变量走白名单（只收 JAVA_HOME/GOROOT 这类路径变量），
 *     不读 .npmrc 的 auth token、不碰 SSH 私钥、不碰 git credential。
 *  2. **导入是"差异展示 + 逐项确认"**，不是"一键覆盖"。恢复 PATH / 环境变量前一律先备份。
 *  3. **装软件复用现有的安装流程**（预检 → 下载 → 校验 → 安装 → 自检 → 激活），
 *     不新开一条路径 —— 少一条路径就少一类 bug。
 */

/** 只收这些环境变量：都是"路径/工具链位置"，不含任何凭证 */
export const PROFILE_ENV_ALLOWLIST: readonly string[] = [
  'JAVA_HOME',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'MAVEN_HOME',
  'GRADLE_HOME',
  'PYTHONHOME',
  'GOPATH',
  'ANDROID_HOME',
  'DEVKIT_HOME'
]

/** 这些 PATH 条目是 Windows 自带的，导出时排除（换机不需要带） */
const SYSTEM_PATH_PREFIXES = [
  '%systemroot%',
  'c:\\windows',
  '%programfiles%',
  'c:\\program files',
  '%programfiles(x86)%',
  'c:\\program files (x86)',
  '%programdata%'
]

export interface ExportOptions {
  /** 是否带上 git 身份（user.name / user.email）。默认不带 —— 那算个人信息 */
  includeGitIdentity?: boolean
  /** 目标机器上要装什么；不传则由"本机已装"推导 */
  selections?: PlanSelection[]
}

function isSystemPathEntry(entry: string): boolean {
  const lowered = entry.toLowerCase()
  return SYSTEM_PATH_PREFIXES.some((prefix) => lowered.startsWith(prefix))
}

async function readGitIdentity(): Promise<{ userName: string | null; userEmail: string | null }> {
  const read = async (key: string): Promise<string | null> => {
    const result = await runCommand('git', ['config', '--global', '--get', key], { timeoutMs: 15_000 })
    if (result.code !== 0) return null
    const value = result.stdout.trim()
    return value === '' ? null : value
  }
  return { userName: await read('user.name'), userEmail: await read('user.email') }
}

async function readVscodeExtensions(): Promise<string[]> {
  const result = await runCommand('code', ['--list-extensions'], { timeoutMs: 30_000 })
  if (result.code !== 0 || result.spawnError) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line))
}

export interface CollectContext {
  tools: ToolManifest[]
  detections: DetectionResult[]
  installed: InstalledTool[]
  mirrors: MirrorSetting[]
}

/** 把"本机现状"收成一份档案 */
export async function collectProfile(
  context: CollectContext,
  options: ExportOptions = {}
): Promise<EnvProfile> {
  const userPath = await readUserPath().catch(() => '')
  const analysis = analyzePath(userPath, { exists: existsSync, env: process.env })

  const devkitManaged = new Set(
    readActivationState().records.flatMap((record) =>
      record.pathEntries.map((entry) => normalizeEntry(entry))
    )
  )

  const userPathExtra = analysis.entries
    .filter((entry) => entry.kind === 'ok')
    .map((entry) => entry.raw)
    .filter((entry) => !isSystemPathEntry(entry))
    .filter((entry) => !devkitManaged.has(normalizeEntry(entry)))

  const env: Record<string, string> = {}
  for (const name of PROFILE_ENV_ALLOWLIST) {
    const value = await readUserEnv(name).catch(() => null)
    if (value !== null && value.trim() !== '') env[name] = value
  }

  const currentMirrors = readCurrentMirrors()

  // 目标机器上要装什么：本机已装（或 devkit 已装）的那些工具
  const installedIds = new Set(context.installed.map((item) => item.toolId))
  const selections: PlanSelection[] =
    options.selections ??
    context.detections
      .filter(
        (result) =>
          result.status === 'installed' ||
          result.status === 'version-mismatch' ||
          result.status === 'path-missing' ||
          installedIds.has(result.toolId)
      )
      .map((result) => {
        // devkit 装过就带上具体版本（换机能复现同一版本），否则只带工具 id 让它选推荐版
        const mine = context.installed.find((item) => item.toolId === result.toolId)
        return mine ? { toolId: result.toolId, version: mine.version } : { toolId: result.toolId }
      })

  const vscodeExtensions = await readVscodeExtensions()
  const git = options.includeGitIdentity ? await readGitIdentity() : { userName: null, userEmail: null }

  const profile: EnvProfile = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    devkitVersion: context.tools.length > 0 ? '0.2.x' : 'unknown',
    machine: {
      platform: process.platform,
      arch: osArch(),
      osRelease: osRelease()
    },
    detected: context.detections.map((result) => ({
      toolId: result.toolId,
      status: result.status,
      version: result.installedVersion
    })),
    installed: context.installed.map((item) => ({
      toolId: item.toolId,
      version: item.version,
      activated: item.active
    })),
    userPathExtra,
    env,
    mirrors: context.mirrors.map((item) => ({
      target: item.target,
      url: item.enabled ? currentMirrors[item.target] ?? item.url : null
    })),
    git,
    vscodeExtensions,
    selections
  }

  logger.info(
    'profile',
    `已收集环境档案：${profile.detected.length} 个检测结果、${profile.installed.length} 个 devkit 安装、` +
      `${userPathExtra.length} 条自定义 PATH、${Object.keys(env).length} 个环境变量、${vscodeExtensions.length} 个插件`
  )
  return profile
}

/** 校验一份外部拿到的档案（可能是别人给的，不能直接信） */
export function sanitizeProfile(raw: unknown): EnvProfile {
  if (typeof raw !== 'object' || raw === null) throw new Error('档案不是一个对象')
  const input = raw as Partial<EnvProfile>
  if (input.schemaVersion !== 1) throw new Error(`档案版本不支持：${String(input.schemaVersion)}`)

  const toolId = /^[a-z0-9][a-z0-9-]{0,39}$/
  const safeSelections: PlanSelection[] = Array.isArray(input.selections)
    ? input.selections
        .filter(
          (item): item is PlanSelection =>
            typeof item === 'object' && item !== null && typeof (item as PlanSelection).toolId === 'string'
        )
        .filter((item) => toolId.test(item.toolId))
        .map((item) =>
          typeof item.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(item.version)
            ? { toolId: item.toolId, version: item.version }
            : { toolId: item.toolId }
        )
    : []

  const safePathExtra = Array.isArray(input.userPathExtra)
    ? input.userPathExtra.filter(
        (entry): entry is string => typeof entry === 'string' && /^[a-zA-Z]:[\\/]/.test(entry)
      )
    : []

  const env: Record<string, string> = {}
  if (typeof input.env === 'object' && input.env !== null) {
    for (const [name, value] of Object.entries(input.env)) {
      // 只收白名单里的变量名 —— 别人给的档案不能往我们环境里塞任意变量
      if (!PROFILE_ENV_ALLOWLIST.includes(name)) continue
      if (typeof value === 'string' && value.length <= 500) env[name] = value
    }
  }

  return {
    schemaVersion: 1,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    devkitVersion: typeof input.devkitVersion === 'string' ? input.devkitVersion : 'unknown',
    machine: {
      platform: String(input.machine?.platform ?? 'unknown'),
      arch: String(input.machine?.arch ?? 'unknown'),
      osRelease: String(input.machine?.osRelease ?? 'unknown')
    },
    detected: Array.isArray(input.detected)
      ? input.detected.filter(
          (item): item is EnvProfile['detected'][number] =>
            typeof item === 'object' && item !== null && typeof (item as { toolId?: unknown }).toolId === 'string'
        )
      : [],
    installed: Array.isArray(input.installed)
      ? input.installed.filter(
          (item): item is EnvProfile['installed'][number] =>
            typeof item === 'object' && item !== null && typeof (item as { toolId?: unknown }).toolId === 'string'
        )
      : [],
    userPathExtra: safePathExtra,
    env,
    mirrors: Array.isArray(input.mirrors)
      ? input.mirrors.filter(
          (item): item is EnvProfile['mirrors'][number] =>
            typeof item === 'object' && item !== null && typeof (item as { target?: unknown }).target === 'string'
        )
      : [],
    git: {
      userName: typeof input.git?.userName === 'string' ? input.git.userName : null,
      userEmail: typeof input.git?.userEmail === 'string' ? input.git.userEmail : null
    },
    vscodeExtensions: Array.isArray(input.vscodeExtensions)
      ? input.vscodeExtensions.filter((item): item is string => typeof item === 'string').slice(0, 500)
      : [],
    selections: safeSelections
  }
}

/** 档案 vs 本机：缺什么、版本差什么、已经有什么 */
export async function diffProfile(
  profile: EnvProfile,
  context: { tools: ToolManifest[]; detections: DetectionResult[]; installed: InstalledTool[] }
): Promise<ProfileDiff> {
  const byId = new Map(context.tools.map((tool) => [tool.id, tool]))
  const detectionById = new Map(context.detections.map((item) => [item.toolId, item]))
  const installedById = new Map(context.installed.map((item) => [item.toolId, item]))

  const tools: ProfileDiffEntry[] = profile.selections.map((selection) => {
    const tool = byId.get(selection.toolId)
    const detection = detectionById.get(selection.toolId)
    const mine = installedById.get(selection.toolId)

    let state: ProfileDiffEntry['state'] = 'missing'
    if (mine) state = 'installed-by-devkit'
    else if (detection?.status === 'installed') state = 'already-present'
    else if (detection?.status === 'version-mismatch' || detection?.status === 'path-missing') {
      state = 'version-differs'
    }

    return {
      toolId: selection.toolId,
      name: tool?.name ?? null,
      wantedVersion: selection.version ?? null,
      currentVersion: mine?.version ?? detection?.installedVersion ?? null,
      state
    }
  })

  // PATH 条目：档案里有、本机没有的
  const currentPath = await readUserPath().catch(() => '')
  const currentEntries = new Set(
    analyzePath(currentPath, { exists: existsSync, env: process.env }).entries.map((entry) =>
      normalizeEntry(entry.raw)
    )
  )
  const missingPathEntries = profile.userPathExtra.filter(
    (entry) => !currentEntries.has(normalizeEntry(entry))
  )

  // 环境变量：档案里有、本机没有或值不同的
  const envToRestore: Record<string, string> = {}
  for (const [name, value] of Object.entries(profile.env)) {
    const current = await readUserEnv(name).catch(() => null)
    if (current !== value) envToRestore[name] = value
  }

  const diff: ProfileDiff = {
    tools,
    missingPathEntries,
    envToRestore,
    vscodeExtensions: profile.vscodeExtensions,
    summary: {
      toInstall: tools.filter((entry) => entry.state === 'missing' || entry.state === 'version-differs').length,
      alreadyPresent: tools.filter((entry) => entry.state !== 'missing' && entry.state !== 'version-differs')
        .length,
      pathEntries: missingPathEntries.length,
      envVars: Object.keys(envToRestore).length
    }
  }

  logger.info(
    'profile',
    `档案差异：需安装 ${diff.summary.toInstall}、已有 ${diff.summary.alreadyPresent}、` +
      `PATH 待恢复 ${diff.summary.pathEntries}、环境变量待恢复 ${diff.summary.envVars}`
  )
  return diff
}

export interface ApplyProfileOptions {
  /** 把档案里的自定义 PATH 条目补进用户 PATH（会先备份） */
  restoreUserPath: boolean
  /** 恢复环境变量（会先备份） */
  restoreEnv: boolean
  /** 恢复镜像源配置 */
  restoreMirrors: boolean
  /** 恢复 git 身份 */
  restoreGit: boolean
}

export interface ApplyProfileResult {
  ok: boolean
  /** 实际做了什么，逐条列出 */
  changed: string[]
  /** 需要安装的工具（交给现有安装流程） */
  selections: PlanSelection[]
  error: string | null
}

/**
 * 执行档案恢复。
 *
 * 只做"环境配置"部分（PATH / 环境变量 / 镜像 / git）；
 * **装软件不在这里做** —— 它返回 selections，由界面走现有的安装流程
 * （预检 → 下载 → 校验 → 安装 → 自检 → 激活），避免重复实现一条安装路径。
 */
export async function applyProfile(
  profile: EnvProfile,
  options: ApplyProfileOptions
): Promise<ApplyProfileResult> {
  const changed: string[] = []

  try {
    if (options.restoreUserPath && profile.userPathExtra.length > 0) {
      const raw = await readUserPath()
      const existing = new Set(
        analyzePath(raw, { exists: existsSync, env: process.env }).entries.map((entry) =>
          normalizeEntry(entry.raw)
        )
      )
      const toAdd = profile.userPathExtra.filter((entry) => !existing.has(normalizeEntry(entry)))

      if (toAdd.length > 0) {
        // 追加到末尾而不是插到最前：档案来自另一台机器，不确定它的优先级意图
        const next = raw.trim() === '' ? toAdd.join(';') : `${raw};${toAdd.join(';')}`
        await writeUserPath(next)
        changed.push(...toAdd.map((entry) => `用户 PATH += ${entry}`))
      }
    }

    if (options.restoreEnv) {
      for (const [name, value] of Object.entries(profile.env)) {
        await writeUserEnv(name, value)
        changed.push(`环境变量 ${name} = ${value}`)
      }
    }

    if (options.restoreMirrors && profile.mirrors.length > 0) {
      const settings: MirrorSetting[] = profile.mirrors
        .filter((item) => item.url !== null)
        .filter((item): item is { target: MirrorTarget; url: string } =>
          (MIRROR_TARGETS as readonly string[]).includes(item.target) && typeof item.url === 'string'
        )
        .map((item) => ({ target: item.target, enabled: true, url: item.url }))
      if (settings.length > 0) {
        const result = applyMirrors(settings)
        changed.push(...result.changed)
      }
    }

    if (options.restoreGit && profile.git.userName && profile.git.userEmail) {
      const pairs: [string, string][] = [
        ['user.name', profile.git.userName],
        ['user.email', profile.git.userEmail]
      ]
      for (const [key, value] of pairs) {
        const result = await runCommand('git', ['config', '--global', key, value], { timeoutMs: 15_000 })
        if (result.code === 0) changed.push(`git config --global ${key} = ${value}`)
      }
    }

    logger.info('profile', `档案恢复完成：${changed.length} 项变更`)
    return { ok: true, changed, selections: profile.selections, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('profile', `档案恢复失败：${message}`)
    return { ok: false, changed, selections: profile.selections, error: message }
  }
}

/** 给界面显示的档案摘要（导入后先让用户看清里面是什么） */
export function describeProfile(profile: EnvProfile): string[] {
  const lines: string[] = []
  lines.push(`来源：${profile.machine.platform} / ${profile.machine.arch} / build ${profile.machine.osRelease}`)
  lines.push(`生成时间：${profile.createdAt}`)
  lines.push(`工具：${profile.selections.length} 项要装，其中 devkit 装过的 ${profile.installed.length} 项`)
  lines.push(`自定义 PATH：${profile.userPathExtra.length} 条`)
  lines.push(`环境变量：${Object.keys(profile.env).length} 个${Object.keys(profile.env).length > 0 ? `（${Object.keys(profile.env).join('、')}）` : ''}`)
  lines.push(`镜像源：${profile.mirrors.filter((item) => item.url).length} 项已配置`)
  lines.push(`VS Code 插件：${profile.vscodeExtensions.length} 个`)
  if (profile.git.userName) lines.push(`git 身份：${profile.git.userName} <${profile.git.userEmail ?? '—'}>`)
  return lines
}

/** 档案默认保存位置（用户可以在保存对话框里改） */
export function defaultProfileFileName(): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return `devkit-profile-${stamp}.json`
}

export { homedir }
