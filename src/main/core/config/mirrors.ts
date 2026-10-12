import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MirrorApplyResult, MirrorSetting, MirrorTarget } from '@shared/types'
import { ensureDir } from '../../utils/fs'
import { logger } from '../report/logger'

/**
 * 镜像源配置（FR-5）。
 *
 * 刻意不走 `npm config set` / `pip config set`：
 *  · 这两个命令要求对应工具**已经装好且在 PATH 上**，而 devkit 的典型场景恰恰是「什么都还没装」
 *  · 直接写配置文件是幂等的，失败可定位，也不需要拉起子进程
 *
 * 两个目标：
 *  · npm → %USERPROFILE%\.npmrc
 *  · pip → %APPDATA%\pip\pip.ini
 *
 * 写之前一律先备份原文件，并保留文件里其它行（用户可能还有 token、proxy 等设置）。
 */

export function npmrcPath(): string {
  return join(homedir(), '.npmrc')
}

export function pipIniPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'pip', 'pip.ini')
}

/** 把 "registry=..." 这一行替换掉；没有就追加。其它行原样保留。 */
export function upsertIniValue(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/)
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i')
  let replaced = false

  const next = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true
      return `${key}=${value}`
    }
    return line
  })

  if (!replaced) {
    // 去掉结尾多余空行再追加，避免文件越写越长
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
    next.push(`${key}=${value}`)
    next.push('')
  }

  return next.join('\n')
}

/** 在 INI 的某个 section 下写入 key；section 不存在就创建 */
export function upsertIniSectionValue(
  content: string,
  section: string,
  key: string,
  value: string
): string {
  const lines = content.split(/\r?\n/)
  const header = `[${section}]`
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase() === header.toLowerCase())

  if (headerIndex === -1) {
    const base = content.trim() === '' ? [] : content.trimEnd().split(/\r?\n/)
    base.push(header, `${key} = ${value}`, '')
    return base.join('\n')
  }

  // 找到该 section 的范围
  let end = lines.length
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }

  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i')
  for (let i = headerIndex + 1; i < end; i += 1) {
    if (keyPattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`
      return lines.join('\n')
    }
  }

  lines.splice(headerIndex + 1, 0, `${key} = ${value}`)
  return lines.join('\n')
}

function readIfExists(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function backupOnce(file: string): string | null {
  if (!existsSync(file)) return null
  const backup = `${file}.devkit-backup`
  if (existsSync(backup)) return backup
  try {
    writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
    return backup
  } catch {
    return null
  }
}

function writeFileEnsured(file: string, content: string): void {
  ensureDir(dirname(file))
  writeFileSync(file, content, 'utf8')
}

/** 读当前生效的镜像（用于设置页回显） */
export function readCurrentMirrors(): Record<MirrorTarget, string | null> {
  const npmContent = readIfExists(npmrcPath())
  const npmMatch = npmContent.match(/^\s*registry\s*=\s*(.+)$/im)

  const pipContent = readIfExists(pipIniPath())
  const pipMatch = pipContent.match(/^\s*index-url\s*=\s*(.+)$/im)

  return {
    npm: npmMatch ? npmMatch[1].trim() : null,
    pip: pipMatch ? pipMatch[1].trim() : null
  }
}

/**
 * 应用镜像设置。enabled=false 的目标会被移除对应配置行（回到官方源）。
 * 只改 registry / index-url 这两个键，绝不整文件覆盖。
 */
export function applyMirrors(settings: MirrorSetting[]): MirrorApplyResult {
  const changed: string[] = []
  const backupFiles: string[] = []

  try {
    const npm = settings.find((item) => item.target === 'npm')
    if (npm) {
      const file = npmrcPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (npm.enabled && npm.url) {
        writeFileEnsured(file, upsertIniValue(content, 'registry', npm.url))
        changed.push(`npm registry → ${npm.url}`)
      } else if (/^\s*registry\s*=/im.test(content)) {
        // 关掉镜像 = 删掉这一行，让 npm 回到官方源
        const stripped = content
          .split(/\r?\n/)
          .filter((line) => !/^\s*registry\s*=/i.test(line))
          .join('\n')
        writeFileEnsured(file, stripped)
        changed.push('npm registry → 官方源（已移除自定义 registry）')
      }
    }

    const pip = settings.find((item) => item.target === 'pip')
    if (pip) {
      const file = pipIniPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (pip.enabled && pip.url) {
        writeFileEnsured(file, upsertIniSectionValue(content, 'global', 'index-url', pip.url))
        changed.push(`pip index-url → ${pip.url}`)
      } else if (/^\s*index-url\s*=/im.test(content)) {
        const stripped = content
          .split(/\r?\n/)
          .filter((line) => !/^\s*index-url\s*=/i.test(line))
          .join('\n')
        writeFileEnsured(file, stripped)
        changed.push('pip index-url → 官方源（已移除自定义 index-url）')
      }
    }

    logger.info('mirrors', `镜像配置已应用：${changed.join('；') || '无变化'}`)
    return { ok: true, changed, backupFiles, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('mirrors', `应用镜像配置失败：${message}`)
    return { ok: false, changed, backupFiles, error: message }
  }
}
