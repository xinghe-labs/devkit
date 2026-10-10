import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionResult, ManifestLoadResult, ToolManifest } from '@shared/types'

/**
 * 回归测试：启动流程必须幂等。
 *
 * 背景：React StrictMode 在开发模式下会把 effect 跑两遍。首版没有闸门，
 * 导致清单加载与整轮环境检测各跑两次，注册表被扫两遍（本机实测每次 2~9 秒），
 * 启动肉眼可见地变慢。这个测试锁住"并发调用只跑一次"这个不变量。
 */

const TOOL: ToolManifest = {
  id: 'demo',
  category: 'tool',
  tier: 'L1',
  status: 'detect-only',
  name: { 'zh-CN': '演示', 'en-US': 'Demo' },
  description: { 'zh-CN': '演示', 'en-US': 'Demo' },
  detect: { files: ['C:\\demo.exe'] },
  versions: []
}

const RESULT: DetectionResult = {
  toolId: 'demo',
  status: 'installed',
  installedVersion: '1.0.0',
  recommendedVersion: null,
  versionMatches: true,
  evidence: 'file:C:\\demo.exe',
  error: null,
  durationMs: 1
}

const MANIFESTS: ManifestLoadResult = {
  tools: [TOOL],
  errors: [],
  source: 'builtin',
  dir: 'resources/manifest',
  loadedAt: new Date(0).toISOString()
}

const listManifests = vi.fn<() => Promise<ManifestLoadResult>>()
const runDetection = vi.fn<() => Promise<DetectionResult[]>>()
const setLocale = vi.fn<() => Promise<'zh-CN'>>()

function installMockWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    value: { devkit: { listManifests, runDetection, setLocale } },
    writable: true,
    configurable: true
  })
}

/** 每次拿一个全新的 store 模块，这样模块级闸门也是干净的 */
async function freshStore() {
  vi.resetModules()
  const module = await import('./app-store')
  return module.useAppStore
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 推进微任务与一个宏任务，让 await 链走完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  installMockWindow()
})

describe('bootstrap 幂等性', () => {
  it('并发调用只加载清单一次、只检测一次（StrictMode 回归）', async () => {
    const manifests = deferred<ManifestLoadResult>()
    const detection = deferred<DetectionResult[]>()
    listManifests.mockReturnValue(manifests.promise)
    runDetection.mockReturnValue(detection.promise)

    const store = await freshStore()
    const first = store.getState().bootstrap()
    const second = store.getState().bootstrap()

    // 第二次调用必须复用同一个 promise，而不是再跑一遍
    expect(second).toBe(first)

    manifests.resolve(MANIFESTS)
    await flush()
    detection.resolve([RESULT])
    await Promise.all([first, second])

    expect(listManifests).toHaveBeenCalledTimes(1)
    expect(runDetection).toHaveBeenCalledTimes(1)
  })

  it('清单与检测结果正确落到 state', async () => {
    listManifests.mockResolvedValue(MANIFESTS)
    runDetection.mockResolvedValue([RESULT])

    const store = await freshStore()
    await store.getState().bootstrap()

    const state = store.getState()
    expect(state.tools).toHaveLength(1)
    expect(state.detections.demo.status).toBe('installed')
    expect(state.detecting).toBe(false)
    expect(state.fatalError).toBeNull()
  })

  it('清单加载失败时落到 fatalError，且不去跑检测', async () => {
    listManifests.mockRejectedValue(new Error('清单目录不存在'))

    const store = await freshStore()
    await store.getState().bootstrap()

    expect(store.getState().fatalError).toBe('清单目录不存在')
    expect(runDetection).not.toHaveBeenCalled()
  })
})

describe('refreshDetection 并发控制', () => {
  it('检测进行中再次调用会被合并，不会并发扫描', async () => {
    const detection = deferred<DetectionResult[]>()
    listManifests.mockResolvedValue(MANIFESTS)
    runDetection.mockReturnValue(detection.promise)

    const store = await freshStore()
    const booting = store.getState().bootstrap()
    await flush()

    // 此时第一轮检测正在进行（runDetection 的 promise 还没 resolve）
    const again = store.getState().refreshDetection()
    detection.resolve([RESULT])
    await Promise.all([booting, again])

    expect(runDetection).toHaveBeenCalledTimes(1)
  })

  it('上一轮结束后可以再次检测（闸门被释放）', async () => {
    listManifests.mockResolvedValue(MANIFESTS)
    runDetection.mockResolvedValue([RESULT])

    const store = await freshStore()
    await store.getState().bootstrap()
    await store.getState().refreshDetection()

    expect(runDetection).toHaveBeenCalledTimes(2)
  })

  it('没有清单时不发起检测', async () => {
    listManifests.mockResolvedValue({ ...MANIFESTS, tools: [] })

    const store = await freshStore()
    await store.getState().bootstrap()

    expect(runDetection).not.toHaveBeenCalled()
  })
})
