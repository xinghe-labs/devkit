import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { loadManifests } from './core/manifest'
import { logger } from './core/report/logger'
import { registerIpcHandlers } from './ipc'
import { getLogDir } from './utils/app-paths'

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
