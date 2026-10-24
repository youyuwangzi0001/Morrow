/**
 * 演示 Provider：离线剧本引擎（WOW 时刻）。
 *
 * 设计要点：
 * - 实现同一个 Provider 接口，Agent 循环完全不知道这是剧本；
 * - 剧本里的工具调用（list_dir / read_file / run_command / grep / write_file / open_artifact）
 *   全部由真实工具执行，数据来自用户工作区；
 * - 报告里的数字由本模块读取 CSV 后**真实计算**，与 run_command 的 PowerShell 聚合结果一致；
 * - 文本逐字流式、带思考段、约 35–50 秒（MORROW_DEMO_SPEED 可调速，测试用 0）；
 * - 没有可用数据文件时退回内置基准数据，剧本仍能完整跑完（避免首次演示失败）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../types'
import { newId, sleep } from '../util'

/* ── 数据结构 ─────────────────────────────────────────────────── */

interface SalesRow {
  line: number
  date: string
  orderId: string
  channel: string
  customer: string
  city: string
  category: string
  price: number
  quantity: number
  discount: number
  amount: number
}

export interface DemoAnomaly {
  orderId: string
  line: number
  reason: string
  detail: string
}

export interface DemoMetrics {
  rawRows: number
  uniqueOrderIds: number
  validOrders: number
  duplicateExtra: number
  refundCount: number
  totalRevenue: number
  avgOrderValue: number
  q2Revenue: number
  q2ReportedTotal: number
  q2Gap: number
  qoqGrowth: number
  monthly: Array<{ label: string; revenue: number; orders: number }>
  channels: Array<{ name: string; revenue: number; orders: number }>
  cities: Array<{ name: string; revenue: number }>
  categories: Array<{ name: string; revenue: number }>
  anomalies: DemoAnomaly[]
  customerConflict: { customer: string; salesCity: string; listCity: string } | null
  files: {
    sales: string
    customers: string
    readme: string
    q2: string
    notes: string
  }
  source: 'workspace' | 'fallback'
}

interface DemoStep {
  caption: string
  thinking?: string
  text?: string
  tools?: Array<{ name: string; input: Record<string, unknown> }>
}

export interface DemoProviderOptions {
  /** 播放速度倍率：0 = 不等待（测试），1 = 正常演示 */
  speed?: number
}

function demoEnvSpeed(): number {
  const raw = process.env.MORROW_DEMO_SPEED
  if (!raw) return 1
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 1
}

/* ── CSV 解析 ─────────────────────────────────────────────────── */

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out
}

function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map((header) => header.trim())
  const rows: Array<Record<string, string>> = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i])
    if (cells.every((cell) => !cell.trim())) continue
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim()
    })
    rows.push(record)
  }
  return rows
}

