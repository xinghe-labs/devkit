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
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJunctionAt, removeJunctionAt, unlinkJunction } from './index'

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
    // 用同步方式建一个 junction，避免测试里混入 async
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
