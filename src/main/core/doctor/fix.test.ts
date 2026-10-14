import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 体检的修复动作（FR-21）。
 *
 * 这个模块**会改用户的 PATH**，所以最该被测的是三条硬规矩，而不是"成功路径"：
 *
 *  1. 改之前先备份
 *  2. 改完复验（写完重新读一遍）
 *  3. 危险结果拒绝执行（算出来是空值就停手）
 *
 * 以及 `prune-devkit-state` 的一条边界：**只动 devkit 自己记录的东西**，
 * 不猜"哪条 PATH 是脏数据"。
 */

let backupDir = ''
let userPathValue = ''
let writtenPaths: string[] = []
let machinePathValue = ''
let elevatedCalls: unknown[][] = []
let elevationOk = true
let activationRecords: unknown[] = []
let deactivated: string[] = []
/** 模拟"写进去了但又被别的程序改回去" */
let writeIsIgnored = false
let machineWriteIsIgnored = false

vi.mock('../../utils/app-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/app-paths')>()
  return { ...actual, getBackupDir: () => backupDir }
})

vi.mock('../activate/windows', () => ({
  readUserPath: async () => userPathValue,
  writeUserPath: async (value: string) => {
    writtenPaths.push(value)
    if (!writeIsIgnored) userPathValue = value
  },
  readMachinePath: async () => machinePathValue
}))

vi.mock('../activate', () => ({
  readActivationState: () => ({ records: activationRecords, backupFile: null }),
  deactivateTool: async (toolId: string) => {
    deactivated.push(toolId)
    return { ok: true, removed: [`PATH ${toolId}`], error: null }
  },
  getLinkPath: (name: string) => `C:\\link\\${name}`,
  removeJunction: () => true
}))

vi.mock('../elevation', () => ({
  runElevated: async (steps: unknown[]) => {
    elevatedCalls.push(steps)
    if (!elevationOk) {
      return { ok: false, elevated: true, cancelled: false, steps: [], error: '提权失败' }
    }
    // 模拟提权写入真的生效（cleanMachinePath 会写后复验）
    for (const step of steps as { kind?: string; value?: string }[]) {
      if (step.kind === 'set-machine-path' && step.value !== undefined && !machineWriteIsIgnored) {
        machinePathValue = step.value
      }
    }
    return { ok: true, elevated: true, cancelled: false, steps: [], error: null }
  },
  toMachinePathStep: (label: string, value: string) => ({ kind: 'set-machine-path', label, value })
}))

const { applyDoctorFix } = await import('./fix')

const BS = String.fromCharCode(92)
const EXISTING = `C:${BS}WINDOWS${BS}system32`

beforeEach(() => {
  backupDir = mkdtempSync(join(tmpdir(), 'devkit-doctorfix-'))
  userPathValue = ''
  machinePathValue = ''
  writtenPaths = []
  elevatedCalls = []
  elevationOk = true
  activationRecords = []
  deactivated = []
  writeIsIgnored = false
  machineWriteIsIgnored = false
})

afterEach(() => {
  rmSync(backupDir, { recursive: true, force: true })
})

describe('clean-user-path：三条硬规矩', () => {
  it('没有可清理的东西时什么都不做，也不备份', async () => {
    userPathValue = EXISTING

    const result = await applyDoctorFix('clean-user-path')

    expect(result.ok).toBe(true)
    expect(result.changed).toEqual([])
    expect(result.backupFile).toBeNull()
    expect(writtenPaths).toHaveLength(0)
  })

  it('**改之前先备份**（备份文件真的落到 backup 目录且内容等于原文）', async () => {
    // 同一个目录写两次 → 重复条目
    userPathValue = `${EXISTING};${EXISTING}`

    const result = await applyDoctorFix('clean-user-path')

    expect(result.ok).toBe(true)
    expect(result.backupFile).toBeTruthy()
    expect(readFileSync(result.backupFile as string, 'utf8')).toBe(`${EXISTING};${EXISTING}`)
    expect(result.changed.length).toBeGreaterThan(0)
  })

  it('**算出来是空值就拒绝执行**，并且不写', async () => {
    // 只有一条不存在的目录 → 清完就是空的
    userPathValue = `C:${BS}definitely${BS}does${BS}not${BS}exist-devkit-test`

    const result = await applyDoctorFix('clean-user-path')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('空值')
    expect(writtenPaths).toHaveLength(0)
  })

  it('**改完复验**：写入被别的东西改回去时报错，而不是报成功', async () => {
    userPathValue = `${EXISTING};${EXISTING}`
    // 写入"成功"但值没变 —— 模拟被其它程序改回去 / 注册表写入没生效
    writeIsIgnored = true

    const result = await applyDoctorFix('clean-user-path')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('复验不一致')
    // 原文仍然备份了，用户可以手工确认
    expect(result.backupFile).toBeTruthy()
  })
})

