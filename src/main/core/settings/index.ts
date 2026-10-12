import { app } from 'electron'
import { normalizeLocale } from '@shared/localized'
import {
  DEFAULT_LOCALE,
  MIRROR_TARGETS,
  type Locale,
  type MirrorPreference,
  type MirrorSetting,
  type MirrorTarget,
  type UserConfigView
} from '@shared/types'
import { getConfigFile } from '../../utils/app-paths'
import { fileExists, readJsonFile, writeJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'
import { readActivationState } from '../activate'

export interface UserConfig {
  locale: Locale
  /** 启动时检查 GitHub Release 更新（FR-13） */
  autoUpdate: boolean
  /** 启动时拉取最新清单（FR-15） */
  manifestHotUpdate: boolean
  /** 1 = 串行；最大 3（FR-4） */
  concurrency: number
  /** 安装前创建系统还原点（FR-10） */
  createRestorePoint: boolean
  /** 下载优先使用哪个源（FR-5） */
  mirrorPreference: MirrorPreference
  /** http://host:port；null = 跟随系统 */
  proxy: string | null
  /** 安装成功后自动激活（写用户 PATH 与环境变量） */
  activateAfterInstall: boolean
  /** 安装成功后自动写 npm/pip/git 镜像源 */
  configureMirrors: boolean
  /** 各镜像目标的取值 */
  mirrors: MirrorSetting[]
}

const MIRRORS: readonly string[] = ['official', 'huaweicloud', 'aliyun', 'tuna', 'ustc']

/** 默认镜像源：npm 与 pip 用国内镜像（国内开发者的实际选择） */
const DEFAULT_MIRROR_URLS: Record<MirrorTarget, string> = {
  npm: 'https://registry.npmmirror.com',
  pip: 'https://pypi.tuna.tsinghua.edu.cn/simple'
}

const DEFAULTS: UserConfig = {
  locale: DEFAULT_LOCALE,
  autoUpdate: true,
  manifestHotUpdate: true,
  concurrency: 1,
  createRestorePoint: false,
  mirrorPreference: 'official',
  proxy: null,
  activateAfterInstall: true,
  configureMirrors: false,
  mirrors: MIRROR_TARGETS.map((target) => ({
    target,
    enabled: true,
    url: DEFAULT_MIRROR_URLS[target]
  }))
}

let cache: UserConfig | null = null

/** 首次运行时按系统语言初始化，而不是一律中文 */
function systemLocale(): Locale {
  try {
    return normalizeLocale(app.getLocale())
  } catch {
    return DEFAULT_LOCALE
  }
}

const MIRROR_URL_PATTERN = /^https:\/\/[^\s"'`<>|]{3,200}$/

function sanitizeMirrors(raw: unknown): MirrorSetting[] {
  const input = Array.isArray(raw) ? raw : []
  return MIRROR_TARGETS.map((target) => {
    const found = input.find(
      (item): item is Partial<MirrorSetting> =>
        typeof item === 'object' && item !== null && (item as MirrorSetting).target === target
    )
    const url = typeof found?.url === 'string' ? found.url.trim() : DEFAULT_MIRROR_URLS[target]
    const safeUrl = url === '' || MIRROR_URL_PATTERN.test(url) ? url : DEFAULT_MIRROR_URLS[target]
    return {
      target,
      enabled: found?.enabled === true,
      url: safeUrl
    }
  })
}

function sanitize(raw: unknown): UserConfig {
  const input = (raw ?? {}) as Partial<UserConfig>
  const concurrency = Number(input.concurrency)
  const mirror = String(input.mirrorPreference ?? DEFAULTS.mirrorPreference)
  const proxy = typeof input.proxy === 'string' && input.proxy.trim() !== '' ? input.proxy.trim() : null

  return {
    locale: normalizeLocale(input.locale ?? systemLocale()),
    autoUpdate: input.autoUpdate !== false,
    manifestHotUpdate: input.manifestHotUpdate !== false,
    concurrency: Number.isFinite(concurrency) ? Math.min(3, Math.max(1, concurrency)) : 1,
    createRestorePoint: input.createRestorePoint === true,
    mirrorPreference: MIRRORS.includes(mirror) ? (mirror as MirrorPreference) : 'official',
    proxy,
    activateAfterInstall: input.activateAfterInstall !== false,
    configureMirrors: input.configureMirrors === true,
    mirrors: sanitizeMirrors(input.mirrors)
  }
}

export function loadConfig(): UserConfig {
  if (cache) return cache

  const file = getConfigFile()
  if (!fileExists(file)) {
    cache = { ...DEFAULTS, locale: systemLocale() }
    return cache
  }

  try {
    cache = sanitize(readJsonFile(file))
  } catch (error) {
    logger.warn('settings', `配置文件损坏，已回退默认值：${(error as Error).message}`)
    cache = { ...DEFAULTS, locale: systemLocale() }
  }
  return cache
}

export function saveConfig(patch: Partial<UserConfig>): UserConfig {
  const next = sanitize({ ...loadConfig(), ...patch })
  cache = next
  try {
    writeJsonFile(getConfigFile(), next)
  } catch (error) {
    logger.error('settings', `写入配置失败：${(error as Error).message}`)
  }
  return next
}

export function getLocale(): Locale {
  return loadConfig().locale
}

/** 给界面用的配置视图（带上 PATH 备份文件等运行期信息） */
export function getConfigView(): UserConfigView {
  const config = loadConfig()
  return { ...config, pathBackupFile: readActivationState().backupFile }
}

/** 只允许从界面改这些字段；其余（如 locale）走专门的 setLocale */
export function saveConfigView(patch: unknown): UserConfigView {
  const input = (patch ?? {}) as Partial<UserConfigView>
  const allowed: Partial<UserConfig> = {}

  if (typeof input.autoUpdate === 'boolean') allowed.autoUpdate = input.autoUpdate
  if (typeof input.manifestHotUpdate === 'boolean') allowed.manifestHotUpdate = input.manifestHotUpdate
  if (typeof input.activateAfterInstall === 'boolean') allowed.activateAfterInstall = input.activateAfterInstall
  if (typeof input.configureMirrors === 'boolean') allowed.configureMirrors = input.configureMirrors
  if (typeof input.createRestorePoint === 'boolean') allowed.createRestorePoint = input.createRestorePoint
  if (typeof input.concurrency === 'number') allowed.concurrency = input.concurrency
  if (typeof input.mirrorPreference === 'string') {
    allowed.mirrorPreference = input.mirrorPreference as MirrorPreference
  }
  if (input.proxy === null || typeof input.proxy === 'string') allowed.proxy = input.proxy
  if (Array.isArray(input.mirrors)) allowed.mirrors = sanitizeMirrors(input.mirrors)

  saveConfig(allowed)
  return getConfigView()
}

export function setLocale(input: unknown): Locale {
  const locale = normalizeLocale(input)
  saveConfig({ locale })
  logger.info('settings', `界面语言切换为 ${locale}`)
  return locale
}
