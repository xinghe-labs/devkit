import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { ManifestLoadError, ToolManifest } from '@shared/types'

export interface RawManifestFile {
  file: string
  data: unknown
}

export interface ManifestValidationResult {
  tools: ToolManifest[]
  errors: ManifestLoadError[]
}

/**
 * 编译 JSON Schema 校验器。
 * strict:false 是为了允许 Schema 里出现自定义关键字而不报错；
 * allErrors:true 让我们能一次报出清单里的全部问题，而不是修一个报一个。
 */
export function createManifestValidator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
  return ajv.compile(schema)
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '未知校验错误'
  return errors
    .slice(0, 6)
    .map((error) => {
      const path = error.instancePath === '' ? '/' : error.instancePath
      return `${path} ${error.message ?? ''}`.trim()
    })
    .join('; ')
}

/**
 * 校验一批清单。
 *
 * 除了 Schema 能表达的结构约束，还做几项 Schema 难以表达的语义检查：
 *  1. id 不能重复
 *  2. 同一个工具最多只能有一个 recommended 版本
 *  3. status 为 ready 时，每个版本必须有 source.url / source.sha256 / install.template
 *  4. dependsOn 指向的工具必须存在
 *
 * 第 3 条是防"看起来能装、实际装不了"的清单混进来 —— 见 SPEC §7.1。
 */
export function validateManifests(
  files: RawManifestFile[],
  validate: ValidateFunction
): ManifestValidationResult {
  const tools: ToolManifest[] = []
  const errors: ManifestLoadError[] = []
  const seenIds = new Map<string, string>()

  for (const entry of files) {
    const name = entry.file

    if (!validate(entry.data)) {
      errors.push({ file: name, message: formatAjvErrors(validate.errors) })
      continue
    }

    const tool = entry.data as ToolManifest

    const previous = seenIds.get(tool.id)
    if (previous) {
      errors.push({ file: name, message: `id "${tool.id}" 与 ${previous} 重复` })
      continue
    }

    const recommendedCount = tool.versions.filter((version) => version.recommended).length
    if (recommendedCount > 1) {
      errors.push({
        file: name,
        message: `id "${tool.id}" 有 ${recommendedCount} 个 recommended 版本，最多只能有一个`
      })
      continue
    }

    if (tool.status === 'ready') {
      const incomplete = tool.versions.filter(
        (version) => !version.source?.url || !version.source?.sha256 || !version.install?.template
      )
      if (tool.versions.length === 0) {
        errors.push({ file: name, message: `id "${tool.id}" 状态为 ready 但没有任何版本` })
        continue
      }
      if (incomplete.length > 0) {
        errors.push({
          file: name,
          message: `id "${tool.id}" 状态为 ready，但版本 ${incomplete
            .map((version) => version.version)
            .join(', ')} 缺少 source.url / source.sha256 / install.template`
        })
        continue
      }
    }

    seenIds.set(tool.id, name)
    tools.push(tool)
  }

  // dependsOn 引用完整性
  const knownIds = new Set(tools.map((tool) => tool.id))
  for (const tool of tools) {
    for (const version of tool.versions) {
      for (const dependency of version.dependsOn ?? []) {
        if (!knownIds.has(dependency)) {
          errors.push({
            file: seenIds.get(tool.id) ?? tool.id,
            message: `id "${tool.id}" 的版本 ${version.version} 依赖不存在的工具 "${dependency}"`
          })
        }
      }
    }
  }

  return { tools, errors }
}
