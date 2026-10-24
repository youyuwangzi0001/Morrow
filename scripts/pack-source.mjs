#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const refIndex = process.argv.indexOf('--ref')
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : 'HEAD'
if (!ref) throw new Error('--ref 需要一个提交或标签')

const target = resolve('deliver', `Morrow-${version}-source.zip`)
mkdirSync(dirname(target), { recursive: true })
execFileSync('git', ['archive', '--format=zip', `--prefix=Morrow-${version}/`, '-o', target, ref], {
  stdio: 'inherit'
})
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
const bytes = statSync(target).size
writeFileSync(`${target}.sha256`, `${sha256} *${basename(target)}\n`)
console.log(`源码包：${target}`)
console.log(`大小：${bytes} B · SHA-256：${sha256}`)
console.log(`校验文件：${basename(target)}.sha256`)
