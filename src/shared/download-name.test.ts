import { describe, expect, it } from 'vitest'
import { downloadFileName, urlBasename } from './download-name'

/**
 * 下载缓存文件名的**唯一实现**。
 *
 * 这组测试存在的直接原因是一个确定性 bug：这个规则以前有两份实现，
 * `executor` 补 `.exe`、`offline` 不补，于是离线安装 VS Code 必然失败
 * （包里叫 `vscode-1.141.0-stable`，执行器找 `...stable.exe`）。
 * 当时那条单测名字就叫「与 executor 的命名规则一致」，但只喂了 `.zip` 的 URL。
 */
describe('urlBasename', () => {
  it('取路径最后一段', () => {
    expect(urlBasename('https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip')).toBe(
      'node-v24.21.0-win-x64.zip'
    )
  })

  it('忽略查询串与片段', () => {
    expect(urlBasename('https://example.com/a/b/c.zip?token=1')).toBe('c.zip')
    expect(urlBasename('https://example.com/a/b/c.zip#frag')).toBe('c.zip')
  })

  it('末尾带斜杠时取前一段', () => {
    expect(urlBasename('https://example.com/a/b/')).toBe('b')
  })

  it('不是合法 URL 时抛错，而不是猜一个名字', () => {
    expect(() => urlBasename('not a url')).toThrow(/不是合法的 URL/)
  })
})

describe('downloadFileName', () => {
  it('已带扩展名时原样保留', () => {
    expect(
      downloadFileName({
        toolId: 'nodejs',
        version: '24.21.0',
        url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
        installType: 'zip'
      })
    ).toBe('nodejs-24.21.0-node-v24.21.0-win-x64.zip')
  })

  it('**VS Code 的 /stable 要补 .exe** —— 这就是当初漏掉的那个形态', () => {
    // 离线包与在线安装必须得到同一个名字，否则离线包导入后执行器找不到文件
    expect(
      downloadFileName({
        toolId: 'vscode',
        version: '1.141.0',
        url: 'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
        installType: 'exe-inno'
      })
    ).toBe('vscode-1.141.0-stable.exe')
  })

  it('zip 类即使没有扩展名也不补（解压靠内容识别）', () => {
    expect(
      downloadFileName({
        toolId: 'x',
        version: '1.0',
        url: 'https://example.com/download',
        installType: 'zip'
      })
    ).toBe('x-1.0-download')
  })

  it('没有 installType 时按"安装器类"处理，补 .exe', () => {
    expect(
      downloadFileName({ toolId: 'x', version: '1.0', url: 'https://example.com/stable' })
    ).toBe('x-1.0-stable.exe')
  })

  it('取不到文件名时抛错', () => {
    expect(() =>
      downloadFileName({ toolId: 'x', version: '1.0', url: 'https://example.com/' })
    ).toThrow(/取不到文件名/)
  })

  it('toolId 与版本都进文件名（同一个工具的多个版本要能共存）', () => {
    const a = downloadFileName({
      toolId: 'nodejs',
      version: '24.21.0',
      url: 'https://x.com/n.zip',
      installType: 'zip'
    })
    const b = downloadFileName({
      toolId: 'nodejs',
      version: '22.23.3',
      url: 'https://x.com/n.zip',
      installType: 'zip'
    })
    expect(a).not.toBe(b)
    expect(a).toBe('nodejs-24.21.0-n.zip')
    expect(b).toBe('nodejs-22.23.3-n.zip')
  })
})
