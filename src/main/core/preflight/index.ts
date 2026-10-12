import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { arch as osArch, release as osRelease } from 'node:os'
import { parse as parsePath } from 'node:path'
import type { InstallPlan, PreflightCheck, PreflightResult, ToolManifest } from '@shared/types'
import { orderDownloadSources, type DownloadSourceRef } from '@shared/manifest'
import { requestStream } from '../downloader/http'
import { logger } from '../report/logger'

/**
 * 安装前预检（SPEC FR-18）。
 *
 * 目的是把所有"注定会失败"的原因一次性报完，而不是让用户在安装过程中逐个撞墙。
 * 所有检查都不产生副作用：网络检查用 HEAD，磁盘检查只读。
 */

/** Windows 10 22H2 的 build 号（SPEC 已确认的最低支持版本） */
export const MIN_WINDOWS_BUILD = 19045

/** 磁盘余量：下载体积的 2.5 倍 + 500 MB（解压后还会膨胀） */
export const DISK_HEADROOM_FACTOR = 2.5
export const DISK_HEADROOM_BYTES = 500 * 1024 * 1024

/**
 * 已知的互斥组合：同一台机器上只应装其中一个。
 * M2 扩充清单时继续往这里补。
 */
const CONFLICTS: [string, string][] = [['docker-desktop', 'podman']]

/** 从 os.release() 的 "10.0.26300" 里取出 build 号 */
export function parseWindowsBuild(release: string): number | null {
  const parts = release.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null
  return parts[2]
}

export function findConflicts(toolIds: string[]): string[] {
  const selected = new Set(toolIds)
  return CONFLICTS.filter(([a, b]) => selected.has(a) && selected.has(b)).map(
    ([a, b]) => `${a} 与 ${b} 功能重叠，同一台机器上建议只安装其中一个`
  )
}

export function computeRequiredBytes(totalDownloadBytes: number): number {
  return Math.ceil(totalDownloadBytes * DISK_HEADROOM_FACTOR) + DISK_HEADROOM_BYTES
}

export interface ProbeResult {
  source: string
  url: string
  reachable: boolean
  /** 源可达但文件不在（镜像未同步该版本） */
  missing: boolean
  detail: string
}

/** 用 HEAD 探测单个源：既判断可达性，也顺便发现"镜像没有这个版本" */
export async function probeSource(
  source: DownloadSourceRef,
  proxy: string | null
): Promise<ProbeResult> {
  try {
    const response = await requestStream(source.url, {
      method: 'HEAD',
      proxy,
      timeoutMs: 5000,
      maxRedirects: 3
    })
    response.stream.resume()
    response.stream.destroy()

    if (response.status === 404 || response.status === 410) {
      return {
        source: source.name,
        url: source.url,
        reachable: true,
        missing: true,
        detail: `HTTP ${response.status}（该源没有这个版本）`
      }
    }
    if (response.status === 403) {
      return {
        source: source.name,
        url: source.url,
        reachable: true,
        missing: true,
        detail: 'HTTP 403（拒绝访问）'
      }
    }
    if (response.status >= 500) {
      return {
        source: source.name,
        url: source.url,
        reachable: false,
        missing: false,
        detail: `HTTP ${response.status}（服务端错误）`
      }
    }
    return {
      source: source.name,
      url: source.url,
      reachable: true,
      missing: false,
      detail: `HTTP ${response.status}`
    }
  } catch (error) {
    return {
      source: source.name,
      url: source.url,
      reachable: false,
      missing: false,
      detail: (error as Error).message
    }
  }
}

export interface PreflightInput {
  plan: InstallPlan
  tools: Map<string, ToolManifest>
  /** 安装目录所在的盘，用来查剩余空间 */
  targetPath: string
  /** 探测时最多检查几个源（避免预检本身变成一堆网络请求）；0 表示跳过网络探测 */
  maxProbes?: number
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { plan, tools } = input
  const checks: PreflightCheck[] = []

  const totalDownloadBytes = plan.items.reduce((sum, item) => {
    const tool = tools.get(item.id)
    const version = tool?.versions.find((entry) => entry.version === item.version)
    return sum + (version?.sizeBytes ?? 0)
  }, 0)

  const requiresAdmin = plan.items.some((item) => item.requiresAdmin)

  // 1. 系统版本
  const build = parseWindowsBuild(osRelease())
  if (build === null) {
    checks.push({
      id: 'os-version',
      level: 'warn',
      message: `无法识别系统版本（os.release() = ${osRelease()}），跳过版本检查`
    })
  } else if (build < MIN_WINDOWS_BUILD) {
    checks.push({
      id: 'os-version',
      level: 'error',
      message: `系统版本过低：build ${build}，最低要求 build ${MIN_WINDOWS_BUILD}（Windows 10 22H2）`
    })
  } else {
    checks.push({
      id: 'os-version',
      level: 'ok',
      message: `系统版本满足要求（build ${build}）`
    })
  }

  // 2. 架构
  if (osArch() === 'x64') {
    checks.push({ id: 'arch', level: 'ok', message: '系统架构为 x64' })
  } else {
    checks.push({
      id: 'arch',
      level: 'error',
      message: `当前架构是 ${osArch()}，本版本只支持 x64`
    })
  }