describe('clean-machine-path：走提权，且同样拒绝空值', () => {
  it('机器级 PATH 需要提权（一次 UAC）', async () => {
    machinePathValue = `C:${BS}WINDOWS;${EXISTING};${EXISTING}`

    const result = await applyDoctorFix('clean-machine-path')

    expect(result.ok).toBe(true)
    expect(elevatedCalls).toHaveLength(1)
    // 提权步骤必须是写机器级 PATH，且带的是清理后的值
    const step = (elevatedCalls[0] as { kind: string; value: string }[])[0]
    expect(step.kind).toBe('set-machine-path')
    expect(step.value).toBe(`C:${BS}WINDOWS;${EXISTING}`)
  })

  it('**机器级也复验**：提权"成功"但值没变时报错，且不假装成功', async () => {
    machinePathValue = `C:${BS}WINDOWS;${EXISTING};${EXISTING}`
    machineWriteIsIgnored = true

    const result = await applyDoctorFix('clean-machine-path')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('复验不一致')
    expect(result.backupFile).toBeTruthy()
  })

  it('提权被取消时如实上报，不假装成功', async () => {
    machinePathValue = `C:${BS}WINDOWS;${EXISTING};${EXISTING}`
    elevationOk = false

    const result = await applyDoctorFix('clean-machine-path')

    expect(result.ok).toBe(false)
  })
})

describe('prune-devkit-state：只动 devkit 自己记录的东西', () => {
  it('**悬空的激活记录被移除**（目标目录已不存在）', async () => {
    activationRecords = [
      {
        toolId: 'nodejs',
        version: '24.21.0',
        linkName: 'nodejs',
        linkPath: `C:${BS}link${BS}nodejs`,
        // 这个目录不存在 → 悬空
        target: `C:${BS}definitely${BS}missing-devkit-test`,
        pathEntries: [],
        env: {},
        activatedAt: 'T'
      }
    ]

    const result = await applyDoctorFix('prune-devkit-state')

    expect(result.ok).toBe(true)
    expect(deactivated).toContain('nodejs')
    expect(result.changed.join('\n')).toContain('悬空激活记录')
  })

  it('**用户自己的 PATH 条目一条都不动**（没有记录认领的才清，且必须是 devkit 目录下的）', async () => {
    activationRecords = []
    // 用户的 PATH 里没有任何 devkit 条目 → 不该被改
    userPathValue = `D:${BS}Python;${EXISTING}`

    const result = await applyDoctorFix('prune-devkit-state')

    expect(result.ok).toBe(true)
    expect(result.changed).toEqual([])
    expect(writtenPaths).toHaveLength(0)
  })

  it('没有可清理的东西时返回空改动（幂等）', async () => {
    activationRecords = []
    userPathValue = EXISTING

    const first = await applyDoctorFix('prune-devkit-state')
    const second = await applyDoctorFix('prune-devkit-state')

    expect(first.changed).toEqual([])
    expect(second.changed).toEqual([])
  })
})

describe('未知修复项', () => {
  it('直接报错，不做任何事', async () => {
    const result = await applyDoctorFix('nope' as never)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未知的修复项')
  })
})
