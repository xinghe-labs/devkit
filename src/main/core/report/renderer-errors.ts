/**
 * 渲染进程报错收集器。
 *
 * 为什么单独开一个模块：这些错误在主窗口创建时被捕获（main/index.ts），
 * 而冒烟模式的退出码判定发生在 IPC 处理器里（ipc/index.ts）。
 * 两边都要用，又不能互相 import（会形成循环），所以状态放在这里。
 *
 * 它存在的意义：没有它的话，"界面白屏"会被当成"启动成功"——
 * 渲染进程的 JS 报错只会出现在开发者工具里，打包后没人看得见。
 */
const errors: string[] = []

export function recordRendererError(message: string): void {
  errors.push(message)
}

export function getRendererErrors(): string[] {
  return [...errors]
}

export function clearRendererErrors(): void {
  errors.length = 0
}
