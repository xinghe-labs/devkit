import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import { URL } from 'node:url'
import { logger } from '../report/logger'
import { sha256File, shortHash } from './checksum'
import { requestStream } from './http'

/**
 * 下载器（SPEC FR-19）。
 *
 * 职责：按优先级依次尝试多个下载源，支持断点续传、SHA-256 强校验、镜像回退。
 * 镜像顺序由调用方（executor）根据用户的镜像偏好排好，这里只负责"按顺序试"。
 */

export interface DownloadSource {
  /** 便于日志与错误报告里指出是哪个源 */
  name: string
  url: string
}

export interface DownloadProgress {
  source: string
  received: number
  total: number | null
}

export interface DownloadAttempt {
  source: string
  url: string
  error: string
}

export interface DownloadRequest {
  /** 已按优先级排好的候选源，第一个是首选 */
  sources: DownloadSource[]
  /** 期望的 SHA-256（小写十六进制） */
  sha256: string
  sizeBytes?: number
  /** 最终落盘路径 */
  targetFile: string
  proxy?: string | null
  /** 等待响应头超时 */
  timeoutMs?: number
  /** 无数据超时（不是总时长限制，大文件慢速下载不会被误杀） */
  idleTimeoutMs?: number
  /** 平均速度低于此值就换源（默认 32 KB/s） */
  minSpeedBytesPerSec?: number
  /** 速度哨兵的宽限期（默认 15 秒，大文件慢启动不误杀）；单测会调小 */
  speedGraceMs?: number
  retriesPerSource?: number
  /** 仅测试用：允许 http:// 源。生产环境一律 https */
  allowInsecure?: boolean
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  /** 阶段变化回调，供 executor 把 UI 状态从"下载中"切到"校验中" */
  onPhase?: (phase: 'downloading' | 'verifying', source: string) => void
}

export interface DownloadResult {
  ok: boolean
  filePath: string | null
  attempts: DownloadAttempt[]
  bytes: number
  durationMs: number
  sha256: string | null
  error: string | null
}

interface ResumeMeta {
  url: string
  total: number | null
}

/**
 * 源级别的失败：该镜像没有这个文件（未同步此版本）或拒绝访问。
 * 重试同一个源没有意义，应该直接换下一个源 —— 实测清华镜像就只到 v24.1.0，
 * 遇到新版本必然 404。
 */
class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceUnavailableError'
  }
}

/**
 * 源太慢：不是"连不上"，而是"连上了但慢到不可用"。
 *
 * 为什么必须单独识别：实测 GitHub release 资产在国内有时会以 1~5 KB/s 的速度"慢慢滴"，
 * 连接正常、也不断流，所以空闲超时永远不会触发 —— 一个 10 MB 的包要下三个小时，
 * 而且会卡在那里挡住后面明明更快的镜像。把"平均速度长期低于阈值"当成可回退错误，
 * 是让镜像回退真正生效的关键一步（SPEC 风险表里"镜像速度差异巨大"那条）。
 */
class SlowSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlowSourceError'
  }
}

/** 低于这个速度就换源（32 KB/s）；正常国内镜像都是 MB/s 级 */
export const MIN_ACCEPTABLE_BYTES_PER_SEC = 32 * 1024
/** 前 15 秒不计速度：大文件刚建立连接时可能有一段慢启动 */
export const SPEED_GRACE_MS = 15_000

/** 把"连接被掐断"这类底层报错翻译成用户能看懂的话 */
function describeStreamError(error: Error, received: number, expected: number | null): Error {
  if (/aborted|premature close|ECONNRESET|socket hang up|other side closed/i.test(error.message)) {
    return new Error(
      `连接中断，下载不完整：已收到 ${received} 字节${expected ? `，期望 ${expected} 字节` : ''}（${error.message}）`
    )
  }
  return error
}

async function statSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function readResumeMeta(file: string): Promise<ResumeMeta | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ResumeMeta>
    if (typeof parsed.url !== 'string') return null
    return { url: parsed.url, total: typeof parsed.total === 'number' ? parsed.total : null }
  } catch {
    return null
  }
}

