import { create } from 'zustand'
import type {
  AppInfo,
  DetectionResult,
  Locale,
  ManifestLoadError,
  PlanSelection,
  ToolCategory,
  ToolManifest
} from '@shared/types'
import { DEFAULT_LOCALE } from '@shared/types'
import { pickRecommendedVersion } from '@shared/manifest'
import { changeLanguage } from '../i18n'

export type CategoryFilter = ToolCategory | 'all'

interface AppState {
  info: AppInfo | null
  locale: Locale
  tools: ToolManifest[]
  manifestErrors: ManifestLoadError[]
  manifestDir: string
  detections: Record<string, DetectionResult>
  detecting: boolean
  selected: Record<string, boolean>
  selectedVersions: Record<string, string>
  /** 由 selected + selectedVersions 推导出的勾选结果，供预设保存与安装使用 */
  selections: PlanSelection[]
  activeCategory: CategoryFilter
  query: string
  fatalError: string | null

  bootstrap: () => Promise<void>
  refreshDetection: () => Promise<void>
  changeLocale: (locale: Locale) => Promise<void>
  toggleTool: (toolId: string, checked: boolean) => void
  setSelectedVersion: (toolId: string, version: string) => void
  /** 套用预设：把勾选与版本一次性设成预设的内容（已有勾选会被替换） */
  applyPreset: (preset: PlanSelection[]) => void
  selectCategory: (category: CategoryFilter) => void
  setQuery: (query: string) => void
  clearSelection: () => void
  setInfo: (info: AppInfo) => void
  setFatalError: (message: string | null) => void
}

/**
 * 启动流程与检测都只允许同时跑一次。
 *
 * 这两个闸门是必需的，不是防御性编程：
 * React StrictMode 在开发模式下会故意把 effect 跑两遍以暴露副作用问题，
 * 它确实抓到了 —— 不加闸门时清单加载与整轮环境检测各跑两次，
 * 注册表被扫两遍（本机实测每次 2~9 秒），用户看到的就是启动明显变慢。
 * 同一个闸门也顺便挡住了"重新检测"按钮连点导致的并发扫描。
 */
let bootstrapPromise: Promise<void> | null = null
let detectionPromise: Promise<void> | null = null

export const useAppStore = create<AppState>()((set, get) => ({
  info: null,
  locale: DEFAULT_LOCALE,
  tools: [],
  manifestErrors: [],
  manifestDir: '',
  detections: {},
  detecting: false,
  selected: {},
  selectedVersions: {},
  selections: [],
  activeCategory: 'all',
  query: '',
  fatalError: null,

  setInfo: (info) => set({ info, locale: info.locale }),

  setFatalError: (message) => set({ fatalError: message }),

  /** 启动流程：读清单 → 跑检测。任一步失败都落到 fatalError，界面给出可读提示。 */
  bootstrap: () => {
    if (bootstrapPromise) return bootstrapPromise

    const task = (async () => {
      try {
        const result = await window.devkit.listManifests()
        set({
          tools: result.tools,
          manifestErrors: result.errors,
          manifestDir: result.dir,
          fatalError: null
        })
      } catch (error) {
        set({ fatalError: (error as Error).message })
        return
      }
      await get().refreshDetection()
    })()

    bootstrapPromise = task
    return task
  },

  refreshDetection: () => {
    if (detectionPromise) return detectionPromise

    const task = (async () => {
      if (get().tools.length === 0) return

      set({ detecting: true })
      try {
        const results = await window.devkit.runDetection({})
        const detections: Record<string, DetectionResult> = {}
        for (const result of results) detections[result.toolId] = result
        set({ detections, fatalError: null })
      } catch (error) {
        set({ fatalError: (error as Error).message })
      } finally {
        set({ detecting: false })
      }
    })()

    // 完成后释放闸门，允许用户手动重新检测
    detectionPromise = task.finally(() => {
      detectionPromise = null
    })
    return detectionPromise
  },

  changeLocale: async (locale) => {
    // 先落盘再切界面：即使切换语言时崩溃，下次启动也是用户选的语言
    await window.devkit.setLocale(locale)
    await changeLanguage(locale)
    set({ locale })
  },

  toggleTool: (toolId, checked) =>
    set((state) => {
      const selected = { ...state.selected, [toolId]: checked }
      return { selected, selections: computeSelections(state.tools, selected, state.selectedVersions) }
    }),

  setSelectedVersion: (toolId, version) =>
    set((state) => {
      const selectedVersions = { ...state.selectedVersions, [toolId]: version }
      return {
        selectedVersions,
        selections: computeSelections(state.tools, state.selected, selectedVersions)
      }
    }),

  applyPreset: (preset) =>
    set((state) => {
      const selected: Record<string, boolean> = {}
      const selectedVersions: Record<string, string> = {}
      const known = new Map(state.tools.map((tool) => [tool.id, tool]))

      for (const item of preset) {
        const tool = known.get(item.toolId)
        if (!tool) continue
        selected[item.toolId] = true

        // 预设指定的版本如果已不存在，就回退到推荐版本，而不是让这一项装不了
        const version =
          item.version && tool.versions.some((entry) => entry.version === item.version)
            ? item.version
            : (pickRecommendedVersion(tool)?.version ?? '')
        if (version) selectedVersions[item.toolId] = version
      }

      return { selected, selectedVersions, selections: computeSelections(state.tools, selected, selectedVersions) }
    }),

  selectCategory: (category) => set({ activeCategory: category }),

  setQuery: (query) => set({ query }),

  clearSelection: () => set({ selected: {}, selectedVersions: {}, selections: [] })
}))

/** 把"勾选表 + 版本表"整理成安装计划需要的选择数组 */
function computeSelections(
  tools: ToolManifest[],
  selected: Record<string, boolean>,
  selectedVersions: Record<string, string>
): PlanSelection[] {
  const result: PlanSelection[] = []
  for (const tool of tools) {
    if (selected[tool.id] !== true) continue
    const version = selectedVersions[tool.id]
    result.push(version ? { toolId: tool.id, version } : { toolId: tool.id })
  }
  return result
}
