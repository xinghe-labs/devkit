import { beforeEach, describe, expect, it, vi } from 'vitest'

const readMachinePath = vi.fn()
const getDataRoot = vi.fn(() => 'D:\\devkit')
const readActivationState = vi.fn()

vi.mock('./windows', () => ({ readMachinePath: () => readMachinePath() }))
vi.mock('../../utils/app-paths', () => ({ getDataRoot: () => getDataRoot() }))
vi.mock('./index', () => ({ readActivationState: () => readActivationState() }))

const {
  collectWantedMachineEntries,
  isDevkitMachineEntry,
  planMachinePathAdd,
  planMachinePathRemove,
  readMachinePathState,
  syncMachinePath
} = await import('./machine-path')

const BS = String.fromCharCode(92)
const ROOT = `D:${BS}devkit`
const CUR = `${ROOT}${BS}current`

/** 一台机器的真实样子：系统条目 + devkit 条目混在一起 */
const SYSTEM = [
  `C:${BS}WINDOWS${BS}system32`,
  `C:${BS}WINDOWS`,
  `C:${BS}Program Files${BS}PowerShell${BS}7${BS}`
].join(';')

function stateWith(entries: string[]) {
  return {
    records: [
      {
        toolId: 'nodejs',
        version: '24.21.0',
        linkName: 'nodejs',
        linkPath: `${CUR}${BS}nodejs`,
        target: `${ROOT}${BS}versions${BS}nodejs${BS}24.21.0`,
        pathEntries: entries,
        env: {},
        activatedAt: 'T'
      }
    ],
    binDir: `${ROOT}${BS}bin`,
    userPath: '',
    backupFile: null,
    managedEntries: []
  }
}

beforeEach(() => {
  readMachinePath.mockReset()
  readActivationState.mockReset()
  getDataRoot.mockReturnValue(ROOT)
})

/**
 * 「全局可用」= 把已激活工具的路径也写进机器级 PATH。
 *
 * 这个功能天生危险：写的是 HKLM，所有账号共享，而且这台机器的机器级 PATH
 * 已经因为历史上某个安装器用 setx 写而留下 8 条坏条目。所以测试重点不在"能加进去"，
 * 而在**不该加的一个都加不进去**。
 */
describe('isDevkitMachineEntry：只认 devkit 自己的条目', () => {
  it('认 dataRoot 下 current 的绝对路径', () => {
    expect(isDevkitMachineEntry(`${CUR}${BS}nodejs`, ROOT)).toBe(true)
    expect(isDevkitMachineEntry(`${CUR}${BS}nodejs${BS}bin`, ROOT)).toBe(true)
  })

  it('认 %DEVKIT_HOME% 变量形式', () => {
    expect(isDevkitMachineEntry(`%DEVKIT_HOME%${BS}current${BS}nodejs`, ROOT)).toBe(true)
  })

  it('大小写不敏感、容忍结尾反斜杠', () => {
    expect(isDevkitMachineEntry(`${CUR}${BS}NodeJS${BS}`, ROOT)).toBe(true)
    expect(isDevkitMachineEntry(`d:${BS}DEVKIT${BS}current${BS}x`, ROOT)).toBe(true)
  })

  it('别的东西一概不认', () => {
    expect(isDevkitMachineEntry(`C:${BS}WINDOWS${BS}system32`, ROOT)).toBe(false)
    expect(isDevkitMachineEntry(`C:${BS}P`, ROOT)).toBe(false)
    // 同名前缀但不是 current 子目录
    expect(isDevkitMachineEntry(`${ROOT}${BS}versions${BS}nodejs`, ROOT)).toBe(false)
    // 只在路径中间出现，不算
    expect(isDevkitMachineEntry(`C:${BS}x${BS}${CUR}${BS}nodejs`, ROOT)).toBe(false)
    expect(isDevkitMachineEntry('', ROOT)).toBe(false)
  })
})

describe('planMachinePathAdd：追加而不是插入', () => {
  it('新条目追加到末尾（不改变系统工具的解析顺序）', () => {
    const plan = planMachinePathAdd(SYSTEM, [`${CUR}${BS}nodejs`], ROOT)
    expect(plan.next).toBe(`${SYSTEM};${CUR}${BS}nodejs`)
    expect(plan.added).toEqual([`${CUR}${BS}nodejs`])
  })

  it('已经有了就不重复加（大小写不敏感）', () => {
    const current = `${SYSTEM};${CUR}${BS}NodeJS`
    const plan = planMachinePathAdd(current, [`${CUR}${BS}nodejs`], ROOT)
    expect(plan.added).toEqual([])
    expect(plan.next).toBe(current)
  })

  it('**非 devkit 条目一律拒绝** —— 否则这就是一条持久化劫持通道', () => {
    const plan = planMachinePathAdd(SYSTEM, [`C:${BS}evil`, `C:${BS}WINDOWS${BS}system32`], ROOT)
    expect(plan.added).toEqual([])
    expect(plan.next).toBe(SYSTEM)
  })

  it('忽略空条目与空白', () => {
    const plan = planMachinePathAdd(SYSTEM, ['', '   ', `${CUR}${BS}go`], ROOT)
    expect(plan.added).toEqual([`${CUR}${BS}go`])
  })

  it('机器 PATH 为空时能正常加进去', () => {
    const plan = planMachinePathAdd('', [`${CUR}${BS}nodejs`], ROOT)
    expect(plan.next).toBe(`${CUR}${BS}nodejs`)
    expect(plan.wouldBeEmpty).toBe(false)
  })

  it('清掉原有条目里的空段（; ; 这类残留）', () => {
    const plan = planMachinePathAdd(`A;;B;`, [`${CUR}${BS}x`], ROOT)
    expect(plan.next).toBe(`A;B;${CUR}${BS}x`)
  })
})

