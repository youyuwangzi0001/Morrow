// 验证打包产物里含本次修复：从 app.asar 直接读取主进程/渲染产物，检查关键代码是否为新版本。
// 这是「产物验证」而非「源码验证」——源码通过不代表打进 exe 的是新代码。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asarPath = process.argv[2]
if (!asarPath) {
  console.error('用法: node scripts/verify-packaged-fix.mjs <app.asar 路径>')
  process.exit(1)
}
if (!existsSync(asarPath)) {
  console.error(`找不到 ${asarPath}`)
  process.exit(1)
}

// app.asar 是 JSON 头 + 拼接文件；这里只解析头部索引，按偏移读取需要的文件
function loadAsar(path) {
  const buffer = readFileSync(path)
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
  const base = 16 + headerSize
  const entries = new Map()

  function walk(node, prefix) {
    for (const [name, info] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name
      if (info.files) walk(info, full)
      else if (typeof info.offset === 'string' || typeof info.offset === 'number') {
        const start = base + Number(info.offset)
        entries.set(full, { start, size: Number(info.size) })
      }
    }
  }
  walk(header, '')
  return {
    has: (file) => entries.has(file),
    files: () => [...entries.keys()],
    read: (file) => {
      const entry = entries.get(file)
      if (!entry) return null
      return buffer.subarray(entry.start, entry.start + entry.size).toString('utf8')
    }
  }
}

const archive = loadAsar(asarPath)
const checks = []

function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

// 1. 主进程：不再有工具调用上限；有自动续段
const main = archive.read('out/main/index.js') ?? ''
check('主进程产物可读取', main.length > 0, `${Math.round(main.length / 1024)} KB`)
check('主进程：已移除工具调用上限字段 maxToolCalls', !main.includes('maxToolCalls'), main.includes('maxToolCalls') ? '仍存在' : '未出现')
check('主进程：包含预算自动续段逻辑', main.includes('goal budget auto-extended'), main.includes('goal budget auto-extended') ? '存在' : '缺失')
check('主进程：不再有 budget_tool_calls 停止原因', !main.includes('budget_tool_calls'), main.includes('budget_tool_calls') ? '仍存在' : '未出现')

// 2. 渲染产物：样式修复要真的进了包
const cssFiles = archive.files().filter((file) => file.startsWith('out/renderer/') && file.endsWith('.css'))
const css = cssFiles.map((file) => archive.read(file) ?? '').join('\n')
/** 取某选择器的规则体，容忍换行与多余空白 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : null
}
check('渲染样式产物存在', cssFiles.length > 0, `${cssFiles.length} 个 CSS`)
const todoEm = ruleBody('.super-worker-todos li em') ?? ''
check(
  '渲染样式：成员待办状态标签不参与收缩',
  /flex:\s*0\s+0\s+auto/.test(todoEm) && /white-space:\s*nowrap/.test(todoEm),
  todoEm ? '规则体含 flex:0 0 auto + nowrap' : '未找到规则'
)
const fileSize = ruleBody('.composer-file-size') ?? ''
check(
  '渲染样式：附件大小标签不换行',
  /white-space:\s*nowrap/.test(fileSize),
  fileSize ? '规则体含 nowrap' : '未找到规则'
)

let failed = 0
for (const item of checks) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}  (${item.detail})`)
  if (!item.pass) failed += 1
}
console.log(failed === 0 ? '\n产物验证通过：exe 内确实是本次修复后的代码。' : `\n产物验证失败：${failed} 项未通过。`)
process.exitCode = failed === 0 ? 0 : 1