import { createWriteStream, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requestStream } from '../downloader/http'
import { compareVersions } from '@shared/version'
import { sha256File, shortHash } from '../downloader/checksum'
import { logger } from '../report/logger'

/**
 * 更新检查与**半自动**升级（FR-13）。
 *
 * 刻意的取舍：**不做静默自动更新**。
 *  · SPEC §13.4 #16 已经定了：静默替换开发环境里的二进制不是个安全行为
 *  · 未签名时静默下载的安装包照样会被 SmartScreen 拦，静默没有意义
 *  · 但「得自己回 GitHub 找下载页」确实太麻烦 —— 所以做成：
 *    启动自动检查 → 顶部横幅 → 一键下载（**校验 SHA-256**）→ 直接拉起安装包
 *
 * 更新源支持两种格式（`latest.json` 与 electron-builder 的 `latest.yml`），
 * 因为前者是本项目自己产出的、后者是生态里常见的。
 */

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  /** 期望的 SHA-256（来自索引；没有就返回 null，下载时不强校验但会告警） */
  downloadSha256: string | null
  sizeBytes: number | null
  notes: string | null
  error: string | null
}

export interface DownloadUpdateResult {
  ok: boolean
  filePath: string | null
  bytes: number
  /** 实际校验结果；索引里没给哈希时为 null */
  verified: boolean | null
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

export interface ParsedIndex {
  version: string | null
  downloadUrl: string | null
  sha256: string | null
  sizeBytes: number | null
  notes: string | null
}

/**
 * 解析更新索引。支持两种格式：
 *  · 本项目 `scripts/make-update-index.ts` 产出的 latest.json
 *    （`{version, url, checksums: {文件名: sha256}, sizes: {...}}`）
 *  · electron-builder 的 latest.yml
 */
export function parseUpdateIndex(text: string, sourceUrl: string): ParsedIndex {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        version?: unknown
        url?: unknown
        path?: unknown
        notes?: unknown
        checksums?: Record<string, string>
        sizes?: Record<string, number>
      }
      const version = typeof parsed.version === 'string' ? parsed.version.replace(/^v/, '') : null
      const rawUrl =
        typeof parsed.url === 'string'
          ? parsed.url
          : typeof parsed.path === 'string'
            ? parsed.path
            : null
      const downloadUrl = rawUrl ? new URL(rawUrl, sourceUrl).toString() : null

      // checksums 是按文件名索引的；用下载地址的最后一段去匹配
      const fileName = downloadUrl ? basename(new URL(downloadUrl).pathname) : ''
      const sha256 = parsed.checksums?.[fileName]?.toLowerCase() ?? null
      const sizeBytes = parsed.sizes?.[fileName] ?? null

      return {
        version,
        downloadUrl,
        sha256: sha256 && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null,
        sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : null,
        notes: typeof parsed.notes === 'string' ? parsed.notes : null
      }
    } catch {
      return { version: null, downloadUrl: null, sha256: null, sizeBytes: null, notes: null }
    }
  }

  const yml = parseLatestYml(trimmed)
  const version = yml.version ? yml.version.replace(/^v/, '') : null
  const rawUrl = yml.url ?? yml.path ?? null
  return {
    version,
    downloadUrl: rawUrl ? new URL(rawUrl, sourceUrl).toString() : null,
    sha256: null,
    sizeBytes: null,
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
    downloadSha256: null,
    sizeBytes: null,
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
      downloadSha256: index.sha256,
      sizeBytes: index.sizeBytes,
      notes: index.notes,
      error: null
    }
  } catch (error) {
    const message = (error as Error).message
    logger.warn('updater', `更新检查失败：${message}`)
    return { ...base, error: message }
  }
}

/** 把安装包下载到 <dataRoot>\updates\，校验 SHA-256 之后才返回路径 */
export async function downloadUpdate(params: {
  url: string
  sha256: string | null
  targetDir: string
  proxy: string | null
  onProgress?: (received: number, total: number | null) => void
  signal?: AbortSignal
}): Promise<DownloadUpdateResult> {
  const { url, sha256, targetDir, proxy } = params

  if (!/^https:\/\//.test(url)) {
    return { ok: false, filePath: null, bytes: 0, verified: null, error: '更新包地址必须是 https' }
  }

  await mkdir(targetDir, { recursive: true })
  const fileName = basename(new URL(url).pathname) || 'devkit-update.exe'
  const partFile = join(targetDir, `${fileName}.part`)
  const finalFile = join(targetDir, fileName)

  try {
    const response = await requestStream(url, { proxy, timeoutMs: 30_000, signal: params.signal })
    if (response.status !== 200) {
      response.stream.destroy()
      return {
        ok: false,
        filePath: null,
        bytes: 0,
        verified: null,
        error: `下载更新包失败：HTTP ${response.status}`
      }
    }

    const totalHeader = Number(response.headers['content-length'] ?? 0)
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(partFile)
      let received = 0
      response.stream.on('data', (chunk: Buffer) => {
        received += chunk.length
        params.onProgress?.(received, total)
      })
      response.stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      response.stream.pipe(out)
    })

    // 校验通过才改名 —— 与下载器同一条规矩：未校验的文件不出现在最终位置。
    //
    // 索引里没有 SHA-256 时**直接拒绝**，而不是"警告一下照样装"。
    // 以前是后者：日志里一行 warn，然后文件照样落到最终位置、返回 ok:true，
    // 用户看到的是一个"可以安装"的更新包。而更新包是会被拉起来执行的，
    // 没有完整性校验等于把"更新"变成了一条未认证的代码执行通道。
    if (!sha256) {
      await rm(partFile, { force: true })
      return {
        ok: false,
        filePath: null,
        bytes: 0,
        verified: null,
        error: '更新索引里没有 SHA-256 校验和，已拒绝下载（无法确认更新包是否被篡改）'
      }
    }

    const actual = await sha256File(partFile)
    if (actual !== sha256.toLowerCase()) {
      await rm(partFile, { force: true })
      return {
        ok: false,
        filePath: null,
        bytes: 0,
        verified: false,
        error: `更新包校验失败：期望 ${shortHash(sha256)}，实际 ${shortHash(actual)}。已丢弃，未启动安装`
      }
    }
    const verified: boolean | null = true

    await rm(finalFile, { force: true })
    await rename(partFile, finalFile)

    const bytes = statSync(finalFile).size
    logger.info('updater', `更新包已就绪：${finalFile}（${bytes} 字节，校验=${verified}）`)
    return { ok: true, filePath: finalFile, bytes, verified, error: null }
  } catch (error) {
    await rm(partFile, { force: true })
    const message = (error as Error).message
    logger.error('updater', `下载更新包失败：${message}`)
    return { ok: false, filePath: null, bytes: 0, verified: null, error: message }
  }
}
