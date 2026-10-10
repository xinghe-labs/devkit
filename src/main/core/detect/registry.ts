import { runCommand } from '../../utils/exec'
import { logger } from '../report/logger'
import { parseRegQueryOutput, type InstalledProgram } from './registry-parse'

/**
 * 扫描已安装程序（注册表 Uninstall 项）。
 *
 * 只扫 4 个标准位置，一次扫完缓存起来 —— 12 个清单各自去查注册表会慢到无法接受。
 * 这份数据后面 FR-16（卸载）也会复用，因为它同时带出了 UninstallString。
 */
const UNINSTALL_KEYS = [
  { hive: 'HKLM', view: '64', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  {
    hive: 'HKLM',
    view: '32',
    path: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  },
  { hive: 'HKCU', view: '64', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  {
    hive: 'HKCU',
    view: '32',
    path: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  }
] as const

let cache: InstalledProgram[] | null = null

export async function getInstalledPrograms(force = false): Promise<InstalledProgram[]> {
  if (cache && !force) return cache

  const collected: InstalledProgram[] = []
  const startedAt = Date.now()

  for (const key of UNINSTALL_KEYS) {
    const result = await runCommand(
      'reg.exe',
      ['query', `${key.hive}\\${key.path}`, '/s', `/reg:${key.view}`],
      { timeoutMs: 30_000 }
    )

    if (result.spawnError) {
      logger.warn('detect', `注册表扫描失败（${key.hive}\\${key.path}）：${result.spawnError}`)
      continue
    }
    // 键不存在时 reg.exe 返回 1，属于正常情况
    if (result.code !== 0) {
      logger.debug('detect', `注册表键不存在或不可读：${key.hive}\\${key.path}`)
      continue
    }

    const parsed = parseRegQueryOutput(result.stdout, key.hive, key.view)
    for (const program of parsed) {
      if (program.fields.DisplayName) collected.push(program)
    }
  }

  cache = collected
  logger.info(
    'detect',
    `注册表扫描完成：${collected.length} 个已安装程序，耗时 ${Date.now() - startedAt}ms`
  )
  return collected
}

export function clearRegistryCache(): void {
  cache = null
}