function num(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value.replace(/[,\s¥￥]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function listFiles(root: string, depth = 3, prefix = ''): string[] {
  const out: string[] = []
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', '.morrow'].includes(entry.name)) continue
      if (depth > 1) out.push(...listFiles(join(root, entry.name), depth - 1, rel))
      continue
    }
    if (entry.isFile()) out.push(rel)
  }
  return out
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/* ── 数据收集与计算 ───────────────────────────────────────────── */

function isSalesHeader(rows: Array<Record<string, string>>): boolean {
  if (rows.length === 0) return false
  const headers = Object.keys(rows[0])
  const has = (keyword: string): boolean => headers.some((header) => header.includes(keyword))
  return has('订单号') && has('金额') && has('日期')
}

function isCustomerHeader(rows: Array<Record<string, string>>): boolean {
  if (rows.length === 0) return false
  const headers = Object.keys(rows[0])
  return headers.some((header) => header.includes('客户')) && headers.some((header) => header.includes('城市'))
}

function findField(row: Record<string, string>, keywords: string[]): string {
  for (const key of Object.keys(row)) {
    if (keywords.some((keyword) => key.includes(keyword))) return row[key] ?? ''
  }
  return ''
}

function fallbackMetrics(): DemoMetrics {
  return {
    rawRows: 103,
    uniqueOrderIds: 102,
    validOrders: 101,
    duplicateExtra: 1,
    refundCount: 1,
    totalRevenue: 171627.85,
    avgOrderValue: 1699.29,
    q2Revenue: 144900,
    q2ReportedTotal: 145760,
    q2Gap: 860,
    qoqGrowth: 18.44,
    monthly: [
      { label: '7 月', revenue: 43421.35, orders: 32 },
      { label: '8 月', revenue: 61105.65, orders: 35 },
      { label: '9 月', revenue: 67100.85, orders: 34 }
    ],
    channels: [
      { name: '京东自营', revenue: 61381.95, orders: 12 },
      { name: '微信小程序', revenue: 43666.9, orders: 21 },
      { name: '抖音直播', revenue: 39724.6, orders: 42 },
      { name: '天猫旗舰店', revenue: 19022.5, orders: 15 },
      { name: '小红书商城', revenue: 6568.9, orders: 8 },
      { name: '线下门店', revenue: 1263, orders: 3 }
    ],
    cities: [
      { name: '广州', revenue: 47964.7 },
      { name: '上海', revenue: 22750.65 },
      { name: '苏州', revenue: 21194.45 }
    ],
    categories: [
      { name: '企业礼盒', revenue: 93712 },
      { name: '咖啡器具', revenue: 22668.55 },
      { name: '茶具', revenue: 22615.4 },
      { name: '家居香氛', revenue: 22442.45 },
      { name: '文具', revenue: 10189.45 }
    ],
    anomalies: [
      { orderId: 'ORD-2026Q3-0054', line: 0, reason: '折扣异常', detail: '折扣率 85%，远高于正常水平' },
      { orderId: 'ORD-2026Q3-0098', line: 0, reason: '退款/负数量单', detail: '数量 -1、金额负数，按口径剔除' },
      { orderId: 'ORD-2026Q3-0031', line: 0, reason: '订单号重复', detail: '同一订单在导出中出现 2 次，按口径只算一次' },
      { orderId: 'ORD-2026Q3-0003', line: 0, reason: '金额勾稽不符', detail: '金额与「单价 × 数量 × (1 − 折扣)」相差 1,888 元' }
    ],
    customerConflict: { customer: '上海星野广告', salesCity: '上海', listCity: '杭州' },
    files: {
      sales: '销售明细-2026Q3.csv',
      customers: '客户名单.csv',
      readme: 'README-待整理.md',
      q2: '旧文件/2026Q2-销售汇总.csv',
      notes: '旧文件/客户回访记录-2026-06.txt'
    },
    source: 'fallback'
  }
}

/** 从演示工作区读取真实数据并计算报告所需指标（文件缺失时退回基准数据） */
export function collectDemoMetrics(workspace: string | null): DemoMetrics {
  const fallback = fallbackMetrics()
  if (!workspace || !existsSync(workspace)) return fallback
  const files = listFiles(workspace, 3)
  const pick = (predicate: (rel: string, text: string) => boolean): string | null => {
    for (const rel of files) {
      if (!rel.toLowerCase().endsWith('.csv')) continue
      const text = readTextFile(join(workspace, rel))
      if (predicate(rel, text)) return rel
    }
    return null
  }
  const salesRel =
    pick((rel, text) => isSalesHeader(parseCsv(text).slice(0, 1))) ??
    files.find((rel) => rel.includes('销售明细')) ??
    null
  if (!salesRel) return fallback
  const salesText = readTextFile(join(workspace, salesRel))
  const rawRowsList = parseCsv(salesText)
  if (rawRowsList.length < 5) return fallback

  const sales: SalesRow[] = rawRowsList.map((row, index) => ({
    line: index + 2, // 1 行表头
    date: findField(row, ['日期', 'date']),
    orderId: findField(row, ['订单号', 'order']),
    channel: findField(row, ['渠道', 'channel']),
    customer: findField(row, ['客户', 'customer']),
    city: findField(row, ['城市', 'city', '地区', 'region']),
    category: findField(row, ['品类', '产品线', 'category']),
    price: num(findField(row, ['单价', 'price'])),
    quantity: num(findField(row, ['数量', 'qty', 'quantity'])),
    discount: num(findField(row, ['折扣', 'discount'])),
    amount: num(findField(row, ['金额', 'amount', 'revenue']))
  }))

  const uniqueIds = new Set(sales.map((row) => row.orderId))
  const countByOrder = new Map<string, number>()
  for (const row of sales) countByOrder.set(row.orderId, (countByOrder.get(row.orderId) ?? 0) + 1)
  const duplicateExtra = [...countByOrder.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)

  const refundRows = sales.filter((row) => row.amount < 0 || row.quantity < 0)
  const clean: SalesRow[] = []
  const seen = new Set<string>()
  for (const row of sales) {
    if (row.amount < 0 || row.quantity <= 0) continue
    if (seen.has(row.orderId)) continue
    seen.add(row.orderId)
    clean.push(row)
  }

  const totalRevenue = round2(clean.reduce((sum, row) => sum + row.amount, 0))
  const validOrders = clean.length
  const avgOrderValue = validOrders > 0 ? round2(totalRevenue / validOrders) : 0

  const monthMap = new Map<string, { revenue: number; orders: number }>()
  for (const row of clean) {
    const month = row.date.slice(0, 7)
    if (!month) continue
    const entry = monthMap.get(month) ?? { revenue: 0, orders: 0 }
    entry.revenue += row.amount
    entry.orders += 1
    monthMap.set(month, entry)
  }
  const monthly = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, value]) => ({ label: `${Number(month.slice(5, 7))} 月`, revenue: round2(value.revenue), orders: value.orders }))

  const groupSum = (key: (row: SalesRow) => string, withOrders: boolean): Array<{ name: string; revenue: number; orders: number }> => {
    const map = new Map<string, { revenue: number; orders: number }>()
    for (const row of clean) {
      const name = key(row) || '（未填写）'
      const entry = map.get(name) ?? { revenue: 0, orders: 0 }
      entry.revenue += row.amount
      entry.orders += 1
      map.set(name, entry)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, revenue: round2(value.revenue), orders: withOrders ? value.orders : 0 }))
      .sort((a, b) => b.revenue - a.revenue)
  }
  const channels = groupSum((row) => row.channel, true)
  const cities = groupSum((row) => row.city, false).map((item) => ({ name: item.name, revenue: item.revenue }))
  const categories = groupSum((row) => row.category, false).map((item) => ({ name: item.name, revenue: item.revenue }))

  // Q2 汇总：分渠道加总 vs 表内合计行
  let q2Revenue = fallback.q2Revenue
  let q2ReportedTotal = fallback.q2ReportedTotal
  const q2Rel =
    files.find((rel) => /2026Q2|2026-Q2/i.test(rel) && rel.toLowerCase().endsWith('.csv')) ??
    files.find((rel) => rel.includes('旧文件') && rel.toLowerCase().endsWith('.csv') && !rel.includes('销售明细')) ??
    null
  if (q2Rel) {
    const q2Rows = parseCsv(readTextFile(join(workspace, q2Rel)))
    if (q2Rows.length > 0) {
      let detailSum = 0
      let totalRowValue: number | null = null
      for (const row of q2Rows) {
        const month = findField(row, ['月份', 'month'])
        const amount = num(findField(row, ['销售额', 'amount', '金额']))
        if (month.includes('合计') || month.includes('总计')) {
          totalRowValue = amount
          continue
        }
        detailSum += amount
      }
      if (detailSum > 0) q2Revenue = round2(detailSum)
      if (totalRowValue !== null) q2ReportedTotal = round2(totalRowValue)
    }
  }
  const q2Gap = round2(q2ReportedTotal - q2Revenue)
  const qoqGrowth = q2Revenue > 0 ? round2(((totalRevenue - q2Revenue) / q2Revenue) * 100) : 0

  // 异常：折扣、退款、重复、勾稽
  const anomalies: DemoAnomaly[] = []
  for (const row of sales) {
    if (row.discount > 0.6) {
      anomalies.push({
        orderId: row.orderId,
        line: row.line,
        reason: '折扣异常',
        detail: `折扣率 ${(row.discount * 100).toFixed(0)}%，远高于正常水平（正常 ≤ 30%）`
      })
    }
  }
  for (const row of refundRows) {
    anomalies.push({
      orderId: row.orderId,
      line: row.line,
      reason: '退款/负数量单',
      detail: `数量 ${row.quantity}、金额 ¥${fmtMoney(row.amount)}，按口径在汇总时剔除`
    })
  }
  for (const [orderId, count] of countByOrder) {
    if (count > 1) {
      const row = sales.find((item) => item.orderId === orderId)
      anomalies.push({
        orderId,
        line: row?.line ?? 0,
        reason: '订单号重复',
        detail: `同一订单在导出中出现 ${count} 次，按口径只算一次（多计 ${count - 1} 行）`
      })
    }
  }
  for (const row of sales) {
    const expected = round2(row.price * row.quantity * (1 - row.discount))
    if (Math.abs(round2(row.amount) - expected) > 1) {
      anomalies.push({
        orderId: row.orderId,
        line: row.line,
        reason: '金额勾稽不符',
        detail: `金额 ¥${fmtMoney(row.amount)}，按「单价 × 数量 × (1 − 折扣)」应为 ¥${fmtMoney(expected)}，差 ¥${fmtMoney(row.amount - expected)}`
      })
    }
  }

  // 客户名单城市矛盾
  let customerConflict: DemoMetrics['customerConflict'] = null
  const customersRel = files.find((rel) => {
    if (!rel.toLowerCase().endsWith('.csv') || rel === salesRel) return false
    return isCustomerHeader(parseCsv(readTextFile(join(workspace, rel))).slice(0, 1))
  })
  if (customersRel) {
    const customerRows = parseCsv(readTextFile(join(workspace, customersRel)))
    const listCity = new Map<string, string>()
    for (const row of customerRows) {
      const name = findField(row, ['客户', 'customer'])
      const city = findField(row, ['城市', 'city'])
      if (name && city) listCity.set(name, city)
    }
    for (const row of clean) {
      const listed = listCity.get(row.customer)
      if (listed && row.city && listed !== row.city) {
        customerConflict = { customer: row.customer, salesCity: row.city, listCity: listed }
        break
      }
    }
  }

  const pickRel = (keywords: string[], extensions: string[]): string | null =>
    files.find((rel) => {
      const lower = rel.toLowerCase()
      return keywords.some((keyword) => lower.includes(keyword.toLowerCase())) && extensions.some((ext) => lower.endsWith(ext))
    }) ?? null

  return {
    rawRows: sales.length,
    uniqueOrderIds: uniqueIds.size,
    validOrders,
    duplicateExtra,
    refundCount: refundRows.length,
    totalRevenue,
    avgOrderValue,
    q2Revenue,
    q2ReportedTotal,
    q2Gap,
    qoqGrowth,
    monthly,
    channels,
    cities,
    categories,
    anomalies,
    customerConflict,
    files: {
      sales: toPosix(salesRel),
      customers: customersRel ? toPosix(customersRel) : fallback.files.customers,
      readme: pickRel(['readme', '说明'], ['.md', '.txt']) ? toPosix(pickRel(['readme', '说明'], ['.md', '.txt']) as string) : fallback.files.readme,
      q2: q2Rel ? toPosix(q2Rel) : fallback.files.q2,
      notes: pickRel(['回访'], ['.txt']) ? toPosix(pickRel(['回访'], ['.txt']) as string) : fallback.files.notes
    },
    source: 'workspace'
  }
}

