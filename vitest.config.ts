import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@builtin-skills': resolve(__dirname, 'src/main/builtin-skill-content')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks'
  }
})
