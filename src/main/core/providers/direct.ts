import { basename, dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { compareVersions } from '@shared/version'
import type { ToolManifest, ToolVersionSpec } from '@shared/types'
import { runCommand } from '../../utils/exec'
import { getCurrentRoot } from '../../utils/app-paths'
import { logger } from '../report/logger'
import { resolveInstallTemplate, type CommandContext, type InstallerCommand } from '../templates'
import { extractZip, extractZipSingleFile } from '../installer/zip'
import { diffPathEntries } from '../activate/paths'
import { readUserPath, writeUserPath } from '../activate/windows'

/**
 * 直连安装提供者（SPEC §6.3 的 DirectProvider）。
 *
 * 只负责"把已经下载并校验过的文件装到目标目录"这一件事。
 * 下载、校验、自检、状态机都在别处 —— 这样新增一种安装方式时只需要动这个文件
 * 与 templates 里的模板声明。
 */

export interface InstallRequest {
  tool: ToolManifest
  version: ToolVersionSpec
  installDir: string
  archivePath: string
  /** 安装器日志落盘位置 */
  logFile: string
  /** 只演练不执行（VM 验收前的干跑） */
  dryRun?: boolean
  /**
   * 需要管理员的安装命令交给它执行（常驻提权助手，一次 UAC 干完所有事）。
   * 不传时直接执行 —— 已经是管理员的场景（或在 CI 里）能跑通，普通用户会看到权限错误。
   */
  runElevatedCommand?: (command: InstallerCommand, verifySha256?: string) => Promise<void>
  signal?: AbortSignal
  onProgress?: (files: number, currentFileBytes: number) => void
  onCommand?: (command: { cmd: string; args: string[] }) => void
}

export interface InstallOutcome {
  installDir: string
  files: number
  bytes: number
  /** 安装器写日志的位置，失败时要提示用户去看 */
  logFile: string | null
  /** 干跑模式没有真正执行任何安装器 */
  dryRun: boolean
  /**
   * 安装器自己往用户 PATH 里加的条目（已被 devkit 还原）。
   *
   * 为什么必须管这件事：devkit 的原则是「安装 ≠ 激活」，PATH 归激活机制统一管。
   * 但有些官方安装器（实测 VS Code 的 Inno 安装器）会**自己**往用户 PATH 写一条目录，
   * 于是用户没点过「激活」命令却能用了 —— 状态与界面不一致，而且那条 PATH 不受
   * devkit 的记录管理，将来卸载时也没人清它。
   * 试过用 /MERGETASKS=!addtopath 阻止，实测无效，所以改成"事后还原 + 明确告知"。
   */
  revertedPathEntries: string[]
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/**
 * 解析 npm 可执行文件。
 *
 * 顺序：devkit 激活的 Node.js → devkit 装过的最新 Node.js → PATH 上的 npm。
 * 为什么不能只用 PATH：devkit 的模型是「装进版本目录但不一定激活」，
 * 用户完全可能刚用 devkit 装了 Node.js 却没点激活，这时 PATH 上根本没有 npm。
 */
function resolveNpmCmd(): { cmd: string; fromDevkit: boolean } {
  // 1) 激活链接
  try {
    const activated = join(getCurrentRoot(), 'nodejs', 'npm.cmd')
    if (existsSync(activated)) return { cmd: activated, fromDevkit: true }
  } catch {
    // 脚本模式（tsx）里没有 electron 运行时，getCurrentRoot 会抛；忽略即可
  }

  // 2) 版本目录里最新的一个 Node.js
  try {
    const root = join(homedir(), '.devkit', 'versions', 'nodejs')
    if (existsSync(root)) {
      const versions = readdirSync(root)
        .filter((name) => /^\d/.test(name))
        .sort((a, b) => compareVersions(b, a))
      for (const version of versions) {
        const candidate = join(root, version, 'npm.cmd')
        if (existsSync(candidate)) return { cmd: candidate, fromDevkit: true }
      }
    }
  } catch {
    // 读不到就当没有
  }

  // 3) 交给 PATH
  return { cmd: 'npm.cmd', fromDevkit: false }
}

/** 安装器最长允许跑 30 分钟（VS Code / Python 这类在慢机器上可能要几分钟） */
const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000

async function runInstaller(
  command: InstallerCommand,
  request: InstallRequest
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  request.onCommand?.({ cmd: command.cmd, args: command.args })
  logger.info(
    'installer',
    `执行安装器：${basename(command.cmd)} ${command.args
      .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
      .join(' ')}`
  )

  const result = await runCommand(command.cmd, command.args, {
    timeoutMs: INSTALLER_TIMEOUT_MS,
    env: command.env,
    signal: request.signal
  })

  if (result.spawnError) {
    throw new InstallError(`安装器无法启动：${result.spawnError}`)
  }
  if (result.timedOut) {
    throw new InstallError(`安装器超时（${INSTALLER_TIMEOUT_MS / 60000} 分钟）未结束，已终止`)
  }

  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code !== 0) {
    throw new InstallError(
      `安装器退出码 ${result.code}。${output ? `输出：${output.split(/\r?\n/).slice(0, 3).join(' | ')}` : ''}` +
        `（安装器日志：${request.logFile}）`
    )
  }

  if (output) {
    logger.info('installer', `安装器输出：${output.split(/\r?\n/).slice(0, 3).join(' | ')}`)
  }
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** 统计目录占用（用于安装结果与卸载前的展示） */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  const { readdir } = await import('node:fs/promises')
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // 文件在统计过程中被删掉，忽略
        }
      }
    }
  }
  try {
    await walk(dir)
  } catch {
    return 0
  }
  return total
}

