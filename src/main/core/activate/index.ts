import { existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActivateResult, ActivateSpec, ActivationRecord, ActivationSnapshot } from '@shared/types'
import { getActivationFile, getBackupDir, getCurrentRoot, getShimDir } from '../../utils/app-paths'
import { fileExists, readJsonFile, timestampSlug, writeJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'
import { buildActivateEntries, prependPathEntries, removePathEntries, type ActivateVars } from './paths'
import { readUserEnv, readUserPath, writeUserEnv, writeUserPath } from './windows'
import { readEffectivePaths, verifyActivation, type ActivationVerifySpec } from './verify'

/**
 * 激活（FR-11）：把「已经装进版本目录的文件」接到用户环境里，让用户新开一个终端就能用。
 *
 * 机制：
 *  1. 每个工具一个 junction：%USERPROFILE%\.devkit\current\<linkName> → 版本目录
 *  2. 把该工具的 bin 目录（指向 junction）插到**用户 PATH 最前面**
 *  3. 写入该工具需要的用户环境变量（JAVA_HOME / GOROOT / CARGO_HOME …）
 *  4. 所有改动记到 activated.json，回滚时按记录精确移除，不靠"猜哪条 PATH 是脏数据"
 *
 * 切版本 = 只改 junction 指向，PATH 一个字都不用动。
 */

export interface ActivationState {
  schemaVersion: 1
  records: ActivationRecord[]
  /** 当前由 devkit 管理的全部 PATH 条目（并集） */
  managedPathEntries: string[]
  /** 首次改动用户 PATH 前的备份文件 */
  backupFile: string | null
  /** DEVKIT_HOME 这个用户变量是不是 devkit 自己创建的（决定取消激活时要不要删它） */
  ownsDevkitHomeVar?: boolean
}

const EMPTY_STATE: ActivationState = {
  schemaVersion: 1,
  records: [],
  managedPathEntries: [],
  backupFile: null,
  ownsDevkitHomeVar: false
}

/**
 * PATH 条目里用这个变量代替 %USERPROFILE%\.devkit。
 *
 * 为什么：每装一个工具就往 PATH 里加一条绝对路径，10 个工具就多 400+ 字符，
 * 而 PATH 过长是 winget 那边被反复投诉的真实故障（#3601 / #5557）。
 * 收敛到一个变量后，每一条只多 20 多个字符，而且用户一眼能看出哪些条目是 devkit 管的。
 */
export const DEVKIT_HOME_VAR = '%DEVKIT_HOME%'

/** PATH 超过这个长度就告警（Windows 上路径相关的 API 普遍以 2047/2048 为界） */
export const PATH_LENGTH_WARN = 2047

export function getDevkitHome(): string {
  return join(homedir(), '.devkit')
}

/**
 * 把绝对路径改写成 %DEVKIT_HOME% 形式（只改 devkit 自己的目录）。
 *
 * 注意必须校验剩下的部分以路径分隔符开头：否则 `C:\Users\x\.devkit-other`
 * 这种"前缀相似的兄弟目录"会被误改，把一个无关的 PATH 条目指向 devkit。
 */
export function toDevkitHomeVar(entry: string): string {
  const home = getDevkitHome()
  if (!entry.toLowerCase().startsWith(home.toLowerCase())) return entry

  const rest = entry.slice(home.length)
  if (rest !== '' && rest[0] !== '\\' && rest[0] !== '/') return entry

  return `${DEVKIT_HOME_VAR}${rest}`
}

export function readActivationState(): ActivationState {
  const file = getActivationFile()
  if (!fileExists(file)) return { ...EMPTY_STATE }
  try {
    const raw = readJsonFile<Partial<ActivationState>>(file)
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.records)) return { ...EMPTY_STATE }
    return {
      schemaVersion: 1,
      records: raw.records.filter(
        (record): record is ActivationRecord =>
          typeof record === 'object' &&
          record !== null &&
          typeof (record as ActivationRecord).toolId === 'string'
      ),
      managedPathEntries: Array.isArray(raw.managedPathEntries)
        ? raw.managedPathEntries.filter((entry): entry is string => typeof entry === 'string')
        : [],
      backupFile: typeof raw.backupFile === 'string' ? raw.backupFile : null,
      ownsDevkitHomeVar: raw.ownsDevkitHomeVar === true
    }
  } catch (error) {
    logger.warn('activate', `激活记录损坏，已重置：${(error as Error).message}`)
    return { ...EMPTY_STATE }
  }
}

