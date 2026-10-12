import { describe, expect, it } from 'vitest'
import { indexById } from '@shared/manifest'
import type { InstallPlan, ToolManifest, ToolVersionSpec } from '@shared/types'
import {
  computeRequiredBytes,
  DISK_HEADROOM_BYTES,
  findConflicts,
  parseWindowsBuild,
  runPreflight
} from './index'

describe('parseWindowsBuild', () => {
  it('从 os.release() 的形态里取 build 号', () => {
    expect(parseWindowsBuild('10.0.26300')).toBe(26300)
    expect(parseWindowsBuild('10.0.19045')).toBe(19045)
    expect(parseWindowsBuild('10.0.22631')).toBe(22631)
  })

  it('解析不出来时返回 null（不猜）', () => {
    expect(parseWindowsBuild('6.1')).toBeNull()
    expect(parseWindowsBuild('')).toBeNull()
    expect(parseWindowsBuild('abc')).toBeNull()
  })
})

describe('findConflicts', () => {
  it('两个互斥的工具同时被选中时报出来', () => {
    const conflicts = findConflicts(['nodejs', 'docker-desktop', 'podman'])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain('docker-desktop')
    expect(conflicts[0]).toContain('podman')
  })

  it('只选其中一个时不报冲突', () => {
    expect(findConflicts(['docker-desktop'])).toEqual([])
    expect(findConflicts(['podman'])).toEqual([])
    expect(findConflicts([])).toEqual([])
  })
})

describe('computeRequiredBytes', () => {
  it('按倍数 + 固定余量估算', () => {
    expect(computeRequiredBytes(0)).toBe(DISK_HEADROOM_BYTES)
    expect(computeRequiredBytes(100 * 1024 * 1024)).toBe(
      Math.ceil(100 * 1024 * 1024 * 2.5) + DISK_HEADROOM_BYTES
    )
  })
})

describe('runPreflight', () => {
  const version: ToolVersionSpec = {
    version: '24.21.0',
    channel: 'lts',
    arch: 'x64',
    installScope: 'user',
    sizeBytes: 1024 * 1024,
    source: { url: 'https://example.invalid/a.zip', sha256: 'a'.repeat(64) },
    install: { type: 'zip', template: 'zip-into-version-dir' }
  }

  const tool: ToolManifest = {
    id: 'nodejs',
    category: 'runtime',
    tier: 'L1',
    status: 'ready',
    name: { 'zh-CN': 'Node.js', 'en-US': 'Node.js' },
    description: { 'zh-CN': 'x', 'en-US': 'x' },
    detect: { files: ['C:\\node.exe'] },
    versions: [version]
  }

  const plan: InstallPlan = {
    schemaVersion: 1,
    planId: '20261010-153000-abcd',
    createdAt: new Date().toISOString(),
    devkitVersion: '0.1.0',
    manifestRevision: '2026-10-10',
    options: {
      concurrency: 1,
      mirrorPreference: 'official',
      proxy: null,
      createRestorePoint: false,
      dryRun: false
    },
    items: [
      {
        id: 'nodejs',
        version: '24.21.0',
        tier: 'L1',
        installScope: 'user',
        requiresAdmin: false,
        requiresReboot: false,
        dependsOn: [],
        state: 'pending',
        attempts: 0,
        error: null,
        note: null,
        startedAt: null,
        finishedAt: null,
        installDir: 'C:\\Users\\x\\.devkit\\versions\\nodejs\\24.21.0',
        archivePath: null
      }
    ],
    summary: { total: 1, success: 0, failed: 0, skipped: 0, cancelled: 0 }
  }

  it('把系统/架构/磁盘/权限都检查一遍，且不做任何网络请求（maxProbes=0）', async () => {
    const result = await runPreflight({
      plan,
      tools: indexById([tool]),
      targetPath: 'C:\\Users\\x\\.devkit\\versions',
      maxProbes: 0
    })

    const ids = result.checks.map((check) => check.id)
    expect(ids).toContain('os-version')
    expect(ids).toContain('arch')
    expect(ids).toContain('disk')
    expect(ids).toContain('admin')
    expect(result.totalDownloadBytes).toBe(version.sizeBytes)
  })

  it('用户级安装不要求管理员权限', async () => {
    const result = await runPreflight({
      plan,
      tools: indexById([tool]),
      targetPath: 'C:\\',
      maxProbes: 0
    })
    expect(result.requiresAdmin).toBe(false)
    const admin = result.checks.find((check) => check.id === 'admin')
    expect(admin?.level).toBe('ok')
  })

  it('系统级安装会把"需要授权"标成 warn 而不是 error（不阻断）', async () => {
    const machinePlan: InstallPlan = {
      ...plan,
      items: [{ ...plan.items[0], installScope: 'machine', requiresAdmin: true }]
    }
    const result = await runPreflight({
      plan: machinePlan,
      tools: indexById([tool]),
      targetPath: 'C:\\',
      maxProbes: 0
    })

    expect(result.requiresAdmin).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.checks.find((check) => check.id === 'admin')?.level).toBe('warn')
  })

  it('预检结果里不出现 error 时 ok 为 true', async () => {
    const result = await runPreflight({
      plan,
      tools: indexById([tool]),
      targetPath: 'C:\\',
      maxProbes: 0
    })
    expect(result.ok).toBe(result.checks.every((check) => check.level !== 'error'))
  })

  it('所有下载源都不可达时给出 error 级阻断', async () => {
    // 127.0.0.1:1 是必定拒绝连接的端口，能快速稳定地造出"不可达"
    const unreachable: ToolManifest = {
      ...tool,
      versions: [
        { ...version, source: { url: 'https://127.0.0.1:1/a.zip', sha256: 'a'.repeat(64) } }
      ]
    }

    const result = await runPreflight({
      plan,
      tools: indexById([unreachable]),
      targetPath: 'C:\\',
      maxProbes: 3
    })

    expect(result.ok).toBe(false)
    expect(result.checks.some((check) => check.id === 'network' && check.level === 'error')).toBe(
      true
    )
  })
})
