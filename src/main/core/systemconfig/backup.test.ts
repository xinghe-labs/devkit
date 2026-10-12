import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let backupDir = ''
vi.mock('../../utils/app-paths', () => ({
  getBackupDir: () => backupDir
}))

const {
  clearBackupEntry,
  describeBackupFile,
  getBackupEntry,
  readSystemConfigBackup,
  recordBackup
} = await import('./backup')

const BS = String.fromCharCode(92)

/** 取注册表类型的备份记录（联合类型需要窄化） */
function regBackup(id: 'long-paths' | 'developer-mode') {
  const entry = getBackupEntry(id)
  if (!entry || entry.kind !== 'registry') throw new Error(`期望 registry 记录，实际 ${entry?.kind ?? '无'}`)
  return entry
}

function regEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'long-paths' as const,
    kind: 'registry' as const,
    path: `HKLM${BS}SYSTEM${BS}CurrentControlSet${BS}Control${BS}FileSystem`,
    name: 'LongPathsEnabled',
    existed: false,
    value: null,
    valueType: 'REG_DWORD' as const,
    backedUpAt: '2026-10-12T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  backupDir = mkdtempSync(join(tmpdir(), 'devkit-backup-'))
})

afterEach(() => {
  rmSync(backupDir, { recursive: true, force: true })
})

/**
 * 系统配置的备份账本（P1-2）。
 *
 * 最要紧的两条：
 *  1. **首写胜出** —— 第二次「启用」时原值已经被自己改过了，
 *     再记一次就把真正的原值覆盖掉了，还原会还原成"devkit 改过的样子"。
 *  2. **区分「原本不存在」与「原本为 0」** —— 两者界面都显示"没启用"，
 *     但还原动作完全不同（删值 vs 写回 0）。
 */
describe('系统配置备份账本', () => {
  it('第一次记账后能读回来', () => {
    recordBackup(regEntry())
    expect(regBackup('long-paths').existed).toBe(false)
  })

  it('首写胜出：第二次记账不覆盖第一次的原值', () => {
    recordBackup(regEntry({ existed: false, value: null, backedUpAt: 'T1' }))
    // 第二次「启用」时，值已经是 1 了 —— 如果不做首写胜出，
    // 备份里就会记成 existed=true/value=1，还原时把用户钉死在"开启"状态
    recordBackup(regEntry({ existed: true, value: 1, backedUpAt: 'T2' }))

    const entry = regBackup('long-paths')
    expect(entry.existed).toBe(false)
    expect(entry.value).toBeNull()
    expect(entry.backedUpAt).toBe('T1')
    expect(readSystemConfigBackup().entries).toHaveLength(1)
  })

  it('区分「原本不存在」与「原本为 0」', () => {
    recordBackup(regEntry({ id: 'long-paths', existed: false, value: null }))
    recordBackup(regEntry({ id: 'developer-mode', existed: true, value: 0 }))

    expect(regBackup('long-paths')).toMatchObject({ existed: false, value: null })
    expect(regBackup('developer-mode')).toMatchObject({ existed: true, value: 0 })
  })

  it('不同项互不干扰', () => {
    recordBackup(regEntry({ id: 'long-paths' }))
    recordBackup({
      id: 'git-identity',
      kind: 'git-config',
      keys: [{ key: 'user.name', existed: false, value: null }],
      backedUpAt: 'T'
    })
    expect(readSystemConfigBackup().entries).toHaveLength(2)
    expect(getBackupEntry('git-identity')?.kind).toBe('git-config')
  })

  it('销账之后读不到，文件里也没了', () => {
    recordBackup(regEntry())
    clearBackupEntry('long-paths')
    expect(getBackupEntry('long-paths')).toBeUndefined()
    expect(readSystemConfigBackup().entries).toHaveLength(0)
  })

  it('销一个不存在的账不会出错，也不会破坏别的记录', () => {
    recordBackup(regEntry({ id: 'long-paths' }))
    clearBackupEntry('developer-mode')
    expect(readSystemConfigBackup().entries).toHaveLength(1)
  })

  it('文件不存在时返回空账本（首次运行）', () => {
    expect(readSystemConfigBackup()).toEqual({ schemaVersion: 1, entries: [] })
  })

  it('账本损坏时按空处理，不抛异常把程序带崩', () => {
    writeFileSync(describeBackupFile(), '{ 这不是 JSON', 'utf8')
    expect(() => readSystemConfigBackup()).not.toThrow()
    expect(readSystemConfigBackup().entries).toEqual([])
  })

  it('账本结构不对（entries 不是数组）也按空处理', () => {
    writeFileSync(describeBackupFile(), JSON.stringify({ entries: 'oops' }), 'utf8')
    expect(readSystemConfigBackup().entries).toEqual([])
  })

  it('落盘的是 UTF-8 且带缩进的 JSON（用户要能自己看、自己改）', () => {
    recordBackup(regEntry())
    const raw = readFileSync(describeBackupFile(), 'utf8')
    expect(raw).toContain('\n  ')
    expect(JSON.parse(raw).entries).toHaveLength(1)
  })

  it('备份文件落在 backup 目录下且名字稳定', () => {
    expect(describeBackupFile()).toBe(join(backupDir, 'system-config.json'))
  })
})
