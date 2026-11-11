import React from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource-variable/manrope/wght.css'
import '@fontsource-variable/newsreader/wght.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource-variable/noto-serif-sc'

import './styles.css'
import App from './App'
import { IslandApp } from './features/island'
import { useAppStore } from './store'
import { applyThemePreferences } from './store'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')
const rootElement = container

const isIsland = window.location.hash === '#island'
if (isIsland) {
  document.documentElement.classList.add('island-root')
  document.body.classList.add('island-root')
}

// 仅测试模式暴露 store，便于 E2E/截图驱动真实状态（生产环境不存在）
if (window.morrow.isTest && !isIsland) {
  ;(window as unknown as { __morrowStore: typeof useAppStore }).__morrowStore = useAppStore
}

async function mount(): Promise<void> {
  // 灵动岛是独立窗口，不会经过主窗口的 store 初始化；先取一次设置，避免浅色主题下闪深色。
  if (isIsland) {
    try {
      const result = await window.morrow.settings.get()
      if (result.ok) applyThemePreferences(result.data)
    } catch {
      // 设置读取失败时保留默认深色
    }
  }
  createRoot(rootElement).render(
    <React.StrictMode>{isIsland ? <IslandApp /> : <App />}</React.StrictMode>
  )
}

void mount()
