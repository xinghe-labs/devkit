import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function fileExists(file: string): boolean {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

export function readTextFile(file: string): string {
  return readFileSync(file, 'utf8')
}

/** 读 JSON，失败时抛出带文件名的错误（方便日志定位到具体清单） */
export function readJsonFile<T = unknown>(file: string): T {
  const raw = readFileSync(file, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${(error as Error).message}`, { cause: error })
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  ensureDir(dirname(file))
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** 生成 "20261010-043000" 形式的时间戳，用于文件名 */
export function timestampSlug(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function joinIfRelative(base: string, target: string): string {
  return target.includes(':') || target.startsWith('\\\\') ? target : join(base, target)
}
