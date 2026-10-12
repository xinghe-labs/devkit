import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemConfigId } from '@shared/types'
import { getBackupDir } from '../../utils/app-paths'
import { logger } from '../report/logger'

/**
 * 系统配置的备份账本（P1-2）。
 *
 * 背景：`systemconfig` 会写 HKLM 注册表与 `~/.gitconfig`，但原来**零备份、零还原路径** ——
 * 这与 devkit 自己反复强调的「可回退」原则直接冲突（`activate` 有完整备份机制，它没有）。
 *
 * 设计要点：
 *
 * 1. **单文件 + 按项首写胜出**，不是每次改都存一个时间戳文件。
 *    原因：第二次「启用」时原值已经被自己改过了，再存一次就把真正的原值覆盖掉了。
 *    只留第一次改动前的样子，才能精确还原到「devkit 介入之前」。
 *
 * 2. **必须区分「原本不存在」与「原本为 0」**。
 *    两者在界面上都显示成"没启用"，但还原动作完全不同：
 *    前者要删值，后者要写回 0。记录里用 `existed` 显式表达。
 *
 * 3. **`ssh-key` 不记账**。生成的私钥可能已经用于 GitHub/GitLab，删掉是破坏性操作。
 *    这里只记录「本次生成过」，并在报告里提示用户自行处理，不提供还原。
 */

const BACKUP_FILE_NAME = 'system-config.json'
const SCHEMA_VERSION = 1

export interface RegistryBackupEntry {
  id: SystemConfigId
  kind: 'registry'
  /** 存 reg.exe 风格（HKLM\...），读的时候直接可用 */
  path: string
  name: string
  /** false = 原本不存在（还原时删值）；true = 原本存在（还原时写回 value） */
  existed: boolean
  value: number | null
  valueType: 'REG_DWORD'
  backedUpAt: string
}

export interface GitConfigBackupEntry {
  id: 'git-identity'
  kind: 'git-config'
  keys: { key: string; existed: boolean; value: string | null }[]
  backedUpAt: string
}

export interface ExecutionPolicyBackupEntry {
  id: 'powershell-policy'
  kind: 'execution-policy'
  scope: 'CurrentUser'
  existed: boolean
  value: string | null
  backedUpAt: string
}

export interface MachinePathBackupEntry {
  id: 'machine-path'
  kind: 'machine-path'
  /** 机器级 PATH 原文（整串，还原时整串写回） */
  value: string
  /** 条目数，仅用于展示 */
  entryCount: number
  backedUpAt: string
}

export type SystemConfigBackupEntry =
  | RegistryBackupEntry
  | GitConfigBackupEntry
  | ExecutionPolicyBackupEntry
  | MachinePathBackupEntry

export interface SystemConfigBackup {
  schemaVersion: number
  entries: SystemConfigBackupEntry[]
}

function backupFilePath(): string {
  return join(getBackupDir(), BACKUP_FILE_NAME)
}

export function readSystemConfigBackup(): SystemConfigBackup {
  const file = backupFilePath()
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SystemConfigBackup
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { schemaVersion: SCHEMA_VERSION, entries: [] }
    }
    return { schemaVersion: SCHEMA_VERSION, entries: parsed.entries }
  } catch (error) {
    // 账本坏了不能让程序起不来；当空的处理，并在日志里留痕
    logger.warn('system', `系统配置备份账本损坏，按空处理：${(error as Error).message}`)
    return { schemaVersion: SCHEMA_VERSION, entries: [] }
  }
}

export function getBackupEntry(id: SystemConfigId): SystemConfigBackupEntry | undefined {
  return readSystemConfigBackup().entries.find((entry) => entry.id === id)
}

function writeBackup(backup: SystemConfigBackup): void {
  writeFileSync(backupFilePath(), `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
}

/**
 * 记账。**首写胜出** —— 已经记过这一项就直接返回，不覆盖。
 * 返回真正生效的记录（可能是之前那条）。
 */
export function recordBackup(entry: SystemConfigBackupEntry): SystemConfigBackupEntry {
  const backup = readSystemConfigBackup()
  const existing = backup.entries.find((item) => item.id === entry.id)
  if (existing) return existing

  backup.entries.push(entry)
  writeBackup(backup)
  logger.info('system', `已备份系统配置原值：${entry.id}（还原点 ${backupFilePath()}）`)
  return entry
}

/** 还原成功后销账 —— 留着会让界面一直显示"已由 devkit 修改" */
export function clearBackupEntry(id: SystemConfigId): void {
  const backup = readSystemConfigBackup()
  const next = backup.entries.filter((entry) => entry.id !== id)
  if (next.length === backup.entries.length) return
  writeBackup({ schemaVersion: SCHEMA_VERSION, entries: next })
  logger.info('system', `已清除系统配置备份记录：${id}`)
}

export function describeBackupFile(): string {
  return backupFilePath()
}

/** 供测试与自检使用 */
export const __testing = { BACKUP_FILE_NAME, SCHEMA_VERSION }
