import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJunctionAt,
  getDevkitHome,
  removeJunctionAt,
  toDevkitHomeVar,
  unlinkJunction
} from './index'
import { verifyActivation } from './verify'

/**
 * junction 增删的真实文件系统测试。
 *
 * 这里的每一条都对应一个**真实踩过的坑**，不是想象的边界：
 *  · `fs.rmSync(path, { recursive: false })` 对 junction 会报 "Path is a directory"，
 *    导致"取消激活"在最后一步失败（PATH 已清理、链接还在，下次没人能清它）
 *  · 如果误把真实目录当成链接删掉，会把用户数据带走 —— 所以必须有 isSymbolicLink 守卫
 *  · junction 是 Windows 特性，其它平台跳过
 */
const onWindows = process.platform === 'win32'
const SEP = sep

describe.skipIf(!onWindows)('junction 管理（Windows 真实文件系统）', () => {
  let root: string
  let linkPath: string
  let target: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devkit-junction-'))
    linkPath = join(root, 'link')
    target = join(root, 'target')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'marker.txt'), 'target-data', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('创建 junction 后可以透过它读到目标文件', async () => {
    const result = await createJunctionAt(linkPath, target)
    expect(result).toBe('created')
    expect(existsSync(join(linkPath, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(linkPath, 'marker.txt'), 'utf8')).toBe('target-data')
  })

  it('重复创建指向同一目标的 junction 是幂等的', async () => {
    await createJunctionAt(linkPath, target)
    expect(await createJunctionAt(linkPath, target)).toBe('unchanged')
  })

  it('切换目标时替换链接（这就是"切版本"）', async () => {
    const other = join(root, 'target2')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'marker.txt'), 'v2', 'utf8')

    await createJunctionAt(linkPath, target)
    expect(await createJunctionAt(linkPath, other)).toBe('replaced')
    expect(readFileSync(join(linkPath, 'marker.txt'), 'utf8')).toBe('v2')
    // 原目标必须完好
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('target-data')
  })

  it('删除 junction **不会**删掉目标目录（回归：rmSync recursive:false 会报 Path is a directory）', () => {
    symlinkSync(target, linkPath, 'junction')

    expect(removeJunctionAt(linkPath)).toBe(true)
    expect(existsSync(linkPath)).toBe(false)
    expect(existsSync(join(target, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('target-data')
  })

  it('拒绝删除真实目录，也拒绝把真实目录替换成链接', async () => {
    const realDir = join(root, 'real')
    mkdirSync(realDir)
    writeFileSync(join(realDir, 'important.txt'), 'do-not-delete', 'utf8')

    // 删除：不动它
    expect(removeJunctionAt(realDir)).toBe(false)
    expect(existsSync(join(realDir, 'important.txt'))).toBe(true)

    // 替换：直接报错，而不是递归删掉
    await expect(createJunctionAt(realDir, target)).rejects.toThrow(/不是一个链接/)
    expect(readFileSync(join(realDir, 'important.txt'), 'utf8')).toBe('do-not-delete')
  })

  it('对不存在的路径操作是安全的空操作', () => {
    expect(removeJunctionAt(join(root, 'nope'))).toBe(false)
    expect(() => unlinkJunction(join(root, 'nope'))).not.toThrow()
  })
})

describe('PATH 条目收敛到 %DEVKIT_HOME%', () => {
  const home = getDevkitHome()

  it('只改写 devkit 自己的目录', () => {
    expect(toDevkitHomeVar(`${home}${SEP}current${SEP}nodejs`)).toBe(
      `%DEVKIT_HOME%${SEP}current${SEP}nodejs`
    )
    expect(toDevkitHomeVar(`${home.toUpperCase()}${SEP}current${SEP}go${SEP}bin`)).toBe(
      `%DEVKIT_HOME%${SEP}current${SEP}go${SEP}bin`
    )
  })

  it('别人的目录原样保留', () => {
    expect(toDevkitHomeVar(`D:${SEP}Python`)).toBe(`D:${SEP}Python`)
    expect(toDevkitHomeVar(`C:${SEP}Program Files${SEP}nodejs`)).toBe(
      `C:${SEP}Program Files${SEP}nodejs`
    )
  })

  it('前缀相似但不是同一个目录时不能误改', () => {
    const sibling = `${home}-other${SEP}x`
    expect(toDevkitHomeVar(sibling)).toBe(sibling)
  })
})

describe.skipIf(!onWindows)('激活后的「新终端」验证', () => {
  it('命令解析到 devkit 目录之外时会如实指出（不是假阳性）', async () => {
    // cmd.exe 一定解析到 C:\Windows\System32，不可能落在 devkit 目录里
    const result = await verifyActivation(
      { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hello'] },
      { machine: process.env.PATH ?? '', user: '' },
      `C:${SEP}Users${SEP}nobody${SEP}.devkit`
    )

    expect(result.ok).toBe(true)
    expect(result.resolvedFromDevkit).toBe(false)
    expect(result.resolvedPath?.toLowerCase()).toContain('cmd.exe')
    expect(result.detail).toContain('不是 devkit 装的那份')
  }, 60_000)

  it('命令解析到预期目录内时判定为通过', async () => {
    const result = await verifyActivation(
      { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hello'], expectRegex: 'hello' },
      { machine: process.env.PATH ?? '', user: '' },
      `C:${SEP}Windows`
    )

    expect(result.ok).toBe(true)
    expect(result.resolvedFromDevkit).toBe(true)
    expect(result.detail).toContain('hello')
  }, 60_000)

  it('命令不存在时给出可读错误而不是抛异常', async () => {
    const result = await verifyActivation(
      { cmd: 'devkit-no-such-command.exe' },
      { machine: process.env.PATH ?? '', user: '' },
      `C:${SEP}Users${SEP}nobody${SEP}.devkit`
    )
    expect(result.ok).toBe(false)
    // 只断言**我们自己拼的**那部分文案：系统报错是本地化的
    // （中文系统是"不是内部或外部命令"，英文 runner 是 "is not recognized as ..."），
    // 拿系统文案做断言会在 CI 上直接红掉。
    expect(result.detail).toContain('devkit-no-such-command.exe')
    expect(result.detail).toMatch(/退出码|找不到/)
  }, 60_000)
})
