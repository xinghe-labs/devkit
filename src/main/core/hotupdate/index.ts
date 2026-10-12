import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestLoadError, ToolManifest } from '@shared/types'
import { getUserManifestDir } from '../../utils/app-paths'
import { readJsonFile, writeJsonFile } from '../../utils/fs'
import { requestStream } from '../downloader/http'
import { createManifestValidator, validateManifests, type RawManifestFile } from '../manifest/validate'
import { clearManifestCache, getSchemaPath } from '../manifest'
import { logger } from '../report/logger'
import { mergeHotUpdate, type HotUpdateIndex } from './whitelist'

/**
 * 清单热更新（FR-15）。
 *
 * 只做三件事：拉索引 → 按白名单合并 → 用同一套 Schema 校验后落到用户目录。
 * 校验不过的一律不落盘 —— 宁可继续用旧清单，也不要把一份来路不明、
 * 结构不对的清单写进去（下次启动会加载它）。
 */

export interface HotUpdateRejection {
  id: string
  reason: string
}

export interface HotUpdateOutcome {
  ok: boolean
  /** 远程索引里的工具数 */
  fetched: number
  /** 成功写入的工具数 */
  applied: number
  /** 被拒绝的条目及原因 */
  rejected: HotUpdateRejection[]
  updated: { id: string; versions: string[] }[]
  error: string | null
}

const MAX_INDEX_BYTES = 4 * 1024 * 1024

async function fetchIndex(url: string, proxy: string | null): Promise<HotUpdateIndex> {
  if (!/^https:\/\//.test(url)) {
    throw new Error('清单更新地址必须是 https')
  }

  const response = await requestStream(url, { proxy, timeoutMs: 20_000, maxRedirects: 4 })
  if (response.status !== 200) {
    response.stream.destroy()
    throw new Error(`拉取清单索引失败：HTTP ${response.status}`)
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.stream) {
    total += (chunk as Buffer).length
    if (total > MAX_INDEX_BYTES) {
      response.stream.destroy()
      throw new Error(`清单索引超过 ${MAX_INDEX_BYTES / 1024 / 1024} MB，已拒绝`)
    }
    chunks.push(chunk as Buffer)
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<HotUpdateIndex>
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tools)) {
    throw new Error('清单索引格式不匹配（需要 schemaVersion: 1 与 tools 数组）')
  }
  return parsed as HotUpdateIndex
}

export async function runHotUpdate(params: {
  url: string
  tools: ToolManifest[]
  proxy: string | null
}): Promise<HotUpdateOutcome> {
  const { url, tools, proxy } = params
  const rejected: HotUpdateRejection[] = []
  const updated: { id: string; versions: string[] }[] = []

  let index: HotUpdateIndex
  try {
    index = await fetchIndex(url, proxy)
  } catch (error) {
    const message = (error as Error).message
    logger.warn('hotupdate', message)
    return { ok: false, fetched: 0, applied: 0, rejected, updated, error: message }
  }

  const byId = new Map(tools.map((tool) => [tool.id, tool]))
  const validator = createManifestValidator(readJsonFile<object>(getSchemaPath()))
  const userToolsDir = join(getUserManifestDir(), 'tools')
  mkdirSync(userToolsDir, { recursive: true })

  let applied = 0

  for (const remote of index.tools) {
    if (typeof remote?.id !== 'string') {
      rejected.push({ id: String(remote?.id ?? '?'), reason: '远程条目缺少 id' })
      continue
    }

    const local = byId.get(remote.id)
    if (!local) {
      rejected.push({ id: remote.id, reason: '本地清单里没有这个工具，拒绝下发新工具' })
      continue
    }

    const merged = mergeHotUpdate(local, remote)
    for (const reason of merged.rejected) rejected.push({ id: remote.id, reason })

    if (merged.accepted === 0) continue

    // 用与内置清单完全相同的 Schema + 语义校验再拦一道
    const files: RawManifestFile[] = [{ file: `${remote.id}.json`, data: merged.manifest }]
    const checked = validateManifests(files, validator)
    if (checked.errors.length > 0) {
      rejected.push({
        id: remote.id,
        reason: `合并后的清单未通过校验：${checked.errors.map((item) => item.message).join('；')}`
      })
      continue
    }

    writeJsonFile(join(userToolsDir, `${remote.id}.json`), merged.manifest)
    applied += 1
    updated.push({
      id: remote.id,
      versions: merged.manifest.versions.map((version) => version.version)
    })
    logger.info('hotupdate', `${remote.id} 清单已更新：${merged.accepted} 个版本`)
  }

  clearManifestCache()

  logger.info('hotupdate', `热更新完成：远程 ${index.tools.length} 个，应用 ${applied} 个，拒绝 ${rejected.length} 个`)
  return { ok: true, fetched: index.tools.length, applied, rejected, updated, error: null }
}

/** 读用户目录里的清单覆盖文件（loadManifests 会调用） */
export function readUserManifestFiles(): { files: RawManifestFile[]; errors: ManifestLoadError[] } {
  const dir = join(getUserManifestDir(), 'tools')
  const files: RawManifestFile[] = []
  const errors: ManifestLoadError[] = []

  try {
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
      try {
        files.push({ file: name, data: readJsonFile(join(dir, name)) })
      } catch (error) {
        errors.push({ file: `(用户清单) ${name}`, message: (error as Error).message })
      }
    }
  } catch {
    // 目录不存在 = 没做过热更新，正常
  }

  return { files, errors }
}

/** 清空用户清单覆盖，回到内置清单 */
export function clearUserManifests(): number {
  const dir = join(getUserManifestDir(), 'tools')
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { force: true })
      removed += 1
    }
  } catch {
    // 目录不存在，没什么可清的
  }
  clearManifestCache()
  logger.info('hotupdate', `已清空 ${removed} 个用户清单覆盖文件`)
  return removed
}
