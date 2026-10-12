import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SystemConfigId, SystemConfigItem, SystemConfigRequest, SystemConfigResult } from '@shared/types'
import { runCommand } from '../../utils/exec'
import { getCurrentRoot } from '../../utils/app-paths'
import { runElevated, toExecStep } from '../elevation'
import { logger } from '../report/logger'
import {
  clearBackupEntry,
  getBackupEntry,
  recordBackup,
  type GitConfigBackupEntry
} from './backup'
import { isMissingValueError, readRegDword, regDeleteArgs, regDwordAddArgs, toRegPath } from './registry'

/**
 * 系统配置（FR-6）。
 *
 * 原则：**能用户级做的绝不提权**。
 *  · git 身份、SSH key、PowerShell 执行策略 → 用户级，直接做
 *  · 长路径、开发者模式 → 写 HKLM，必须提权，走提权助手（会弹一次 UAC）
 *
 * 每一项都先「读」再「写」：状态要能独立查询，用户才知道自己缺什么。
 *
 * **P1-2 起：改之前先记账，能精确还原。**
 * 详见 `backup.ts`。规矩是「读不到就不改」—— 备份不了的东西不碰。
 */

const REG_LONG_PATHS = {
  id: 'long-paths' as const,
  path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
  name: 'LongPathsEnabled'
}

const REG_DEV_MODE = {
  id: 'developer-mode' as const,
  path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock',
  name: 'AllowDevelopmentWithoutDevLicense'
}

/** 优先用 devkit 自己激活的那份 git，其次是 PATH 上的 */
function resolveGit(): string {
  const activated = join(getCurrentRoot(), 'git', 'cmd', 'git.exe')
  if (existsSync(activated)) return activated
  return 'git'
}

function resolveSshKeygen(): string {
  const fromGit = join(getCurrentRoot(), 'git', 'usr', 'bin', 'ssh-keygen.exe')
  if (existsSync(fromGit)) return fromGit
  return 'ssh-keygen'
}

function sshDir(): string {
  return join(homedir(), '.ssh')
}

