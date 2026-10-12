import { basename, dirname, join } from 'node:path'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import type { ToolManifest, ToolVersionSpec } from '@shared/types'
import { runCommand } from '../../utils/exec'
import { logger } from '../report/logger'
import { resolveInstallTemplate, type CommandContext, type InstallerCommand } from '../templates'
import { extractZip, extractZipSingleFile } from '../installer/zip'

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
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
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

  const context: CommandContext = {
    archivePath: request.archivePath,
    installDir: request.installDir,
    logFile: request.logFile,
    version: request.version.version,
    toolId: request.tool.id
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
      dryRun: true
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
        dryRun: false
      }
    }

    if (plan.mode === 'zip-single-file') {
      const result = await extractZipSingleFile({
        zipFile: request.archivePath,
        destDir: request.installDir,
        fileName: plan.fileName,
        subDir: plan.subDir,
        signal: request.signal
      })
      return {
        installDir: request.installDir,
        files: 1,
        bytes: result.bytes,
        logFile: null,
        dryRun: false
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
      return { installDir: request.installDir, files: 0, bytes: size, logFile: null, dryRun: false }
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

  if (command.requiresAdmin && request.runElevatedCommand) {
    // 机器级安装（MSI / 写 HKLM）：交给提权助手，整个作业只弹一次 UAC
    await request.runElevatedCommand(command, request.version.source?.sha256)
  } else {
    await runInstaller(command, request)
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
    dryRun: false
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
