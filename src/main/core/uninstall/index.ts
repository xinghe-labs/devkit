import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledTool, ToolManifest, UninstallResult } from '@shared/types'
import { getVersionsRoot } from '../../utils/app-paths'
import { logger } from '../report/logger'
import { deactivateTool, getActivatedVersion, getLinkPath, removeJunction } from '../activate'
import { directorySize, removeInstallDir } from '../providers/direct'

/**
 * 已安装项列表与卸载（FR-16）。
 *
 * 一条硬性边界：**只卸载 devkit 自己装的东西**。
 * 判断依据是「版本目录在 %USERPROFILE%\.devkit\versions\<tool>\<version>\ 下」，
 * 而不是"PATH 上有这个命令"——后者会诱导用户把系统里原有的 Node/Java 一起删掉。
 *
 * 卸载语义是「只卸载不回滚」：删掉版本目录、取消激活、移除 PATH 与环境变量。
 * 不会去猜某个工具是不是还在别处有系统级安装。
 */

// 版本目录名：数字或字母开头都接受（rust 的版本标签来自 rustup 自己的版本号）
const VERSION_DIR = /^[0-9A-Za-z][\w.+-]{0,39}$/

/** 列出一个工具目录下的版本目录；不是目录或读不到就返回 null */
function listVersionDirs(toolDir: string): string[] | null {
  try {
    if (!statSync(toolDir).isDirectory()) return null
    return readdirSync(toolDir).filter((name) => VERSION_DIR.test(name))
  } catch {
    return null
  }
}

function birthTimeOf(dir: string): string | null {
  try {
    return statSync(dir).birthtime.toISOString()
  } catch {
    return null
  }
}

export function listInstalled(tools: ToolManifest[]): InstalledTool[] {
  const root = getVersionsRoot()
  if (!existsSync(root)) return []

  const result: InstalledTool[] = []
  const byId = new Map(tools.map((tool) => [tool.id, tool]))

  for (const toolId of readdirSync(root)) {
    const toolDir = join(root, toolId)
    const versions = listVersionDirs(toolDir)
    if (versions === null) continue

    const tool = byId.get(toolId)
    const activated = getActivatedVersion(toolId)

    for (const version of versions) {
      const installDir = join(toolDir, version)
      const spec = tool?.versions.find((item) => item.version === version)
      result.push({
        toolId,
        version,
        installDir,
        sizeBytes: 0,
        installedAt: birthTimeOf(installDir),
        active: activated === version,
        activatable: Boolean(spec?.activate)
      })
    }
  }

  return result.sort((a, b) => a.toolId.localeCompare(b.toolId) || a.version.localeCompare(b.version))
}

/** 带体积统计的版本（体积统计要遍历目录，比较慢，单独提供） */
export async function listInstalledWithSize(tools: ToolManifest[]): Promise<InstalledTool[]> {
  const items = listInstalled(tools)
  for (const item of items) {
    item.sizeBytes = await directorySize(item.installDir)
  }
  return items
}

export async function uninstallVersion(
  toolId: string,
  version: string,
  versionsRoot: string = getVersionsRoot()
): Promise<UninstallResult> {
  const removed: string[] = []

  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(toolId)) {
    return { ok: false, removed, error: `工具 id 不合法：${toolId}` }
  }
  if (!VERSION_DIR.test(version)) {
    return { ok: false, removed, error: `版本号不合法：${version}` }
  }

  const installDir = join(versionsRoot, toolId, version)
  if (!existsSync(installDir)) {
    return { ok: false, removed, error: `没有找到已安装的 ${toolId}@${version}` }
  }

  try {
    // 如果卸载的正是当前激活的版本，先取消激活（否则 PATH 会指向不存在的目录）
    if (getActivatedVersion(toolId) === version) {
      const deactivated = await deactivateTool(toolId)
      if (deactivated.error) {
        logger.warn('uninstall', `取消激活失败（继续删除文件）：${deactivated.error}`)
      }
      removed.push(...deactivated.removed)
    } else {
      // 非激活版本：junction 指向别处，不动它
    }

    await removeInstallDir(installDir, versionsRoot)
    removed.push(`安装目录 ${installDir}`)

    // 版本目录空了就把工具目录一起收掉，避免留下空壳
    try {
      const toolDir = join(versionsRoot, toolId)
      if (readdirSync(toolDir).length === 0) {
        const { rmSync } = await import('node:fs')
        rmSync(toolDir, { recursive: true, force: true })
        removed.push(`空目录 ${toolDir}`)
      }
    } catch {
      // 收尾失败不影响卸载结论
    }

    logger.info('uninstall', `已卸载 ${toolId}@${version}：${removed.join('；')}`)
    return { ok: true, removed, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('uninstall', `卸载 ${toolId}@${version} 失败：${message}`)
    return { ok: false, removed, error: message }
  }
}

/** 清掉指向不存在目录的 junction（诊断/修复用） */
export function pruneDanglingLinks(toolIds: string[]): string[] {
  const pruned: string[] = []
  const root = getVersionsRoot()
  for (const toolId of toolIds) {
    const activated = getActivatedVersion(toolId)
    if (!activated) continue
    const target = join(root, toolId, activated)
    if (!existsSync(target)) {
      if (removeJunction(getLinkPath(toolId))) pruned.push(toolId)
    }
  }
  return pruned
}