export async function installVersion(request: InstallRequest): Promise<InstallOutcome> {
  const resolved = resolveInstallTemplate(request.version.install)
  if (!resolved) {
    throw new InstallError(
      `${request.tool.id} 的版本 ${request.version.version} 没有声明安装模板，无法安装`
    )
  }

  const npm = resolveNpmCmd()

  // npm 类模板的前置检查：给一条能直接照做的报错，而不是让用户看到
  // 「spawn npm.cmd ENOENT」这种无从下手的消息
  if (resolved.template.type === 'npm' && !request.dryRun) {
    const probe = await runCommand(npm.cmd, ['--version'], { timeoutMs: 30_000 })
    if (probe.spawnError || probe.code !== 0) {
      throw new InstallError(
        `${request.tool.id} 需要通过 npm 安装，但没找到可用的 npm。\n` +
          'npm 随 Node.js 一起提供：请在 devkit 里把 Node.js 一起勾选安装（或先装好 Node.js 再回来）。\n' +
          `已尝试的 npm 路径：${npm.cmd}${probe.spawnError ? `（${probe.spawnError}）` : ''}`
      )
    }
  }

  const context: CommandContext = {
    archivePath: request.archivePath,
    installDir: request.installDir,
    logFile: request.logFile,
    version: request.version.version,
    toolId: request.tool.id,
    npmCmd: npm.cmd
  }

  if (request.dryRun) {
    const preview = resolved.buildCommand ? resolved.buildCommand(context) : null
    if (preview) request.onCommand?.({ cmd: preview.cmd, args: preview.args })
    logger.info('installer', `[dry-run] 跳过实际安装：${request.tool.id}@${request.version.version}`)
    return {
      installDir: request.installDir,
      files: 0,
      bytes: 0,
      logFile: preview ? request.logFile : null,
      dryRun: true,
      revertedPathEntries: []
    }
  }

  // ---- 解压类模板 ----
  if (resolved.extract) {
    const plan = resolved.extract

    if (plan.mode === 'zip') {
      const result = await extractZip({
        zipFile: request.archivePath,
        destDir: request.installDir,
        stripComponents: plan.stripComponents,
        signal: request.signal,
        onProgress: request.onProgress
      })
      return {
        installDir: request.installDir,
        files: result.files,
        bytes: result.bytes,
        logFile: null,
        dryRun: false,
        revertedPathEntries: []
      }
    }

    if (plan.mode === 'zip-single-file') {
      const result = await extractZipSingleFile({
        zipFile: request.archivePath,
        destDir: request.installDir,
        fileName: plan.fileName,
        subDir: plan.subDir,
        asName: plan.asName,
        signal: request.signal
      })
      return {
        installDir: request.installDir,
        files: 1,
        bytes: result.bytes,
        logFile: null,
        dryRun: false,
        revertedPathEntries: []
      }
    }

    if (plan.mode === '7zsfx') {
      await mkdir(request.installDir, { recursive: true })
      const command: InstallerCommand = {
        cmd: request.archivePath,
        args: [`-o${request.installDir}`, '-y', '-bso0', '-bsp0'],
        requiresAdmin: false
      }
      request.onCommand?.({ cmd: command.cmd, args: command.args })
      logger.info('installer', `7-Zip 自解压：${basename(request.archivePath)} → ${request.installDir}`)

      const result = await runCommand(command.cmd, command.args, {
        timeoutMs: INSTALLER_TIMEOUT_MS,
        signal: request.signal
      })
      if (result.spawnError) throw new InstallError(`自解压包无法启动：${result.spawnError}`)
      // 7-Zip SFX 在部分版本上即使成功也返回非 0；以"目录里确实有文件"为准
      const size = await directorySize(request.installDir)
      if (size === 0) {
        throw new InstallError(
          `自解压失败：目标目录仍为空（退出码 ${result.code}）。` +
            `${`${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(0, 2).join(' | ')}`
        )
      }
      return {
        installDir: request.installDir,
        files: 0,
        bytes: size,
        logFile: null,
        dryRun: false,
        revertedPathEntries: []
      }
    }
  }

  // ---- 安装器类模板 ----
  if (!resolved.buildCommand) {
    throw new InstallError(`模板 ${resolved.template.id} 既不是解压类也不是安装器类，无法执行`)
  }

  const command = resolved.buildCommand(context)

  // 安装器可能不理会我们给的目录（rustup 这类靠环境变量），先建好目录并统计前后差异
  await mkdir(request.installDir, { recursive: true })
  await mkdir(dirname(request.logFile), { recursive: true })

  // 安装器类模板可能自己改用户 PATH，跑之前先留一份原文用于比对。
  // 只有 exe/msi 类需要；zip 解压不可能改环境变量。
  const pathBefore = await readUserPath().catch(() => null)

  if (command.requiresAdmin && request.runElevatedCommand) {
    // 机器级安装（MSI / 写 HKLM）：交给提权助手，整个作业只弹一次 UAC
    await request.runElevatedCommand(command, request.version.source?.sha256)
  } else {
    await runInstaller(command, request)
  }

  const revertedPathEntries: string[] = []
  if (pathBefore !== null) {
    try {
      const pathAfter = await readUserPath()
      if (pathAfter !== pathBefore) {
        const added = diffPathEntries(pathBefore, pathAfter)

        await writeUserPath(pathBefore)
        revertedPathEntries.push(...added)
        logger.warn(
          'installer',
          `${request.tool.id} 的安装器自己改了用户 PATH，已还原。被移除的条目：` +
            `${added.join('、') || '（无法定位具体条目，已整体还原）'}。` +
            '需要让命令可用请在 devkit 里点「激活」。'
        )
      }
    } catch (error) {
      logger.warn('installer', `检查/还原用户 PATH 失败：${(error as Error).message}`)
    }
  }

  const size = await directorySize(request.installDir)
  if (command.installsOutsideVersionDir && size === 0) {
    throw new InstallError(
      `安装器报告成功，但 ${request.installDir} 里没有任何文件。请查看安装器日志：${request.logFile}`
    )
  }

  return {
    installDir: request.installDir,
    files: 0,
    bytes: size,
    logFile: request.logFile,
    dryRun: false,
    revertedPathEntries
  }
}

/** 卸载时用：把一个目录整体删掉（只允许删版本目录之下的路径） */
export async function removeInstallDir(installDir: string, versionsRoot: string): Promise<void> {
  const normalizedRoot = versionsRoot.replace(/[\\/]+$/, '').toLowerCase()
  const normalizedTarget = installDir.replace(/[\\/]+$/, '').toLowerCase()
  if (!normalizedTarget.startsWith(`${normalizedRoot}\\`) && normalizedTarget !== normalizedRoot) {
    throw new InstallError(`拒绝删除版本目录之外的路径：${installDir}`)
  }
  await rm(installDir, { recursive: true, force: true })
}

/** 把文件从临时位置搬到版本目录（离线包安装用） */
export async function copyIntoPlace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}
