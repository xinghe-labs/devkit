import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  InstallPlan,
  InstallProgressEvent,
  PendingPlanLoad,
  PlanItem,
  PlanPreparation,
  ToolManifest
} from '@shared/types'
import { isPlanFinished, unfinishedCount } from './install-store'

const TOOL: ToolManifest = {
  id: 'nodejs',
  category: 'runtime',
  tier: 'L1',
  status: 'ready',
  name: { 'zh-CN': 'Node.js', 'en-US': 'Node.js' },
  description: { 'zh-CN': 'x', 'en-US': 'x' },
  detect: { files: ['C:\\node.exe'] },
  versions: [
    {
      version: '24.21.0',
      channel: 'lts',
      arch: 'x64',
      installScope: 'user',
      source: { url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) },
      install: { type: 'zip', template: 'zip-into-version-dir' }
    }
  ]
}

function item(state: PlanItem['state']): PlanItem {
  return {
    id: 'nodejs',
    version: '24.21.0',
    tier: 'L1',
    installScope: 'user',
    requiresAdmin: false,
    requiresReboot: false,
    dependsOn: [],
    state,
    attempts: 0,
    error: null,
    note: null,
    startedAt: null,
    finishedAt: null,
    installDir: 'C:\\Users\\x\\.devkit\\versions\\nodejs\\24.21.0',
    archivePath: null
  }
}

function plan(state: PlanItem['state']): InstallPlan {
  const items = [item(state)]
  return {
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
    items,
    summary: { total: 1, success: state === 'success' ? 1 : 0, failed: 0, skipped: 0, cancelled: 0 }
  }
}

const preparation = (): PlanPreparation => ({
  plan: plan('pending'),
  preflight: {
    ok: true,
    checks: [{ id: 'os-version', level: 'ok', message: 'ok' }],
    totalDownloadBytes: 1024,
    requiresAdmin: false
  },
  problems: []
})

const prepareInstall = vi.fn<(selections: unknown) => Promise<PlanPreparation>>()
const startInstall = vi.fn<(planId: string) => Promise<{ started: boolean; error?: string }>>()
const cancelInstall = vi.fn<() => Promise<boolean>>()
const getPendingPlan = vi.fn<() => Promise<PendingPlanLoad>>()
const discardPendingPlan = vi.fn<() => Promise<boolean>>()
const resumeInstall = vi.fn<() => Promise<{ started: boolean; error?: string }>>()
const exportInstallReport = vi.fn<() => Promise<string | null>>()

function installMockWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    value: {
      devkit: {
        prepareInstall,
        startInstall,
        cancelInstall,
        getPendingPlan,
        discardPendingPlan,
        resumeInstall,
        exportInstallReport
      }
    },
    writable: true,
    configurable: true
  })
}

/** 每个用例拿一个全新的 store，避免模块级状态串味 */
async function freshStore() {
  vi.resetModules()
  const module = await import('./install-store')
  return module.useInstallStore
}

beforeEach(() => {
  vi.clearAllMocks()
  installMockWindow()
})

describe('准备阶段', () => {
  it('成功时进入预检阶段并带上计划', async () => {
    prepareInstall.mockResolvedValue(preparation())
    const store = await freshStore()

    await store.getState().prepare([{ toolId: 'nodejs' }])

    const state = store.getState()
    expect(state.phase).toBe('preflight')
    expect(state.plan?.planId).toBe('20261010-153000-abcd')
    expect(state.preparation?.preflight.ok).toBe(true)
    expect(state.busy).toBe(false)
  })

  it('失败时记录错误且不进入预检阶段', async () => {
    prepareInstall.mockRejectedValue(new Error('有 1 项无法安装 —— cmake：安装信息尚未补齐'))
    const store = await freshStore()

    await store.getState().prepare([{ toolId: 'cmake' }])

    const state = store.getState()
    expect(state.phase).toBe('idle')
    expect(state.error).toContain('尚未补齐')
    expect(state.busy).toBe(false)
  })
})

describe('开始与取消', () => {
  it('startInstall 返回 started:false 时把原因写进 error', async () => {
    prepareInstall.mockResolvedValue(preparation())
    startInstall.mockResolvedValue({ started: false, error: '计划已失效' })
    const store = await freshStore()

    await store.getState().prepare([{ toolId: 'nodejs' }])
    await store.getState().start()

    expect(store.getState().phase).toBe('preflight')
    expect(store.getState().error).toBe('计划已失效')
  })

  it('开始成功后进入运行阶段', async () => {
    prepareInstall.mockResolvedValue(preparation())
    startInstall.mockResolvedValue({ started: true })
    const store = await freshStore()

    await store.getState().prepare([{ toolId: 'nodejs' }])
    await store.getState().start()

    expect(store.getState().phase).toBe('running')
    expect(startInstall).toHaveBeenCalledWith('20261010-153000-abcd')
  })

  it('没有计划时不会调用 startInstall', async () => {
    const store = await freshStore()
    await store.getState().start()
    expect(startInstall).not.toHaveBeenCalled()
    expect(store.getState().error).toBe('没有待执行的安装计划')
  })

  it('取消会调用主进程', async () => {
    cancelInstall.mockResolvedValue(true)
    const store = await freshStore()
    await store.getState().cancel()
    expect(cancelInstall).toHaveBeenCalled()
  })
})

