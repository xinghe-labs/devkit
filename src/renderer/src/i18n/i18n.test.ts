import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * i18n 的完整性。
 *
 * 这组测试存在的直接原因：界面上会显示**原始 key 字符串**。
 * `App.tsx` 用了 `update.available` / `update.downloadAndInstall` / `update.downloading` /
 * `update.hint`，而两个 locale 文件里**根本没有 `update` 这一节** ——
 * 于是用户看到的是 `update.available` 这种字样，而不是"发现新版本 0.7.0"。
 *
 * 这类问题的麻烦之处是它**不会报错**：react-i18next 找不到 key 就原样回显，
 * typecheck 也不会红（`t()` 的键是字符串）。所以必须靠测试兜住。
 */

const LOCALES_DIR = join(process.cwd(), 'src/renderer/src/i18n/locales')
const RENDERER_DIR = join(process.cwd(), 'src/renderer/src')

type Json = Record<string, unknown>

function loadLocale(name: string): Json {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${name}.json`), 'utf8')) as Json
}

/** 把嵌套的 locale 摊平成 `a.b.c` 形式的叶子键 */
function flatten(value: Json, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, raw] of Object.entries(value)) {
    const full = `${prefix}${key}`
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of flatten(raw as Json, `${full}.`)) out.set(k, v)
    } else {
      out.set(full, String(raw))
    }
  }
  return out
}

/** 递归收集渲染进程下所有 .ts/.tsx 文件 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) acc.push(full)
  }
  return acc
}

const zh = flatten(loadLocale('zh-CN'))
const en = flatten(loadLocale('en-US'))

/** 代码里以字面量出现的 i18n key（模板拼出来的动态键抓不到，属正常） */
function literalKeysInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(RENDERER_DIR)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
      const key = match[1] as string
      found.set(key, [...(found.get(key) ?? []), file.replace(process.cwd(), '')])
    }
  }
  return found
}

describe('i18n 完整性', () => {
  it('中英两边的叶子键完全对齐', () => {
    const onlyZh = [...zh.keys()].filter((k) => !en.has(k)).sort()
    const onlyEn = [...en.keys()].filter((k) => !zh.has(k)).sort()
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] })
  })

  it('**代码里用到的字面量 key 都必须存在**（否则界面显示原始 key）', () => {
    const used = literalKeysInCode()
    const missing = [...used.entries()]
      .filter(([key]) => !zh.has(key) || !en.has(key))
      .map(([key, files]) => `${key}（用于 ${[...new Set(files)].join('、')}）`)

    expect(missing, `以下 key 在 locale 里缺失：\n${missing.join('\n')}`).toEqual([])
  })

  it('扫描确实覆盖到了渲染进程（防止路径写错导致这组测试空转）', () => {
    const used = literalKeysInCode()
    expect(used.size).toBeGreaterThan(100)
  })

  it('翻译值里不残留 {{占位符}} 拼写不一致的键', () => {
    // 同一 key 在两种语言里必须用同一组占位符，否则某一种语言下会显示空值
    const problems: string[] = []
    for (const [key, zhValue] of zh) {
      const enValue = en.get(key)
      if (enValue === undefined) continue
      const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',')
      if (vars(zhValue) !== vars(enValue)) {
        problems.push(`${key}: zh=[${vars(zhValue)}] en=[${vars(enValue)}]`)
      }
    }
    expect(problems, `占位符不一致：\n${problems.join('\n')}`).toEqual([])
  })
})
