import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

/**
 * ZIP 解压。
 *
 * 安全关键：ZIP 是攻击面。恶意压缩包可以用 `../` 或绝对路径把文件写到目标目录之外
 * （zip slip）。这里不依赖任何库的默认行为，自己算并校验最终路径 —— 见 resolveEntryPath。
 * 符号链接条目也一律拒绝：Windows 上解出符号链接没有正当用途，只会带来意外。
 */

export class ZipSlipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipSlipError'
  }
}

export interface ExtractOptions {
  zipFile: string
  destDir: string
  /** 去掉压缩包顶部的目录层数（Node 的 zip 有一层 node-v24.21.0-win-x64/） */
  stripComponents?: number
  onProgress?: (extracted: number, total: number) => void
  signal?: AbortSignal
}

export interface ExtractResult {
  files: number
  bytes: number
}

/**
 * 计算某个压缩包条目应该落到哪个绝对路径。
 * 返回 null 表示该条目应被跳过（是目录项，或被 stripComponents 削没了）。
 *
 * 校验规则（任一不满足即抛 ZipSlipError）：
 *  1. 不允许出现 `..` 段
 *  2. 不允许绝对路径（`/x`、`\x`）或盘符（`C:`）
 *  3. 拼出的最终路径必须仍在 destDir 之内
 */
export function resolveEntryPath(
  destDir: string,
  entryName: string,
  stripComponents = 0
): string | null {
  if (entryName.includes('\0')) {
    throw new ZipSlipError(`条目名包含空字节：${JSON.stringify(entryName)}`)
  }

  const normalized = entryName.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    throw new ZipSlipError(`条目使用了绝对路径：${entryName}`)
  }

  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.')

  if (parts.some((part) => part === '..')) {
    throw new ZipSlipError(`条目试图跳出目标目录（含 ..）：${entryName}`)
  }
  if (parts.length > 0 && /^[a-zA-Z]:/.test(parts[0])) {
    throw new ZipSlipError(`条目包含盘符：${entryName}`)
  }

  const stripped = parts.slice(stripComponents)
  if (stripped.length === 0) return null

  const resolved = join(destDir, ...stripped)
  const rel = relative(destDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ZipSlipError(`条目落点超出目标目录：${entryName} → ${resolved}`)
  }

  return resolved
}

/** 判断是否为符号链接条目（unix mode 位于 externalFileAttributes 高 16 位） */
export function isSymlinkEntry(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0o170000
  return mode === 0o120000
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, zipfile) => {
      if (error) reject(error)
      else resolve(zipfile)
    })
  })
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

/** 把 yauzl 的事件式读取包装成 async 迭代器，便于按顺序处理每个条目 */
async function* iterateEntries(zipfile: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  const queue: yauzl.Entry[] = []
  let done = false
  let failure: Error | null = null
  let notify: (() => void) | null = null

  const wake = (): void => {
    const resolve = notify
    notify = null
    resolve?.()
  }

  zipfile.on('entry', (entry: yauzl.Entry) => {
    queue.push(entry)
    wake()
  })
  zipfile.on('end', () => {
    done = true
    wake()
  })
  zipfile.on('error', (error: Error) => {
    failure = error
    wake()
  })

  zipfile.readEntry()

  for (;;) {
    if (failure) throw failure
    const entry = queue.shift()
    if (entry) {
      yield entry
      zipfile.readEntry()
      continue
    }
    if (done) return
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
}

export async function extractZip(options: ExtractOptions): Promise<ExtractResult> {
  const strip = options.stripComponents ?? 0
  const zipfile = await openZip(options.zipFile)

  let files = 0
  let bytes = 0

  try {
    for await (const entry of iterateEntries(zipfile)) {
      if (options.signal?.aborted) throw new Error('解压已取消')

      const isDirectory = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')

      if (isSymlinkEntry(entry.externalFileAttributes)) {
        throw new ZipSlipError(`压缩包内含符号链接条目，已拒绝解压：${entry.fileName}`)
      }

      const target = resolveEntryPath(options.destDir, entry.fileName, strip)
      if (target === null) continue

      if (isDirectory) {
        await mkdir(target, { recursive: true })
        continue
      }

      await mkdir(dirname(target), { recursive: true })
      const stream = await openEntryStream(zipfile, entry)
      await pipeline(stream, createWriteStream(target))

      files += 1
      bytes += entry.uncompressedSize
      options.onProgress?.(files, entry.uncompressedSize)
    }
  } finally {
    zipfile.close()
  }

  return { files, bytes }
}
