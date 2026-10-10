import { join } from 'node:path'
import { app } from 'electron'
import { ensureDir } from './fs'

/**
 * 应用相关路径。这是少数几个依赖 electron 的模块之一，
 * 纯逻辑模块不得 import 它，否则无法在 vitest（无 electron 运行时）里测试。
 */

/** 清单目录：开发期读仓库里的 resources/manifest，打包后读 extraResources */
export function getManifestDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'manifest')
    : join(app.getAppPath(), 'resources', 'manifest')
}

/** %APPDATA%\devkit */
export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getLogDir(): string {
  return join(getUserDataDir(), 'logs')
}

/** 配置/备份目录（FR-6 写环境变量前备份原值用） */
export function getConfigFile(): string {
  return join(getUserDataDir(), 'config.json')
}

export function getBackupDir(): string {
  return ensureDir(join(getUserDataDir(), 'backup'))
}

export function ensureManifestDir(): string {
  return ensureDir(getManifestDir())
}
