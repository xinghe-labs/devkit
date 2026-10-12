import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SystemConfigItem, SystemConfigRequest, SystemConfigResult } from '@shared/types'
import { runCommand } from '../../utils/exec'
import { getCurrentRoot } from '../../utils/app-paths'
import { runElevated, toExecStep } from '../elevation'
import { logger } from '../report/logger'

/**
 * 系统配置（FR-6）。
 *
 * 原则：**能用户级做的绝不提权**。
 *  · git 身份、SSH key、PowerShell 执行策略 → 用户级，直接做
 *  · 长路径、开发者模式 → 写 HKLM，必须提权，走提权助手（会弹一次 UAC）
 *
 * 每一项都先「读」再「写」：状态要能独立查询，用户才知道自己缺什么。
 */

const REG_LONG_PATHS = {
  path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
  name: 'LongPathsEnabled'
}

const REG_DEV_MODE = {
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

async function readRegistryValue(path: string, name: string): Promise<number | null> {
  const result = await runCommand('reg.exe', ['query', path, '/v', name])
  if (result.code !== 0) return null
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i'))
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return Number.isFinite(value) ? value : null
}

async function readGitConfig(key: string): Promise<string | null> {
  const result = await runCommand(resolveGit(), ['config', '--global', '--get', key], {
    timeoutMs: 15_000
  })
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

/** 查询当前各项系统配置的状态（只读，不产生副作用） */
export async function getSystemConfigStatus(): Promise<SystemConfigItem[]> {
  const items: SystemConfigItem[] = []

  // 1. git 身份
  const [gitName, gitEmail] = await Promise.all([
    readGitConfig('user.name'),
    readGitConfig('user.email')
  ])
  items.push({
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

  // 2. PowerShell 执行策略（用户级）
  const policy = await runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-ExecutionPolicy -Scope CurrentUser).ToString()'
  ])
  const policyValue = policy.stdout.trim()
  items.push({
    id: 'powershell-policy',
    label: { 'zh-CN': 'PowerShell 执行策略', 'en-US': 'PowerShell execution policy' },
    requiresAdmin: false,
    configured: /RemoteSigned|Unrestricted|Bypass/i.test(policyValue),
    detail: policyValue || '未知',
    hint: {
      'zh-CN': '很多脚手架脚本（npm、pnpm 的 .ps1）需要 RemoteSigned，否则会被拒绝执行',
      'en-US': 'Many toolchain scripts (npm/pnpm .ps1) need RemoteSigned or they refuse to run'
    }
  })

  // 3. 长路径（HKLM，需要管理员）
  const longPaths = await readRegistryValue(REG_LONG_PATHS.path, REG_LONG_PATHS.name)
  items.push({
    id: 'long-paths',
    label: { 'zh-CN': '长路径支持', 'en-US': 'Long path support' },
    requiresAdmin: true,
    configured: longPaths === 1,
    detail: longPaths === null ? '读不到（可能需要管理员）' : longPaths === 1 ? '已启用' : '未启用',
    hint: {
      'zh-CN': '深层 node_modules 很容易超过 260 字符，不开长路径会随机报"路径过长"',
      'en-US': 'Deep node_modules easily exceed 260 chars; without this you get random path-too-long errors'
    }
  })

  // 4. 开发者模式（HKLM，需要管理员）
  const devMode = await readRegistryValue(REG_DEV_MODE.path, REG_DEV_MODE.name)
  items.push({
    id: 'developer-mode',
    label: { 'zh-CN': '开发者模式', 'en-US': 'Developer mode' },
    requiresAdmin: true,
    configured: devMode === 1,
    detail: devMode === null ? '读不到（可能需要管理员）' : devMode === 1 ? '已启用' : '未启用',
    hint: {
      'zh-CN': '允许创建符号链接、启用设备门户，前端与容器相关工具常用',
      'en-US': 'Allows symlink creation and Device Portal — commonly needed by frontend and container tooling'
    }
  })

  // 5. SSH key
  const keyPath = join(sshDir(), 'id_ed25519')
  const hasKey = existsSync(keyPath)
  items.push({
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

  return items
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
        if (!/^[^\s<>"\n@]+@[^\s<>"\n@]+\.[^\s<>"\n@]+$/.test(email)) throw new Error('user.email 格式不正确')

        const git = resolveGit()
        for (const [key, value] of [
          ['user.name', name],
          ['user.email', email]
        ] as const) {
          const result = await runCommand(git, ['config', '--global', key, value], { timeoutMs: 15_000 })
          if (result.code !== 0) {
            throw new Error(`git config ${key} 失败：${result.stderr.trim() || result.spawnError || result.code}`)
          }
        }
        logger.info('system', `Git 身份已设置为 ${name} <${email}>`)
        return { ok: true, detail: `${name} <${email}>`, error: null, requiresAdmin: false }
      }

      case 'powershell-policy': {
        const result = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-Command', "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force"],
          { timeoutMs: 30_000 }
        )
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.spawnError || `退出码 ${result.code}`)
        }
        logger.info('system', 'PowerShell 执行策略已设为 CurrentUser RemoteSigned')
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
        return { ok: true, detail: target, error: null, requiresAdmin: false }
      }

      case 'long-paths':
      case 'developer-mode': {
        const target = id === 'long-paths' ? REG_LONG_PATHS : REG_DEV_MODE
        const outcome = await runElevated([
          toExecStep(`启用 ${id}`, {
            cmd: 'reg.exe',
            args: ['add', target.path.replace(/^HKLM:\\/, 'HKLM\\'), '/v', target.name, '/t', 'REG_DWORD', '/d', '1', '/f'],
            requiresAdmin: true
          })
        ])
        if (!outcome.ok) {
          throw new Error(
            outcome.cancelled ? '用户取消了管理员授权' : (outcome.error ?? '注册表写入失败')
          )
        }
        logger.info('system', `已启用 ${id}`)
        return {
          ok: true,
          detail: `${target.name} = 1（部分程序需要重启才能感知）`,
          error: null,
          requiresAdmin: true
        }
      }

      default:
        throw new Error(`未知的系统配置项：${String(id)}`)
    }
  } catch (error) {
    const message = (error as Error).message
    logger.warn('system', `应用系统配置 ${String(id)} 失败：${message}`)
    return { ok: false, detail: null, error: message, requiresAdmin: id === 'long-paths' || id === 'developer-mode' }
  }
}
