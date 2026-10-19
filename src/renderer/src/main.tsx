import React from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource-variable/manrope/wght.css'
import '@fontsource-variable/newsreader/wght.css'
import '@fontsource-variable/newsreader/wght-italic.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource-variable/noto-serif-sc'

import './styles/base.css'
import App from './App'
import { useAppStore } from './state/store'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

// 仅测试模式暴露 store，便于 E2E/截图驱动真实状态（生产环境不存在）
if (window.morrow.isTest) {
  ;(window as unknown as { __morrowStore: typeof useAppStore }).__morrowStore = useAppStore
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
