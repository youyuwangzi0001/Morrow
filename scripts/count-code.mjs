#!/usr/bin/env node
// 统一代码统计：按固定范围统计文件数与行数，行为等同 `wc -l`（只数换行符）。
// 用法：
//   node scripts/count-code.mjs                 # 当前工作树
//   node scripts/count-code.mjs --ref v0.1.0    # 指定提交/标签
// 统计范围：
//   生产 src/**/*.{ts,tsx,css,html}
//   测试 tests/**/*.{ts,tsx,mts,cts,js,mjs,cjs}
//   脚本 scripts/**/*.{mjs,js,py,ps1,ts}
//   启动器 build/launcher/**/*.cs
// 不计 node_modules、构建产物、文档、图片与媒体夹具。
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const refIndex = process.argv.indexOf('--ref')
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : ''

const groups = [
  { key: 'production', label: '生产源码 src/', dir: 'src', extensions: new Set(['.ts', '.tsx', '.css', '.html']) },
  { key: 'tests', label: '测试 tests/', dir: 'tests', extensions: new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']) },
  { key: 'scripts', label: '构建脚本 scripts/', dir: 'scripts', extensions: new Set(['.mjs', '.js', '.py', '.ps1', '.ts']) },
  { key: 'launcher', label: '启动器 build/launcher/', dir: 'build/launcher', extensions: new Set(['.cs']) }
]

function lineCount(content) {
  return (content.match(/\n/g) ?? []).length
}

function matches(path, group) {
  return group.extensions.has(extname(path)) && path.replace(/\\/g, '/').startsWith(group.dir + '/')
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile()) files.push(relative(root, full).replace(/\\/g, '/'))
  }
}

function currentFiles() {
  const files = []
  for (const group of groups) walk(join(root, group.dir), files)
  return files
}

function refFiles() {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

const files = ref ? refFiles() : currentFiles()
const result = {}
for (const group of groups) {
  let fileCount = 0
  let lines = 0
  for (const path of files) {
    if (!matches(path, group)) continue
    const content = ref
      ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      : readFileSync(join(root, path), 'utf8')
    fileCount += 1
    lines += lineCount(content)
  }
  result[group.key] = { label: group.label, files: fileCount, lines }
}
const total = Object.values(result).reduce(
  (sum, entry) => ({ files: sum.files + entry.files, lines: sum.lines + entry.lines }),
  { files: 0, lines: 0 }
)

console.log(`统计来源：${ref || '当前工作树'}`)
console.log('口径：生产 + 测试 + 构建脚本 + 启动器；排除 node_modules、构建产物、文档、图片与媒体夹具；行数按换行符计（wc -l）。')
for (const entry of Object.values(result)) {
  console.log(`${entry.label}：${entry.files} 文件 / ${entry.lines.toLocaleString('en-US')} 行`)
}
console.log(`代码合计：${total.files} 文件 / ${total.lines.toLocaleString('en-US')} 行`)
