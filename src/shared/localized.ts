import { DEFAULT_LOCALE, LOCALES, type Locale, type LocalizedText } from './types'

/**
 * 语言回退链（SPEC FR-14）：
 *   当前语言 → zh-CN → en-US → 清单里第一个可用值
 * 保证任何情况下都返回非空字符串，UI 永远不会出现 undefined / 空白。
 */
export function localizedText(
  text: LocalizedText | undefined | null,
  locale: Locale,
  fallback = ''
): string {
  if (!text) return fallback

  const chain: Locale[] = [locale, ...LOCALES.filter((item) => item !== locale)]
  for (const key of chain) {
    const value = text[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }

  // 清单里出现了回退链之外的语种（例如未来加了 ja-JP 而 UI 还没支持）
  const first = Object.values(text).find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )
  return first ?? fallback
}

/** 把任意输入规整成受支持的 Locale，未知值一律落到默认语言 */
export function normalizeLocale(input: unknown): Locale {
  if (typeof input === 'string') {
    if ((LOCALES as readonly string[]).includes(input)) return input as Locale

    // 容忍 "zh" / "zh-CN" / "en" / "en-US" / "en_US" 这类写法
    const lowered = input.toLowerCase().replace('_', '-')
    if (lowered.startsWith('zh')) return 'zh-CN'
    if (lowered.startsWith('en')) return 'en-US'
  }
  return DEFAULT_LOCALE
}