function pipeToFile(params: {
  stream: IncomingMessage
  file: string
  append: boolean
  baseSize: number
  expectedTotal: number | null
  idleTimeoutMs: number
  minSpeedBytesPerSec: number
  speedGraceMs: number
  onProgress: (received: number) => void
  signal?: AbortSignal
}): Promise<number> {
  const {
    stream,
    file,
    append,
    baseSize,
    expectedTotal,
    idleTimeoutMs,
    minSpeedBytesPerSec,
    speedGraceMs,
    onProgress,
    signal
  } = params

  return new Promise<number>((resolve, reject) => {
    const out = createWriteStream(file, { flags: append ? 'a' : 'w' })
    const startedAt = Date.now()
    let received = 0
    let settled = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearInterval(speedTimer)
      signal?.removeEventListener('abort', onAbort)
      stream.destroy()
      out.destroy()
      if (error) reject(error)
      else resolve(baseSize + received)
    }

    const onAbort = (): void => finish(new Error('下载已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })

    // 速度哨兵：过了宽限期还在爬，就换源
    const speedTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      if (elapsed < speedGraceMs) return

      const total = baseSize + received
      const speed = total / (elapsed / 1000)
      if (speed >= minSpeedBytesPerSec) return

      finish(
        new SlowSourceError(
          `下载速度只有 ${(speed / 1024).toFixed(1)} KB/s（低于 ${(
            minSpeedBytesPerSec / 1024
          ).toFixed(0)} KB/s），已放弃这个源`
        )
      )
    }, 4000)

    stream.setTimeout(idleTimeoutMs, () => {
      finish(new Error(`下载中断：${idleTimeoutMs}ms 内没有收到任何数据`))
    })
    stream.on('data', (chunk: Buffer) => {
      received += chunk.length
      onProgress(received)
    })
    stream.on('error', (error: Error) =>
      finish(describeStreamError(error, baseSize + received, expectedTotal))
    )
    out.on('error', (error: Error) => finish(error))
    out.on('finish', () => finish())

    stream.pipe(out)
  })
}

/** 从单个源下载到 .part 文件，返回写入后的文件大小 */
async function downloadFromSource(
  source: DownloadSource,
  partFile: string,
  metaFile: string,
  request: DownloadRequest
): Promise<number> {
  const expected = request.sha256.toLowerCase()
  const idleTimeoutMs = request.idleTimeoutMs ?? 30_000

  // 断点续传：只有当侧车文件记录的 URL 与当前源一致时才敢续
  let baseSize = 0
  const meta = await readResumeMeta(metaFile)
  if (meta && meta.url === source.url) {
    const size = await statSize(partFile)
    if (size !== null && size > 0 && (meta.total === null || size <= meta.total)) {
      baseSize = size
    }
  }
  if (baseSize === 0) await rm(partFile, { force: true })

  const headers: Record<string, string> = {}
  if (baseSize > 0) headers.Range = `bytes=${baseSize}-`

  request.onPhase?.('downloading', source.name)

  const response = await requestStream(source.url, {
    headers,
    proxy: request.proxy,
    timeoutMs: request.timeoutMs,
    signal: request.signal
  })

  // 把"源上没有这个文件"与"网络错误"区分开：前者说明该镜像没同步这个版本，
  // 应该直接换下一个源，而不是重试同一个源
  if (response.status === 404 || response.status === 410) {
    response.stream.destroy()
    throw new SourceUnavailableError(
      `该源没有这个文件（HTTP ${response.status}），可能是镜像未同步此版本`
    )
  }
  if (response.status === 403) {
    response.stream.destroy()
    throw new SourceUnavailableError('该源拒绝访问（HTTP 403）')
  }
  if (response.status === 416) {
    response.stream.destroy()
    await rm(partFile, { force: true })
    throw new Error('断点位置已失效（HTTP 416），已丢弃断点，下次将重新下载')
  }
  if (response.status !== 200 && response.status !== 206) {
    response.stream.destroy()
    throw new Error(`HTTP ${response.status}`)
  }

  // 只有 206 才证明服务器接受了 Range；返回 200 说明它忽略了 Range，得从头写
  const resuming = response.status === 206 && baseSize > 0
  if (!resuming) baseSize = 0

  const contentLength = Number(response.headers['content-length'] ?? 0)
  const total =
    Number.isFinite(contentLength) && contentLength > 0
      ? resuming
        ? baseSize + contentLength
        : contentLength
      : (request.sizeBytes ?? null)

  const written = await pipeToFile({
    stream: response.stream,
    file: partFile,
    append: resuming,
    baseSize,
    expectedTotal: total,
    idleTimeoutMs,
    minSpeedBytesPerSec: request.minSpeedBytesPerSec ?? MIN_ACCEPTABLE_BYTES_PER_SEC,
    speedGraceMs: request.speedGraceMs ?? SPEED_GRACE_MS,
    onProgress: (received) =>
      request.onProgress?.({ source: source.name, received: baseSize + received, total }),
    signal: request.signal
  })

  await writeFile(metaFile, JSON.stringify({ url: source.url, total }, null, 2), 'utf8')

  // 提前发现"下少了"：比对声明大小，避免把截断的文件送去校验
  if (request.sizeBytes && written !== request.sizeBytes) {
    throw new Error(`文件大小不符：期望 ${request.sizeBytes} 字节，实际 ${written} 字节`)
  }

  logger.info(
    'download',
    `${source.name} 下载完成：${written} 字节（${shortHash(expected)}）`
  )
  return written
}

