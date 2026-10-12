import { describe, expect, it } from 'vitest'
import { sanitizeProfile, PROFILE_ENV_ALLOWLIST } from './index'

/**
 * 档案可能来自**别人的机器**（换机迁移、团队共享），所以导入时必须当不可信输入处理。
 *
 * 最要紧的一条：环境变量与 PATH 条目都是"会被写进用户环境"的东西。
 * 如果档案能塞任意环境变量名，那它就是一条持久化的环境投毒通道。
 */
function baseProfile(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    devkitVersion: '0.2.2',
    machine: { platform: 'win32', arch: 'x64', osRelease: '10.0.26300' },
    detected: [],
    installed: [],
    userPathExtra: [],
    env: {},
    mirrors: [],
    git: { userName: null, userEmail: null },
    vscodeExtensions: [],
    selections: [],
    ...overrides
  }
}

describe('档案清洗（外部输入不可信）', () => {
  it('接受一份正常档案', () => {
    const profile = sanitizeProfile(
      baseProfile({ selections: [{ toolId: 'nodejs', version: '24.21.0' }] })
    )
    expect(profile.schemaVersion).toBe(1)
    expect(profile.selections).toEqual([{ toolId: 'nodejs', version: '24.21.0' }])
  })

  it('拒绝版本不对的档案', () => {
    expect(() => sanitizeProfile(baseProfile({ schemaVersion: 2 }))).toThrow(/版本不支持/)
    expect(() => sanitizeProfile(null)).toThrow(/不是一个对象/)
    expect(() => sanitizeProfile('x')).toThrow(/不是一个对象/)
  })

  it('环境变量只收白名单里的名字 —— 否则档案就是一条环境投毒通道', () => {
    const profile = sanitizeProfile(
      baseProfile({
        env: {
          JAVA_HOME: 'D:\\jdk',
          // 下面这些都不该进来
          PATH: 'C:\\evil',
          TEMP: 'C:\\evil',
          NODE_OPTIONS: '--require C:\\evil.js',
          'npm_config_registry': 'https://evil.example.com'
        }
      })
    )
    expect(profile.env).toEqual({ JAVA_HOME: 'D:\\jdk' })
    expect(Object.keys(profile.env).every((name) => PROFILE_ENV_ALLOWLIST.includes(name))).toBe(true)
  })

  it('PATH 条目必须是绝对路径（相对路径的含义随当前目录变化，等于埋雷）', () => {
    const profile = sanitizeProfile(
      baseProfile({
        userPathExtra: [
          'D:\\tools\\bin',
          'C:/tools/bin',
          'relative\\bin',
          '\\\\server\\share\\bin'.replace('\\\\', '\\\\'),
          'C:\\P',
          'v16.13.1'
        ]
      })
    )
    // 只保留以盘符开头的绝对路径
    expect(profile.userPathExtra).toEqual(['D:\\tools\\bin', 'C:/tools/bin', 'C:\\P'])
  })

  it('工具 id 必须符合清单的字符集（否则会流向文件系统路径拼接）', () => {
    const profile = sanitizeProfile(
      baseProfile({
        selections: [
          { toolId: 'nodejs' },
          { toolId: '../evil' },
          { toolId: 'UPPER' },
          { toolId: 'a b' },
          { toolId: '' },
          { version: '1.0' }
        ]
      })
    )
    expect(profile.selections).toEqual([{ toolId: 'nodejs' }])
  })

  it('版本号必须符合清单约定（拒绝 .. 这类能逃逸目录的值）', () => {
    const profile = sanitizeProfile(
      baseProfile({
        selections: [
          { toolId: 'nodejs', version: '..' },
          { toolId: 'go', version: '1.27.2' }
        ]
      })
    )
    // '..' 不合法 → 退化成"不带版本"，由清单自己选推荐版本
    expect(profile.selections).toEqual([{ toolId: 'nodejs' }, { toolId: 'go', version: '1.27.2' }])
  })

  it('VS Code 插件列表有上限（避免一份档案塞几万个 id）', () => {
    const many = Array.from({ length: 800 }, (_, i) => `publisher.ext${i}`)
    const profile = sanitizeProfile(baseProfile({ vscodeExtensions: many }))
    expect(profile.vscodeExtensions).toHaveLength(500)
  })

  it('缺失或类型不对的字段会被兜底成安全默认值，而不是抛错', () => {
    const profile = sanitizeProfile({ schemaVersion: 1 })
    expect(profile.selections).toEqual([])
    expect(profile.userPathExtra).toEqual([])
    expect(profile.env).toEqual({})
    expect(profile.machine.platform).toBe('unknown')
    expect(profile.git).toEqual({ userName: null, userEmail: null })
  })
})