function saveActivationState(state: ActivationState): void {
  writeJsonFile(getActivationFile(), state)
}

export function getLinkPath(linkName: string): string {
  return join(getCurrentRoot(), linkName)
}

/**
 * 删除一个 junction（只删链接本身，绝不动目标目录）。
 *
 * 踩过的坑：`fs.rmSync(path, { recursive: false })` 对 junction 会直接报
 * "Path is a directory" —— junction 在文件系统层面是个**目录**（带重解析点），
 * 只有 `rmdir`（RemoveDirectoryW）或带 recursive 的 rm 才能把它拿掉。
 * 实测 `rmSync(recursive: true)` 也只删链接、不动目标，但 `rmdirSync` 语义最准，所以优先用它。
 */
export function unlinkJunction(linkPath: string): void {
  try {
    rmdirSync(linkPath)
  } catch {
    rmSync(linkPath, { recursive: true, force: true })
  }
}

/**
 * 在指定位置创建 junction（不依赖 electron，方便单测）。
 * 返回 created / replaced / unchanged。
 */
export async function createJunctionAt(
  linkPath: string,
  target: string
): Promise<'created' | 'replaced' | 'unchanged'> {
  if (existsSync(linkPath)) {
    const info = lstatSync(linkPath)
    if (!info.isSymbolicLink()) {
      throw new Error(
        `拒绝替换 ${linkPath}：它不是一个链接（可能是你手工创建的目录）。请先自行处理该目录。`
      )
    }

    const current = readLinkTargetSafe(linkPath)
    if (current && current.toLowerCase() === target.toLowerCase()) return 'unchanged'

    unlinkJunction(linkPath)
    await symlink(target, linkPath, 'junction')
    return 'replaced'
  }

  await symlink(target, linkPath, 'junction')
  return 'created'
}

/** 删除 junction（只删链接本身，绝不动目标目录）；不是链接就返回 false */
export function removeJunctionAt(linkPath: string): boolean {
  if (!existsSync(linkPath)) return false
  const info = lstatSync(linkPath)
  if (!info.isSymbolicLink()) return false
  unlinkJunction(linkPath)
  return true
}

/**
 * 创建/替换 junction。
 *
 * 安全关键：**只删除确认是链接的路径**。如果那个位置是真实目录（用户手工建过、或上次
 * 写坏了），一律拒绝 —— 递归删掉它会把用户的数据一起带走。
 */
export async function ensureJunction(
  linkPath: string,
  target: string
): Promise<'created' | 'replaced' | 'unchanged'> {
  mkdirSync(getCurrentRoot(), { recursive: true })
  return createJunctionAt(linkPath, target)
}

function readLinkTargetSafe(linkPath: string): string | null {
  try {
    return readlinkSync(linkPath)
  } catch {
    return null
  }
}

/** 删除 junction（只删链接本身，绝不动目标目录） */
export function removeJunction(linkPath: string): boolean {
  const removed = removeJunctionAt(linkPath)
  if (!removed && existsSync(linkPath)) {
    logger.warn('activate', `跳过删除 ${linkPath}：它不是链接`)
  }
  return removed
}

/** 首次改动用户 PATH 之前先留一份原文，用户随时能自己比对/还原 */
function backupUserPathOnce(state: ActivationState, rawPath: string): ActivationState {
  if (state.backupFile && fileExists(state.backupFile)) return state

  try {
    const file = join(getBackupDir(), `user-path-${timestampSlug()}.txt`)
    writeFileSync(file, rawPath, 'utf8')
    logger.info('activate', `已备份用户 PATH 原文：${file}`)
    return { ...state, backupFile: file }
  } catch (error) {
    logger.warn('activate', `备份用户 PATH 失败（继续激活）：${(error as Error).message}`)
    return state
  }
}

