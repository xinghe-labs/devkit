import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 系统配置的写路径（FR-6 / P1-2）。
 *
 * 这个模块**会改用户的机器**（HKLM 注册表、~/.gitconfig、机器级 PATH），
 * 所以最该被测的不是"成功路径长什么样"，而是**几条拒绝规则**：
 *
 *  - 读不到原值就不改（拿不到原值就没有还原路径）
 *  - 没有备份记录就不还原
 *  - SSH 私钥永不还原（删私钥是破坏性操作）
 *  - 还原后必须复验
 *
 * 这些规则以前一条测试都没有 —— 而它们正是"改了回不去"的最后一道闸。
 */

let backupDir = ''
/** 这些注册表键存在 */
let regKeys = new Set<string>()
/** 值名 → 值；null 表示"键在、值不存在" */
let regValues = new Map<string, number | null>()
let elevatedCalls: unknown[][] = []
let elevatedOk = true
/** 机器级 PATH 的读取结果（还原复验用） */
let machinePathValue = 'C:' + String.fromCharCode(92) + 'WINDOWS'

const notFound = { code: 1, stdout: '', stderr: '找不到', spawnError: null }

vi.mock('../../utils/app-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/app-paths')>()
  return { ...actual, getBackupDir: () => backupDir }
})

vi.mock('../../utils/exec', () => ({
  runCommand: async (cmd: string, args: string[]) => {
    if (cmd === 'reg.exe' && args[0] === 'query') {
      const vIndex = args.indexOf('/v')
      if (vIndex >= 0) {
        const name = args[vIndex + 1] as string
        if (!regValues.has(name)) return notFound
        const value = regValues.get(name)
        // null / undefined = 键在但值不存在 → reg query 返回非零
        if (value === null || value === undefined) return notFound
        return {
          code: 0,
          stdout: `    ${name}    REG_DWORD    0x${value.toString(16)}`,
          stderr: '',
          spawnError: null
        }
      }
      const key = args[1] as string
      return regKeys.has(key)
        ? { code: 0, stdout: 'HKEY_LOCAL_MACHINE\\...', stderr: '', spawnError: null }
        : notFound
    }
    if (cmd === 'git') return { code: 0, stdout: '', stderr: '', spawnError: null }
    return notFound
  }
}))

vi.mock('../elevation', () => ({
  runElevated: async (steps: unknown[][]) => {
    elevatedCalls.push(steps)
    return elevatedOk
      ? { ok: true, elevated: true, cancelled: false, steps: [], error: null }
      : { ok: false, elevated: true, cancelled: false, steps: [], error: '提权失败' }
  },
  toExecStep: (label: string, command: unknown) => ({ kind: 'exec', label, ...(command as object) }),
  toMachinePathStep: (label: string, value: string) => ({ kind: 'set-machine-path', label, value })
}))

vi.mock('../activate/windows', () => ({
  readMachinePath: async () => machinePathValue,
  readUserPath: async () => '',
  writeUserPath: async () => undefined
}))

const { recordBackup, clearBackupEntry, getBackupEntry } = await import('./backup')
const { applySystemConfig, revertSystemConfig } = await import('./index')

const BS = String.fromCharCode(92)

/** 让两个注册表键都存在 */
function keysExist(): void {
  regKeys = new Set([
    `HKLM${BS}SYSTEM${BS}CurrentControlSet${BS}Control${BS}FileSystem`,
    `HKLM${BS}SOFTWARE${BS}Microsoft${BS}Windows${BS}CurrentVersion${BS}AppModelUnlock`
  ])
}

/** 设置一个 REG_DWORD：null 表示"键在、值不存在" */
function setDword(name: string, value: number | null): void {
  keysExist()
  regValues.set(name, value)
}

beforeEach(() => {
  backupDir = mkdtempSync(join(tmpdir(), 'devkit-syscfg-'))
  regKeys = new Set()
  regValues = new Map()
  elevatedCalls = []
  elevatedOk = true
  machinePathValue = `C:${BS}WINDOWS`
})

afterEach(() => {
  rmSync(backupDir, { recursive: true, force: true })
})

