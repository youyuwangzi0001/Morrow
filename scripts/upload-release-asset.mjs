// 上传发布资产到 GitHub Release（逐个、带进度与超时）。
//
// 设计要点（都是踩过的坑）：
//   1) 同名资产的处理顺序是「先上传改了名的临时名 → 删旧 → 改名」，不是先删再传：
//      先前版本先删旧资产，上传一旦超时，release 上就直接缺文件。
//   2) 用 node:https 主动管道写入，而不是 fetch + ReadStream：
//      GitHub 会把它判定为 request body inactivity 并返回 408。
//
// 用法：node scripts/upload-release-asset.mjs <tag> <文件路径> [...]
import { createReadStream, statSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { request } from 'node:https'
import { execFileSync } from 'node:child_process'

const [tag, ...files] = process.argv.slice(2)
if (!tag || files.length === 0) {
  console.error('用法: node scripts/upload-release-asset.mjs <tag> <文件路径> [...]')
  process.exit(1)
}

const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const repo = (() => {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/)
  if (!match) throw new Error(`无法从 origin 解析仓库：${url}`)
  return `${match[1]}/${match[2]}`
})()

const api = `https://api.github.com/repos/${repo}`
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': `${pkg.name}-release-upload`
}

async function apiJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

/** 取 release 的所有资产（分页） */
async function listAssets(releaseId) {
  const all = []
  for (let page = 1; ; page += 1) {
    const batch = await apiJson(`${api}/releases/${releaseId}/assets?per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

/** 用 node:https 流式上传，主动节流避免被判 inactivity，并打印进度 */
function uploadAsset(releaseId, file, uploadName) {
  const size = statSync(file).size
  const url = new URL(
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(uploadName)}`
  )
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size)
        },
        timeout: 30 * 60_000
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            reject(new Error(`上传失败 ${res.statusCode}：${text.slice(0, 300)}`))
            return
          }
          const seconds = ((Date.now() - started) / 1000).toFixed(1)
          const asset = JSON.parse(text)
          console.log(`[${uploadName}] 完成 · ${(asset.size / 1024 / 1024).toFixed(2)} MB · ${seconds}s · state=${asset.state}`)
          resolve(asset)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('上传超时（30 分钟）')))
    req.on('error', reject)

    const stream = createReadStream(file)
    let sent = 0
    let lastLog = 0
    stream.on('data', (chunk) => {
      sent += chunk.length
      const now = Date.now()
      if (now - lastLog > 5000) {
        lastLog = now
        const pct = ((sent / size) * 100).toFixed(1)
        const mbps = sent / 1024 / 1024 / ((now - started) / 1000)
        console.log(`[${uploadName}] ${pct}% · ${mbps.toFixed(1)} MB/s`)
      }
    })
    stream.on('error', reject)
    stream.pipe(req)
  })
}

async function main() {
  const release = await apiJson(`${api}/releases/tags/${tag}`)
  console.log(`发布：${release.name} (${tag}) · release id=${release.id} · 目标仓库 ${repo}`)
  const existing = await listAssets(release.id)
  console.log(`现有资产：${existing.map((item) => item.name).join('、') || '（无）'}`)

  for (const file of files) {
    const name = basename(file)
    const size = statSync(file).size
    const old = existing.find((item) => item.name === name)

    console.log(`\n[${name}] 上传 ${(size / 1024 / 1024).toFixed(2)} MB …`)
    // 有同名旧资产时先用临时名上传，成功后再删旧、改名：
    // 这样任何一步失败，release 上都还留着上一个可用版本。
    const uploadName = old ? `${name}.uploading` : name
    const asset = await uploadAsset(release.id, file, uploadName)

    if (old) {
      console.log(`[${name}] 新资产已就位，删除旧资产（${old.size} B）…`)
      await apiJson(`${api}/releases/assets/${old.id}`, { method: 'DELETE' })
      await apiJson(`${api}/releases/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      console.log(`[${name}] 已替换为本次构建`)
    }
  }

  const finalAssets = await listAssets(release.id)
  console.log('\n发布资产现状：')
  for (const asset of finalAssets) console.log(`  ${asset.name}\t${asset.size}\t${asset.state}`)
}

main().catch((err) => {
  console.error(`失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})