describe('进度推送', () => {
  it('未完成的计划 → 保持运行中', async () => {
    const store = await freshStore()
    const event: InstallProgressEvent = {
      plan: plan('downloading'),
      currentItemId: 'nodejs',
      detail: { received: 100, total: 200, source: 'huaweicloud' }
    }

    store.getState().applyProgress(event)

    const state = store.getState()
    expect(state.phase).toBe('running')
    expect(state.currentItemId).toBe('nodejs')
    expect(state.detail?.received).toBe(100)
  })

  it('全部进入终态 → 切到完成阶段', async () => {
    const store = await freshStore()
    store.getState().applyProgress({ plan: plan('success'), currentItemId: null, detail: null })
    expect(store.getState().phase).toBe('done')
  })

  it('失败也算终态，不会卡在运行中', async () => {
    const store = await freshStore()
    store.getState().applyProgress({ plan: plan('failed'), currentItemId: null, detail: null })
    expect(store.getState().phase).toBe('done')
  })
})

describe('关闭与报告', () => {
  it('close 把状态清干净', async () => {
    prepareInstall.mockResolvedValue(preparation())
    const store = await freshStore()
    await store.getState().prepare([{ toolId: 'nodejs' }])

    store.getState().close()

    const state = store.getState()
    expect(state.phase).toBe('idle')
    expect(state.plan).toBeNull()
    expect(state.preparation).toBeNull()
    expect(state.error).toBeNull()
  })

  it('导出报告返回路径', async () => {
    exportInstallReport.mockResolvedValue('D:\\report.md')
    const store = await freshStore()
    expect(await store.getState().exportReport()).toBe('D:\\report.md')
  })

  it('导出失败时把错误落到 error 并返回 null', async () => {
    exportInstallReport.mockRejectedValue(new Error('还没有可导出的安装报告'))
    const store = await freshStore()
    expect(await store.getState().exportReport()).toBeNull()
    expect(store.getState().error).toContain('还没有可导出的安装报告')
  })
})

describe('续跑', () => {
  it('checkPending 在无 pending 时保持为 null', async () => {
    getPendingPlan.mockResolvedValue({ status: 'none' })
    const store = await freshStore()
    await store.getState().checkPending()
    expect(store.getState().pending).toBeNull()
  })

  it('checkPending 读到有效计划时挂到 pending 上', async () => {
    getPendingPlan.mockResolvedValue({ status: 'ok', plan: plan('downloading') })
    const store = await freshStore()
    await store.getState().checkPending()
    expect(store.getState().pending?.status).toBe('ok')
  })

  it('续跑成功后进入运行阶段，并把上次的计划先摆上去', async () => {
    getPendingPlan.mockResolvedValue({ status: 'ok', plan: plan('downloading') })
    resumeInstall.mockResolvedValue({ started: true })
    const store = await freshStore()

    await store.getState().checkPending()
    await store.getState().resume()

    const state = store.getState()
    expect(state.phase).toBe('running')
    expect(state.plan).not.toBeNull()
    expect(state.pending).toBeNull()
  })

  it('续跑失败时保留 pending 并报错', async () => {
    getPendingPlan.mockResolvedValue({ status: 'ok', plan: plan('downloading') })
    resumeInstall.mockResolvedValue({ started: false, error: '已有安装任务正在进行中' })
    const store = await freshStore()

    await store.getState().checkPending()
    await store.getState().resume()

    expect(store.getState().error).toBe('已有安装任务正在进行中')
    expect(store.getState().pending).not.toBeNull()
  })

  it('放弃 pending 会清空它', async () => {
    getPendingPlan.mockResolvedValue({ status: 'ok', plan: plan('downloading') })
    discardPendingPlan.mockResolvedValue(true)
    const store = await freshStore()

    await store.getState().checkPending()
    await store.getState().discardPending()

    expect(store.getState().pending).toBeNull()
    expect(discardPendingPlan).toHaveBeenCalled()
  })
})

describe('辅助函数', () => {
  it('isPlanFinished 只认全部终态', () => {
    expect(isPlanFinished(null)).toBe(false)
    expect(isPlanFinished(plan('pending'))).toBe(false)
    expect(isPlanFinished(plan('success'))).toBe(true)
    expect(isPlanFinished(plan('failed'))).toBe(true)
    expect(isPlanFinished(plan('skipped'))).toBe(true)
    expect(isPlanFinished(plan('cancelled'))).toBe(true)
  })

  it('unfinishedCount 数出还没结束的项', () => {
    expect(unfinishedCount(null)).toBe(0)
    expect(unfinishedCount(plan('pending'))).toBe(1)
    expect(unfinishedCount(plan('success'))).toBe(0)
  })

  it('清单本身完整时也算数（TOOL 夹具是合法清单）', () => {
    expect(TOOL.versions[0].source?.sha256).toHaveLength(64)
  })
})
