import { app } from 'electron'
import { normalizeLocale } from '@shared/localized'
import { DEFAULT_LOCALE, type Locale, type MirrorPreference } from '@shared/types'
import { getConfigFile } from '../../utils/app-paths'
import { fileExists, readJsonFile, writeJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'

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
}

const MIRRORS: readonly string[] = ['official', 'huaweicloud', 'aliyun', 'tuna', 'ustc']

const DEFAULTS: UserConfig = {
  locale: DEFAULT_LOCALE,
  autoUpdate: true,
  manifestHotUpdate: true,
  concurrency: 1,
  createRestorePoint: false,
  mirrorPreference: 'official',
  proxy: null
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
    proxy
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

export function setLocale(input: unknown): Locale {
  const locale = normalizeLocale(input)
  saveConfig({ locale })
  logger.info('settings', `界面语言切换为 ${locale}`)
  return locale
}
