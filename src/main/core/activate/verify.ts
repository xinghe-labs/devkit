import { runCommand } from '../../utils/exec'
import { logger } from '../report/logger'
import { runPowerShell } from './windows'

/**
 * 激活后的"新 shell"验证。
 *
 * 为什么必须单独做这一步：写进 PATH ≠ 生效。winget 的 PATH 相关 bug 几乎全是
 * "写进去了但新开的终端还是找不到命令"（#5678 / #3046）。而 devkit 自己的安装自检
 * 用的是 `{installDir}` 绝对路径 —— 那验证的是"文件装对了"，不是"用户敲命令能找到"。
 *
 * 做法：把机器级 PATH 与用户级 PATH 分别取出来（都已展开），拼成一个"全新进程会看到的 PATH"，
 * 用它当环境变量跑一次用户在终端里会敲的那条命令（取自清单的 detect.commands[0]）。
 * 这不是真的开一个新终端，但环境变量的构成与真实新终端一致。
 */

/** 读展开后的机器级 / 用户级 PATH */
export async function readEffectivePaths(): Promise<{ machine: string; user: string }> {
  const result = await runPowerShell(
    [
      "$m = [Environment]::GetEnvironmentVariable('Path','Machine')",
      "$u = [Environment]::GetEnvironmentVariable('Path','User')",
      "$out = @{ machine = $m; user = $u } | ConvertTo-Json -Compress",
      '$utf8 = New-Object System.Text.UTF8Encoding($false)',
      "[Console]::Out.Write($out)"
    ].join('; '),
    20_000
  )

  try {
    const parsed = JSON.parse(result.stdout.trim()) as { machine?: string; user?: string }
    return { machine: parsed.machine ?? '', user: parsed.user ?? '' }
  } catch {
    logger.warn('activate', `读取生效 PATH 失败：${result.stdout.slice(0, 120)}`)
    return { machine: '', user: '' }
  }
}

export interface ActivationVerifySpec {
  cmd: string
  args?: string[]
  expectRegex?: string
}

export interface ActivationVerifyResult {
  ok: boolean
  /** 命令实际解析到的文件是否属于 devkit（不是系统里原有的那一份） */
  resolvedFromDevkit: boolean
  /** where.exe 给出的第一个命中路径 */
  resolvedPath: string | null
  detail: string
}

/**
 * 用"新终端会看到的环境"跑一次命令。
 *
 * 命令名必须是用户会敲的那个（node / java / go），不能是绝对路径 ——
 * 否则测的还是"文件在不在"，而不是"PATH 通不通"。
 *
 * 还要多做一步 `where.exe`：Windows 的进程 PATH 是「机器级 + 用户级」，
 * 机器级在前。所以如果系统里已经装了同名工具且它在机器级 PATH 里，
 * **用户级里前置的 devkit 条目并不能胜出**。只跑命令看输出版本号会得到假阳性
 * （正则能匹配上系统那份的输出），必须看 where 解析到了哪个文件。
 */
export async function verifyActivation(
  spec: ActivationVerifySpec,
  paths: { machine: string; user: string },
  expectedPrefix: string
): Promise<ActivationVerifyResult> {
  // Windows 的进程 PATH 构成：机器级在前，用户级在后
  const effectivePath = [paths.machine, paths.user].filter((part) => part.trim() !== '').join(';')
  const env = { PATH: effectivePath, Path: effectivePath }

  // 1. 先看命令解析到哪个文件
  let resolvedPath: string | null = null
  const where = await runCommand('where.exe', [spec.cmd], { timeoutMs: 15_000, env })
  if (where.code === 0) {
    resolvedPath = where.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? null
  }

  const resolvedFromDevkit = Boolean(
    resolvedPath && resolvedPath.toLowerCase().startsWith(expectedPrefix.toLowerCase())
  )

  // 2. 再跑一次命令，确认它真的能执行
  const result = await runCommand(spec.cmd, spec.args ?? [], { timeoutMs: 20_000, env })

  if (result.spawnError) {
    return {
      ok: false,
      resolvedFromDevkit,
      resolvedPath,
      detail: `新终端环境里找不到 ${spec.cmd}：${result.spawnError}`
    }
  }

  const output = `${result.stdout}\n${result.stderr}`.trim()
  const firstLine = output.split(/\r?\n/)[0] ?? ''

  if (spec.expectRegex) {
    let pattern: RegExp
    try {
      pattern = new RegExp(spec.expectRegex, 'i')
    } catch (error) {
      return {
        ok: false,
        resolvedFromDevkit,
        resolvedPath,
        detail: `检测正则非法：${(error as Error).message}`
      }
    }
    if (!pattern.test(output)) {
      return {
        ok: false,
        resolvedFromDevkit,
        resolvedPath,
        detail: `新终端环境里 ${spec.cmd} 的输出不符合预期：${firstLine}`
      }
    }
  } else if (result.code !== 0) {
    return {
      ok: false,
      resolvedFromDevkit,
      resolvedPath,
      detail: `新终端环境里 ${spec.cmd} 退出码 ${result.code}：${firstLine}`
    }
  }

  if (!resolvedFromDevkit) {
    return {
      ok: true,
      resolvedFromDevkit: false,
      resolvedPath,
      detail:
        resolvedPath === null
          ? `${spec.cmd} 能执行（${firstLine}），但 where.exe 没给出解析路径`
          : `${spec.cmd} 解析到了 ${resolvedPath}（不是 devkit 装的那份）。` +
            '系统级 PATH 里的同名工具优先级高于用户级 PATH；要改用 devkit 的版本，' +
            `可以直接用 ${expectedPrefix}\\... 下的绝对路径，或先卸掉系统里那一份`
    }
  }

  return {
    ok: true,
    resolvedFromDevkit: true,
    resolvedPath,
    detail: `${spec.cmd} → ${firstLine}（${resolvedPath ?? 'devkit 目录内'}）`
  }
}
