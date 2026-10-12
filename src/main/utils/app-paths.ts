import { join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { ensureDir } from './fs'

/**
 * 应用相关路径。这是少数几个依赖 electron 的模块之一，
 * 纯逻辑模块不得 import 它，否则无法在 vitest（无 electron 运行时）里测试。
 *
 * 路径分两类，这个区分很重要：
 *  · **应用数据**（配置、日志、激活记录、备份、预设）→ `%APPDATA%\devkit\`，
 *    都很小，跟着应用走。
 *  · **批量产物**（版本目录、切换链接、下载缓存）→ `getDataRoot()` 下面。
 *    实测能到几 GB，所以必须有办法挪到别的盘（见 getDataRoot 的说明）。
 */

let dataRootOverride: string | null = null

/**
 * 允许主进程在读完配置后覆盖数据根目录。
 * 用 setter 而不是直接读配置，是为了避开 app-paths ↔ settings 的循环依赖
 * （settings 要 import 本模块拿 getConfigFile）。
 */
export function setDataRootOverride(dir: string | null): void {
  dataRootOverride = dir && dir.trim() !== '' ? dir.trim() : null
}

function homeDir(): string {
  try {
    return app.getPath('home')
  } catch {
    // 脚本模式（tsx）里没有 electron 运行时；用 node:os 的等价实现
    return homedir()
  }
}

/**
 * 批量产物的根目录。
 *
 * 优先级：环境变量 `DEVKIT_DATA_ROOT` → 主进程设置 → `%USERPROFILE%\.devkit`
 *
 * 为什么要单独抽出来：版本目录 + 下载缓存都是**批量产物**（实测下载缓存能到 1 GB、
 * 版本目录能到几 GB），而 `%APPDATA%` 与 `%USERPROFILE%` 都在系统盘上。
 * 给一个能改的根目录，用户就能把它们整体挪到别的盘。
 */
export function getDataRoot(): string {
  const fromEnv = process.env.DEVKIT_DATA_ROOT
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  if (dataRootOverride) return dataRootOverride
  return join(homeDir(), '.devkit')
}

/** 给界面显示用：这个根目录是从哪来的 */
export function describeDataRoot(): { path: string; source: 'env' | 'config' | 'default' } {
  const fromEnv = process.env.DEVKIT_DATA_ROOT
  if (fromEnv && fromEnv.trim() !== '') return { path: fromEnv.trim(), source: 'env' }
  if (dataRootOverride) return { path: dataRootOverride, source: 'config' }
  return { path: join(homeDir(), '.devkit'), source: 'default' }
}

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
 * 用户级版本目录：<dataRoot>\versions\<tool>\<version>\
 *
 * 默认落在 `%USERPROFILE%\.devkit\versions\`。装在这里而不是 Program Files，
 * 是「安装 ≠ 激活」原则的落地：不需要管理员、不覆盖系统里已有的同名工具、不动 PATH。
 */
export function getVersionsRoot(): string {
  return join(getDataRoot(), 'versions')
}

/**
 * 下载缓存目录（`.part` 断点文件也在这里）。
 *
 * 刻意放在 dataRoot 而不是 userData：这是**批量产物**（实测能到 1 GB），
 * 而且命令行脚本（scripts/install-tool.ts）与应用必须用**同一个**缓存 ——
 * 之前两者一个在 %APPDATA%、一个在 %USERPROFILE%，同一个文件会各下一份。
 */
export function getDownloadDir(): string {
  return ensureDir(join(getDataRoot(), 'downloads'))
}

/**
 * 切换链接根目录：<dataRoot>\current\
 *
 * 每个工具一个 junction（目录联接）指向当前激活的版本。
 * junction 在 Windows 上**不需要管理员权限**（这点与符号链接不同），
 * 而且切版本只改 junction 指向，不用改 PATH —— 这正是 FR-11 想要的形态。
 */
export function getCurrentRoot(): string {
  return join(getDataRoot(), 'current')
}

/** 预留给未来的 shim 目录：<dataRoot>\bin */
export function getShimDir(): string {
  return join(getDataRoot(), 'bin')
}

/** 激活记录（FR-11 回滚依据）：%APPDATA%\devkit\activated.json */
export function getActivationFile(): string {
  return join(getUserDataDir(), 'activated.json')
}

/**
 * 用户清单覆盖目录：%APPDATA%\devkit\manifest\
 *
 * 热更新（FR-15）把白名单过滤后的清单写到这里，启动时优先于内置清单。
 * 放在用户数据目录而不是安装目录：便携版可能装在只读位置，而且这样升级 devkit
 * 不会把用户更新的清单冲掉。
 */
export function getUserManifestDir(): string {
  return join(getUserDataDir(), 'manifest')
}

/** 用户自建预设目录：%APPDATA%\devkit\presets\ */
export function getPresetDir(): string {
  return ensureDir(join(getUserDataDir(), 'presets'))
}

/** 离线包目录：%APPDATA%\devkit\offline\（只是保存对话框的默认位置） */
export function getOfflineDir(): string {
  return ensureDir(join(getUserDataDir(), 'offline'))
}

export function getBackupDir(): string {
  return ensureDir(join(getUserDataDir(), 'backup'))
}

export function ensureManifestDir(): string {
  return ensureDir(getManifestDir())
}