/**
 * 把 PATH 同步成「新的管理条目并集 + 其余原样」。
 *
 * 做法是每次都先把**已知的全部管理条目**从当前 PATH 里摘掉，再把新的并集插到最前面。
 * 这样反复激活/取消激活不会留下重复项，也不会误删用户自己的条目。
 */
async function syncUserPath(state: ActivationState): Promise<{ state: ActivationState; warning: string | null }> {
  const raw = await readUserPath()
  const withBackup = backupUserPathOnce(state, raw)

  const desired = [...new Set(withBackup.records.flatMap((record) => record.pathEntries))]
  const stripped = removePathEntries(raw, [...withBackup.managedPathEntries, ...desired])
  const merged = prependPathEntries(stripped, desired)

  let warning: string | null = null
  if (merged.value.length > PATH_LENGTH_WARN) {
    // PATH 过长是 winget 那边被反复投诉的真实问题（#3601 / #5557）：
    // 不报错，但必须告诉用户，否则他会在别处碰到莫名其妙的"命令找不到"。
    warning =
      `用户 PATH 已经 ${merged.value.length} 个字符（超过 ${PATH_LENGTH_WARN}），` +
      '建议清理一些不再使用的条目'
    logger.warn('activate', warning)
  }

  if (merged.value !== raw) {
    await writeUserPath(merged.value)
    logger.info(
      'activate',
      `用户 PATH 已更新：新增 ${merged.added.length} 条，已在 PATH 中 ${merged.alreadyPresent.length} 条`
    )
  }

  return { state: { ...withBackup, managedPathEntries: desired }, warning }
}

export interface ActivateParams {
  toolId: string
  version: string
  installDir: string
  spec: ActivateSpec
  /** 用"新终端环境"验证时跑的命令（取自清单的 detect.commands[0]） */
  verifySpec?: ActivationVerifySpec
}

