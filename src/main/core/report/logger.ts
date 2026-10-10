import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry, LogLevel } from '@shared/types'
import { ensureDir, timestampSlug } from '../../utils/fs'

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR'
}

const MAX_BUFFER = 3000

/**
 * 日志器：同时落文件（UTF-8）与推送给渲染进程。
 * 不依赖 electron，日志目录由 main 在启动时注入，方便单测。
 */
class Logger {
  private stream: WriteStream | null = null
  private filePath = ''
  private readonly buffer: LogEntry[] = []
  private readonly emitter = new EventEmitter()

  init(logDir: string): string {
    ensureDir(logDir)
    this.filePath = join(logDir, `${timestampSlug()}.log`)
    this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' })
    return this.filePath
  }

  get currentFile(): string {
    return this.filePath
  }

  log(level: LogLevel, scope: string, message: string): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, scope, message }

    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER)

    const line = `[${entry.ts}] [${LEVEL_LABEL[level]}] [${scope}] ${message}\n`
    this.stream?.write(line)

    // 开发期同步打到控制台，方便在没有 UI 的情况下排查启动问题。
    // 跑单测时静默，否则每个下载/检测步骤都会往测试输出里刷日志。
    if (!process.env.VITEST && (!this.stream || process.env.NODE_ENV !== 'production')) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      sink(line.trimEnd())
    }

    this.emitter.emit('line', entry)
  }

  debug(scope: string, message: string): void {
    this.log('debug', scope, message)
  }

  info(scope: string, message: string): void {
    this.log('info', scope, message)
  }

  warn(scope: string, message: string): void {
    this.log('warn', scope, message)
  }

  error(scope: string, message: string): void {
    this.log('error', scope, message)
  }

  /** 读取最近 n 条（渲染进程启动时回填历史日志用） */
  tail(count = 500): LogEntry[] {
    const size = Math.max(0, Math.min(count, this.buffer.length))
    return this.buffer.slice(this.buffer.length - size)
  }

  /** 订阅新日志，返回取消订阅函数 */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.emitter.on('line', listener)
    return () => {
      this.emitter.off('line', listener)
    }
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}

export const logger = new Logger()
export type { Logger }
