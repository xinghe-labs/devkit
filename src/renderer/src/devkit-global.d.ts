/**
 * window.devkit 全局类型声明。
 *
 * Electron 时代由 src/preload/index.d.ts 提供；R7 删除 preload 后，类型声明
 * 迁到渲染层——适配层（api/tauri-adapter.ts）在 Tauri 环境下挂载同契约的
 * tauriAdapter 到 window.devkit（main.tsx installTauriBridge()）。
 *
 * 注意：本文件必须保持“脚本文件”形态（顶层无 import/export），
 * 直接写顶层 interface Window 增强（不能用 declare global —— 那是模块文件的语法，
 * 在脚本文件里会被静默忽略）。类型引用用 import() 语法。
 */
interface Window {
  devkit: import('../../shared/api').DevkitApi
}
