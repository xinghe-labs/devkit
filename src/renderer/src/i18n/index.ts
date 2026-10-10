import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { LOCALES, type Locale } from '@shared/types'
import enUS from './locales/en-US.json'
import zhCN from './locales/zh-CN.json'

/**
 * 回退链与 localizedText() 保持一致：当前语言 → zh-CN → en-US。
 * 这样 UI 文案和清单文案（manifest 里的 name/description）行为一致，
 * 不会出现"界面是英文、软件描述是空白"这种割裂。
 */
export async function initI18n(locale: Locale): Promise<void> {
  await i18n.use(initReactI18next).init({
    lng: locale,
    fallbackLng: [...LOCALES],
    supportedLngs: [...LOCALES],
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS }
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false }
  })
}

export async function changeLanguage(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale)
}

export default i18n
