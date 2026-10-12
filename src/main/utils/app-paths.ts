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

/** 未完成安装计划的持久化位置（FR-17 重启续跑） */
export function getPendingPlanFile(): string {
  return join(getUserDataDir(), 'pending.json')
}

/**
 * 用户级版本目录：%USERPROFILE%\.devkit\versions\<tool>\<version>\
 *
 * 装在这里而不是 Program Files，是「安装 ≠ 激活」原则的落地：
 * 不需要管理员、不覆盖系统里已有的同名工具、不动 PATH。
 */
export function getVersionsRoot(): string {
  return join(app.getPath('home'), '.devkit', 'versions')
}

/** 下载缓存目录（.part 断点文件也在这里） */
export function getDownloadDir(): string {
  return ensureDir(join(getUserDataDir(), 'downloads'))
}

/**
 * 切换链接根目录：%USERPROFILE%\.devkit\current\
 *
 * 每个工具一个 junction（目录联接）指向当前激活的版本。
 * junction 在 Windows 上**不需要管理员权限**（这点与符号链接不同），
 * 而且切版本只改 junction 指向，不用改 PATH —— 这正是 FR-11 想要的形态。
 */
export function getCurrentRoot(): string {
  return join(app.getPath('home'), '.devkit', 'current')
}

/** 预留给未来的 shim 目录：%USERPROFILE%\.devkit\bin */
export function getShimDir(): string {
  return join(app.getPath('home'), '.devkit', 'bin')
}

/** 激活记录（FR-11 回滚依据）：%APPDATA%\devkit\activated.json */
export function getActivationFile(): string {
  return join(getUserDataDir(), 'activated.json')
}

/** 用户自建预设目录：%APPDATA%\devkit\presets\ */
export function getPresetDir(): string {
  return ensureDir(join(getUserDataDir(), 'presets'))
}

/** 离线包目录：%APPDATA%\devkit\offline\ */
export function getOfflineDir(): string {
  return ensureDir(join(getUserDataDir(), 'offline'))
}

export function getBackupDir(): string {
  return ensureDir(join(getUserDataDir(), 'backup'))
}

export function ensureManifestDir(): string {
  return ensureDir(getManifestDir())
}
