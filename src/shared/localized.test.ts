import { describe, expect, it } from 'vitest'
import { localizedText, normalizeLocale } from './localized'

describe('localizedText 语言回退链', () => {
  it('命中当前语言时直接返回', () => {
    expect(localizedText({ 'zh-CN': '中文', 'en-US': 'English' }, 'zh-CN')).toBe('中文')
    expect(localizedText({ 'zh-CN': '中文', 'en-US': 'English' }, 'en-US')).toBe('English')
  })

  it('当前语言缺失时回退到 zh-CN', () => {
    expect(localizedText({ 'zh-CN': '只有中文' }, 'en-US')).toBe('只有中文')
  })

  it('只有 en-US 时，中文界面也能拿到值', () => {
    expect(localizedText({ 'en-US': 'English only' }, 'zh-CN')).toBe('English only')
  })

  it('当前语言是空串时视为缺失，继续回退', () => {
    expect(localizedText({ 'zh-CN': '中文', 'en-US': '   ' }, 'en-US')).toBe('中文')
  })

  it('出现回退链之外的语种时取第一个可用值', () => {
    expect(localizedText({ 'ja-JP': '日本語' }, 'zh-CN')).toBe('日本語')
  })

  it('全部缺失时返回 fallback，绝不返回 undefined', () => {
    expect(localizedText({}, 'zh-CN', '回退值')).toBe('回退值')
    expect(localizedText(undefined, 'zh-CN', '回退值')).toBe('回退值')
    expect(localizedText(null, 'zh-CN')).toBe('')
  })

  it('返回值永远是字符串', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(typeof localizedText({}, locale)).toBe('string')
    }
  })
})

describe('normalizeLocale', () => {
  it('接受标准写法', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('en-US')).toBe('en-US')
  })

  it('容忍大小写与下划线', () => {
    expect(normalizeLocale('zh_CN')).toBe('zh-CN')
    expect(normalizeLocale('EN-us')).toBe('en-US')
  })

  it('容忍只给语言代码', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('en')).toBe('en-US')
  })

  it('未知值落到默认语言', () => {
    expect(normalizeLocale('fr-FR')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
    expect(normalizeLocale(42)).toBe('zh-CN')
    expect(normalizeLocale({})).toBe('zh-CN')
  })
})
