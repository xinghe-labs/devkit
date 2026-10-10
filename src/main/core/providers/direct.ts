import type { ToolManifest, ToolVersionSpec } from '@shared/types'
import { extractZip } from '../installer/zip'
import { resolveInstallTemplate } from '../templates'

/**
 * 直连安装提供者（SPEC §6.3 的 DirectProvider）。
 *
 * 只负责"把已经下载并校验过的文件装到目标目录"这一件事。
 * 下载、校验、自检、状态机都在别处 —— 这样新增一种安装方式时只需要动这个文件。
 */

export interface InstallRequest {
  tool: ToolManifest
  version: ToolVersionSpec
  installDir: string
  archivePath: string
  signal?: AbortSignal
  onProgress?: (files: number, currentFileBytes: number) => void
}

export interface InstallOutcome {
  installDir: string
  files: number
  bytes: number
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export async function installVersion(request: InstallRequest): Promise<InstallOutcome> {
  const resolved = resolveInstallTemplate(request.version.install)
  if (!resolved) {
    throw new InstallError(
      `${request.tool.id} 的版本 ${request.version.version} 没有声明安装模板，无法安装`
    )
  }

  const { template, params } = resolved

  switch (template.id) {
    case 'zip-into-version-dir': {
      const stripComponents = Number.parseInt(params.stripComponents ?? '0', 10)
      const result = await extractZip({
        zipFile: request.archivePath,
        destDir: request.installDir,
        stripComponents: Number.isFinite(stripComponents) ? stripComponents : 0,
        signal: request.signal,
        onProgress: request.onProgress
      })
      return {
        installDir: request.installDir,
        files: result.files,
        bytes: result.bytes
      }
    }

    default:
      // 模板表里新增了条目但忘了实现执行逻辑，这里必须显式失败
      throw new InstallError(`安装模板 ${template.id} 尚未实现执行逻辑`)
  }
}
