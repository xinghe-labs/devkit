import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeDataRoot,
  getCurrentRoot,
  getDataRoot,
  getDownloadDir,
  getShimDir,
  getVersionsRoot,
  setDataRootOverride
} from './app-paths'

/**
 * 批量产物根目录的解析规则。
 *
 * 这组测试存在的原因是一个真实缺陷：下载缓存在应用里是 `%APPDATA%\devkit\downloads`，
 * 而命令行脚本里是 `%USERPROFILE%\.devkit\downloads` —— 同一个文件各下一份，
 * 缓存永远命中不了。现在两边都走 getDataRoot()，这里把优先级钉死。
 */
const ENV_KEY = 'DEVKIT_DATA_ROOT'
const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  setDataRootOverride(null)
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
})

describe('数据根目录的解析优先级', () => {
  it('都没有时用默认值 %USERPROFILE%\\.devkit', () => {
    delete process.env[ENV_KEY]
    setDataRootOverride(null)

    expect(getDataRoot()).toBe(join(homedir(), '.devkit'))
    expect(describeDataRoot().source).toBe('default')
  })

  it('配置里的值优先于默认值', () => {
    delete process.env[ENV_KEY]
    setDataRootOverride('D:\\devkit-data')

    expect(getDataRoot()).toBe('D:\\devkit-data')
    expect(describeDataRoot().source).toBe('config')
  })

  it('环境变量优先于配置（部署时能强制指定）', () => {
    process.env[ENV_KEY] = 'E:\\forced-root'
    setDataRootOverride('D:\\devkit-data')

    expect(getDataRoot()).toBe('E:\\forced-root')
    expect(describeDataRoot().source).toBe('env')
  })

  it('环境变量与配置里的空白值都当作「没设置」', () => {
    process.env[ENV_KEY] = '   '
    setDataRootOverride(null)
    expect(getDataRoot()).toBe(join(homedir(), '.devkit'))

    delete process.env[ENV_KEY]
    setDataRootOverride('  ')
    expect(getDataRoot()).toBe(join(homedir(), '.devkit'))
  })

  it('环境变量会被 trim（避免复制粘贴带进来的空格）', () => {
    process.env[ENV_KEY] = '  D:\\devkit-data  '
    expect(getDataRoot()).toBe('D:\\devkit-data')
  })
})

describe('批量产物都挂在数据根目录下', () => {
  it('版本目录 / 切换链接 / shim / 下载缓存 都跟着根目录走', () => {
    delete process.env[ENV_KEY]
    // 用一个真实存在的临时目录当根：getDownloadDir 会真的建目录，
    // 用不存在的盘符（E:\）会因为盘不存在而失败 —— 那不是被测逻辑的问题
    const root = mkdtempSync(join(tmpdir(), 'devkit-root-'))
    setDataRootOverride(root)

    try {
      expect(getVersionsRoot()).toBe(join(root, 'versions'))
      expect(getCurrentRoot()).toBe(join(root, 'current'))
      expect(getShimDir()).toBe(join(root, 'bin'))
      expect(getDownloadDir()).toBe(join(root, 'downloads'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('换成别的根之后，所有批量产物都跟着走（不会有一部分留在旧位置）', () => {
    delete process.env[ENV_KEY]
    const root = mkdtempSync(join(tmpdir(), 'devkit-root2-'))
    setDataRootOverride(root)

    try {
      for (const path of [getVersionsRoot(), getCurrentRoot(), getShimDir(), getDownloadDir()]) {
        expect(path.startsWith(root)).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
