/**
 * 下载产物在缓存目录里的文件名 —— **全项目唯一实现**。
 *
 * ## 为什么单独抽出来
 *
 * 这份知识曾经有两份实现，而且不一致：
 *
 * - `executor` 会补 `.exe`：VS Code 的下载地址以 `/stable` 结尾，取出来没有扩展名，
 *   而 Windows 主要按扩展名决定怎么执行
 * - `offline` 的 `archiveFileName()` **不补**
 *
 * 后果是确定的：离线包里那个文件叫 `vscode-1.141.0-stable`，
 * 而执行器去下载缓存里找 `vscode-1.141.0-stable.exe` —— **离线安装 VS Code 必然失败**。
 *
 * 更糟的是当时那条单测的名字就叫「与 executor 的下载缓存命名规则一致」，
 * 但它只喂了一个 `.zip` 的 URL，于是这个不一致一直活着。
 *
 * 所以现在两边都调这里，单测直接覆盖 VS Code 那个 URL 形态。
 *
 * ## 约束
 *
 * 这个文件在 `src/shared/`，**渲染进程也会打包它** —— 不能 import `node:path`。
 * 所以 basename 是手写的，用全局 `URL`。
 */

export interface DownloadNameInput {
  toolId: string
  version: string
  url: string
  /**
   * 安装模板的 `type`（如 `zip` / `exe-inno` / `msi`）。
   *
   * zip 类不补扩展名：解压靠内容识别，不靠后缀。
   * 其余（安装器类）在 URL 末段没有扩展名时补 `.exe`。
   */
  installType?: string | null
}

/** 取 URL 路径部分的最后一段（等价 `node:path.basename(new URL(url).pathname)`） */
export function urlBasename(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    throw new Error(`下载地址不是合法的 URL，无法推导缓存文件名：${url}`)
  }
  const segments = pathname.split('/').filter((segment) => segment !== '')
  return segments.length > 0 ? (segments[segments.length - 1] as string) : ''
}

/**
 * 下载缓存的文件名：`<toolId>-<version>-<url 末段>[.exe]`。
 *
 * 离线包**制作**与离线包**导入后的执行**都必须走这个函数，
 * 否则打包时写的名字和执行时找的名字就会不一致。
 */
export function downloadFileName(input: DownloadNameInput): string {
  const base = urlBasename(input.url)
  if (base === '') {
    throw new Error(`下载地址里取不到文件名：${input.url}`)
  }

  // 已经带扩展名（node-v24.21.0-win-x64.zip）就不动；
  // 没有扩展名且不是 zip 类（VS Code 的 /stable）才补 .exe
  const hasExtension = base.includes('.')
  const name = hasExtension || input.installType === 'zip' ? base : `${base}.exe`

  return `${input.toolId}-${input.version}-${name}`
}
