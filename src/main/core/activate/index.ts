import { existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivateResult, ActivateSpec, ActivationRecord, ActivationSnapshot } from '@shared/types'
import { getActivationFile, getBackupDir, getCurrentRoot, getShimDir } from '../../utils/app-paths'
import { fileExists, readJsonFile, timestampSlug, writeJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'
import { buildActivateEntries, prependPathEntries, removePathEntries, type ActivateVars } from './paths'
import { readUserEnv, readUserPath, writeUserEnv, writeUserPath } from './windows'

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
}

const EMPTY_STATE: ActivationState = {
  schemaVersion: 1,
  records: [],
  managedPathEntries: [],
  backupFile: null
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
      backupFile: typeof raw.backupFile === 'string' ? raw.backupFile : null
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
async function syncUserPath(state: ActivationState): Promise<ActivationState> {
  const raw = await readUserPath()
  const withBackup = backupUserPathOnce(state, raw)

  const desired = [...new Set(withBackup.records.flatMap((record) => record.pathEntries))]
  const stripped = removePathEntries(raw, [...withBackup.managedPathEntries, ...desired])
  const merged = prependPathEntries(stripped, desired)

  if (merged.value !== raw) {
    await writeUserPath(merged.value)
    logger.info(
      'activate',
      `用户 PATH 已更新：新增 ${merged.added.length} 条，已在 PATH 中 ${merged.alreadyPresent.length} 条`
    )
  }

  return { ...withBackup, managedPathEntries: desired }
}

export interface ActivateParams {
  toolId: string
  version: string
  installDir: string
  spec: ActivateSpec
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
      pathEntries: entries.pathEntries,
      env: entries.env,
      activatedAt: new Date().toISOString()
    }

    state = {
      ...state,
      records: [...state.records.filter((item) => item.toolId !== toolId), record]
    }

    // 先写环境变量再改 PATH：如果环境变量写失败，PATH 还没动，回滚成本最低
    for (const [name, value] of Object.entries(entries.env)) {
      await writeUserEnv(name, value)
    }

    state = await syncUserPath(state)
    saveActivationState(state)

    const note =
      previous && previous.version !== version
        ? `已从 ${previous.version} 切换到 ${version}；新开的终端里生效`
        : '已写入用户 PATH；新开的终端里生效'

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
    saveActivationState(synced)

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
