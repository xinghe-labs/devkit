import { create } from 'zustand'
import type {
  InstallPlan,
  InstallProgressDetail,
  InstallProgressEvent,
  PendingPlanLoad,
  PlanItem,
  PlanPreparation,
  PlanSelection
} from '@shared/types'

export type InstallPhase = 'idle' | 'preflight' | 'running' | 'done'

const TERMINAL_STATES = new Set<PlanItem['state']>([
  'success',
  'failed',
  'skipped',
  'cancelled'
])

export function isItemFinished(item: PlanItem): boolean {
  return TERMINAL_STATES.has(item.state)
}

export function isPlanFinished(plan: InstallPlan | null): boolean {
  return plan !== null && plan.items.length > 0 && plan.items.every(isItemFinished)
}

export function unfinishedCount(plan: InstallPlan | null): number {
  if (!plan) return 0
  return plan.items.filter((item) => !isItemFinished(item)).length
}

interface InstallState {
  phase: InstallPhase
  preparation: PlanPreparation | null
  plan: InstallPlan | null
  currentItemId: string | null
  detail: InstallProgressDetail | null
  busy: boolean
  error: string | null
  pending: PendingPlanLoad | null

  checkPending: () => Promise<void>
  discardPending: () => Promise<void>
  resume: () => Promise<void>
  prepare: (selections: PlanSelection[], availableToolIds?: string[]) => Promise<void>
  start: () => Promise<void>
  cancel: () => Promise<void>
  exportReport: () => Promise<string | null>
  close: () => void
  /** 只清错误、不动计划（App 顶部的错误条用它关闭） */
  clearError: () => void
  applyProgress: (event: InstallProgressEvent) => void
}

export const useInstallStore = create<InstallState>()((set, get) => ({
  phase: 'idle',
  preparation: null,
  plan: null,
  currentItemId: null,
  detail: null,
  busy: false,
  error: null,
  pending: null,

  checkPending: async () => {
    try {
      const pending = await window.devkit.getPendingPlan()
      set({ pending: pending.status === 'none' ? null : pending })
    } catch {
      // 读不到 pending 不影响正常使用，静默忽略
      set({ pending: null })
    }
  },

  discardPending: async () => {
    await window.devkit.discardPendingPlan()
    set({ pending: null })
  },

  resume: async () => {
    const pending = get().pending
    set({ busy: true, error: null })
    try {
      const result = await window.devkit.resumeInstall()
      if (!result.started) {
        set({ error: result.error ?? '无法继续上次的安装' })
        return
      }
      // 后续进度由 progress 事件推送；先把上次的计划摆上去，避免抽屉一开始是空的
      set({
        phase: 'running',
        plan: pending?.status === 'ok' ? pending.plan : get().plan,
        pending: null
      })
    } catch (error) {
      set({ error: (error as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  prepare: async (selections, availableToolIds) => {
    set({ busy: true, error: null })
    try {
      const preparation = await window.devkit.prepareInstall(selections, false, availableToolIds)
      set({ preparation, plan: preparation.plan, phase: 'preflight' })
    } catch (error) {
      set({ error: (error as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  start: async () => {
    const plan = get().plan
    if (!plan) {
      set({ error: '没有待执行的安装计划' })
      return
    }

    set({ busy: true, error: null })
    try {
      const result = await window.devkit.startInstall(plan.planId)
      if (!result.started) {
        set({ error: result.error ?? '无法开始安装' })
        return
      }
      set({ phase: 'running' })
    } catch (error) {
      set({ error: (error as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  cancel: async () => {
    await window.devkit.cancelInstall()
  },

  exportReport: async () => {
    try {
      return await window.devkit.exportInstallReport()
    } catch (error) {
      set({ error: (error as Error).message })
      return null
    }
  },

  clearError: () => set({ error: null }),

  close: () =>
    set({
      phase: 'idle',
      preparation: null,
      plan: null,
      currentItemId: null,
      detail: null,
      error: null
    }),

  applyProgress: (event) =>
    set({
      plan: event.plan,
      currentItemId: event.currentItemId,
      detail: event.detail,
      phase: isPlanFinished(event.plan) ? 'done' : 'running'
    })
}))
