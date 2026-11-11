#!/usr/bin/env node
/**
 * T01 协作基准入口。
 *
 * 用 esbuild 把 tests/fixtures/collaboration-benchmark.ts 打成临时 CJS，
 * 在隔离样例上跑串行/并行两种调度，并把脱敏时间线写到
 * tmp/verification/collaboration/。
 *
 * 用法：
 *   npm run bench:collaboration
 *
 * 这里使用离线脚本模型，只验证调度、依赖交接、真实文件写入与验收命令；
 * 不调用外部 API，也不把结果当成真实模型速度。
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'tmp', 'collaboration-benchmark-entry.cjs')
mkdirSync(dirname(bundlePath), { recursive: true })

buildSync({
  entryPoints: [join(root, 'tests', 'fixtures', 'collaboration-benchmark.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'warning',
  absWorkingDir: root
})

const require = createRequire(import.meta.url)
const { runCollaborationBenchmark } = require(bundlePath)
if (typeof runCollaborationBenchmark !== 'function') {
  throw new Error('协作基准入口没有导出 runCollaborationBenchmark。')
}

try {
  const record = await runCollaborationBenchmark({ root })
  const sequential = record.aggregate.find((run) => run.scenario === 'sequential')
  const parallel = record.aggregate.find((run) => run.scenario === 'parallel')
  console.log(
    [
      `协作对照通过：${record.runs.length} 次运行，${record.rounds.length} 轮顺序轮换`,
      `旧方式中位 ${sequential?.wallMsMedian ?? '?'}ms / 新方式中位 ${parallel?.wallMsMedian ?? '?'}ms`,
      `验收 ${record.checks.find((check) => check.id === 'acceptance-pass')?.ok ? '通过' : '失败'}`,
      `记录：${join(root, 'tmp', 'verification', 'collaboration', 'timeline-latest.md')}`
    ].join(' · ')
  )
} finally {
  if (existsSync(bundlePath)) rmSync(bundlePath, { force: true })
}
