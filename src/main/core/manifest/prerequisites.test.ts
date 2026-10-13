import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 清单里的**前置依赖声明**必须覆盖所有已知的隐藏前置。
 *
 * 为什么需要这组测试：`dependsOn` 机制（schema / 拓扑排序 / 预检拦截）全都建好了，
 * 但**一个清单都没声明过** —— 机制等于没接线。而"没声明"这件事本身不会报错，
 * 只会在干净机器上装到一半才炸（`mvn -v` 报 JAVA_HOME 未定义、npm 根本不存在）。
 *
 * 所以这里把「什么模板 / 什么自检命令 ⇒ 需要声明什么依赖」写成可执行的规则，
 * 以后加新工具时忘了声明会直接红。
 */

const TOOLS_DIR = join(process.cwd(), 'resources', 'manifest', 'tools')

interface VersionEntry {
  version: string
  recommended?: boolean
  dependsOn?: string[]
  install?: { template?: string }
  verify?: { cmd?: string }
}

interface ToolEntry {
  id: string
  versions: VersionEntry[]
}

function loadAll(): ToolEntry[] {
  return readdirSync(TOOLS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(TOOLS_DIR, file), 'utf8')) as ToolEntry
      return { id: raw.id, versions: raw.versions ?? [] }
    })
}

/** 只按推荐版本判定：推荐版本是用户默认会装的那个 */
function recommended(tool: ToolEntry): VersionEntry | undefined {
  return tool.versions.find((entry) => entry.recommended) ?? tool.versions[0]
}

const tools = loadAll()
const allIds = new Set(tools.map((tool) => tool.id))

describe('清单前置依赖：声明必须完整', () => {
  it('清单能读到（防止路径写错导致这组测试空转）', () => {
    expect(tools.length).toBeGreaterThan(20)
  })

  it('**npm 类模板必须声明依赖 nodejs**', () => {
    // npm-global-into-version-dir 要跑 `npm install`，npm 是随 Node.js 一起提供的。
    // 不声明 → 干净机器上选它必然失败，而预检当时是全绿的。
    //
    // 直接双层遍历 versions，不先按 recommended 版本筛工具：
    // 那样会让「推荐版本不是 npm 模板、但某些版本是」的工具整条漏掉。
    let seen = 0
    for (const tool of tools) {
      for (const version of tool.versions) {
        if (version.install?.template !== 'npm-global-into-version-dir') continue
        seen += 1
        expect(
          version.dependsOn ?? [],
          `${tool.id}@${version.version} 用 npm 模板，必须声明 dependsOn: ['nodejs']`
        ).toContain('nodejs')
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('**自检要起 JVM 的工具（mvn / gradle）必须声明依赖 jdk-temurin**', () => {
    // 实测：没有 JDK 时 `mvn -v` 直接输出
    // 「The JAVA_HOME environment variable is not defined correctly」
    // 所以这类工具装完必然自检失败，而不是"装不上"。
    const jvmTools = tools.filter((tool) => {
      const cmd = recommended(tool)?.verify?.cmd ?? ''
      return /(^|[\\/])(mvn\.cmd|gradle\.bat)$/i.test(cmd)
    })
    expect(jvmTools.map((tool) => tool.id).sort()).toEqual(['gradle', 'maven'])

    for (const tool of jvmTools) {
      for (const version of tool.versions) {
        expect(
          version.dependsOn ?? [],
          `${tool.id}@${version.version} 的自检要起 JVM，必须声明 dependsOn: ['jdk-temurin']`
        ).toContain('jdk-temurin')
      }
    }
  })

  it('声明的依赖必须指向真实存在的工具', () => {
    for (const tool of tools) {
      for (const version of tool.versions) {
        for (const dependency of version.dependsOn ?? []) {
          expect(
            allIds.has(dependency),
            `${tool.id}@${version.version} 依赖了不存在的工具 ${dependency}`
          ).toBe(true)
        }
      }
    }
  })

  it('不能依赖自己', () => {
    for (const tool of tools) {
      for (const version of tool.versions) {
        expect(
          (version.dependsOn ?? []).includes(tool.id),
          `${tool.id} 依赖了自己`
        ).toBe(false)
      }
    }
  })

  it('依赖里没有重复项', () => {
    for (const tool of tools) {
      for (const version of tool.versions) {
        const list = version.dependsOn ?? []
        expect(new Set(list).size, `${tool.id}@${version.version} 的 dependsOn 有重复`).toBe(list.length)
      }
    }
  })

  it('同一个工具的各个版本依赖声明一致（避免切换版本后行为突变）', () => {
    for (const tool of tools) {
      const declared = tool.versions.map((version) => [...(version.dependsOn ?? [])].sort().join(','))
      expect(
        new Set(declared).size,
        `${tool.id} 的不同版本声明了不同的依赖：${declared.join(' | ')}`
      ).toBeLessThanOrEqual(1)
    }
  })

  it('依赖声明覆盖了审计出来的全部隐藏前置', () => {
    // 这份名单来自对 22 个可装工具的逐项审计（模板 + 自检命令）。
    // 新增工具时如果它也有隐藏前置，要同时更新这里 —— 测试红了说明你漏了。
    const expected = {
      'claude-code': 'nodejs',
      'copilot-cli': 'nodejs',
      'gemini-cli': 'nodejs',
      'qwen-code': 'nodejs',
      maven: 'jdk-temurin',
      gradle: 'jdk-temurin'
    } as const

    for (const [toolId, dependency] of Object.entries(expected)) {
      const tool = tools.find((item) => item.id === toolId)
      expect(tool, `清单里找不到 ${toolId}`).toBeDefined()
      for (const version of tool!.versions) {
        expect(
          version.dependsOn ?? [],
          `${toolId}@${version.version} 应声明依赖 ${dependency}`
        ).toContain(dependency)
      }
    }
  })
})
