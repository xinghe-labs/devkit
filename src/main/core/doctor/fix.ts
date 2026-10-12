import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorFixResult, DoctorFixId } from '@shared/types'
import { getBackupDir } from '../../utils/app-paths'
import { timestampSlug } from '../../utils/fs'
import { logger } from '../report/logger'
import { readActivationState, deactivateTool, getLinkPath, removeJunction } from '../activate'
import { readMachinePath, readUserPath, writeUserPath } from '../activate/windows'
import { runElevated, toMachinePathStep } from '../elevation'
import { analyzePath } from './paths'

/**
 * 体检发现的修复动作。
 *
 * 三条硬规矩：
 *  1. **改之前先备份** —— 原文写到 %APPDATA%\devkit\backup\，文件名带时间戳
 *  2. **改完复验** —— 重新读一遍确认写入生效，而不是"写完就当成功"
 *  3. **危险结果拒绝执行** —— 比如算出来的新 PATH 是空的，直接拒绝而不是写进去
 *
 * 用户级修复直接做；机器级修复走提权助手（一次 UAC）。
 */

function backupFile(kind: string, content: string): string {
  const file = join(getBackupDir(), `${kind}-${timestampSlug()}.txt`)
  writeFileSync(file, content, 'utf8')
  logger.info('doctor', `已备份 ${kind} 原文：${file}`)
  return file
}

/** 清理用户级 PATH：只删重复/不存在/畸形/未解析变量的条目 */
async function cleanUserPath(): Promise<DoctorFixResult> {
  const raw = await readUserPath()
  const analysis = analyzePath(raw, { exists: existsSync, env: process.env })

  if (!analysis.changed) {
    return { ok: true, changed: [], backupFile: null, error: null }
  }
  if (analysis.suggested.trim() === '') {
    return {
      ok: false,
      changed: [],
      backupFile: null,
      error: '清理后用户 PATH 会变成空值，已拒绝执行。请手工检查（原文已保留）'
    }
  }

  const file = backupFile('user-path', raw)
  await writeUserPath(analysis.suggested)

  // 复验：重新读一遍，确认真的写进去了
  const after = await readUserPath()
  if (after !== analysis.suggested) {
    return {
      ok: false,
      changed: [],
      backupFile: file,
      error: '写入后复验不一致，可能被其它程序改回去了。原文已备份，请手工确认'
    }
  }

  const removed = analysis.problems.map((entry) => `第 ${entry.index} 条：${entry.raw} —— ${entry.reason}`)
  logger.info('doctor', `用户 PATH 已清理：移除 ${analysis.problems.length} 条`)
  return { ok: true, changed: removed, backupFile: file, error: null }
}

/** 清理机器级 PATH（需要管理员） */
async function cleanMachinePath(): Promise<DoctorFixResult> {
  const raw = await readMachinePath()
  const analysis = analyzePath(raw, { exists: existsSync, env: process.env })

  if (!analysis.changed) {
    return { ok: true, changed: [], backupFile: null, error: null }
  }
  if (analysis.suggested.trim() === '') {
    return {
      ok: false,
      changed: [],
      backupFile: null,
      error: '清理后机器级 PATH 会变成空值，已拒绝执行。请手工检查'
    }
  }

  const file = backupFile('machine-path', raw)
  const outcome = await runElevated([
    toMachinePathStep(`清理机器级 PATH（移除 ${analysis.problems.length} 条无效条目）`, analysis.suggested)
  ])

  if (!outcome.ok) {
    return {
      ok: false,
      changed: [],
      backupFile: file,
      error: outcome.cancelled ? '用户取消了管理员授权' : (outcome.error ?? '写入机器级 PATH 失败')
    }
  }

  const after = await readMachinePath()
  if (after !== analysis.suggested) {
    return {
      ok: false,
      changed: [],
      backupFile: file,
      error: '写入后复验不一致。原文已备份，请手工确认'
    }
  }

  const removed = analysis.problems.map((entry) => `第 ${entry.index} 条：${entry.raw} —— ${entry.reason}`)
  logger.info('doctor', `机器级 PATH 已清理：移除 ${analysis.problems.length} 条`)
  return { ok: true, changed: removed, backupFile: file, error: null }
}

/** 清理 devkit 残留：悬空的激活记录、指向不存在的版本的 junction、没人管的 PATH 条目 */
async function pruneDevkitState(): Promise<DoctorFixResult> {
  const changed: string[] = []
  let backup: string | null = null

  const state = readActivationState()
  for (const record of state.records) {
    if (existsSync(record.target)) continue

    const outcome = await deactivateTool(record.toolId)
    changed.push(
      `移除悬空激活记录：${record.toolId}@${record.version}（目标 ${record.target} 已不存在）` +
        (outcome.error ? `，但取消激活时报错：${outcome.error}` : '')
    )
  }

  // 再扫一遍用户 PATH：还有 devkit 目录下的条目、但没有任何记录认领它们
  const stillState = readActivationState()
  const managed = new Set(
    stillState.records.flatMap((record) => record.pathEntries.map((entry) => entry.toLowerCase()))
  )
  const raw = await readUserPath()
  const analysis = analyzePath(raw, { exists: existsSync, env: process.env })
  const orphans = analysis.entries.filter((entry) => {
    const lowered = entry.raw.toLowerCase()
    const isDevkitEntry = lowered.includes('.devkit') || lowered.includes('%devkit_home%')
    return isDevkitEntry && !managed.has(lowered)
  })

  if (orphans.length > 0) {
    backup = backupFile('user-path', raw)
    const cleaned = analysis.entries
      .filter((entry) => !orphans.some((orphan) => orphan.index === entry.index))
      .map((entry) => entry.raw)
      .join(';')

    if (cleaned.trim() === '') {
      return {
        ok: false,
        changed,
        backupFile: backup,
        error: '清理后用户 PATH 会变成空值，已拒绝执行'
      }
    }

    await writeUserPath(cleaned)
    for (const orphan of orphans) {
      changed.push(`移除无人认领的 devkit PATH 条目：${orphan.raw}`)
    }
  }

  // 切换链接目录里如果有指向不存在目标的链接，一并清掉
  for (const record of stillState.records) {
    const linkPath = getLinkPath(record.linkName)
    if (existsSync(linkPath) && !existsSync(record.target)) {
      if (removeJunction(linkPath)) changed.push(`移除悬空切换链接：${linkPath}`)
    }
  }

  if (changed.length === 0) {
    return { ok: true, changed: [], backupFile: null, error: null }
  }
  logger.info('doctor', `devkit 残留已清理：${changed.length} 项`)
  return { ok: true, changed, backupFile: backup, error: null }
}

export async function applyDoctorFix(fixId: DoctorFixId): Promise<DoctorFixResult> {
  try {
    switch (fixId) {
      case 'clean-user-path':
        return await cleanUserPath()
      case 'clean-machine-path':
        return await cleanMachinePath()
      case 'prune-devkit-state':
        return await pruneDevkitState()
      default:
        return { ok: false, changed: [], backupFile: null, error: `未知的修复项：${String(fixId)}` }
    }
  } catch (error) {
    const message = (error as Error).message
    logger.error('doctor', `修复 ${fixId} 失败：${message}`)
    return { ok: false, changed: [], backupFile: null, error: message }
  }
}
