import { readActivationState } from './index'
import { readMachinePath } from './windows'
import { getDataRoot } from '../../utils/app-paths'
import { logger } from '../report/logger'

/**
 * 「全局可用」：把已激活工具的 PATH 条目也写进**机器级** PATH（P1-2 之后的第二件事）。
 *
 * ## 为什么默认关着
 *
 * 写机器级 PATH 要管理员权限，而且它有两个真实代价：
 *
 * 1. **每次改动弹 UAC**，且 HKLM 的 PATH 是所有账号共享的 —— 用户 A 装 node 18、
 *    用户 B 装 node 22，会互相打架。
 * 2. **这台机器就是反面教材**：机器级 PATH 33 条里有 8 条坏条目
 *    （`C:\P`、`ogram Files\Git\cmd`、`%NOODE_PATH%`…），
 *    是历史上某个安装器用 `setx` 写、撞上 1024 字符静默截断留下的。
 *
 * 所以这里**不做自动同步** —— 它是一个用户显式点的动作，一次 UAC，改前备份、改完复验。
 *
 * ## 一个必须说清的边界
 *
 * 机器 PATH 里的条目用**绝对路径**（`<dataRoot>\current\<tool>\...`），
 * 因为 `%DEVKIT_HOME%` 是用户级变量，别的账号根本读不到。
 * 但这也意味着：**只有当 `dataRoot` 在共享位置时，「所有账号都能用」才成立**。
 * 若 dataRoot 还在 `%USERPROFILE%\.devkit` 下，那"全局可用"实际只对
 * **以管理员身份运行的进程**有效（它们仍带当前用户的 PATH 与环境变量）。
 * 界面必须把这一点讲明白，不能含糊成"全局可用"。
 */

/** 展开用（带 g） */
const DEVKIT_HOME_VAR = /%DEVKIT_HOME%/gi
/** 判断用（不带 g）—— 带 g 的正则 .test() 有 lastIndex 状态，连续调用会错 */
const DEVKIT_HOME_VAR_TEST = /%DEVKIT_HOME%/i

/** 一个条目是不是 devkit 管的（指向 dataRoot 下的 current 目录） */
export function isDevkitMachineEntry(entry: string, dataRoot: string): boolean {
  const normalized = entry.trim().replace(/\\+$/, '').toLowerCase()
  if (normalized === '') return false
  const root = dataRoot.trim().replace(/\\+$/, '').toLowerCase()
  // 绝对路径形式
  if (normalized.startsWith(`${root}\\current\\`)) return true
  // 变量形式（用户在用户级 PATH 里可能这么写；机器级里虽然少见，也认）
  if (normalized.includes('%devkit_home%')) return true
  return false
}

export interface MachinePathPlan {
  /** 算好的新 PATH 值 */
  next: string
  added: string[]
  removed: string[]
  /** 结果会不会是空值 —— 空值一律拒绝执行 */
  wouldBeEmpty: boolean
}

function splitEntries(raw: string): string[] {
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * 把条目**追加**到机器 PATH 末尾（不是插到最前）。
 *
 * 用户 PATH 那边 devkit 是插到最前的（要让自己装的版本优先）。
 * 机器级不一样：这里放的是系统级工具与驱动，插到最前会改变它们的解析顺序，
 * 可能把别人的东西顶掉。追加是这里唯一稳妥的选择。
 */
export function planMachinePathAdd(
  currentRaw: string,
  wanted: string[],
  dataRoot: string
): MachinePathPlan {
  const entries = splitEntries(currentRaw)
  const lowered = new Set(entries.map((entry) => entry.toLowerCase()))
  const added: string[] = []

  for (const entry of wanted) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    // 只允许往机器 PATH 里放 devkit 自己管的条目。
    // 不加这道门，任何调用方都能把任意路径塞进系统 PATH —— 那就是一条持久化的劫持通道。
    if (!isDevkitMachineEntry(trimmed, dataRoot)) continue
    if (lowered.has(trimmed.toLowerCase())) continue
    entries.push(trimmed)
    lowered.add(trimmed.toLowerCase())
    added.push(trimmed)
  }

  const next = entries.join(';')
  return {
    next,
    added,
    removed: [],
    wouldBeEmpty: next.trim() === ''
  }
}

/** 移除所有 devkit 管的条目，其余原样保留 */
export function planMachinePathRemove(currentRaw: string, dataRoot: string): MachinePathPlan {
  const entries = splitEntries(currentRaw)
  const kept: string[] = []
  const removed: string[] = []

  for (const entry of entries) {
    if (isDevkitMachineEntry(entry, dataRoot)) removed.push(entry)
    else kept.push(entry)
  }

  const next = kept.join(';')
  return {
    next,
    added: [],
    removed,
    // 只剩空值说明机器 PATH 上本来就只有 devkit 的东西 —— 拒绝，别把系统 PATH 清空
    wouldBeEmpty: next.trim() === ''
  }
}