describe('planMachinePathRemove：只动 devkit 自己的', () => {
  it('移除 devkit 条目，系统条目原样保留', () => {
    const current = `${SYSTEM};${CUR}${BS}nodejs;${CUR}${BS}go`
    const plan = planMachinePathRemove(current, ROOT)
    expect(plan.next).toBe(SYSTEM)
    expect(plan.removed).toEqual([`${CUR}${BS}nodejs`, `${CUR}${BS}go`])
  })

  it('没有 devkit 条目时什么都不动', () => {
    const plan = planMachinePathRemove(SYSTEM, ROOT)
    expect(plan.next).toBe(SYSTEM)
    expect(plan.removed).toEqual([])
  })

  it('结果会变成空值时标记出来（调用方据此拒绝执行）', () => {
    const plan = planMachinePathRemove(`${CUR}${BS}nodejs`, ROOT)
    expect(plan.wouldBeEmpty).toBe(true)
  })
})

describe('collectWantedMachineEntries：%DEVKIT_HOME% 必须展开成绝对路径', () => {
  it('机器级上下文里没有 DEVKIT_HOME 这个用户变量，所以不能留变量形式', () => {
    readActivationState.mockReturnValue(stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`]))
    const wanted = collectWantedMachineEntries(ROOT)
    expect(wanted).toEqual([`${CUR}${BS}nodejs`])
    expect(wanted.join('')).not.toContain('%')
  })

  it('多个工具、多条条目去重', () => {
    readActivationState.mockReturnValue({
      ...stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`, `%DEVKIT_HOME%${BS}current${BS}nodejs`])
    })
    expect(collectWantedMachineEntries(ROOT)).toHaveLength(1)
  })
})

describe('readMachinePathState', () => {
  it('区分「总数」「devkit 条目」「还差哪些」', async () => {
    readMachinePath.mockResolvedValue(`${SYSTEM};${CUR}${BS}nodejs`)
    readActivationState.mockReturnValue(
      stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`, `%DEVKIT_HOME%${BS}current${BS}go`])
    )

    const state = await readMachinePathState()
    expect(state.total).toBe(4)
    expect(state.devkitEntries).toEqual([`${CUR}${BS}nodejs`])
    expect(state.pending).toEqual([`${CUR}${BS}go`])
  })
})

describe('syncMachinePath：改完必须复验', () => {
  it('无需改动时不调用提权写入', async () => {
    readMachinePath.mockResolvedValue(SYSTEM)
    readActivationState.mockReturnValue(stateWith([]))
    const write = vi.fn()

    const result = await syncMachinePath('add', write)
    expect(result.ok).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('写入后复验通过才算成功', async () => {
    readActivationState.mockReturnValue(stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`]))
    readMachinePath
      .mockResolvedValueOnce(SYSTEM) // 改之前
      .mockResolvedValueOnce(`${SYSTEM};${CUR}${BS}nodejs`) // 改之后

    const write = vi.fn().mockResolvedValue({ ok: true, error: null })
    const result = await syncMachinePath('add', write)

    expect(result.ok).toBe(true)
    expect(result.added).toEqual([`${CUR}${BS}nodejs`])
    expect(result.totalAfter).toBe(4)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('**写入"成功"但实际没生效 → 必须报错**（提权助手可能静默失败）', async () => {
    readActivationState.mockReturnValue(stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`]))
    readMachinePath
      .mockResolvedValueOnce(SYSTEM)
      .mockResolvedValueOnce(SYSTEM) // 写完还是老样子

    const result = await syncMachinePath('add', async () => ({ ok: true, error: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('复验失败')
    expect(result.added).toEqual([])
  })

  it('移除后条目还在 → 也要报错', async () => {
    readActivationState.mockReturnValue(stateWith([]))
    const withDevkit = `${SYSTEM};${CUR}${BS}nodejs`
    readMachinePath.mockResolvedValueOnce(withDevkit).mockResolvedValueOnce(withDevkit)

    const result = await syncMachinePath('remove', async () => ({ ok: true, error: null }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('复验失败')
  })

  it('提权写入失败（例如用户取消 UAC）如实上报', async () => {
    readActivationState.mockReturnValue(stateWith([`%DEVKIT_HOME%${BS}current${BS}nodejs`]))
    readMachinePath.mockResolvedValue(SYSTEM)

    const result = await syncMachinePath('add', async () => ({ ok: false, error: '用户取消了管理员授权' }))
    expect(result.ok).toBe(false)
    expect(result.error).toBe('用户取消了管理员授权')
  })

  it('结果会是空值时拒绝执行，不调用写入', async () => {
    readActivationState.mockReturnValue(stateWith([]))
    readMachinePath.mockResolvedValue(`${CUR}${BS}nodejs`)
    const write = vi.fn()

    const result = await syncMachinePath('remove', write)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('空值')
    expect(write).not.toHaveBeenCalled()
  })
})