/** 激活某个版本；重复激活同一工具等于切换版本 */
export async function activateVersion(params: ActivateParams): Promise<ActivateResult> {
  const { toolId, version, installDir, spec } = params

  if (!existsSync(installDir)) {
    return { ok: false, record: null, note: null, error: `版本目录不存在：${installDir}` }
  }

  const linkName = spec.linkName ?? toolId
  const vars: ActivateVars = {
    installDir,
    currentDir: getLinkPath(linkName),
    version,
    toolId
  }

  let entries
  try {
    entries = buildActivateEntries(spec, vars)
  } catch (error) {
    return { ok: false, record: null, note: null, error: (error as Error).message }
  }

  // PATH 条目收敛到 %DEVKIT_HOME%，避免每装一个工具就把 PATH 拉长一截
  const pathEntries = entries.pathEntries.map(toDevkitHomeVar)
  const usesDevkitHome = pathEntries.some((entry) => entry.includes(DEVKIT_HOME_VAR))

  let state = readActivationState()
  const previous = state.records.find((record) => record.toolId === toolId) ?? null

  try {
    const linkResult = await ensureJunction(getLinkPath(linkName), installDir)
    logger.info('activate', `${toolId}@${version} 切换链接：${linkResult} → ${installDir}`)

    const record: ActivationRecord = {
      toolId,
      version,
      linkName,
      linkPath: getLinkPath(linkName),
      target: installDir,
      pathEntries,
      env: entries.env,
      activatedAt: new Date().toISOString()
    }

    state = {
      ...state,
      records: [...state.records.filter((item) => item.toolId !== toolId), record]
    }

    // 先写环境变量再改 PATH：如果环境变量写失败，PATH 还没动，回滚成本最低
    if (usesDevkitHome && state.ownsDevkitHomeVar !== true) {
      await writeUserEnv('DEVKIT_HOME', getDevkitHome())
      state = { ...state, ownsDevkitHomeVar: true }
      logger.info('activate', `已设置 DEVKIT_HOME=${getDevkitHome()}`)
    }
    for (const [name, value] of Object.entries(entries.env)) {
      await writeUserEnv(name, value)
    }

    const synced = await syncUserPath(state)
    state = synced.state
    saveActivationState(state)

    // 关键一步：用"新终端会看到的环境"验证命令真的能找到、且解析到 devkit 这一份
    // （写进 PATH ≠ 生效；机器级 PATH 里的同名工具还会抢在前面）
    const notes: string[] = []
    const warnings: string[] = []

    if (params.verifySpec) {
      const paths = await readEffectivePaths()
      const verified = await verifyActivation(params.verifySpec, paths, getLinkPath(linkName))
      if (verified.ok && verified.resolvedFromDevkit) {
        notes.push(`新终端验证通过（${verified.detail}）`)
        logger.info('activate', `${toolId} 新终端验证通过：${verified.detail}`)
      } else if (verified.ok) {
        // 能跑，但跑的不是 devkit 装的那份 —— 这是必须让用户知道的事实
        warnings.push(verified.detail)
        logger.warn('activate', `${toolId} 新终端验证：${verified.detail}`)
      } else {
        warnings.push(`新终端验证未通过：${verified.detail}`)
        logger.warn('activate', `${toolId} 新终端验证未通过：${verified.detail}`)
      }
    }

    const head =
      previous && previous.version !== version
        ? `已从 ${previous.version} 切换到 ${version}`
        : '已写入用户 PATH'
    if (synced.warning) warnings.push(synced.warning)

    const note =
      `${head}；新开的终端里生效` +
      (notes.length > 0 ? `；${notes.join('；')}` : '') +
      (warnings.length > 0 ? `。注意：${warnings.join('；')}` : '')

    return { ok: true, record, note, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('activate', `激活 ${toolId}@${version} 失败：${message}`)
    return { ok: false, record: null, note: null, error: message }
  }
}

/** 取消激活：移除 PATH 条目、环境变量与 junction；**不删安装文件** */
export async function deactivateTool(toolId: string): Promise<{ removed: string[]; error: string | null }> {
  const state = readActivationState()
  const record = state.records.find((item) => item.toolId === toolId)
  if (!record) return { removed: [], error: null }

  const removed: string[] = []
  try {
    // 先拆 junction：它失败的概率最低，而且如果拆不掉，宁可不动 PATH
    // （否则会出现"PATH 已清理、链接还在"的半成品状态，下次就没人能清它了）
    if (removeJunction(record.linkPath)) removed.push(`切换链接 ${record.linkPath}`)

    for (const name of Object.keys(record.env)) {
      await writeUserEnv(name, null)
      removed.push(`环境变量 ${name}`)
    }

    const next: ActivationState = {
      ...state,
      records: state.records.filter((item) => item.toolId !== toolId)
    }
    const synced = await syncUserPath(next)

    // 没有别的工具在用 %DEVKIT_HOME% 了，就把这个变量也收回
    let finalState = synced.state
    if (finalState.ownsDevkitHomeVar === true && finalState.records.length === 0) {
      await writeUserEnv('DEVKIT_HOME', null)
      finalState = { ...finalState, ownsDevkitHomeVar: false }
      removed.push('环境变量 DEVKIT_HOME')
    }
    saveActivationState(finalState)

    removed.push(...record.pathEntries.map((entry) => `PATH ${entry}`))

    logger.info('activate', `已取消激活 ${toolId}：${removed.join('；')}`)
    return { removed, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('activate', `取消激活 ${toolId} 失败：${message}`)
    return { removed, error: message }
  }
}

/** 该工具当前激活的是哪个版本（没激活返回 null） */
export function getActivatedVersion(toolId: string): string | null {
  return readActivationState().records.find((record) => record.toolId === toolId)?.version ?? null
}

export async function getSnapshot(): Promise<ActivationSnapshot> {
  const state = readActivationState()
  let userPath = ''
  try {
    userPath = await readUserPath()
  } catch (error) {
    logger.warn('activate', `读取用户 PATH 失败：${(error as Error).message}`)
  }

  return {
    records: state.records,
    binDir: getShimDir(),
    userPath,
    backupFile: state.backupFile,
    managedPathEntries: state.managedPathEntries
  }
}

/** 只读探测：某个环境变量当前是否指向 devkit 的激活目录（诊断用） */
export async function describeEnv(name: string): Promise<string | null> {
  return readUserEnv(name)
}