/**
 * 当前已激活的工具，在机器 PATH 上需要哪些条目（绝对路径形式）。
 *
 * `%DEVKIT_HOME%` 必须展开成 dataRoot：机器级上下文里没有这个用户变量。
 */
export function collectWantedMachineEntries(dataRoot: string): string[] {
  const state = readActivationState()
  const wanted = new Set<string>()

  for (const record of state.records) {
    for (const entry of record.pathEntries) {
      const absolute = entry.replace(DEVKIT_HOME_VAR, dataRoot)
      // 变量没被替换掉的（用户自定义过 DEVKIT_HOME）也不要，机器级里它没有意义
      if (DEVKIT_HOME_VAR_TEST.test(absolute)) continue
      wanted.add(absolute)
    }
  }

  return [...wanted]
}

export interface MachinePathState {
  /** 机器 PATH 的总条目数 */
  total: number
  /** 其中 devkit 管的条目 */
  devkitEntries: string[]
  /** 已激活工具想在机器 PATH 上放的条目 */
  wantedEntries: string[]
  /** 想要的但还没放上去的 */
  pending: string[]
  /** 机器 PATH 原始值（只读展示） */
  raw: string
}

export async function readMachinePathState(): Promise<MachinePathState> {
  const dataRoot = getDataRoot()
  const raw = await readMachinePath()
  const entries = splitEntries(raw)
  const devkitEntries = entries.filter((entry) => isDevkitMachineEntry(entry, dataRoot))
  const wantedEntries = collectWantedMachineEntries(dataRoot)
  const lowered = new Set(entries.map((entry) => entry.toLowerCase()))
  const pending = wantedEntries.filter((entry) => !lowered.has(entry.toLowerCase()))

  return { total: entries.length, devkitEntries, wantedEntries, pending, raw }
}

export type MachinePathMode = 'add' | 'remove'

export interface MachinePathSyncResult {
  ok: boolean
  mode: MachinePathMode
  added: string[]
  removed: string[]
  /** 改完之后重新读到的机器 PATH 条目数（用于复验） */
  totalAfter: number
  error: string | null
}

/**
 * 执行同步。**只负责算与验**，提权写入由调用方注入 ——
 * 这样核心逻辑可以单测，不必真的弹 UAC。
 */
export async function syncMachinePath(
  mode: MachinePathMode,
  write: (value: string) => Promise<{ ok: boolean; error: string | null }>
): Promise<MachinePathSyncResult> {
  const dataRoot = getDataRoot()
  const currentRaw = await readMachinePath()

  const plan =
    mode === 'add'
      ? planMachinePathAdd(currentRaw, collectWantedMachineEntries(dataRoot), dataRoot)
      : planMachinePathRemove(currentRaw, dataRoot)

  const empty = { added: [] as string[], removed: [] as string[], totalAfter: splitEntries(currentRaw).length }

  if (plan.added.length === 0 && plan.removed.length === 0) {
    return { ok: true, mode, ...empty, error: null }
  }

  if (plan.wouldBeEmpty) {
    logger.warn('machine-path', `同步被拒绝：算出来的机器 PATH 是空值`)
    return {
      ok: false,
      mode,
      added: [],
      removed: [],
      totalAfter: splitEntries(currentRaw).length,
      error: '同步后机器级 PATH 会变成空值，已拒绝执行'
    }
  }

  const outcome = await write(plan.next)
  if (!outcome.ok) {
    return {
      ok: false,
      mode,
      added: [],
      removed: [],
      totalAfter: splitEntries(currentRaw).length,
      error: outcome.error ?? '写入机器级 PATH 失败'
    }
  }

  // 复验：写完重新读一遍，确认条目真的进去了 / 真的没了
  const afterRaw = await readMachinePath()
  const afterEntries = splitEntries(afterRaw)
  const loweredAfter = new Set(afterEntries.map((entry) => entry.toLowerCase()))

  const missing = plan.added.filter((entry) => !loweredAfter.has(entry.toLowerCase()))
  const leftovers = plan.removed.filter((entry) => loweredAfter.has(entry.toLowerCase()))

  if (missing.length > 0 || leftovers.length > 0) {
    const problem =
      missing.length > 0
        ? `写入后复验失败：${missing.join('；')} 没有出现在机器级 PATH 里`
        : `移除后复验失败：${leftovers.join('；')} 仍然在机器级 PATH 里`
    logger.warn('machine-path', problem)
    return { ok: false, mode, added: [], removed: [], totalAfter: afterEntries.length, error: problem }
  }

  logger.info(
    'machine-path',
    `机器级 PATH 已同步（${mode === 'add' ? '新增' : '移除'} ${mode === 'add' ? plan.added.length : plan.removed.length} 条，现共 ${afterEntries.length} 条）`
  )

  return {
    ok: true,
    mode,
    added: plan.added,
    removed: plan.removed,
    totalAfter: afterEntries.length,
    error: null
  }
}
