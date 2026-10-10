import { create } from 'zustand'
import type { LogEntry } from '@shared/types'

const MAX_ENTRIES = 2000

interface LogState {
  entries: LogEntry[]
  append: (entry: LogEntry) => void
  setAll: (entries: LogEntry[]) => void
  clear: () => void
}

/**
 * 日志单独一个 store。
 * 日志每几百毫秒就可能来一条，如果和主 store 混在一起，会导致工具列表跟着一起重渲染。
 */
export const useLogStore = create<LogState>()((set) => ({
  entries: [],

  append: (entry) =>
    set((state) => {
      const next =
        state.entries.length >= MAX_ENTRIES
          ? state.entries.slice(-MAX_ENTRIES + 1)
          : state.entries.slice()
      next.push(entry)
      return { entries: next }
    }),

  setAll: (entries) => set({ entries }),

  clear: () => set({ entries: [] })
}))
