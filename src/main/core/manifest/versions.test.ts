import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 多版本清单的不变量。
 *
 * 这组测试存在的原因是两个真实问题：
 *
 * 1. **刷新脚本硬编码 `(await discover())[0]`** —— 于是即使官方源能列出全量版本，
 *    清单里每个工具也永远只有 1 个版本可选。UI 的版本下拉不是没做，是没数据。
 * 2. **官方源的顺序是按发布日期倒序，不是按版本号** —— 放开枚举后第一次跑，
 *    Gradle 的 8.14.6（10-08 发）排在了 9.8.1（10-07 发）前面，
 *    结果 `recommended` 标到了 8.x 上。旧线比新线晚几天发补丁是常态。
 */

const TOOLS_DIR = join(process.cwd(), 'resources', 'manifest', 'tools')

interface VersionEntry {
  version: string
  recommended?: boolean
  source: { url: string; sha256: string }
}

function loadAll(): { id: string; versions: VersionEntry[] }[] {
  return readdirSync(TOOLS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(TOOLS_DIR, file), 'utf8')) as {
        id: string
        versions?: VersionEntry[]
      }
      return { id: raw.id, versions: raw.versions ?? [] }
    })
}

const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0)

/** 版本号从大到小：主版本优先，其次次版本、补丁号 */
function compareDesc(a: string, b: string): number {
  const [am, an, ap] = parts(a)
  const [bm, bn, bp] = parts(b)
  return bm - am || bn - an || bp - ap
}

describe('多版本清单的不变量', () => {
  const tools = loadAll()

  it('清单目录能读到（防止路径写错导致这组测试空转）', () => {
    expect(tools.length).toBeGreaterThan(20)
  })

  it('每个工具的版本号不重复', () => {
    for (const tool of tools) {
      const seen = new Set<string>()
      for (const entry of tool.versions) {
        expect(seen.has(entry.version), `${tool.id} 有重复版本 ${entry.version}`).toBe(false)
        seen.add(entry.version)
      }
    }
  })

  it('**最多只有一个 recommended**', () => {
    // 三个版本都标 recommended，UI 的"默认选中"和"推荐"标签就同时失去意义了
    for (const tool of tools) {
      const count = tool.versions.filter((entry) => entry.recommended).length
      expect(count, `${tool.id} 有 ${count} 个 recommended`).toBeLessThanOrEqual(1)
    }
  })

  it('**recommended 不能落在旧的大版本线上**', () => {
    // 这正是 Gradle 那次踩的坑：8.14.6 比 9.8.1 晚一天发补丁，按发布日期倒序就排在前面，
    // recommended 于是标到了 8.x —— 而 8.x 是遗留线，9.x 才是当前活跃线。
    //
    // 规则用「主版本号相等」而不是「必须是最新的那个」：
    // Python 3.15.0 才发布 5 天，把 3.14.8 当默认是合理选择，
    // 但它和 3.15.0 同属主版本 3，所以不该被判为错误。
    for (const tool of tools) {
      const recommended = tool.versions.find((entry) => entry.recommended)
      if (!recommended || tool.versions.length < 2) continue

      const highest = [...tool.versions].sort((a, b) => compareDesc(a.version, b.version))[0]
      expect(
        parts(recommended.version)[0],
        `${tool.id} 推荐的是 ${recommended.version}，但最大版本是 ${highest.version}（跨了大版本）`
      ).toBe(parts(highest.version)[0])
    }
  })

  it('recommended 只能是最新版本，或次新版本（"再等一个补丁"的克制选择）', () => {
    for (const tool of tools) {
      const recommended = tool.versions.find((entry) => entry.recommended)
      if (!recommended || tool.versions.length < 2) continue

      const sorted = [...tool.versions].sort((a, b) => compareDesc(a.version, b.version))
      const rank = sorted.findIndex((entry) => entry.version === recommended.version)
      expect(rank, `${tool.id} 推荐的是第 ${rank + 1} 新的版本，太靠后了`).toBeLessThanOrEqual(1)
    }
  })

  it('版本按版本号从大到小排列（UI 直接按数组顺序渲染）', () => {
    for (const tool of tools) {
      const sorted = [...tool.versions].sort((a, b) => compareDesc(a.version, b.version))
      expect(
        tool.versions.map((entry) => entry.version),
        `${tool.id} 的版本顺序不是从新到旧`
      ).toEqual(sorted.map((entry) => entry.version))
    }
  })

  it('每个版本都有非空的 url 与 64 位十六进制 SHA-256（不填占位值）', () => {
    for (const tool of tools) {
      for (const entry of tool.versions) {
        expect(entry.source.url, `${tool.id}@${entry.version} 的 url 为空`).toMatch(/^https:\/\//)
        expect(entry.source.sha256, `${tool.id}@${entry.version} 的 sha256 不合法`).toMatch(/^[a-f0-9]{64}$/i)
      }
    }
  })

  it('多版本集中在真正需要版本共存的工具上', () => {
    // 这条不是"越少越好"的硬规矩，而是防止刷新脚本哪天把 CLI 工具也枚举成几十个版本 ——
    // 那些工具用户要的就是最新，多版本只会增加没人验证过的条目。
    const multi = tools.filter((tool) => tool.versions.length > 1).map((tool) => tool.id)
    const allowed = new Set([
      'nodejs',
      'python',
      'jdk-temurin',
      'go',
      'gradle',
      'maven',
      'rust',
      'git'
    ])
    for (const id of multi) {
      expect(allowed.has(id), `${id} 不该有多个版本`).toBe(true)
    }
  })

  it('多版本工具至少覆盖 SPEC 点名的 JDK / Node / Python', () => {
    const multi = new Set(tools.filter((tool) => tool.versions.length > 1).map((tool) => tool.id))
    expect(multi.has('jdk-temurin')).toBe(true)
    expect(multi.has('nodejs')).toBe(true)
    expect(multi.has('python')).toBe(true)
  })
})
