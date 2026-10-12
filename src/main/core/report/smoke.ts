import { writeFileSync } from 'node:fs'

/**
 * 冒烟截图钩子。
 *
 * 为什么需要：`DEVKIT_SMOKE` 只能证明"渲染进程没报错"，证明不了"界面长得对"。
 * 布局塌陷、中文乱码、控件重叠这些都不会抛异常。
 * 所以在冒烟退出前把窗口截一张图，人工（或视觉检查）看一眼。
 *
 * 窗口属于 main/index.ts，退出判定在 ipc/index.ts，两边不能互相 import，
 * 所以钩子放在这个中立模块里。
 */

type Capture = () => Promise<Buffer | null>

let capture: Capture | null = null

export function setSmokeCapture(fn: Capture | null): void {
  capture = fn
}

export async function runSmokeCapture(targetPath: string | undefined): Promise<string | null> {
  if (!targetPath || !capture) return null
  try {
    const image = await capture()
    if (!image) return null
    writeFileSync(targetPath, image)
    return targetPath
  } catch {
    return null
  }
}