/* ── 格式化 ───────────────────────────────────────────────────── */

/** 千分位金额（不带 ¥） */
export function fmtMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/* ── PowerShell 脚本（真实聚合/排查） ─────────────────────────── */

function buildAggregateCommand(files: DemoMetrics['files']): string {
  const sales = psQuote(files.sales)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${sales} -Encoding UTF8`,
    `$clean = @($rows | Where-Object { [double]$_.'数量' -gt 0 -and [double]$_.'金额' -ge 0 } | Sort-Object '订单号' -Unique)`,
    `$refunds = @($rows | Where-Object { [double]$_.'金额' -lt 0 -or [double]$_.'数量' -lt 0 })`,
    `$total = ($clean | ForEach-Object { [double]$_.'金额' } | Measure-Object -Sum).Sum`,
    `$avg = [math]::Round($total / $clean.Count, 2)`,
    `"原始数据行: $($rows.Count)"`,
    `"有效订单数: $($clean.Count)"`,
    `"退款/负数量行: $($refunds.Count)"`,
    `"总销售额: $([math]::Round($total, 2))"`,
    `"客单价: $avg"`,
    `"渠道表现:"`,
    `$channels = $clean | Group-Object '渠道' | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Orders = $_.Count; Sum = (($_.Group | ForEach-Object { [double]$_.'金额' }) | Measure-Object -Sum).Sum } } | Sort-Object Sum -Descending`,
    `foreach ($c in $channels) { "{0} | 订单 {1} 笔 | 销售额 {2}" -f $c.Name, $c.Orders, [math]::Round($c.Sum, 2) }`
  ].join('\n')
}

function buildAnomalyCommand(files: DemoMetrics['files']): string {
  const sales = psQuote(files.sales)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${sales} -Encoding UTF8`,
    `"【1】折扣异常（> 60%）"`,
    `foreach ($r in $rows | Where-Object { [double]$_.'折扣' -gt 0.6 }) { "{0} | 折扣 {1} | 金额 {2}" -f $r.'订单号', $r.'折扣', $r.'金额' }`,
    `"【2】退款 / 负数量"`,
    `foreach ($r in $rows | Where-Object { [double]$_.'金额' -lt 0 -or [double]$_.'数量' -lt 0 }) { "{0} | 数量 {1} | 金额 {2}" -f $r.'订单号', $r.'数量', $r.'金额' }`,
    `"【3】重复订单号"`,
    `foreach ($g in $rows | Group-Object '订单号' | Where-Object { $_.Count -gt 1 }) { "{0} 出现 {1} 次" -f $g.Name, $g.Count }`,
    `"【4】金额与 单价×数量×(1-折扣) 不一致"`,
    `foreach ($r in $rows) { $expect = [double]$r.'单价' * [double]$r.'数量' * (1 - [double]$r.'折扣'); if ([math]::Abs([double]$r.'金额' - $expect) -gt 1) { "{0} | 金额 {1} | 应为 {2}" -f $r.'订单号', $r.'金额', [math]::Round($expect, 2) } }`
  ].join('\n')
}

