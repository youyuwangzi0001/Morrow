// 通过 GitHub Git Data API 推送一个 commit，用于 github.com:443 被网络阻断、
// 但 api.github.com 仍可达的环境。只上传增量 blob，不重传整个仓库。
//
// 用法：node scripts/push-via-api.mjs <branch> [baseCommit]
import { execFileSync } from 'node:child_process'

const [branch, baseArg] = process.argv.slice(2)
if (!branch) {
  console.error('用法: node scripts/push-via-api.mjs <branch> [baseCommit]')
  process.exit(1)
}

const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
if (!match) throw new Error(`无法从 origin 解析仓库：${repoUrl}`)
const repo = `${match[1]}/${match[2]}`
const api = `https://api.github.com/repos/${repo}`

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'morrow-release-push'
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

async function callApi(path, init = {}) {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // 非 JSON 响应交给下面的错误分支说明
  }
  if (!res.ok) {
    throw new Error(`API ${init.method ?? 'GET'} ${path} → HTTP ${res.status}：${text.slice(0, 400)}`)
  }
  return json
}

const head = git('rev-parse', 'HEAD').trim()
const base = (baseArg || git('rev-parse', 'HEAD^').trim()).trim()
const message = git('log', '-1', '--format=%B', head).trim()
const parentMessage = git('log', '-1', '--format=%B', base).trim()

console.log(`仓库 ${repo}`)
console.log(`父提交 ${base}（${parentMessage.split('\n')[0]}）`)
console.log(`新提交 ${head}（${message.split('\n')[0]}）`)

// 1) 父提交必须已经存在于远端，否则说明需要先推更早的历史
const remoteBase = await callApi(`/git/commits/${base}`)
console.log(`远端已有父提交：${remoteBase.sha.slice(0, 7)}`)

// 2) 该提交在远端是否有对应 tag（用于后面同步 v0.2.0）
void 0

// 3) 上传有变化的 blob
const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean)
console.log(`待上传文件：${changed.length} 个`)

const tree = []
for (const file of changed) {
  const modeLine = git('ls-tree', head, '--', file).trim()
  if (!modeLine) {
    // 文件在新提交里已不存在 → 从树里删除
    tree.push({ path: file, mode: '100644', type: 'blob', sha: null })
    console.log(`  删除 ${file}`)
    continue
  }
  const [meta, ...rest] = modeLine.split('\t')
  const [mode, type, sha] = meta.split(/\s+/)
  if (type !== 'blob') throw new Error(`不支持的条目类型：${meta}`)
  const content = execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 256 * 1024 * 1024 })
  const blob = await callApi('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
  })
  tree.push({ path: file, mode, type: 'blob', sha: blob.sha })
  console.log(`  ${file} → ${blob.sha.slice(0, 7)}`)
}

// 4) 基于父提交的树建立新树
const baseTree = await callApi(`/git/commits/${base}`)
const newTree = await callApi('/git/trees', {
  method: 'POST',
  body: JSON.stringify({ base_tree: baseTree.tree.sha, tree })
})
console.log(`新树：${newTree.sha.slice(0, 7)}`)

// 5) 创建提交（不指定 author/committer，让 GitHub 用 token 账号，避免与本地不一致）
const created = await callApi('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message, tree: newTree.sha, parents: [base] })
})
console.log(`新提交已在远端创建：${created.sha.slice(0, 7)}`)

// 6) 强制把分支指向它（等价于 git push --force）
await callApi(`/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: created.sha, force: true })
})
console.log(`分支 ${branch} 已强制指向 ${created.sha.slice(0, 7)}`)

// 7) 同步 tag：v<version> 指向本次提交。
// 仓库版本号的出处不同：桌面读 package.json，安卓读 app/build.gradle.kts 的 versionName。
const readVersion = () => {
  try {
    return JSON.parse(git('cat-file', 'blob', `${head}:package.json`)).version
  } catch {
    const gradle = git('cat-file', 'blob', `${head}:app/build.gradle.kts`)
    const found = gradle.match(/versionName\s*=\s*"([^"]+)"/)
    if (!found) throw new Error('无法确定版本号：package.json 与 app/build.gradle.kts 都未给出')
    return found[1]
  }
}
const tagName = `v${readVersion()}`
try {
  await callApi(`/git/refs/tags/${tagName}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: created.sha, force: true })
  })
  console.log(`标签 ${tagName} 已强制指向 ${created.sha.slice(0, 7)}`)
} catch (err) {
  // tag 不存在时 PATCH 会 422，改为新建
  await callApi('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: created.sha })
  })
  console.log(`标签 ${tagName} 已创建 → ${created.sha.slice(0, 7)}`)
}

console.log('\n完成。远端提交与本地内容一致（sha 可能不同：作者/时间戳由 API 生成）。')