import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { loadManifests } from './core/manifest'
import { setInstallProgressListener } from './core/executor/service'
import { logger } from './core/report/logger'
import { recordRendererError } from './core/report/renderer-errors'
import { setSmokeCapture } from './core/report/smoke'
import { registerIpcHandlers } from './ipc'
import { getDataRoot, getLogDir, setDataRootOverride } from './utils/app-paths'
import { loadConfig } from './core/settings'

const APP_USER_MODEL_ID = 'io.github.devkit'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f5',
    title: 'devkit',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false 才能让预加载脚本里使用 @shared 打包进来的类型与常量
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
    logger.info('app', '主窗口已显示')
  })

  // 冒烟截图：让 DEVKIT_SMOKE_SHOT=<png 路径> 能拿到一张真实界面截图。
  // 只证明"没报错"是不够的 —— 布局塌陷、控件重叠都不会抛异常。
  setSmokeCapture(async () => {
    if (window.isDestroyed()) return null

    // 冒烟时可以先跑一小段脚本（例如把设置抽屉点开），这样截图能覆盖到弹层。
    // 只在 DEVKIT_SMOKE 下生效，正常运行不会执行任何注入脚本。
    const script = process.env.DEVKIT_SMOKE_JS
    if (script && process.env.DEVKIT_SMOKE === '1') {
      try {
        const scriptResult = await window.webContents.executeJavaScript(script, true)
        logger.info('app', `冒烟脚本返回：${JSON.stringify(scriptResult)}`)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      } catch (error) {
        logger.warn('app', `冒烟脚本执行失败：${(error as Error).message}`)
      }
    }

    const image = await window.webContents.capturePage()
    return image.isEmpty() ? null : image.toPNG()
  })

  // 渲染进程里的报错默认只出现在开发者工具里，打包后用户根本看不到。
  // 这里全部收进日志，并在冒烟模式下作为失败依据 —— 否则"界面白屏"会被当成"一切正常"。
  window.webContents.on(
    'console-message',
    (...args: unknown[]) => {
      // Electron 44 起第一个参数是事件对象，之前是 (event, level, message, line, sourceId)
      const first = args[0] as { level?: number; message?: string } | number
      const level = typeof first === 'object' ? (first.level ?? 0) : Number(args[1] ?? 0)
      const message = typeof first === 'object' ? (first.message ?? '') : String(args[2] ?? '')
      const source = typeof first === 'object' ? '' : String(args[4] ?? '')

      if (level >= 3 || /error/i.test(String(level))) {
        recordRendererError(message)
        logger.error('renderer', `${message}${source ? ` (${source})` : ''}`)
      } else if (level === 2) {
        logger.warn('renderer', message)
      } else {
        logger.debug('renderer', message)
      }
    }
  )

  window.webContents.on('render-process-gone', (_event, details) => {
    recordRendererError(`渲染进程退出：${details.reason}`)
    logger.error('renderer', `渲染进程退出：${details.reason}（exitCode ${details.exitCode}）`)
  })

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    recordRendererError(`页面加载失败：${errorDescription}`)
    logger.error('renderer', `页面加载失败：${errorCode} ${errorDescription}`)
  })

  // 外部链接交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.setAppUserModelId(APP_USER_MODEL_ID)

if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行，直接退出，避免两个实例同时写日志和配置
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(() => {
      const logFile = logger.init(getLogDir())
      logger.info('app', `devkit ${app.getVersion()} 启动`)
      logger.info('app', `日志文件：${logFile}`)
      logger.info('app', `打包模式：${app.isPackaged ? '是' : '否'}`)

      // 先把「批量产物根目录」接上，再碰任何版本目录/下载缓存。
      // 必须在 loadManifests 之后（loadConfig 会读激活记录）但要在任何安装动作之前。
      const config = loadConfig()
      setDataRootOverride(config.dataRoot)
      logger.info(
        'app',
        `批量产物根目录：${getDataRoot()}${config.dataRoot ? '（来自设置）' : '（默认）'}` +
          (process.env.DEVKIT_DATA_ROOT ? ' [被环境变量 DEVKIT_DATA_ROOT 覆盖]' : '')
      )

      const manifests = loadManifests()
      logger.info(
        'app',
        `清单就绪：可用 ${manifests.tools.length} 个，校验失败 ${manifests.errors.length} 个`
      )

      registerIpcHandlers()
      mainWindow = createWindow()

      // 日志实时推送到渲染进程
      logger.subscribe((entry) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.logLine, entry)
        }
      })

      // 安装进度实时推送到渲染进程
      setInstallProgressListener((event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.installProgress, event)
        }
      })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
      })
    })
    .catch((error: unknown) => {
      logger.error('app', `启动失败：${(error as Error).message}`)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    logger.info('app', 'devkit 正在退出')
    logger.close()
  })
}
