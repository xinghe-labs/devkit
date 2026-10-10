import type {
  MirrorPreference,
  ToolManifest,
  ToolVersionSpec
} from './types'

/** 取推荐版本；没有标 recommended 就退化为第一个版本；一个版本都没有则返回 null */
export function pickRecommendedVersion(tool: ToolManifest): ToolVersionSpec | null {
  return tool.versions.find((version) => version.recommended) ?? tool.versions[0] ?? null
}

/** 按 id 建索引，UI 里频繁按 id 找工具，避免每次线性查找 */
export function indexById(tools: ToolManifest[]): Map<string, ToolManifest> {
  return new Map(tools.map((tool) => [tool.id, tool]))
}

export interface DownloadSourceRef {
  name: string
  url: string
}

/**
 * 按镜像偏好排出下载源的尝试顺序：
 * 首选源排第一，其余按清单里的声明顺序跟在后面。
 *
 * 实测各源速度相差极大（华为云 8.2 MB/s vs 官方源 191 KB/s），
 * 而且镜像会滞后（清华只到 v24.1.0），所以"首选"只是排序，失败仍会依次回退。
 */
export function orderDownloadSources(
  version: ToolVersionSpec,
  preference: MirrorPreference
): DownloadSourceRef[] {
  const candidates: DownloadSourceRef[] = []

  if (version.source?.url) {
    candidates.push({ name: 'official', url: version.source.url })
  }
  for (const mirror of version.mirrors ?? []) {
    candidates.push({ name: mirror.name, url: mirror.url })
  }

  const index = candidates.findIndex((item) => item.name === preference)
  if (index <= 0) return candidates

  const preferred = candidates[index]
  return [preferred, ...candidates.filter((_, position) => position !== index)]
}
