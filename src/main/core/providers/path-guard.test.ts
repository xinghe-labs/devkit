import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolManifest, ToolVersionSpec } from '@shared/types'
import { diffPathEntries } from '../activate/paths'
import { readUserPath } from '../activate/windows'
import { installVersion } from './direct'

const onWindows = process.platform === 'win32'

describe('diffPathEntries', () => {
  it('列出新增条目', () => {
    expect(diffPathEntries('C:\\a;C:\\b', 'C:\\a;C:\\new;C:\\b')).toEqual(['C:\\new'])
  })

  it('大小写与尾随分隔符不敏感', () => {
    // 返回的是"新增条目原文"（保留尾随分隔符），比较时才做归一化
    expect(diffPathEntries('C:\\A', 'c:\\a\\;C:\\new\\')).toEqual(['C:\\new\\'])
  })

  it('顺序变化不算新增', () => {
    expect(diffPathEntries('C:\\a;C:\\b', 'C:\\b;C:\\a')).toEqual([])
  })

  it('删除条目不算新增', () => {
    expect(diffPathEntries('C:\\a;C:\\b', 'C:\\a')).toEqual([])
  })

  it('忽略空段', () => {
    expect(diffPathEntries('C:\\a', 'C:\\a;;')).toEqual([])
  })
})

/**
 * 安装器自己改 PATH 时的还原（真实端到端）。
 *
 * 背景：VS Code 的 Inno 安装器会自己往用户 PATH 写一条目录，实测用
 * /MERGETASKS=!addtopath 阻止无效。所以 devkit 改成"安装前后各取一次 PATH，
 * 有变化就整体还原并告知"。
 *
 * 这里用一个假的安装器（.cmd，往用户 PATH 追加一个标记条目）来验证这条链路：
 * 走的是 exe-inno-silent 模板 → installVersion → 安装器执行 → PATH 比对与还原。
 * 会短暂改动用户 PATH，但随后被 devkit 自己还原，测试末尾还会断言逐字节一致。
 */
describe.skipIf(!onWindows)('安装器改动用户 PATH 会被还原', () => {
  let dir: string
  let pathBeforeTest = ''

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'devkit-pathguard-'))
    pathBeforeTest = await readUserPath()
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('假安装器加了 PATH 条目 → 被移除，且记在 outcome 里', async () => {
    const marker = 'C:\\devkit-path-guard-marker'
    const fakeInstaller = join(dir, 'fake-installer.cmd')
    // 模拟"安装器自己写 PATH"：直接写注册表（保持 ExpandString）
    writeFileSync(
      fakeInstaller,
      [
        '@echo off',
        'powershell.exe -NoProfile -NonInteractive -Command "' +
          `$raw = (Get-ItemProperty -Path 'HKCU:\\\\Environment' -Name Path).Path; ` +
          `Set-ItemProperty -Path 'HKCU:\\\\Environment' -Name Path -Value ($raw + ';${marker}') -Type ExpandString"`,
        'exit /b 0',
        ''
      ].join('\r\n'),
      'utf8'
    )

    const version: ToolVersionSpec = {
      version: '1.0.0',
      channel: 'stable',
      arch: 'x64',
      installScope: 'user',
      install: { type: 'exe-inno', template: 'exe-inno-silent', params: {} }
    }
    const tool: ToolManifest = {
      id: 'fake-tool',
      category: 'tool',
      tier: 'L1',
      status: 'ready',
      name: { 'zh-CN': '假工具', 'en-US': 'Fake' },
      description: { 'zh-CN': 'x', 'en-US': 'x' },
      detect: { commands: [{ cmd: 'fake' }] },
      versions: [version]
    }

    const outcome = await installVersion({
      tool,
      version,
      installDir: join(dir, 'install'),
      archivePath: fakeInstaller,
      logFile: join(dir, 'installer.log')
    })

    // 安装器确实加了条目，但 devkit 把它还原了
    expect(outcome.revertedPathEntries).toContain(marker)

    const pathAfter = await readUserPath()
    expect(pathAfter).toBe(pathBeforeTest)
    expect(pathAfter).not.toContain('devkit-path-guard-marker')
  }, 180_000)
})
