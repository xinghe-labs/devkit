import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { downloadFileName } from '@shared/download-name'
import type { ToolManifest } from '@shared/types'
import {
  archiveFileName,
  importOfflinePack,
  partitionByRedistributable,
  OFFLINE_ARCHIVE_DIR,
  OFFLINE_INDEX_FILE
} from './index'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('离线包文件命名', () => {
  // 命名规则本身由 @shared/download-name 的单测覆盖（含 VS Code 的 /stable 形态）。
  // 这里只钉住一件事：**离线包用的就是执行器找的那个名字**。
  it('与执行器的下载缓存命名完全一致（含补 .exe 的形态）', () => {
    const cases: { url: string; installType: string; expect: string }[] = [
      {
        url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
        installType: 'zip',
        expect: 'nodejs-24.21.0-node-v24.21.0-win-x64.zip'
      },
      {
        // 曾经就是这一条不一致：离线包叫 ...stable，执行器找 ...stable.exe
        url: 'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
        installType: 'exe-inno',
        expect: 'vscode-1.141.0-stable.exe'
      }
    ]

    for (const c of cases) {
      const toolId = c.expect.split('-')[0] as string
      const version = c.expect.includes('vscode') ? '1.141.0' : '24.21.0'
      expect(archiveFileName(toolId, version, c.url, c.installType)).toBe(c.expect)
      // 同一个函数 —— 不是"看起来一致"，是同一个实现
      expect(archiveFileName(toolId, version, c.url, c.installType)).toBe(
        downloadFileName({ toolId, version, url: c.url, installType: c.installType })
      )
    }
  })

  it('URL 带查询串时只取路径部分', () => {
    expect(archiveFileName('x', '1.0', 'https://example.com/a/b/c.zip?token=1', 'zip')).toBe(
      'x-1.0-c.zip'
    )
  })
})

describe('离线包导入', () => {
  let root: string
  let packDir: string
  let downloadDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devkit-offline-'))
    packDir = join(root, 'pack')
    downloadDir = join(root, 'downloads')
    mkdirSync(join(packDir, OFFLINE_ARCHIVE_DIR), { recursive: true })
    mkdirSync(downloadDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('校验通过的文件被放进下载缓存', async () => {
    const content = 'pretend-this-is-a-7z-archive'
    writeFileSync(join(packDir, OFFLINE_ARCHIVE_DIR, 'git-2.56.0-PortableGit.7z.exe'), content)
    writeFileSync(
      join(packDir, OFFLINE_INDEX_FILE),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        devkitVersion: '0.1.0',
        entries: [
          {
            toolId: 'git',
            version: '2.56.0',
            fileName: 'git-2.56.0-PortableGit.7z.exe',
            sha256: sha256(content),
            sizeBytes: content.length,
            url: 'https://example.com/PortableGit.7z.exe'
          }
        ]
      })
    )

    const result = await importOfflinePack(packDir, downloadDir)
    expect(result.ok).toBe(true)
    expect(result.imported).toBe(1)
    expect(result.missing).toEqual([])
    expect(existsSync(join(downloadDir, 'git-2.56.0-PortableGit.7z.exe'))).toBe(true)
  })

  it('校验失败的文件不会被放进下载缓存（否则安装时才会以"校验失败"暴露）', async () => {
    writeFileSync(join(packDir, OFFLINE_ARCHIVE_DIR, 'bad.zip'), 'tampered')
    writeFileSync(
      join(packDir, OFFLINE_INDEX_FILE),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        devkitVersion: '0.1.0',
        entries: [
          {
            toolId: 'x',
            version: '1.0',
            fileName: 'bad.zip',
            sha256: sha256('original'),
            sizeBytes: 8,
            url: 'https://example.com/bad.zip'
          }
        ]
      })
    )

    const result = await importOfflinePack(packDir, downloadDir)
    expect(result.imported).toBe(0)
    expect(result.missing).toEqual(['bad.zip'])
    expect(existsSync(join(downloadDir, 'bad.zip'))).toBe(false)
  })

  it('缺少索引文件时给出可读错误', async () => {
    const result = await importOfflinePack(packDir, downloadDir)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('offline.json')
  })
})

describe('离线包的许可证分级过滤（SPEC §8）', () => {
  const tool = (id: string, tier: 'L1' | 'L2' | 'L3'): ToolManifest => ({
    id,
    category: 'tool',
    tier,
    status: 'ready',
    name: { 'zh-CN': id, 'en-US': id },
    description: { 'zh-CN': id, 'en-US': id },
    detect: { commands: [{ cmd: id }] },
    versions: []
  })

  it('只有 L1 进离线包', () => {
    const { packable, skipped } = partitionByRedistributable([
      tool('nodejs', 'L1'),
      tool('vscode', 'L2'),
      tool('some-paid-tool', 'L3'),
      tool('go', 'L1')
    ])

    expect(packable.map((item) => item.id)).toEqual(['nodejs', 'go'])
    expect(skipped.map((item) => item.id)).toEqual(['vscode', 'some-paid-tool'])
    expect(skipped[0].tier).toBe('L2')
    expect(skipped[0].reason).toContain('不得再分发')
    expect(skipped[1].reason).toContain('仅引导官网')
  })

  it('全部是 L1 时不产生任何跳过项', () => {
    const { packable, skipped } = partitionByRedistributable([tool('a', 'L1'), tool('b', 'L1')])
    expect(packable).toHaveLength(2)
    expect(skipped).toEqual([])
  })

  it('全部不可再分发时 packable 为空（而不是硬塞进去）', () => {
    const { packable, skipped } = partitionByRedistributable([tool('vscode', 'L2')])
    expect(packable).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  it('AI 类里 npm 装的工具都是 L2（第三方发行物，不进离线包）', () => {
    // 这是清单层面的约定：npm 装的 AI agent 不能进离线包
    const npmAgents = ['claude-code', 'gemini-cli', 'copilot-cli', 'qwen-code'].map((id) =>
      tool(id, 'L2')
    )
    const { packable, skipped } = partitionByRedistributable(npmAgents)
    expect(packable).toEqual([])
    expect(skipped).toHaveLength(4)
  })
})
