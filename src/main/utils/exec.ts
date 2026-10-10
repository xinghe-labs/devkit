import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** spawn 本身失败（如命令不存在）时的错误信息，非进程退出码 */
  spawnError: string | null
  durationMs: number
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 解码子进程输出。
 *
 * 中文 Windows 上控制台可能是 GBK(cp936)，Node 拿到的永远是原始字节。
 * 按 UTF-8 → GB18030 → latin1 依次尝试：
 * - 版本号这类内容全是 ASCII，两种编码下一致，走 UTF-8 就对了
 * - cmd.exe / PowerShell 的中文报错是 GBK，UTF-8 严格解码会失败，退到 GB18030（GBK 的超集）
 * - 最后用 latin1 兜底，至少不丢字节（可能乱码，但比丢信息好）
 * 需要精确中文输出的场景应在命令侧强制 UTF-8，见 SPEC NFR-5。
 */
const decoderCache = new Map<string, TextDecoder>()

function strictDecoder(label: string): TextDecoder | null {
  const cached = decoderCache.get(label)
  if (cached) return cached
  try {
    const decoder = new TextDecoder(label, { fatal: true })
    decoderCache.set(label, decoder)
    return decoder
  } catch {
    return null
  }
}

function decode(buffer: Buffer): string {
  for (const label of ['utf-8', 'gb18030']) {
    const decoder = strictDecoder(label)
    if (!decoder) continue
    try {
      return decoder.decode(buffer)
    } catch {
      // 该编码解不开，试下一个
    }
  }
  return buffer.toString('latin1')
}

/**
 * cmd.exe 回退路径的参数白名单。
 *
 * 为什么不直接拼接并加引号 —— 实测结论（Windows 11 / cmd.exe）：
 *   · 把参数分开传给 cmd.exe：`&` `|` `>` `^` 会被真的解释成命令分隔符与重定向
 *   · 拼接成一条命令串再交给 Node 转义：元字符确实被挡住了，
 *     但 Node 的转义会给含空格的参数塞进多余的反斜杠（cmd 不认 \" 转义）
 *   · windowsVerbatimArguments:true：元字符又不受保护
 * 也就是说，没有任何一种拼法同时做到"正确"和"安全"。
 *
 * 与其和 cmd 的引号规则搏斗，不如从源头限制：回退路径只接受
 * 不含空白、引号与 cmd 元字符的简单参数 —— 版本检测参数（-v / --version / -3）
 * 全是这种形态。不满足就报错，绝不"尽力而为"地拼一条命令出去。
 */
const SAFE_COMMAND = /^[A-Za-z0-9_\-./:\\]+$/
const SAFE_ARG = /^[A-Za-z0-9_\-./:=@+,]+$/

export function isFallbackSafe(cmd: string, args: string[]): boolean {
  return SAFE_COMMAND.test(cmd) && args.every((arg) => SAFE_ARG.test(arg))
}

function spawnOnce(cmd: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const empty: RunResult = {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: null,
      durationMs: 0
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ ...empty, spawnError: (error as Error).message })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    let spawnError: string | null = null
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: decode(Buffer.concat(stdoutChunks)),
        stderr: decode(Buffer.concat(stderrChunks)),
        timedOut,
        spawnError,
        durationMs: 0
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error: Error) => {
      spawnError = error.message
      // 'error' 之后 'close' 仍会触发；这里兜底一次，避免极少数情况下只发 error
      finish(null)
    })
    child.on('close', (code: number | null) => finish(code))
  })
}

/**
 * 执行命令并捕获输出。
 *
 * 不带 shell 执行（避免命令拼接注入，NFR-1）；若因 `.cmd`/`.bat` shim
 * 导致 ENOENT，则在参数通过白名单校验后，退回 `cmd.exe /d /s /c` 再试一次。
 */
export async function runCommand(
  cmd: string,
  args: string[] = [],
  options: RunOptions = {}
): Promise<RunResult> {
  const startedAt = Date.now()
  const result = await spawnOnce(cmd, args, options)

  if (result.spawnError && /ENOENT|not found/i.test(result.spawnError)) {
    if (!isFallbackSafe(cmd, args)) {
      return {
        ...result,
        spawnError: `${result.spawnError}（该命令需要 cmd.exe 回退，但命令名或参数含不安全字符，已拒绝执行）`,
        durationMs: Date.now() - startedAt
      }
    }

    const shell = process.env.ComSpec ?? 'cmd.exe'
    const retried = await spawnOnce(shell, ['/d', '/s', '/c', cmd, ...args], options)
    retried.durationMs = Date.now() - startedAt
    // 只有当重试真的跑起来了才采用重试结果，否则保留原始错误（更准确）
    if (!retried.spawnError) return retried
    return { ...retried, spawnError: result.spawnError, durationMs: Date.now() - startedAt }
  }

  result.durationMs = Date.now() - startedAt
  return result
}