async function readGitConfig(key: string): Promise<string | null> {
  const result = await runCommand(resolveGit(), ['config', '--global', '--get', key], {
    timeoutMs: 15_000
  })
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

/**
 * 读 PowerShell 当前用户作用域的执行策略。
 *
 * 这台机器的 `Microsoft.PowerShell.Security` 模块不完整，`Get-ExecutionPolicy`
 * 直接报错。读不到就是读不到，**返回 null 而不是猜一个值** —— 因为备份要拿它当原值。
 */
async function readExecutionPolicy(): Promise<string | null> {
  const result = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-Command', '(Get-ExecutionPolicy -Scope CurrentUser).ToString()'],
    { timeoutMs: 20_000 }
  )
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

/** 查询当前各项系统配置的状态（只读，不产生副作用） */
export async function getSystemConfigStatus(): Promise<SystemConfigItem[]> {
  const items: SystemConfigItem[] = []

  /** 把「有没有被 devkit 改过」挂到条目上，界面据此显示"可还原" */
  const withBackup = (
    item: Omit<SystemConfigItem, 'devkitModified' | 'backupAt' | 'revertible'>
  ): SystemConfigItem => {
    const entry = getBackupEntry(item.id)
    return {
      ...item,
      devkitModified: Boolean(entry),
      backupAt: entry?.backedUpAt ?? null,
      // SSH 密钥不提供还原：私钥可能已经用于 GitHub/GitLab，删掉是破坏性操作
      revertible: Boolean(entry) && item.id !== 'ssh-key'
    }
  }

  // 1. git 身份
  const [gitName, gitEmail] = await Promise.all([
    readGitConfig('user.name'),
    readGitConfig('user.email')
  ])
  items.push(
    withBackup({
      id: 'git-identity',
      label: { 'zh-CN': 'Git 身份', 'en-US': 'Git identity' },
      requiresAdmin: false,
      configured: Boolean(gitName && gitEmail),
      detail:
        gitName && gitEmail
          ? `${gitName} <${gitEmail}>`
          : gitName || gitEmail
            ? '只配了一半（name 或 email 缺失）'
            : '未配置',
      hint: {
        'zh-CN': '写 ~/.gitconfig 的 user.name 与 user.email，提交记录才会显示你的名字',
        'en-US': 'Writes user.name and user.email to ~/.gitconfig so commits show your name'
      }
    })
  )

  // 2. PowerShell 执行策略（用户级）
  const policyValue = await readExecutionPolicy()
  items.push(
    withBackup({
      id: 'powershell-policy',
      label: { 'zh-CN': 'PowerShell 执行策略', 'en-US': 'PowerShell execution policy' },
      requiresAdmin: false,
      configured: policyValue !== null && /RemoteSigned|Unrestricted|Bypass/i.test(policyValue),
      detail:
        policyValue === null
          ? '读不到（PowerShell 的 Security 模块可能不完整）'
          : policyValue,
      hint: {
        'zh-CN': '很多脚手架脚本（npm、pnpm 的 .ps1）需要 RemoteSigned，否则会被拒绝执行',
        'en-US': 'Many toolchain scripts (npm/pnpm .ps1) need RemoteSigned or they refuse to run'
      }
    })
  )

  // 3. 长路径（HKLM，需要管理员）
  const longPaths = await readRegDword(REG_LONG_PATHS.path, REG_LONG_PATHS.name)
  items.push(
    withBackup({
      id: 'long-paths',
      label: { 'zh-CN': '长路径支持', 'en-US': 'Long path support' },
      requiresAdmin: true,
      configured: longPaths.value === 1,
      detail: !longPaths.valueExists
        ? '未启用（该值不存在）'
        : longPaths.value === 1
          ? '已启用'
          : '未启用',
      hint: {
        'zh-CN': '深层 node_modules 很容易超过 260 字符，不开长路径会随机报"路径过长"',
        'en-US': 'Deep node_modules easily exceed 260 chars; without this you get random path-too-long errors'
      }
    })
  )

  // 4. 开发者模式（HKLM，需要管理员）
  const devMode = await readRegDword(REG_DEV_MODE.path, REG_DEV_MODE.name)
  items.push(
    withBackup({
      id: 'developer-mode',
      label: { 'zh-CN': '开发者模式', 'en-US': 'Developer mode' },
      requiresAdmin: true,
      configured: devMode.value === 1,
      detail: !devMode.valueExists ? '未启用（该值不存在）' : devMode.value === 1 ? '已启用' : '未启用',
      hint: {
        'zh-CN': '允许创建符号链接、启用设备门户，前端与容器相关工具常用',
        'en-US': 'Allows symlink creation and Device Portal — commonly needed by frontend and container tooling'
      }
    })
  )

  // 5. SSH key
  const keyPath = join(sshDir(), 'id_ed25519')
  const hasKey = existsSync(keyPath)
  items.push(
    withBackup({
      id: 'ssh-key',
      label: { 'zh-CN': 'SSH 密钥', 'en-US': 'SSH key' },
      requiresAdmin: false,
      configured: hasKey,
      detail: hasKey ? keyPath : '还没有 ed25519 密钥',
      hint: {
        'zh-CN': '生成 ~/.ssh/id_ed25519（无口令），用于 GitHub / GitLab 免密推送',
        'en-US': 'Generates ~/.ssh/id_ed25519 (no passphrase) for passwordless GitHub/GitLab pushes'
      }
    })
  )

  return items
}

/**
 * 写注册表值并**先记账**。
 *
 * 「读不到就不改」：拿不到原值就不动它 —— 备份不了的东西没有还原路径，
 * 而 devkit 的原则是可回退。
 */
async function setRegistryConfig(
  target: { id: SystemConfigId; path: string; name: string }
): Promise<SystemConfigResult> {
  const before = await readRegDword(target.path, target.name)
  if (!before.keyExists) {
    throw new Error(
      `读不到 ${toRegPath(target.path)}，无法备份原值。为避免"改了却回不去"，这里不继续。`
    )
  }

  // 已经是 1 就不用动，但账要记（否则用户看不到"可还原"）
  if (before.value === 1) {
    recordBackup({
      id: target.id,
      kind: 'registry',
      path: toRegPath(target.path),
      name: target.name,
      existed: before.valueExists,
      value: before.value,
      valueType: 'REG_DWORD',
      backedUpAt: new Date().toISOString()
    })
    return { ok: true, detail: `${target.name} 已经是 1，无需改动`, error: null, requiresAdmin: false }
  }

  const outcome = await runElevated([
    toExecStep(`启用 ${target.id}`, {
      cmd: 'reg.exe',
      args: regDwordAddArgs(target.path, target.name, 1),
      requiresAdmin: true
    })
  ])
  if (!outcome.ok) {
    throw new Error(outcome.cancelled ? '用户取消了管理员授权' : (outcome.error ?? '注册表写入失败'))
  }

  // 写成功了才记账 —— 没改成就别留还原点，免得界面显示"已修改"其实是假的
  recordBackup({
    id: target.id,
    kind: 'registry',
    path: toRegPath(target.path),
    name: target.name,
    existed: before.valueExists,
    value: before.value,
    valueType: 'REG_DWORD',
    backedUpAt: new Date().toISOString()
  })

  logger.info('system', `已启用 ${target.id}（原值：${before.valueExists ? before.value : '不存在'}）`)
  return {
    ok: true,
    detail: `${target.name} = 1（部分程序需要重启才能感知）`,
    error: null,
    requiresAdmin: true
  }
}

export async function applySystemConfig(request: SystemConfigRequest): Promise<SystemConfigResult> {
  const { id } = request

  try {
    switch (id) {
      case 'git-identity': {
        const name = (request.gitName ?? '').trim()
        const email = (request.gitEmail ?? '').trim()
        if (name === '' || email === '') throw new Error('user.name 与 user.email 都不能为空')
        if (!/^[^<>"\n]{1,80}$/.test(name)) throw new Error('user.name 含非法字符')
        if (!/^[^\s<>"\n@]+@[^\s<>"\n@]+\.[^\s<>"\n@]+$/.test(email))
          throw new Error('user.email 格式不正确')

        const git = resolveGit()

        // 记账要在写之前：先读原值
        const before = await Promise.all(
          ['user.name', 'user.email'].map(async (key) => {
            const value = await readGitConfig(key)
            return { key, existed: value !== null, value }
          })
        )

        for (const [key, value] of [
          ['user.name', name],
          ['user.email', email]
        ] as const) {
          const result = await runCommand(git, ['config', '--global', key, value], {
            timeoutMs: 15_000
          })
          if (result.code !== 0) {
            throw new Error(
              `git config ${key} 失败：${result.stderr.trim() || result.spawnError || result.code}`
            )
          }
        }

        const entry: GitConfigBackupEntry = {
          id: 'git-identity',
          kind: 'git-config',
          keys: before,
          backedUpAt: new Date().toISOString()
        }
        recordBackup(entry)

        logger.info('system', `Git 身份已设置为 ${name} <${email}>`)
        return { ok: true, detail: `${name} <${email}>`, error: null, requiresAdmin: false }
      }

      case 'powershell-policy': {
        const before = await readExecutionPolicy()
        if (before === null) {
          throw new Error(
            '读不到当前的执行策略（本机 PowerShell 的 Security 模块可能不完整），' +
              '无法备份原值，因此不改动。'
          )
        }

        const result = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-Command', "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force"],
          { timeoutMs: 30_000 }
        )
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.spawnError || `退出码 ${result.code}`)
        }

        recordBackup({
          id: 'powershell-policy',
          kind: 'execution-policy',
          scope: 'CurrentUser',
          existed: true,
          value: before,
          backedUpAt: new Date().toISOString()
        })

        logger.info('system', `PowerShell 执行策略已设为 CurrentUser RemoteSigned（原值：${before}）`)
        return { ok: true, detail: 'CurrentUser → RemoteSigned', error: null, requiresAdmin: false }
      }

      case 'ssh-key': {
        const dir = sshDir()
        const target = join(dir, 'id_ed25519')
        if (existsSync(target)) {
          return { ok: true, detail: `已存在：${target}`, error: null, requiresAdmin: false }
        }
        const result = await runCommand(
          resolveSshKeygen(),
          ['-t', 'ed25519', '-N', '', '-C', 'devkit', '-f', target],
          { timeoutMs: 60_000 }
        )
        if (result.code !== 0) {
          throw new Error(
            `ssh-keygen 失败：${result.stderr.trim() || result.spawnError || `退出码 ${result.code}`}。` +
              '若机器上没有 ssh-keygen，请先安装 Git（devkit 的 Git 清单自带 ssh-keygen）。'
          )
        }
        logger.info('system', `已生成 SSH 密钥：${target}`)
        // 刻意不记账：私钥可能已被用户用于 GitHub/GitLab，删掉是破坏性操作
        return {
          ok: true,
          detail: `${target}（私钥不提供自动删除，需要时请自行处理）`,
          error: null,
          requiresAdmin: false
        }
      }

      case 'long-paths':
        return await setRegistryConfig(REG_LONG_PATHS)

      case 'developer-mode':
        return await setRegistryConfig(REG_DEV_MODE)

      default:
        throw new Error(`未知的系统配置项：${String(id)}`)
    }
  } catch (error) {
    const message = (error as Error).message
    logger.warn('system', `应用系统配置 ${String(id)} 失败：${message}`)
    return {
      ok: false,
      detail: null,
      error: message,
      requiresAdmin: id === 'long-paths' || id === 'developer-mode'
    }
  }
}

/**
 * 还原某一项到 devkit 改动之前的样子（P1-2）。
 *
 * 三条硬规矩，和体检的修复一致：
 *  1. 没有备份记录就不动手（不知道原值就谈不上还原）
 *  2. 还原完**重新读一遍复验**，对不上就报错
 *  3. 成功后才销账
 */
export async function revertSystemConfig(id: SystemConfigId): Promise<SystemConfigResult> {
  try {
    if (id === 'ssh-key') {
      throw new Error('SSH 私钥不提供自动还原：它可能已经用于 GitHub / GitLab，删除是破坏性操作')
    }

    const entry = getBackupEntry(id)
    if (!entry) {
      throw new Error('这一项没有 devkit 的备份记录，无法还原（可能不是 devkit 改的）')
    }

    switch (entry.kind) {
      case 'registry': {
        const outcome = await runElevated([
          toExecStep(`还原 ${entry.id}`, {
            cmd: 'reg.exe',
            args: entry.existed
              ? regDwordAddArgs(entry.path, entry.name, entry.value ?? 0)
              : regDeleteArgs(entry.path, entry.name),
            requiresAdmin: true
          })
        ])
        if (!outcome.ok) {
          // 「原本不存在」时删值失败是预期结果：说明本来就是干净的
          const detail = outcome.error ?? ''
          if (!entry.existed && isMissingValueError(detail)) {
            clearBackupEntry(id)
            return { ok: true, detail: `${entry.name} 原本就不存在，已确认干净`, error: null, requiresAdmin: true }
          }
          throw new Error(outcome.cancelled ? '用户取消了管理员授权' : (detail || '注册表还原失败'))
        }

        const after = await readRegDword(entry.path, entry.name)
        const matched = entry.existed ? after.value === entry.value : !after.valueExists
        if (!matched) {
          throw new Error(
            `还原后复验不通过：期望 ${entry.existed ? `${entry.name}=${entry.value}` : `${entry.name} 不存在`}，` +
              `实际 ${after.valueExists ? `${entry.name}=${after.value}` : '不存在'}`
          )
        }

        clearBackupEntry(id)
        logger.info('system', `已还原 ${id}（${entry.existed ? `${entry.name}=${entry.value}` : '删除该值'}）`)
        return {
          ok: true,
          detail: entry.existed ? `${entry.name} 已还原为 ${entry.value}` : `${entry.name} 已删除（原本不存在）`,
          error: null,
          requiresAdmin: true
        }
      }

      case 'git-config': {
        const git = resolveGit()
        for (const item of entry.keys) {
          const args = item.existed
            ? ['config', '--global', item.key, item.value ?? '']
            : ['config', '--global', '--unset', item.key]
          const result = await runCommand(git, args, { timeoutMs: 15_000 })
          // --unset 一个不存在的 key 会返回 5，这是预期结果
          if (result.code !== 0 && !(result.code === 5 && !item.existed)) {
            throw new Error(
              `git config ${item.key} 还原失败：${result.stderr.trim() || result.spawnError || result.code}`
            )
          }
        }

        for (const item of entry.keys) {
          const after = await readGitConfig(item.key)
          const matched = item.existed ? after === item.value : after === null
          if (!matched) {
            throw new Error(`还原后复验不通过：${item.key} 期望 ${item.value ?? '(不存在)'}，实际 ${after ?? '(不存在)'}`)
          }
        }

        clearBackupEntry(id)
        logger.info('system', 'Git 身份已还原')
        return { ok: true, detail: 'Git 身份已还原到 devkit 改动之前', error: null, requiresAdmin: false }
      }

      case 'execution-policy': {
        const result = await runCommand(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Set-ExecutionPolicy -Scope ${entry.scope} ${entry.value ?? 'Undefined'} -Force`
          ],
          { timeoutMs: 30_000 }
        )
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.spawnError || `退出码 ${result.code}`)
        }

        const after = await readExecutionPolicy()
        if (after !== entry.value) {
          throw new Error(`还原后复验不通过：期望 ${entry.value}，实际 ${after ?? '(读不到)'}`)
        }

        clearBackupEntry(id)
        logger.info('system', `PowerShell 执行策略已还原为 ${entry.value}`)
        return { ok: true, detail: `执行策略已还原为 ${entry.value}`, error: null, requiresAdmin: false }
      }

      default:
        throw new Error(`不支持还原的记录类型：${String((entry as { kind?: string }).kind)}`)
    }
  } catch (error) {
    const message = (error as Error).message
    logger.warn('system', `还原系统配置 ${String(id)} 失败：${message}`)
    return {
      ok: false,
      detail: null,
      error: message,
      requiresAdmin: id === 'long-paths' || id === 'developer-mode'
    }
  }
}

/** 供「体检」复用的只读读取器 */
export const __testing = { readGitConfig, readExecutionPolicy, REG_LONG_PATHS, REG_DEV_MODE }
