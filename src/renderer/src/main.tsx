import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initI18n } from './i18n'
import { useAppStore } from './store/app-store'
import './styles/global.css'

async function bootstrap(): Promise<void> {
  try {
    const info = await window.devkit.getAppInfo()
    await initI18n(info.locale)
    useAppStore.getState().setInfo(info)
  } catch {
    // 连应用信息都拿不到时至少把界面用默认语言渲染出来，让用户看到错误提示
    await initI18n('zh-CN')
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('找不到 #root 挂载点')

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  // 通知主进程三端链路已通（也用于 CI 冒烟：主进程据此判定启动成功）
  await window.devkit.signalReady()
}

void bootstrap()
