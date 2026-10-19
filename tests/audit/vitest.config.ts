import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * R7 审计测试专用配置（与 npm run test:unit 隔离，默认不跑）：
 *   npx vitest run --config tests/audit/vitest.config.ts
 *
 * - 全部工作目录在 Morrow/tmp/audit/**，不触碰真实用户数据；
 * - 安全题用 scripted provider / 本地 mock SSE 服务，不产生真实模型费用；
 * - electron 模块用 tests/audit/mocks/electron.ts 替身（只提供 dataPath 需要的 app.getPath）。
 */
export default defineConfig({
  root: resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../src/shared'),
      '@core': resolve(__dirname, '../../src/core'),
      electron: resolve(__dirname, 'mocks/electron.ts')
    }
  },
  test: {
    include: ['tests/audit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks'
  }
})
