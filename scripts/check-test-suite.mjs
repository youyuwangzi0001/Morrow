import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const contract = JSON.parse(readFileSync(resolve(root, 'tests/core-coverage.json'), 'utf8'))
const features = new Map(contract.features.map((feature) => [feature.id, feature]))
const cases = []
const errors = []

if (features.size !== contract.features.length) errors.push('核心功能 id 重复')

const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
for (const name of ['test:unit:all', 'test:e2e:all', 'pretest:e2e:all', 'verify:all', 'test:eval', 'test:mock', 'probe:live']) {
  if (name in scripts) errors.push(`${name}: 非核心套组已删除，请勿恢复旧入口；当前规则见 docs/TESTING.md`)
}
for (const name of ['test:unit', 'test:e2e']) {
  if (/(?:^|\s)(?:-t|--testNamePattern|--grep(?:-invert)?)(?:[=\s]|$)/.test(scripts[name] ?? '')) {
    errors.push(`${name}: 当前仅保留核心用例，默认入口应直接运行全部现存用例，不再按标题筛选`)
  }
}

for (const name of readdirSync(resolve(root, 'tests'), { recursive: true })) {
  if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) continue
  if (!/^(unit|e2e)\//.test(name.replaceAll('\\', '/')) || !/\.(test|spec)\.ts$/.test(name)) {
    errors.push(`tests/${name}: 只保留 unit/e2e 中登记的核心套组，不另设扩展测试入口`)
  }
}

for (const kind of ['unit', 'e2e']) {
  const directory = resolve(root, 'tests', kind)
  for (const name of readdirSync(directory, { recursive: true })) {
    if (!/\.(test|spec)\.ts$/.test(name)) continue
    const path = resolve(directory, name)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source)
        const title = node.arguments[0]
        if (/^(it|test|describe|suite)\b/.test(expression) && /\.only\b/.test(expression)) {
          errors.push(`${relative(root, path)}: 不允许提交 .only，否则会漏跑回归`)
        }
        const registersCase = /^(it|test)(?:$|\.(?:only|skip|fixme|todo|each|for|skipIf|runIf|concurrent|fails|sequential)\b)/.test(expression)
          && ((title && ts.isStringLiteralLike(title)) || node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)))
        if (registersCase && (!title || !ts.isStringLiteralLike(title) || !title.text.startsWith('@core:'))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          errors.push(`${relative(root, path)}:${line}: 只保留核心用例；独立 it/test 必须使用已登记的 @core:功能域 标题`)
        }
        if (title && ts.isStringLiteralLike(title) && title.text.startsWith('@core:')) {
          const match = /^@core:([a-z][a-z-]*)\s+\S/.exec(title.text)
          const feature = match?.[1]
          if (!feature || !features.has(feature)) errors.push(`${name}: 未登记的核心功能标记 ${title.text}`)
          if (expression !== 'it' && expression !== 'test') {
            errors.push(`${name}: 核心标记应直接放在独立 it/test 上，不能用整组标记或 skip/each 隐藏数量`)
          }
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          cases.push({ kind, feature, file: relative(root, path).replaceAll('\\', '/'), line, title: title.text })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

const coverage = contract.features.map((feature) => {
  const count = Object.fromEntries(['unit', 'e2e'].map((kind) => [kind,
    cases.filter((item) => item.kind === kind && item.feature === feature.id).length
  ]))
  for (const kind of ['unit', 'e2e']) {
    if (feature[kind] && !count[kind]) errors.push(`${feature.title}: 缺少 ${kind} 核心用例`)
  }
  return { id: feature.id, title: feature.title, ...count }
})
const totals = Object.fromEntries(['unit', 'e2e'].map((kind) => [kind, cases.filter((item) => item.kind === kind).length]))
for (const kind of ['unit', 'e2e']) {
  if (totals[kind] > contract.limits[kind]) {
    errors.push(`${kind} 核心用例 ${totals[kind]} 项超过 ${contract.limits[kind]} 项维护预算，请先去重或说明新增覆盖`)
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ totals, coverage, cases, errors }, null, 2))
} else {
  for (const row of coverage) console.log(`${row.id.padEnd(19)} unit=${String(row.unit).padStart(2)} e2e=${row.e2e}  ${row.title}`)
  console.log(`核心套组：${totals.unit} 项单元 / ${totals.e2e} 项 Electron 集成 / ${coverage.length} 个功能域`)
  console.log('这里只校验覆盖登记与数量；是否通过以 Vitest / Playwright 的执行结果为准。')
  for (const error of errors) console.error(error)
}
if (errors.length) process.exitCode = 1
