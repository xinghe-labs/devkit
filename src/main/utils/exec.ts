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
  /** 取消信号：触发后立即杀掉子进程（安装器可能跑很久，必须能中断） */
  signal?: AbortSignal
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
/**
 * 命令路径的约束：**只禁 cmd 元字符与引号**，不禁空格与中文。
 *
 * 为什么不能像参数那样用纯 ASCII 白名单：devkit 自己的安装目录长这样 ——
 * `%USERPROFILE%\.devkit\versions\maven\3.10.0\bin\mvn.cmd`。
 * 用户名是中文、路径可能带空格，用 ASCII 白名单会把**我们自己装的工具**全部拒之门外
 * （实测：Maven / Gradle / VS Code 的自检都是 .cmd，全部踩到）。
 * 元字符才是真正的风险，所以这里只挡元字符。
 */
const SAFE_COMMAND_PATH = /^[^"&|<>^%!\r\n\t]+$/
/**
 * 参数：**只禁 cmd 元字符、通配符与空白**，不禁中文。
 *
 * 为什么不能是纯 ASCII 白名单：回退路径是给 `.cmd` / `.bat` 用的，而它们的参数里
 * 经常带着 devkit 自己的路径 —— `%USERPROFILE%\.devkit\versions\...`。
 * 用 ASCII 白名单会把中文用户名下的每一次回退都拒掉（实测：假的 .cmd 安装器
 * 收到 `/DIR=C:\Users\张三\AppData\Local\Temp\...` 就被拒了）。
 * 真正的风险是 cmd 的元字符与 %VAR% / 延迟展开，不是汉字。
 */
const SAFE_ARG = /^[^\s"&|<>^%!()*?\r\n\t]+$/

export function isFallbackSafe(cmd: string, args: string[]): boolean {
  return SAFE_COMMAND_PATH.test(cmd) && args.every((arg) => SAFE_ARG.test(arg))
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

    const onAbort = (): void => {
      child.kill()
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
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

  // 需要退回 cmd.exe 的两种情况：
  //  1. 命令根本不存在（ENOENT）—— 例如没装过 Git 时的 git
  //  2. 目标是 .cmd/.bat —— Node 18.20.2 / 20.12.2 起（CVE-2024-27980 的修复），
  //     不带 shell 直接 spawn 批处理文件会抛 EINVAL，而不是像以前那样跑到 cmd.exe 里。
  //     Maven 的 mvn.cmd、Gradle 的 gradle.bat、VS Code 的 code.cmd 都属于这一类。
  const needsShellFallback =
    result.spawnError !== null &&
    (/ENOENT|not found/i.test(result.spawnError) ||
      (/EINVAL/i.test(result.spawnError) && /\.(cmd|bat)$/i.test(cmd)))

  if (needsShellFallback) {
    if (!isFallbackSafe(cmd, args)) {
      return {
        ...result,
        spawnError: `${result.spawnError}（该命令需要 cmd.exe 回退，但命令名或参数含不安全字符，已拒绝执行）`,
        durationMs: Date.now() - startedAt
      }
    }

    const shell = process.env.ComSpec ?? 'cmd.exe'
    // 刻意**不加 /s**：`cmd /d /s /c "带 空格的路径.cmd"` 里 /s 会把整条命令的首尾引号
    // 剥掉，路径里的空格就变成了参数分隔符，命令直接失败（实测 code=1、无输出）。
    // 不加 /s 时 cmd 的引号启发式能正确处理带空格的路径。
    const retried = await spawnOnce(shell, ['/d', '/c', cmd, ...args], options)
    retried.durationMs = Date.now() - startedAt
    // 只有当重试真的跑起来了才采用重试结果，否则保留原始错误（更准确）
    if (!retried.spawnError) return retried
    return { ...retried, spawnError: result.spawnError, durationMs: Date.now() - startedAt }
  }

  result.durationMs = Date.now() - startedAt
  return result
}