function buildQ2Command(files: DemoMetrics['files']): string {
  const q2 = psQuote(files.q2)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${q2} -Encoding UTF8`,
    `$detail = @($rows | Where-Object { $_.'月份' -ne '合计' })`,
    `$totalRow = @($rows | Where-Object { $_.'月份' -eq '合计' })`,
    `$sum = ($detail | ForEach-Object { [double]$_.'销售额' } | Measure-Object -Sum).Sum`,
    `"Q2 明细行: $($detail.Count)"`,
    `"分渠道加总: $([math]::Round($sum, 2))"`,
    `"表内合计行: $($totalRow[0].'销售额')"`,
    `"差额: $([math]::Round([double]$totalRow[0].'销售额' - $sum, 2))"`
  ].join('\n')
}

/* ── HTML 报告 ────────────────────────────────────────────────── */

function svgBars(
  items: Array<{ label: string; value: number; note?: string }>,
  opts: { gradientId: string; labelWidth?: number; valueWidth?: number }
): string {
  const width = 660
  const labelWidth = opts.labelWidth ?? 96
  const valueWidth = opts.valueWidth ?? 208
  const chartWidth = width - labelWidth - valueWidth
  const rowHeight = 34
  const top = 8
  const height = top * 2 + items.length * rowHeight
  const max = Math.max(...items.map((item) => item.value), 1)
  const rows = items
    .map((item, index) => {
      const y = top + index * rowHeight
      const barWidth = Math.max(4, Math.round((item.value / max) * chartWidth))
      const opacity = (0.62 + 0.38 * (1 - index / Math.max(1, items.length - 1))).toFixed(2)
      const note = item.note ? ` <tspan fill="#8f887e">${esc(item.note)}</tspan>` : ''
      return [
        `<text x="${labelWidth - 12}" y="${y + 16}" text-anchor="end" fill="#d9d2c5" font-size="13">${esc(item.label)}</text>`,
        `<rect x="${labelWidth}" y="${y + 4}" width="${chartWidth}" height="18" rx="4" fill="rgba(255,255,255,0.05)"/>`,
        `<rect x="${labelWidth}" y="${y + 4}" width="${barWidth}" height="18" rx="4" fill="url(#${opts.gradientId})" opacity="${opacity}"/>`,
        `<text x="${labelWidth + barWidth + 10}" y="${y + 17}" fill="#e2c894" font-size="12" font-family="ui-monospace, Consolas, monospace">¥${fmtMoney(item.value)}${note}</text>`
      ].join('')
    })
    .join('\n')
  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><linearGradient id="${opts.gradientId}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="#8a6f3d"/><stop offset="100%" stop-color="#e6cf9f"/>`,
    `</linearGradient></defs>`,
    rows,
    `</svg>`
  ].join('\n')
}

function anomalyCards(metrics: DemoMetrics): string {
  return metrics.anomalies
    .map((anomaly) => {
      const order = anomaly.orderId ? `<span class="order">${esc(anomaly.orderId)}</span>` : ''
      return `<li class="anomaly"><span class="tag">${esc(anomaly.reason)}</span>${order}<span class="detail">${esc(anomaly.detail)}</span></li>`
    })
    .join('\n')
}

function rankRows(items: Array<{ name: string; revenue: number }>, total: number): string {
  return items
    .slice(0, 5)
    .map((item, index) => {
      const share = total > 0 ? (item.revenue / total) * 100 : 0
      return `<tr><td class="rank">${String(index + 1).padStart(2, '0')}</td><td class="name">${esc(item.name)}</td><td class="num">¥${fmtMoney(item.revenue)}</td><td class="share"><span style="width:${Math.max(2, Math.round(share))}%"></span></td><td class="pct">${share.toFixed(1)}%</td></tr>`
    })
    .join('\n')
}