export async function downloadFile(request: DownloadRequest): Promise<DownloadResult> {
  const startedAt = Date.now()
  const expected = request.sha256.toLowerCase()
  const attempts: DownloadAttempt[] = []
  const partFile = `${request.targetFile}.part`
  const metaFile = `${partFile}.json`
  const retries = Math.max(1, request.retriesPerSource ?? 2)

  const failed = (error: string): DownloadResult => ({
    ok: false,
    filePath: null,
    attempts,
    bytes: 0,
    durationMs: Date.now() - startedAt,
    sha256: null,
    error
  })

  if (request.sources.length === 0) return failed('没有可用的下载源')

  for (const source of request.sources) {
    if (!request.allowInsecure && new URL(source.url).protocol !== 'https:') {
      return failed(`拒绝非 https 下载地址：${source.url}`)
    }
  }

  await mkdir(dirname(request.targetFile), { recursive: true })

  // 幂等（NFR-2）：目标文件已存在且校验通过就直接复用，不重复下载
  const existingSize = await statSize(request.targetFile)
  if (existingSize !== null) {
    const existingHash = await sha256File(request.targetFile)
    if (existingHash === expected) {
      logger.info('download', `目标文件已存在且校验通过，跳过下载：${request.targetFile}`)
      return {
        ok: true,
        filePath: request.targetFile,
        attempts,
        bytes: existingSize,
        durationMs: Date.now() - startedAt,
        sha256: existingHash,
        error: null
      }
    }
    logger.warn('download', `目标文件已存在但校验不通过，将重新下载：${request.targetFile}`)
    await rm(request.targetFile, { force: true })
  }

  for (const source of request.sources) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (request.signal?.aborted) return failed('已取消')

      const label = `${source.name}${attempt > 1 ? `（第 ${attempt} 次）` : ''}`
      logger.info('download', `开始从 ${label} 下载：${source.url}`)

      try {
        const bytes = await downloadFromSource(source, partFile, metaFile, request)

        request.onPhase?.('verifying', source.name)
        const actual = await sha256File(partFile)
        if (actual !== expected) {
          await rm(partFile, { force: true })
          await rm(metaFile, { force: true })
          throw new Error(
            `SHA-256 校验失败：期望 ${shortHash(expected)}，实际 ${shortHash(actual)}`
          )
        }

        // 校验通过才改名到最终路径 —— 未校验的文件永远不出现在最终位置上
        await rename(partFile, request.targetFile)
        await rm(metaFile, { force: true })

        logger.info('download', `校验通过并落盘：${request.targetFile}`)
        return {
          ok: true,
          filePath: request.targetFile,
          attempts,
          bytes,
          durationMs: Date.now() - startedAt,
          sha256: actual,
          error: null
        }
      } catch (error) {
        const message = (error as Error).message
        attempts.push({ source: source.name, url: source.url, error: message })
        logger.warn('download', `${label} 失败：${message}`)
        if (request.signal?.aborted) return failed('已取消')
        // 源级别的问题（镜像没同步 / 拒绝访问 / 慢到不可用）重试无意义，直接换下一个源
        if (error instanceof SourceUnavailableError || error instanceof SlowSourceError) break
      }
    }
  }

  return failed(
    attempts.length > 0
      ? `所有下载源都失败了。最后一次错误：${attempts[attempts.length - 1].error}`
      : '没有可用的下载源'
  )
}
