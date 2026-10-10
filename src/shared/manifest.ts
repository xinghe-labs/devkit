import type { ToolManifest, ToolVersionSpec } from './types'

/** 取推荐版本；没有标 recommended 就退化为第一个版本；一个版本都没有则返回 null */
export function pickRecommendedVersion(tool: ToolManifest): ToolVersionSpec | null {
  return tool.versions.find((version) => version.recommended) ?? tool.versions[0] ?? null
}

/** 按 id 建索引，UI 里频繁按 id 找工具，避免每次线性查找 */
export function indexById(tools: ToolManifest[]): Map<string, ToolManifest> {
  return new Map(tools.map((tool) => [tool.id, tool]))
}
