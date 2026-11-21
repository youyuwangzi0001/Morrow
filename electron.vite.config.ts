import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Windows 上 esbuild 0.25 把超过 ~512 KB 的 chunk 交给 `transform` 时会先写临时文件，
 * 关闭句柄与删除之间有竞态，稳定报 `remove ...: Access is denied`（本机可复现，
 * 与杀软/目录无关）。Electron 自带 Chromium/Node 都支持 ESNext，因此跳过
 * “降级语法 + esbuild 压缩”这一步：产物仍是完整可运行的 bundle，只是不压缩。
 * 逐模块的 TS/TSX 转译仍由 esbuild 完成（单文件远小于阈值，不受影响）。
 */
const nodeSafeBuild = {
  target: 'node22' as const,
  minify: false as const,
}
const rendererSafeBuild = {
  target: 'esnext' as const,
  // target 为 esnext 时 Vite 不再走 esbuild 的整块转译；压缩交给 terser，
  // 既绕开临时文件竞态，又不把 6 MB 的未压缩 bundle 交给用户。
  minify: 'terser' as const,
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@core': resolve(__dirname, 'src/core'),
      }
    },
    build: {
      ...nodeSafeBuild,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: {
          // 同上：单文件 chunk 超过 ~512 KB 会触发 esbuild 的 Windows 临时文件竞态。
          // 按源文件切开，每个 chunk 都远小于阈值；CJS 下 require 仍走同一模块缓存。
          manualChunks(id) {
            const file = id.replace(/\\/g, '/')
            const match = file.match(/\/src\/(main|core|shared)\/([^/]+)$/)
            if (!match) return undefined
            // runtime.ts 用 __dirname 定位 renderer/preload/图标；
            // 一旦被拆到 out/main/chunks，相对路径就会错两层，必须留在入口 chunk。
            if (match[1] === 'main' && match[2] === 'runtime.ts') return undefined
            return `${match[1]}-${match[2]}`
          }
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      ...nodeSafeBuild,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      ...rendererSafeBuild,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