  // 3. 磁盘空间
  try {
    const drive = parsePath(input.targetPath).root
    const stats = await statfs(drive)
    const free = stats.bavail * stats.bsize
    const required = computeRequiredBytes(totalDownloadBytes)
    const toMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`

    if (free < required) {
      checks.push({
        id: 'disk',
        level: 'error',
        message: `${drive} 剩余空间不足：可用 ${toMb(free)}，需要约 ${toMb(required)}`
      })
    } else {
      checks.push({
        id: 'disk',
        level: 'ok',
        message: `${drive} 剩余空间充足：可用 ${toMb(free)}，需要约 ${toMb(required)}`
      })
    }
  } catch (error) {
    checks.push({
      id: 'disk',
      level: 'warn',
      message: `无法读取磁盘剩余空间：${(error as Error).message}`
    })
  }

  // 4. 下载源可达性：每个工具按镜像偏好顺序探测前几个源。
  //    maxProbes 为 0 表示跳过网络探测（离线环境与单测用）
  //
  //    关键修正：**不能只看首选源**。实测 GitHub release 资产在国内经常完全连不上，
  //    但清单里的国内镜像好得很；如果只看首选源就报"所有源不可达"，用户会被硬生生拦住。
  //    因此这里对每个工具并行探多个源，只要有一个可用就算通过（并在日志里说明用了哪个）。
  const probeLimit = input.maxProbes ?? 3
  const perToolSources = 3
  const targets: { toolId: string; sources: DownloadSourceRef[] }[] = []
  const seenTools = new Set<string>()

  // 所有项都已经落在版本目录里时，本次运行根本不需要下载（执行器会自检后直接跳过）。
  // 这时候还去探网络、并且因为探测失败就整体阻断，是在拿一个"用不到的条件"拦住用户 ——
  // 实测过：GitHub 临时不可达时，重跑一个已经装好的工具会被预检卡住（NFR-2 幂等性体验）。
  const needsDownload = plan.items.some(
    (item) => !item.installDir || !existsSync(item.installDir)
  )

  if (!needsDownload) {
    checks.push({
      id: 'network',
      level: 'ok',
      message: '所有项都已经在版本目录里，本次无需下载（会逐项自检后跳过）'
    })
  } else
    for (const item of plan.items) {
      if (targets.length >= probeLimit) break
      if (seenTools.has(item.id)) continue
      const tool = tools.get(item.id)
      const version = tool?.versions.find((entry) => entry.version === item.version)
      if (!version) continue
      const sources = orderDownloadSources(version, plan.options.mirrorPreference).slice(0, perToolSources)
      if (sources.length === 0) continue
      seenTools.add(item.id)
      targets.push({ toolId: item.id, sources })
    }

  if (!needsDownload) {
    // 上面已经给出 ok 级结论，不再探测
  } else if (targets.length === 0) {
    checks.push({ id: 'network', level: 'warn', message: '没有可探测的下载源' })
  } else {
    const probed = await Promise.all(
      targets.map(async (target) => ({
        toolId: target.toolId,
        results: await Promise.all(
          target.sources.map((source) => probeSource(source, plan.options.proxy))
        )
      }))
    )

    let toolsWithUsableSource = 0

    for (const { toolId, results } of probed) {
      const usableIndex = results.findIndex((result) => result.reachable && !result.missing)
      const missingIndex = results.findIndex((result) => result.missing)

      if (usableIndex >= 0) {
        toolsWithUsableSource += 1
        const usable = results[usableIndex]
        if (usableIndex === 0) {
          checks.push({
            id: `network:${toolId}`,
            level: 'ok',
            message: `${toolId} 的首选源 ${usable.source} 可用（${usable.detail}）`
          })
        } else {
          checks.push({
            id: `network:${toolId}`,
            level: 'warn',
            message:
              `${toolId} 的首选源不可用，已自动改用 ${usable.source}（${usable.detail}）。` +
              `已试：${results.slice(0, usableIndex).map((item) => item.source).join('、')}`
          })
        }
        continue
      }

      if (missingIndex >= 0) {
        checks.push({
          id: `network:${toolId}`,
          level: 'warn',
          message: `${toolId} 的镜像没有这个版本（${results[missingIndex].detail}），安装时会继续尝试其它源`
        })
        continue
      }

      checks.push({
        id: `network:${toolId}`,
        level: 'warn',
        message:
          `${toolId} 的下载源都不可达（${results.map((item) => `${item.source}: ${item.detail}`).join('；')}）。` +
          '安装会失败，请检查网络或代理设置'
      })
    }

    // 只有"一个工具的可用源都没有"才升级为阻断级问题
    if (toolsWithUsableSource === 0) {
      checks.push({
        id: 'network',
        level: 'error',
        message: '所有被探测的下载源都不可达，请检查网络或代理设置'
      })
    }
  }

  // 5. 权限
  if (requiresAdmin) {
    const names = plan.items.filter((item) => item.requiresAdmin).map((item) => item.id)
    checks.push({
      id: 'admin',
      level: 'warn',
      message: `以下项目需要管理员权限，稍后会弹出一次授权：${names.join('、')}`
    })
  } else {
    checks.push({
      id: 'admin',
      level: 'ok',
      message: '本次安装全部是用户级操作，不需要管理员权限'
    })
  }

  // 6. 互斥组合
  const conflicts = findConflicts(plan.items.map((item) => item.id))
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      checks.push({ id: `conflict:${conflict}`, level: 'warn', message: conflict })
    }
  }

  const ok = checks.every((check) => check.level !== 'error')
  logger.info(
    'preflight',
    `预检完成：${ok ? '通过' : '存在阻断问题'}，共 ${checks.length} 项检查`
  )

  return { ok, checks, totalDownloadBytes, requiresAdmin }
}
