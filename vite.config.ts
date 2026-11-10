import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Tauri 版 renderer 构建配置（MIGRATION-RUST.md 附录 E.4）。
 * R7 已删除 Electron 形态（src/main、src/preload、electron.vite.config.ts）。
 * beforeDevCommand/beforeBuildCommand（tauri.conf.json）调用本配置。
 */
const sharedDir = resolve(__dirname, 'src/shared')

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': sharedDir
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true
  },
  // tauri dev 时 devUrl 固定 5173（tauri.conf.json build.devUrl），被占用时直接报错而不是换端口
  server: {
    port: 5173,
    strictPort: true
  }
})
