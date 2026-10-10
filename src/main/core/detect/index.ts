import { existsSync } from 'node:fs'
import type {
  DetectCommandSpec,
  DetectionResult,
  RegistryDetectRule,
  ToolManifest
} from '@shared/types'
import { pickRecommendedVersion } from '@shared/manifest'
import { extractVersion, sameMajor } from '@shared/version'
import { expandEnvVars } from '../../utils/env-vars'
import { runCommand } from '../../utils/exec'
import { logger } from '../report/logger'
import { getInstalledPrograms } from './registry'
import type { InstalledProgram } from './registry-parse'

interface MatchHit {
  evidence: string
  version: string | null
}

async function matchCommand(spec: DetectCommandSpec): Promise<MatchHit | null> {
  const result = await runCommand(spec.cmd, spec.args ?? [], { timeoutMs: 8000 })
  if (result.spawnError) return null

  const output = `${result.stdout}\n${result.stderr}`

  if (spec.expectRegex) {
    let pattern: RegExp
    try {
      pattern = new RegExp(spec.expectRegex, 'i')
    } catch (error) {
      throw new Error(
        `检测正则非法 "${spec.expectRegex}"（命令 ${spec.cmd}）：${(error as Error).message}`,
        { cause: error }
      )
    }
    if (!pattern.test(output)) return null
  } else if (result.code !== 0) {
    return null
  }

  return { evidence: `command:${spec.cmd}`, version: extractVersion(output) }
}

function matchFile(files: string[] | undefined): MatchHit | null {
  for (const raw of files ?? []) {
    const expanded = expandEnvVars(raw)
    try {
      if (existsSync(expanded)) return { evidence: `file:${expanded}`, version: null }
    } catch {
      // 路径非法（例如含未解析的 %VAR%）时跳过
    }
  }
  return null
}

function matchRegistry(
  rules: RegistryDetectRule[] | undefined,
  programs: InstalledProgram[]
): MatchHit | null {
  if (!rules || rules.length === 0 || programs.length === 0) return null

  for (const rule of rules) {
    for (const program of programs) {
      if (program.hive !== rule.hive || program.view !== rule.view) continue
      if (!program.keyPath.toLowerCase().includes(rule.path.toLowerCase())) continue

      let matched = true
      for (const [field, pattern] of Object.entries(rule.match)) {
        const value = program.fields[field]
        if (value === undefined) {
          matched = false
          break
        }
        let expression: RegExp
        try {
          expression = new RegExp(pattern, 'i')
        } catch {
          matched = false
          break
        }
        if (!expression.test(value)) {
          matched = false
          break
        }
      }
      if (!matched) continue

      const versionField = rule.versionFrom ?? 'DisplayVersion'
      return {
        evidence: `registry:${program.keyPath}`,
        version: program.fields[versionField] ?? null
      }
    }
  }
  return null
}

/**
 * 检测单个工具。
 *
 * 判定顺序（SPEC FR-1）：
 *   1. 版本命令能跑通         → installed / version-mismatch
 *   2. 文件或注册表有痕迹     → path-missing（已安装但 PATH 未生效）
 *   3. 都没有                 → not-installed
 * 检测过程本身出错时返回 error，而不是 not-installed ——
 * 不能把"我没查出来"说成"你没装"。
 */
export async function detectTool(
  tool: ToolManifest,
  programs: InstalledProgram[] = []
): Promise<DetectionResult> {
  const startedAt = Date.now()
  const recommended = pickRecommendedVersion(tool)
  const recommendedVersion = recommended?.version ?? null
  const errors: string[] = []

  const base = {
    toolId: tool.id,
    installedVersion: null as string | null,
    recommendedVersion,
    versionMatches: true,
    evidence: null as string | null,
    error: null as string | null
  }

  // 1. 命令可用
  for (const spec of tool.detect.commands ?? []) {
    try {
      const hit = await matchCommand(spec)
      if (!hit) continue

      const versionMatches = sameMajor(hit.version, recommendedVersion)
      return {
        ...base,
        status: versionMatches ? 'installed' : 'version-mismatch',
        installedVersion: hit.version,
        versionMatches,
        evidence: hit.evidence,
        durationMs: Date.now() - startedAt
      }
    } catch (error) {
      errors.push((error as Error).message)
    }
  }

  // 2. 文件痕迹
  const fileHit = matchFile(tool.detect.files)
  if (fileHit) {
    return {
      ...base,
      status: 'path-missing',
      installedVersion: null,
      evidence: fileHit.evidence,
      durationMs: Date.now() - startedAt
    }
  }

  // 3. 注册表痕迹
  try {
    const registryHit = matchRegistry(tool.detect.registry, programs)
    if (registryHit) {
      return {
        ...base,
        status: 'path-missing',
        installedVersion: registryHit.version,
        evidence: registryHit.evidence,
        durationMs: Date.now() - startedAt
      }
    }
  } catch (error) {
    errors.push((error as Error).message)
  }

  return {
    ...base,
    status: errors.length > 0 ? 'error' : 'not-installed',
    error: errors.length > 0 ? errors.join('; ') : null,
    durationMs: Date.now() - startedAt
  }
}

export interface DetectAllOptions {
  concurrency?: number
  onResult?: (result: DetectionResult) => void
}

/** 并发检测全部工具。注册表只扫一次，所有工具共用。 */
export async function detectAll(
  tools: ToolManifest[],
  options: DetectAllOptions = {}
): Promise<DetectionResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8))

  let programs: InstalledProgram[] = []
  try {
    programs = await getInstalledPrograms()
  } catch (error) {
    logger.warn('detect', `注册表扫描失败，退化为仅用命令与文件检测：${(error as Error).message}`)
  }

  const queue = [...tools]
  const results: DetectionResult[] = []
  const startedAt = Date.now()

  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    for (;;) {
      const tool = queue.shift()
      if (!tool) return
      const result = await detectTool(tool, programs)
      results.push(result)
      options.onResult?.(result)
    }
  })

  await Promise.all(workers)

  const order = new Map(tools.map((tool, index) => [tool.id, index]))
  results.sort((a, b) => (order.get(a.toolId) ?? 0) - (order.get(b.toolId) ?? 0))

  logger.info(
    'detect',
    `检测完成：${results.length} 个工具，耗时 ${Date.now() - startedAt}ms，` +
      `已装 ${results.filter((item) => item.status === 'installed').length} 个`
  )

  return results
}
