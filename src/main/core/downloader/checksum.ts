import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** 流式计算文件的 SHA-256（不把整个文件读进内存，安装包可能上百 MB） */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 便于日志里比对：只显示前 12 位 */
export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…` : '—'
}