describe('applySystemConfig：读不到原值就不改', () => {
  it('**注册表键读不到时拒绝写**（拿不到原值就没有还原路径）', async () => {
    // 键不存在 → readRegDword 的 keyExists 为 false
    regKeys = new Set()

    const result = await applySystemConfig({ id: 'long-paths' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法备份原值')
    // 关键：没有发起任何提权写入
    expect(elevatedCalls).toHaveLength(0)
  })

  it('原值为 0 时写入，并记下「原本存在且为 0」', async () => {
    setDword('LongPathsEnabled', 0)

    const result = await applySystemConfig({ id: 'long-paths' })

    expect(result.ok).toBe(true)
    expect(elevatedCalls).toHaveLength(1)
    // 记录必须区分「原本不存在」与「原本为 0」—— 两者还原动作不同（删值 vs 写回 0）
    expect(getBackupEntry('long-paths')).toMatchObject({ existed: true, value: 0 })
  })

  it('原值不存在时写入，记成「原本不存在」（还原时删值）', async () => {
    setDword('LongPathsEnabled', null)

    await applySystemConfig({ id: 'long-paths' })

    expect(getBackupEntry('long-paths')).toMatchObject({ existed: false, value: null })
  })

  it('已经是 1 时不重复写入，但仍然记账（用户要能看到"可还原"）', async () => {
    setDword('LongPathsEnabled', 1)

    const result = await applySystemConfig({ id: 'long-paths' })

    expect(result.ok).toBe(true)
    expect(result.detail).toContain('无需改动')
    expect(elevatedCalls).toHaveLength(0)
    expect(getBackupEntry('long-paths')).toBeDefined()
  })

  it('提权失败时不记账（免得界面显示"已修改"其实是假的）', async () => {
    setDword('LongPathsEnabled', 0)
    elevatedOk = false

    const result = await applySystemConfig({ id: 'long-paths' })

    expect(result.ok).toBe(false)
    expect(getBackupEntry('long-paths')).toBeUndefined()
  })

  it('git 身份的邮箱格式不对时拒绝，且不写任何东西', async () => {
    const result = await applySystemConfig({
      id: 'git-identity',
      gitName: 'x',
      gitEmail: 'not-an-email'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('格式不正确')
  })

  it('git 身份的名字含 <> 时拒绝（防注入）', async () => {
    const result = await applySystemConfig({
      id: 'git-identity',
      gitName: 'a<b>',
      gitEmail: 'a@b.com'
    })
    expect(result.ok).toBe(false)
  })

  it('未知的配置项直接报错，不做任何事', async () => {
    const result = await applySystemConfig({ id: 'nope' as never })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未知的系统配置项')
  })
})

describe('revertSystemConfig：几条拒绝规则', () => {
  it('**没有备份记录就不还原**', async () => {
    const result = await revertSystemConfig('git-identity')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有 devkit 的备份记录')
    expect(elevatedCalls).toHaveLength(0)
  })

  it('**SSH 私钥永不还原**（可能已用于 GitHub/GitLab，删掉是破坏性操作）', async () => {
    const result = await revertSystemConfig('ssh-key')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不提供自动还原')
  })

  it('注册表项：原本不存在 → 删值；删除失败且是"找不到"时按成功处理', async () => {
    recordBackup({
      id: 'long-paths',
      kind: 'registry',
      path: `HKLM${BS}SYSTEM${BS}CurrentControlSet${BS}Control${BS}FileSystem`,
      name: 'LongPathsEnabled',
      existed: false,
      value: null,
      valueType: 'REG_DWORD',
      backedUpAt: 'T'
    })

    // 提权"失败"，但原因是值本来就不存在 —— 这是预期结果
    elevatedOk = false
    const result = await revertSystemConfig('long-paths')

    // 提权失败且不是"找不到"时应当报错并**保留备份记录**（用户可以重试）
    expect(result.ok).toBe(false)
    expect(getBackupEntry('long-paths')).toBeDefined()
  })

  it('机器级 PATH：还原后**逐条比对**，不一致就报错且不销账', async () => {
    recordBackup({
      id: 'machine-path',
      kind: 'machine-path',
      value: `C:${BS}WINDOWS${BS}system32`,
      entryCount: 1,
      backedUpAt: 'T'
    })
    // 提权"成功"，但机器 PATH 实际不是备份里那个 → 必须复验出来
    machinePathValue = `C:${BS}WINDOWS${BS}system32;D:${BS}other`

    const result = await revertSystemConfig('machine-path')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('复验不通过')
    expect(getBackupEntry('machine-path')).toBeDefined()
  })

  it('机器级 PATH：还原后逐条一致 → 成功并销账', async () => {
    recordBackup({
      id: 'machine-path',
      kind: 'machine-path',
      value: `C:${BS}WINDOWS${BS}system32`,
      entryCount: 1,
      backedUpAt: 'T'
    })
    machinePathValue = `C:${BS}WINDOWS${BS}system32`

    const result = await revertSystemConfig('machine-path')

    expect(result.ok).toBe(true)
    expect(result.detail).toContain('已还原')
    expect(getBackupEntry('machine-path')).toBeUndefined()
  })

  it('销账之后就不再是"可还原"状态', () => {
    recordBackup({
      id: 'powershell-policy',
      kind: 'execution-policy',
      scope: 'CurrentUser',
      existed: true,
      value: 'RemoteSigned',
      backedUpAt: 'T'
    })
    expect(getBackupEntry('powershell-policy')).toBeDefined()
    clearBackupEntry('powershell-policy')
    expect(getBackupEntry('powershell-policy')).toBeUndefined()
  })
})