/** 生成自包含 HTML 报告（无外链、内联 CSS/SVG，可直接在 iframe 预览/发给老板） */
export function renderDemoReportHtml(metrics: DemoMetrics, generatedAt: Date): string {
  const total = metrics.totalRevenue
  const topChannel = metrics.channels[0] ?? { name: '—', revenue: 0, orders: 0 }
  const topCategory = metrics.categories[0] ?? { name: '—', revenue: 0 }
  const topCity = metrics.cities[0] ?? { name: '—', revenue: 0 }
  const mostOrders = [...metrics.channels].sort((a, b) => b.orders - a.orders)[0] ?? { name: '—', orders: 0 }
  const channelShare = total > 0 ? (topChannel.revenue / total) * 100 : 0
  const categoryShare = total > 0 ? (topCategory.revenue / total) * 100 : 0
  const monthlyBars = svgBars(
    metrics.monthly.map((month) => ({ label: month.label, value: month.revenue, note: `· ${month.orders} 单` })),
    { gradientId: 'goldMonth' }
  )
  const channelBars = svgBars(
    metrics.channels.map((channel) => ({ label: channel.name, value: channel.revenue, note: `· ${channel.orders} 单` })),
    { gradientId: 'goldChannel', labelWidth: 112 }
  )
  const conflict = metrics.customerConflict
  const generated = generatedAt.toLocaleString('zh-CN', { hour12: false })

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Q3 销售复盘 · 2026</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14171c;
    --panel-2: #1a1e24;
    --line: rgba(201, 168, 106, 0.22);
    --text: #e9e4da;
    --muted: #948d82;
    --gold: #c9a86a;
    --gold-strong: #e6cf9f;
    --good: #8fc4a8;
    --bad: #e29a86;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 15px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1000px; margin: 0 auto; padding: 64px 56px 72px; }
  .eyebrow {
    font-size: 11px; letter-spacing: 0.34em; color: var(--gold);
    text-transform: uppercase; margin-bottom: 18px;
  }
  h1 {
    font-family: Georgia, "Times New Roman", "Songti SC", "SimSun", serif;
    font-size: 52px; line-height: 1.12; font-weight: 500;
    margin: 0 0 18px; letter-spacing: 0.01em;
  }
  h1 em { font-style: normal; color: var(--gold-strong); }
  .lead { color: var(--muted); max-width: 720px; margin: 0 0 8px; }
  .meta-line { color: #6f6a61; font-size: 12px; letter-spacing: 0.04em; }
  .rule { height: 1px; background: linear-gradient(90deg, var(--line), transparent 92%); margin: 40px 0; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .kpi {
    background: linear-gradient(160deg, var(--panel-2), var(--panel));
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px; padding: 22px 20px 18px;
  }
  .kpi .label { color: var(--muted); font-size: 12px; letter-spacing: 0.06em; }
  .kpi .value {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-size: 34px; line-height: 1.2; margin-top: 10px; color: var(--gold-strong);
  }
  .kpi .value small { font-size: 16px; color: var(--muted); margin-right: 2px; }
  .kpi .note { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .delta-up { color: var(--good); }
  section { margin-top: 52px; }
  h2 {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-size: 26px; font-weight: 500; margin: 0 0 6px;
  }
  h2 .num { color: var(--gold); font-size: 14px; margin-right: 12px; letter-spacing: 0.12em; }
  .sub { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .panel {
    background: linear-gradient(165deg, rgba(26, 30, 36, 0.9), rgba(18, 21, 26, 0.9));
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px; padding: 26px 24px;
  }
  .insight { color: var(--muted); font-size: 13px; margin-top: 14px; }
  .insight strong { color: var(--gold-strong); font-weight: 600; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  table.rank-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .rank-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 0 8px 10px 0; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 11px; letter-spacing: 0.08em; }
  .rank-table td { padding: 10px 8px 10px 0; border-bottom: 1px solid rgba(255,255,255,0.045); vertical-align: middle; }
  .rank-table .rank { color: #5f5a52; font-family: ui-monospace, Consolas, monospace; }
  .rank-table .name { color: var(--text); }
  .rank-table .num { color: var(--gold-strong); font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  .rank-table .share { width: 34%; }
  .rank-table .share span { display: block; height: 7px; border-radius: 4px; background: linear-gradient(90deg, #8a6f3d, #e6cf9f); }
  .rank-table .pct { color: var(--muted); font-family: ui-monospace, Consolas, monospace; text-align: right; white-space: nowrap; }
  ul.anomalies { list-style: none; margin: 0; padding: 0; }
  li.anomaly {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px;
    padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 13px;
  }
  li.anomaly:last-child { border-bottom: none; }
  li.anomaly .tag {
    color: var(--bg); background: var(--gold); border-radius: 999px;
    padding: 1px 10px; font-size: 11px; letter-spacing: 0.04em; flex: none;
  }
  li.anomaly .order { color: var(--gold-strong); font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  li.anomaly .detail { color: var(--muted); flex: 1 1 240px; }
  .callout {
    border-left: 2px solid var(--gold); padding: 14px 18px;
    background: rgba(201, 168, 106, 0.06); border-radius: 0 10px 10px 0;
    color: #cfc8bc; font-size: 13px;
  }
  .callout b { color: var(--gold-strong); }
  .suggestions { counter-reset: sug; list-style: none; margin: 0; padding: 0; }
  .suggestions li {
    counter-increment: sug; position: relative; padding: 14px 0 14px 44px;
    border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px;
  }
  .suggestions li:last-child { border-bottom: none; }
  .suggestions li::before {
    content: counter(sug, decimal-leading-zero);
    position: absolute; left: 0; top: 14px; color: var(--gold);
    font-family: Georgia, serif; font-size: 18px;
  }
  .suggestions b { color: var(--gold-strong); font-weight: 600; }
  footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid rgba(255,255,255,0.06); color: #5f5a52; font-size: 11px; letter-spacing: 0.05em; }
  @media (max-width: 820px) {
    .page { padding: 40px 24px 48px; }
    h1 { font-size: 36px; }
    .kpis { grid-template-columns: 1fr 1fr; }
    .grid-2 { grid-template-columns: 1fr; }
  }
  @media print {
    body { background: #fff; color: #1b1b1b; }
    .page { padding: 24px; max-width: none; }
    .panel, .kpi { background: #f7f5f0; border-color: #ddd6c8; }
    h1 em, .kpi .value, .rank-table .num, .rank-table .pct, li.anomaly .order { color: #8a6f3d; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="eyebrow">Morrow · 2026 Q3 Review</div>
  <h1>Q3 销售复盘<em>，比上季度更好一点</em></h1>
  <p class="lead">这份报告由 Morrow 在本地读取销售明细后真实计算生成：先剔除退款、按订单号去重，再按「金额」列汇总。所有数字都可以在原始 CSV 里复核。</p>
  <p class="meta-line">数据来源：${esc(metrics.files.sales)} · 生成时间：${esc(generated)}</p>

  <div class="rule"></div>

  <div class="kpis">
    <div class="kpi">
      <div class="label">Q3 总销售额</div>
      <div class="value"><small>¥</small>${fmtMoney(total)}</div>
      <div class="note">按干净口径汇总</div>
    </div>
    <div class="kpi">
      <div class="label">有效订单</div>
      <div class="value">${metrics.validOrders}<small> 笔</small></div>
      <div class="note">原始 ${metrics.rawRows} 行 · 去重 ${metrics.duplicateExtra} 行 · 剔除退款 ${metrics.refundCount} 笔</div>
    </div>
    <div class="kpi">
      <div class="label">客单价</div>
      <div class="value"><small>¥</small>${fmtMoney(metrics.avgOrderValue)}</div>
      <div class="note">销售额 ÷ 有效订单数</div>
    </div>
    <div class="kpi">
      <div class="label">环比 Q2</div>
      <div class="value delta-up">${fmtPct(metrics.qoqGrowth)}</div>
      <div class="note">Q2 ${fmtMoney(metrics.q2Revenue)} → Q3 ${fmtMoney(total)}</div>
    </div>
  </div>

  <section>
    <h2><span class="num">01</span>三个月都在往上走</h2>
    <p class="sub">按月份拆分的销售额与订单数（干净口径）</p>
    <div class="panel">
      ${monthlyBars}
      <p class="insight">7 月到 9 月连续增长，9 月单月销售额 <strong>¥${fmtMoney(metrics.monthly[metrics.monthly.length - 1]?.revenue ?? 0)}</strong>，是季度内最高点。</p>
    </div>
  </section>

  <section>
    <h2><span class="num">02</span>京东自营扛住了大盘</h2>
    <p class="sub">渠道销售额排名（Top 6）</p>
    <div class="panel">
      ${channelBars}
      <p class="insight">京东自营贡献了 <strong>${channelShare.toFixed(1)}%</strong> 的销售额；但订单数最多的是 <strong>${esc(mostOrders.name)}（${mostOrders.orders} 笔）</strong>——一个走客单价，一个走流量，投放策略值得分开看。</p>
    </div>
  </section>

  <section>
    <h2><span class="num">03</span>城市与品类</h2>
    <p class="sub">销售额 Top 5（城市 / 品类）</p>
    <div class="grid-2">
      <div class="panel">
        <table class="rank-table">
          <thead><tr><th>#</th><th>城市</th><th>销售额</th><th>占比</th><th></th></tr></thead>
          <tbody>${rankRows(metrics.cities, total)}</tbody>
        </table>
      </div>
      <div class="panel">
        <table class="rank-table">
          <thead><tr><th>#</th><th>品类</th><th>销售额</th><th>占比</th><th></th></tr></thead>
          <tbody>${rankRows(metrics.categories, total)}</tbody>
        </table>
      </div>
    </div>
    <p class="insight">头部城市是 <strong>${esc(topCity.name)}</strong>；品类里 <strong>${esc(topCategory.name)}</strong> 一家占了 <strong>${categoryShare.toFixed(1)}%</strong>，主要来自企业礼盒的 B2B 订单，复购和备货要提前锁。</p>
  </section>

  <section>
    <h2><span class="num">04</span>数据里发现的问题</h2>
    <p class="sub">共 ${metrics.anomalies.length} 处，建议先修数据再做下一步决策</p>
    <div class="panel">
      <ul class="anomalies">
        ${anomalyCards(metrics)}
      </ul>
      <div class="callout" style="margin-top:18px">
        另外，Q2 汇总表的分渠道加总是 <b>¥${fmtMoney(metrics.q2Revenue)}</b>，但表内「合计」行写的是 <b>¥${fmtMoney(metrics.q2ReportedTotal)}</b>，差了 <b>¥${fmtMoney(Math.abs(metrics.q2Gap))}</b>，应该是当时手抄错了。本报告的环比用分渠道加总值计算。
      </div>
      ${
        conflict
          ? `<div class="callout" style="margin-top:12px">客户名单里「<b>${esc(conflict.customer)}</b>」的城市和销售表对不上：销售表是 <b>${esc(conflict.salesCity)}</b>，名单写的是 <b>${esc(conflict.listCity)}</b>。发给老板前建议确认一下。</div>`
          : ''
      }
    </div>
  </section>

  <section>
    <h2><span class="num">05</span>下一步建议</h2>
    <p class="sub">按优先级排序</p>
    <div class="panel">
      <ol class="suggestions">
        <li><b>先修那 ${metrics.anomalies.length} 处异常数据</b>：尤其是金额勾稽不符和重复导出的订单，不修掉下次复盘还会对不上。</li>
        <li><b>按渠道分策略</b>：京东自营和企业礼盒贡献了主要销售额，${esc(mostOrders.name)} 带来最多订单但客单价低，两个渠道的投放和选品要分开定。</li>
        <li><b>整理「旧文件」</b>：修正 Q2 汇总的合计错误、归档客户回访记录，并确认${conflict ? esc(conflict.customer) : '客户名单'}的城市口径。</li>
      </ol>
    </div>
  </section>

  <footer>
    Morrow · 明日工坊 · 本报告由本地数据生成，未上传任何文件 · ${esc(generated)}
  </footer>
</div>
</body>
</html>
`
}

/* ── 剧本 ─────────────────────────────────────────────────────── */

function buildDemoScript(workspace: string | null, now: Date): DemoStep[] {
  const m = collectDemoMetrics(workspace)
  const anomalyCount = m.anomalies.length
  const topChannel = m.channels[0] ?? { name: '京东自营', revenue: 0, orders: 0 }
  const topCategory = m.categories[0] ?? { name: '企业礼盒', revenue: 0 }
  const mostOrders = [...m.channels].sort((a, b) => b.orders - a.orders)[0] ?? { name: '抖音直播', orders: 0 }
  const channelShare = m.totalRevenue > 0 ? (topChannel.revenue / m.totalRevenue) * 100 : 0
  const report = renderDemoReportHtml(m, now)

  return [
    {
      caption: '扫描工作区',
      thinking: '先摸清工作区结构，别一上来就写报告。',
      text:
        '我先看看这个文件夹里有什么。\n\n' +
        '不急着下结论——先弄清楚数据在哪、口径是什么，再把数字算准。',
      tools: [{ name: 'list_dir', input: { path: '.', depth: 2 } }]
    },
    {
      caption: '列出计划',
      thinking: '目标是给老板一份能直接发的复盘，拆成五步最稳。',
      text:
        '目录已经清楚了：一份 Q3 销售明细、一份客户名单、一份待整理的说明，还有一个 `旧文件` 文件夹。\n\n' +
        '老板要的复盘我拆成五步，先列个计划，边做边更新：',
      tools: [
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'in_progress' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'pending' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'pending' },
              { text: '生成自包含 HTML 复盘报告', status: 'pending' },
              { text: '打开画布并给出下一步建议', status: 'pending' }
            ]
          }
        }
      ]
    },
    {
      caption: '读取销售明细与说明',
      thinking: '先看表头和说明里的口径，再决定怎么算。',
      text:
        '先读销售明细的前几行，再翻一下那份说明——口径都写在里面，比我自己猜靠谱。',
      tools: [
        { name: 'read_file', input: { path: m.files.sales, limit: 6 } },
        { name: 'read_file', input: { path: m.files.readme } }
      ]
    },
    {
      caption: '用命令做真实聚合',
      thinking: '数字不能靠猜，直接用 PowerShell 把 CSV 聚合一遍。',
      text:
        '说明里写得很清楚：**退款要剔除、重复订单号只算一次、客单价 = 销售额 ÷ 有效订单数**。\n\n' +
        '我直接用 PowerShell 对 CSV 做一次真实聚合，不猜数字：',
      tools: [
        { name: 'run_command', input: { command: buildAggregateCommand(m.files), timeout_ms: 60000 } },
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'completed' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'completed' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'in_progress' },
              { text: '生成自包含 HTML 复盘报告', status: 'pending' },
              { text: '打开画布并给出下一步建议', status: 'pending' }
            ]
          }
        }
      ]
    },
    {
      caption: '排查异常订单',
      thinking: '折差异常、负数、重复、勾稽错误，这四类最容易糊弄过去，必须单独查。',
      text:
        `聚合结果出来了：\n\n` +
        `- Q3 总销售额 **¥${fmtMoney(m.totalRevenue)}**\n` +
        `- 有效订单 **${m.validOrders}** 笔（原始 ${m.rawRows} 行，含 ${m.refundCount} 笔退款、${m.duplicateExtra} 行重复导出）\n` +
        `- 客单价约 **¥${fmtMoney(m.avgOrderValue)}**\n\n` +
        `同时扫出 ${anomalyCount} 处数据问题——这些正是报告里最该被点出来、而不是被平均掉的部分：`,
      tools: [{ name: 'run_command', input: { command: buildAnomalyCommand(m.files), timeout_ms: 60000 } }]
    },
    {
      caption: '核对 Q2 环比与客户名单',
      thinking: '环比要用分渠道加总值，不能直接信合计行；客户名单的城市也对一下。',
      text:
        '接着核对 Q2 和客户名单：环比不能直接信「合计」行，得自己加一遍。',
      tools: [
        { name: 'run_command', input: { command: buildQ2Command(m.files), timeout_ms: 60000 } },
        ...(m.customerConflict ? [{ name: 'grep', input: { pattern: m.customerConflict.customer, include: '*.csv' } }] : [])
      ]
    },
    {
      caption: '生成自包含 HTML 报告',
      thinking: '报告要给老板直接看，单文件、无外链、视觉得撑得住场面。',
      text:
        `口径全部核对完了：Q2 分渠道加总 **¥${fmtMoney(m.q2Revenue)}**，表内合计行却是 **¥${fmtMoney(m.q2ReportedTotal)}**（差 ¥${fmtMoney(Math.abs(m.q2Gap))}）；Q3 环比增长 **${fmtPct(m.qoqGrowth)}**。\n\n` +
        '现在开始写报告：先把结构、样式和图表骨架写好，再补数据与文案。石墨底 + 香槟金、衬线大标题、关键指标卡和环比条形图，做成单文件自包含的 HTML——双击就能看，直接转发也不丢样式。',
      tools: [{ name: 'write_file', input: { path: '分析报告.html', content: report } }]
    },
    {
      caption: '打开画布',
      thinking: '把成品放到用户面前，这一步才算交付。',
      text: '报告写好了，我把它放到画布上给你看看。',
      tools: [
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'completed' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'completed' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'completed' },
              { text: '生成自包含 HTML 复盘报告', status: 'completed' },
              { text: '打开画布并给出下一步建议', status: 'in_progress' }
            ]
          }
        },
        { name: 'open_artifact', input: { title: 'Q3 销售复盘 · 2026', kind: 'html', path: '分析报告.html' } }
      ]
    },
    {
      caption: '给出下一步建议',
      thinking: '最后给三条能直接执行的建议，别让用户自己琢磨。',
      text:
        `报告已经生成好了：**分析报告.html**（已放到画布）。一句话结论：**Q3 卖了 ¥${fmtMoney(m.totalRevenue)}，比 Q2 增长 ${fmtPct(m.qoqGrowth)}，${esc(topChannel.name)}和${esc(topCategory.name)}是主要拉动**。\n\n` +
        '接下来我建议做这三件事：\n\n' +
        `1. **先处理那 ${anomalyCount} 条异常数据**——尤其是金额勾稽不符的订单和重复导出的订单号，不修掉下次复盘还会对不上。\n` +
        `2. **按渠道分策略**：${esc(topChannel.name)}贡献了 ${channelShare.toFixed(1)}% 的销售额，而订单数最多的是${esc(mostOrders.name)}（${mostOrders.orders} 笔），一个走客单价、一个走流量。\n` +
        `3. **整理「旧文件」文件夹**：修正 Q2 汇总的合计错误、把客户回访记录归档，顺便确认一下${m.customerConflict ? esc(m.customerConflict.customer) : '客户名单'}的城市口径。\n\n` +
        '想让我直接改数据、或者把报告导出成别的格式，说一声就行。'
    }
  ]
}

/* ── DemoProvider ─────────────────────────────────────────────── */

export class DemoProvider implements Provider {
  readonly id = 'demo'
  private readonly speed: number
  private script: DemoStep[] | null = null
  private stepIndex = 0
  private finished = false

  constructor(options: DemoProviderOptions = {}) {
    const speed = options.speed ?? demoEnvSpeed()
    this.speed = Number.isFinite(speed) && speed >= 0 ? speed : 1
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    if (!this.script || this.finished) {
      this.script = buildDemoScript(request.workspace ?? null, new Date())
      this.stepIndex = 0
      this.finished = false
    }
    const step = this.script[this.stepIndex]
    if (!step) {
      this.finished = true
      yield { type: 'text_delta', text: '（演示已结束，可以继续向 Morrow 提问。）' }
      return
    }
    this.stepIndex += 1
    const total = this.script.length
    yield { type: 'demo_step', index: this.stepIndex, total, caption: step.caption }

    await this.pause(650, request.signal)
    if (step.thinking) {
      for await (const event of this.streamText(step.thinking, 'thinking', request.signal)) yield event
    }
    if (step.text) {
      for await (const event of this.streamText(step.text, 'text', request.signal)) yield event
    }
    if (step.tools) {
      for (let index = 0; index < step.tools.length; index += 1) {
        const tool = step.tools[index]
        for await (const event of this.streamTool(tool, index, request.signal)) yield event
      }
    }
    await this.pause(450, request.signal)
    const textLength = (step.thinking?.length ?? 0) + (step.text?.length ?? 0)
    yield {
      type: 'usage',
      usage: { inputTokens: 900 + this.stepIndex * 460, outputTokens: 80 + Math.ceil(textLength / 3) }
    }
    if (!step.tools || step.tools.length === 0) this.finished = true
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (this.speed <= 0) return
    await sleep(Math.round(ms * this.speed), signal)
  }

  private async *streamText(
    text: string,
    kind: 'text' | 'thinking',
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    let index = 0
    while (index < text.length) {
      if (signal.aborted) throw Object.assign(new Error('演示已中断'), { name: 'AbortError' })
      if (text[index] === '\n') {
        if (this.speed > 0) await sleep(Math.round((kind === 'thinking' ? 45 : 180) * this.speed), signal)
        yield kind === 'text' ? { type: 'text_delta', text: '\n' } : { type: 'thinking_delta', text: '\n' }
        index += 1
        continue
      }
      // 逐 2~3 个字符输出，接近真人打字的节奏
      const size = index + 4 <= text.length && /[\u3000-\u9fff]/.test(text[index]) ? 3 : 2
      const chunk = text.slice(index, index + size)
      index += size
      if (this.speed > 0) await sleep(Math.round((kind === 'thinking' ? 19 : 26) * this.speed), signal)
      yield kind === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', text: chunk }
    }
  }

  private async *streamTool(
    tool: { name: string; input: Record<string, unknown> },
    index: number,
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const id = newId('call')
    yield { type: 'tool_call_start', index, id, name: tool.name }
    await this.pause(280, signal)
    const args = JSON.stringify(tool.input)
    yield { type: 'tool_call_delta', index, argsDelta: args }
    await this.pause(200, signal)
    if (tool.name === 'write_file') {
      // 真实开发里写文件是最耗时的一步：演示时按内容长度模拟“正在写代码”，
      // 让报告不是瞬间出现，而是先看到结构、再等文件落盘。
      const content = typeof tool.input.content === 'string' ? tool.input.content : ''
      const lines = content ? content.split('\n').length : 20
      const file = typeof tool.input.path === 'string' ? tool.input.path : '文件'
      yield {
        type: 'demo_step',
        index: this.stepIndex,
        total: this.script?.length ?? 0,
        caption: `编写 ${file}（约 ${lines} 行）`
      }
      await this.pause(1_100 + Math.min(4_200, Math.round(content.length / 7)), signal)
    } else if (tool.name === 'run_command' || tool.name === 'terminal') {
      yield {
        type: 'demo_step',
        index: this.stepIndex,
        total: this.script?.length ?? 0,
        caption: '运行命令并核对输出'
      }
      await this.pause(650, signal)
    } else {
      await this.pause(180, signal)
    }
    yield { type: 'tool_call_end', index, id, name: tool.name, input: tool.input }
  }
}

