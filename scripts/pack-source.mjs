#!/usr/bin/env node
// 源码包：默认打包「当前工作树」（含未提交改动与未跟踪文件，遵守 .gitignore）；
// 传 --ref <commit|tag> 时打包指定提交，便于从历史版本复现。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const refIndex = process.argv.indexOf('--ref')
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : ''
if (refIndex >= 0 && !ref) throw new Error('--ref 需要一个提交或标签')

const target = resolve('deliver', `Morrow-${version}-source.zip`)
const prefix = `Morrow-${version}/`
mkdirSync(dirname(target), { recursive: true })

let tree = ref
let temporaryIndex = ''
try {
  if (!ref) {
    temporaryIndex = resolve('tmp', `.source-index-${process.pid}`)
    if (existsSync(temporaryIndex)) rmSync(temporaryIndex, { force: true })
    mkdirSync(dirname(temporaryIndex), { recursive: true })
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex }
    execFileSync('git', ['read-tree', 'HEAD'], { stdio: 'inherit', env })
    execFileSync('git', ['add', '-A'], { stdio: 'inherit', env })
    tree = execFileSync('git', ['write-tree'], { encoding: 'utf8', env }).trim()
    console.log('源码包来源：当前工作树（临时 Git index，含未提交改动）')
  } else {
    console.log(`源码包来源：${ref}`)
  }
  execFileSync('git', ['archive', '--format=zip', `--prefix=${prefix}`, '-o', target, tree], { stdio: 'inherit' })
} finally {
  if (temporaryIndex && existsSync(temporaryIndex)) rmSync(temporaryIndex, { force: true })
}

const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
const bytes = statSync(target).size
writeFileSync(`${target}.sha256`, `${sha256} *${basename(target)}\n`)
console.log(`源码包：${target}`)
console.log(`大小：${bytes} B · SHA-256：${sha256}`)
console.log(`校验文件：${basename(target)}.sha256`)
