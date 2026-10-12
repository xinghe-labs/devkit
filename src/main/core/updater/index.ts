import { requestStream } from '../downloader/http'
import { compareVersions } from '@shared/version'
import { logger } from '../report/logger'

/**
 * 更新检查（FR-13）。
 *
 * 这里刻意**不引入 electron-updater**：它要求构建期就固定 publish 地址，
 * 而这个仓库目前没有远程仓库，写一个假的地址只会让用户看到一个永远失败的"自动更新"。
 * 取而代之的是一个**可验证**的做法：从用户配置的更新源拉一个很小的索引文件
 * （JSON 或 electron-builder 的 latest.yml 都支持），比较版本号，把下载地址交给用户。
 *
 * 好处：没有假地址、不依赖签名与发布基础设施、能单测；
 * 代价：是"提示更新"而不是"静默更新"—— 对开发者工具来说这个取舍是合适的，
 * 静默替换开发环境里的二进制本身就不是个安全的行为。
 */

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  notes: string | null
  error: string | null
}

/** electron-builder 的 latest.yml 就是 key: value 的简单列表 */
export function parseLatestYml(text: string): { version?: string; path?: string; url?: string } {
  const result: { version?: string; path?: string; url?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(version|path|url)\s*:\s*(.+?)\s*$/)
    if (!match) continue
    const value = match[2].replace(/^["']|["']$/g, '')
    if (match[1] === 'version') result.version = value
    else if (match[1] === 'path') result.path = value
    else result.url = value
  }
  return result
}

export function parseUpdateIndex(text: string, sourceUrl: string): {
  version: string | null
  downloadUrl: string | null
  notes: string | null
} {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        version?: unknown
        url?: unknown
        path?: unknown
        notes?: unknown
      }
      const version = typeof parsed.version === 'string' ? parsed.version.replace(/^v/, '') : null
      const rawUrl =
        typeof parsed.url === 'string'
          ? parsed.url
          : typeof parsed.path === 'string'
            ? parsed.path
            : null
      return {
        version,
        downloadUrl: rawUrl ? new URL(rawUrl, sourceUrl).toString() : null,
        notes: typeof parsed.notes === 'string' ? parsed.notes : null
      }
    } catch {
      return { version: null, downloadUrl: null, notes: null }
    }
  }

  const yml = parseLatestYml(trimmed)
  const version = yml.version ? yml.version.replace(/^v/, '') : null
  const rawUrl = yml.url ?? yml.path ?? null
  return {
    version,
    downloadUrl: rawUrl ? new URL(rawUrl, sourceUrl).toString() : null,
    notes: null
  }
}

export async function checkForUpdate(params: {
  feedUrl: string
  currentVersion: string
  proxy: string | null
}): Promise<UpdateInfo> {
  const { feedUrl, currentVersion, proxy } = params
  const base: UpdateInfo = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    downloadUrl: null,
    notes: null,
    error: null
  }

  if (!/^https:\/\//.test(feedUrl)) {
    return { ...base, error: '更新源地址必须是 https' }
  }

  try {
    const response = await requestStream(feedUrl, { proxy, timeoutMs: 15_000, maxRedirects: 4 })
    if (response.status !== 200) {
      response.stream.destroy()
      return { ...base, error: `更新源返回 HTTP ${response.status}` }
    }

    const chunks: Buffer[] = []
    for await (const chunk of response.stream) chunks.push(chunk as Buffer)
    const index = parseUpdateIndex(Buffer.concat(chunks).toString('utf8'), feedUrl)

    if (!index.version) {
      return { ...base, error: '更新源里没有可识别的版本号' }
    }

    const hasUpdate = compareVersions(index.version, currentVersion) > 0
    logger.info(
      'updater',
      `更新检查：当前 ${currentVersion}，最新 ${index.version}，${hasUpdate ? '有新版本' : '已是最新'}`
    )

    return {
      hasUpdate,
      currentVersion,
      latestVersion: index.version,
      downloadUrl: index.downloadUrl,
      notes: index.notes,
      error: null
    }
  } catch (error) {
    const message = (error as Error).message
    logger.warn('updater', `更新检查失败：${message}`)
    return { ...base, error: message }
  }
}
