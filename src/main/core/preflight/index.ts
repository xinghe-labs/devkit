import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { arch as osArch, release as osRelease } from 'node:os'
import { parse as parsePath } from 'node:path'
import type { InstallPlan, PreflightCheck, PreflightResult, ToolManifest } from '@shared/types'
import { orderDownloadSources, type DownloadSourceRef } from '@shared/manifest'
import { requestStream } from '../downloader/http'
import { detectTool } from '../detect'
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

/**
 * 装完之后**仍然需要用户自己准备**的东西。
 *
 * 和 `dependsOn` 的区别：`dependsOn` 指的是「另一个 devkit 能装的工具」，
 * 可以靠拓扑排序 + 预检拦截解决；这里指的是 **devkit 装不了**的东西 ——
 * 只能如实提示，让用户自己去装。
 *
 * 为什么必须提示：不提示就是**假成功**，比干净地失败更糟。
 * Rust 的例子里，装完 `rustc --version` 完全正常、devkit 自检也会通过，
 * 但用户第一次 `cargo build` 会撞上 ``linker `link.exe` not found``，
 * 而那时他早就把"devkit 说装好了"当成事实了。
 *
 * 位置说明：这份表和上面的 `CONFLICTS` 一样是引擎侧的跨工具知识。
 * 条目再涨就该挪进清单（`versions[].requiresExternal`），现在两条以内不值得加 schema。
 */
export const EXTERNAL_REQUIREMENTS: { toolId: string; message: string }[] = [
  {
    toolId: 'rust',
    message:
      'Rust 在 Windows 上默认用 msvc 目标，编译链接需要 MSVC 生成工具' +
      '（Visual Studio Build Tools 里的「使用 C++ 的桌面开发」）。' +
      'devkit 不装它（几个 GB 的独立安装器，有自己的 UI），' +
      '没装的话 rustc 能用、但 cargo build 会报 linker `link.exe` not found。'
  }
]

/** 选中的工具里，哪些还有 devkit 装不了的前置需要用户自己准备 */
export function findExternalRequirements(toolIds: string[]): { toolId: string; message: string }[] {
  const selected = new Set(toolIds)
  return EXTERNAL_REQUIREMENTS.filter((item) => selected.has(item.toolId))
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
  /**
   * 这台机器上**已经可用**的工具 id（来自检测）。
   *
   * 前置依赖的判定是「计划里有 **或** 机器上已有」。
   * 只看计划会把「本机早就装了 JDK，这次只想装 Maven」误判成缺依赖，
   * 那是最烦人的假阳性 —— 用户会直接不信任这个检查。
   */
  availableToolIds?: Set<string>
}

/**
 * 工具间的前置依赖（`versions[].dependsOn`）。
 *
 * 声明的是**隐藏前置**：不是下载/解压需要，而是运行与自检需要。
 *  · npm 类模板要跑 `npm install` → 需要 Node.js
 *  · Maven / Gradle 的自检是 `mvn -v` / `gradle -v`，要起 JVM → 需要 JDK
 *
 * 不拦的话，干净机器上的表现是：下载成功、解压成功，然后自检报一句
 * 「JAVA_HOME environment variable is not defined correctly」——
 * 用户根本猜不到是"该一起装 JDK"。
 *
 * 这个检查在**预检**里而不是构建计划时，是因为 UI 拿预检的 error 直接禁用开始按钮
 * （`disabled={!preflight.ok}`），用户能当场看到原因、补勾选、重新预检。
 */
async function checkToolPrerequisites(input: PreflightInput): Promise<PreflightCheck[]> {
  const { plan, tools, availableToolIds } = input
  const inPlan = new Set(plan.items.map((item) => item.id))
  const available = new Set(availableToolIds ?? [])

  /**
   * 渲染进程还没把检测结果送过来时，自己补一遍「命令 + 文件」快速探测。
   *
   * 为什么必须补：这台机器上完整检测（含注册表扫描）要 7 秒多，
   * 用户完全可能在那之前就点了安装。那时 availableToolIds 是空的，
   * 「本机早有 JDK、这次只想装 Maven」就会被误拦 —— 而这正是我们最不想看到的假阳性。
   *
   * 不传 programs 就是跳过注册表扫描，只跑命令与文件判断，几百毫秒。
   * 判定用白名单（installed / version-mismatch / path-missing）：
   * `error` 表示"我没查出来"，不能当成"你有"。
   */
  const dependencyIds = [...new Set(plan.items.flatMap((item) => item.dependsOn))]
  for (const id of dependencyIds) {
    if (available.has(id)) continue
    const tool = tools.get(id)
    if (!tool) continue
    try {
      const result = await detectTool(tool)
      if (result.status === 'installed' || result.status === 'version-mismatch' || result.status === 'path-missing') {
        available.add(id)
      }
    } catch (error) {
      logger.warn('preflight', `探测前置依赖 ${id} 失败，按"没有"处理：${(error as Error).message}`)
    }
  }

  /** 缺的依赖 → 哪些工具在等它 */
  const missing = new Map<string, string[]>()

  for (const item of plan.items) {
    for (const dependency of item.dependsOn) {
      if (inPlan.has(dependency) || available.has(dependency)) continue
      missing.set(dependency, [...(missing.get(dependency) ?? []), item.id])
    }
  }

  if (missing.size === 0) {
    const declared = plan.items.filter((item) => item.dependsOn.length > 0)
    return [
      {
        id: 'tool-prerequisites',
        level: 'ok',
        message:
          declared.length === 0
            ? '所选工具没有额外的前置依赖'
            : `前置依赖已满足（${declared.map((item) => item.id).join('、')}）`
      }
    ]
  }

  return [...missing.entries()].map(([dependency, dependents]) => {
    const name = tools.get(dependency)?.name['zh-CN'] ?? dependency
    const who = dependents
      .map((id) => tools.get(id)?.name['zh-CN'] ?? id)
      .join('、')
    return {
      id: `tool-prerequisites:${dependency}`,
      level: 'error' as const,
      message:
        `${who} 需要先有「${name}」才能装好并用起来，但计划里没有它、这台机器上也没检测到。` +
        `请回到选择界面把「${name}」一起勾选。`
    }
  })
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

  // 0. 工具间的前置依赖 —— 放在最前面，因为它是最容易当场修掉的一项
  checks.push(...(await checkToolPrerequisites(input)))

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

  // 7. devkit 装不了、需要用户自己准备的前置（只提示，不阻断）
  const external = findExternalRequirements(plan.items.map((item) => item.id))
  for (const item of external) {
    checks.push({
      id: `external-requirement:${item.toolId}`,
      level: 'warn',
      message: item.message
    })
  }

  const ok = checks.every((check) => check.level !== 'error')
  logger.info(
    'preflight',
    `预检完成：${ok ? '通过' : '存在阻断问题'}，共 ${checks.length} 项检查`
  )

  return { ok, checks, totalDownloadBytes, requiresAdmin }
}
