import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolManifest } from '@shared/types'
import { listBuiltinPresets } from './index'

/**
 * 预设最容易犯的错是"引用了一个根本不存在的工具 id"，而且只有用户点到它才会发现。
 * 这里直接把仓库里的清单读出来做交叉校验 —— 加错 id 会让测试红。
 */
function loadManifestIds(): Set<string> {
  const dir = resolve(process.cwd(), 'resources', 'manifest', 'tools')
  const ids = new Set<string>()
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ToolManifest
    ids.add(raw.id)
  }
  return ids
}

describe('内置预设', () => {
  it('id 唯一且格式合法', () => {
    const presets = listBuiltinPresets()
    expect(presets.length).toBeGreaterThanOrEqual(6)
    const ids = presets.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,39}$/)
  })

  it('每个预设都有中英文名称与描述', () => {
    for (const preset of listBuiltinPresets()) {
      expect(preset.name['zh-CN'], `${preset.id} 缺中文名`).toBeTruthy()
      expect(preset.name['en-US'], `${preset.id} 缺英文名`).toBeTruthy()
      expect(preset.description['zh-CN'], `${preset.id} 缺中文描述`).toBeTruthy()
      expect(preset.description['en-US'], `${preset.id} 缺英文描述`).toBeTruthy()
      expect(preset.builtin).toBe(true)
      expect(preset.tools.length).toBeGreaterThan(0)
    }
  })

  it('预设引用的工具在清单里真实存在', () => {
    const known = loadManifestIds()
    for (const preset of listBuiltinPresets()) {
      for (const selection of preset.tools) {
        expect(known.has(selection.toolId), `${preset.id} 引用了不存在的工具 ${selection.toolId}`).toBe(
          true
        )
      }
    }
  })

  it('预设里没有重复工具', () => {
    for (const preset of listBuiltinPresets()) {
      const ids = preset.tools.map((selection) => selection.toolId)
      expect(new Set(ids).size, `${preset.id} 有重复工具`).toBe(ids.length)
    }
  })

  it('返回的是副本，改动不会污染内置表', () => {
    const first = listBuiltinPresets()
    first[0].tools.push({ toolId: 'hacked' })
    const second = listBuiltinPresets()
    expect(second[0].tools.some((item) => item.toolId === 'hacked')).toBe(false)
  })
})
