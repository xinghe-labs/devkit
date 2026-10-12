import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestLoadResult, ToolCategory, ToolManifest } from '@shared/types'
import { getManifestDir } from '../../utils/app-paths'
import { fileExists, readJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'
import { readUserManifestFiles } from '../hotupdate'
import { createManifestValidator, validateManifests, type RawManifestFile } from './validate'

const CATEGORY_ORDER: ToolCategory[] = [
  'runtime',
  'build',
  'database',
  'container',
  'editor',
  'ai',
  'tool'
]

let cache: ManifestLoadResult | null = null

/** 内置 Schema 的位置；热更新要用同一套校验器 */
export function getSchemaPath(dir: string = getManifestDir()): string {
  return join(dir, 'schema', 'tool.schema.json')
}

function schemaPath(dir: string): string {
  return getSchemaPath(dir)
}

function toolsDir(dir: string): string {
  return join(dir, 'tools')
}

/**
 * 加载并校验内置清单。
 *
 * 校验失败的清单会被跳过并记录错误，不会导致整个应用起不来 ——
 * 一个清单写错不应该让用户完全用不了工具。
 */
export function loadManifests(force = false): ManifestLoadResult {
  if (cache && !force) return cache

  const dir = getManifestDir()
  const empty: ManifestLoadResult = {
    tools: [],
    errors: [],
    source: 'builtin',
    dir,
    loadedAt: new Date().toISOString()
  }

  if (!fileExists(schemaPath(dir))) {
    const message = `找不到清单 Schema：${schemaPath(dir)}`
    logger.error('manifest', message)
    cache = { ...empty, errors: [{ file: schemaPath(dir), message }] }
    return cache
  }

  const validate = createManifestValidator(readJsonFile<object>(schemaPath(dir)))

  const directory = toolsDir(dir)
  if (!fileExists(directory)) {
    const message = `找不到清单目录：${directory}`
    logger.error('manifest', message)
    cache = { ...empty, errors: [{ file: directory, message }] }
    return cache
  }

  const files: RawManifestFile[] = []
  const readErrors: ManifestLoadResult['errors'] = []

  for (const name of readdirSync(directory).filter((item) => item.endsWith('.json'))) {
    const file = join(directory, name)
    try {
      files.push({ file: name, data: readJsonFile(file) })
    } catch (error) {
      readErrors.push({ file: name, message: (error as Error).message })
    }
  }

  const { tools: builtinTools, errors } = validateManifests(files, validate)

  // 热更新覆盖（FR-15）：用户目录里同名 id 的清单优先于内置清单，
  // 但**用同一套 Schema 与语义校验**，坏了就整条丢弃、继续用内置的那份。
  const overrides = readUserManifestFiles()
  const overrideChecked = validateManifests(overrides.files, validate)
  const overrideById = new Map(overrideChecked.tools.map((tool) => [tool.id, tool]))

  const tools: ToolManifest[] = builtinTools.map((tool) => overrideById.get(tool.id) ?? tool)
  const usedOverrides = builtinTools.filter((tool) => overrideById.has(tool.id)).map((tool) => tool.id)

  tools.sort((a, b) => {
    const categoryDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    return categoryDiff !== 0 ? categoryDiff : a.id.localeCompare(b.id)
  })

  const result: ManifestLoadResult = {
    tools,
    errors: [...readErrors, ...errors, ...overrides.errors, ...overrideChecked.errors],
    source: usedOverrides.length > 0 ? 'remote' : 'builtin',
    dir,
    loadedAt: new Date().toISOString()
  }

  logger.info(
    'manifest',
    `从 ${dir} 加载清单：成功 ${tools.length} 个，失败 ${result.errors.length} 个` +
      (usedOverrides.length > 0 ? `；其中 ${usedOverrides.length} 个来自热更新覆盖` : '')
  )
  for (const error of result.errors) {
    logger.warn('manifest', `清单 ${error.file} 校验失败：${error.message}`)
  }

  cache = result
  return result
}

export function clearManifestCache(): void {
  cache = null
}
