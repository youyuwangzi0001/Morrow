// 打包产物冒烟：真实启动「文件夹版」或「单文件便携 exe」，验证窗口出现、渲染正常并截图。
//
// 用法：
//   node scripts/smoke-packaged.mjs                # 测单文件便携 exe（deliver/Morrow-<ver>-portable.exe）
//   node scripts/smoke-packaged.mjs --folder       # 测便携文件夹版（deliver/Morrow-<ver>-portable/Morrow.exe）★推荐
//   node scripts/smoke-packaged.mjs --all          # 两种都测（最终验收用）
//   node scripts/smoke-packaged.mjs --exe=<path>   # 指定任意 exe（例如 C:/Temp 下的解压副本）
//
// 本机环境要点：
// - 受限令牌下启动：必须 --no-sandbox；Chromium user-data-dir 与 Morrow data-dir 放项目 tmp/；
// - 单文件版是自研启动器：首次把内嵌 zip 解压到 exe 同级 .morrow-runtime-<ver>，不依赖 %TEMP%；
//   冒烟仍把 TEMP/TMP 指到项目 tmp/，用来模拟受限宿主并记录 tempMode；
// - 文件夹版没有自解压步骤，默认**继承宿主 TEMP**启动（证明不依赖 TEMP），可用 --redirect-temp 强制定向；
// - Playwright 的 _electron.launch 直连 Electron 主进程，穿过自研启动器不稳定；统一用
//   「--remote-debugging-port + chromium.connectOverCDP」连接，对两种形态都成立。
//
// 证据（docs/verification/）：
//   screens/packaged-smoke.png         + smoke-packaged.json          单文件
//   screens/packaged-folder-smoke.png  + smoke-packaged-folder.json   文件夹版
//
// 文件夹版冒烟还会额外验证 portable.marker 行为：不带 --data-dir 启动一次 → 数据目录应出现在
// exe 同级 `Morrow Data/`，验证后立即删除（不污染交付文件夹与 zip）。
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const screensDir = join(root, 'docs', 'verification', 'screens')
const logsDir = join(root, 'docs', 'verification', 'logs')
mkdirSync(screensDir, { recursive: true })
mkdirSync(logsDir, { recursive: true })

const argv = process.argv.slice(2)
const getArg = (key, fallback) => {
  const found = argv.find((a) => a.startsWith(`--${key}=`))
  return found ? found.slice(key.length + 3) : fallback
}
const mode = argv.includes('--folder') ? 'folder' : argv.includes('--all') ? 'all' : 'portable'
const skipCleanup = argv.includes('--keep-tmp')
const forceTempRedirect = argv.includes('--redirect-temp') || process.env.MORROW_SMOKE_REDIRECT_TEMP === '1'

function relative(path) {
  return path.replace(root + '\\', '').replace(root + '/', '').replace(/\\/g, '/')
}

function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePromise(port))
    })
    server.on('error', reject)
  })
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function taskkill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程可能已退出
  }
}

/** 等 CDP 端口就绪；若应用启动即退出（如首次解压失败）会尽快失败并带上退出码。 */
async function waitForCdp(port, child, log, timeoutMs = 90_000) {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return { readyMs: Date.now() - started, version: await res.json() }
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
    const exit = child.__exitInfo
    if (exit) throw new Error(`应用在 CDP 就绪前退出（code=${exit.code}, signal=${exit.signal}）`)
    if (!processAlive(child.pid)) throw new Error('应用进程在 CDP 就绪前结束')
    await delay(400)
  }
  throw new Error(`等待 CDP 端口超时（${timeoutMs}ms，最后错误：${lastError}）`)
}

/** 等出现真正的应用窗口（file:// 加载的页面），返回 { browser, page }。 */
async function connectToApp(port) {
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('file://')) return { browser, page }
      }
    }
    await browser.close().catch(() => {})
    await delay(500)
  }
  throw new Error('CDP 已连接，但 60s 内没有出现应用窗口')
}

/**
 * 验证文件夹版 `portable.marker`：不带 --data-dir 启动 → 数据目录应落在 exe 同级 `Morrow Data/`。
 * 验证后清理该目录，避免污染交付文件夹（zip 在冒烟前已生成，不受影响）。
 */
async function verifyPortableMarker(folderExe, log) {
  const folderDir = dirname(folderExe)
  const markerPath = join(folderDir, 'portable.marker')
  const expectedDataDir = join(folderDir, 'Morrow Data')
  const markerPresent = existsSync(markerPath)
  if (!markerPresent) throw new Error(`文件夹版缺少 portable.marker：${markerPath}`)
  const markerSize = statSync(markerPath).size
  if (markerSize !== 0) throw new Error(`portable.marker 应为空文件，实际 ${markerSize} 字节`)

  const stamp = Date.now()
  const chromiumDir = join(root, 'tmp', `chromium-marker-${stamp}`)
  mkdirSync(chromiumDir, { recursive: true })
  const port = await freePort()
  let child
  let markerDataDirCreated = false
  let entries = []
  try {
    log(`[marker] 验证 portable.marker：不带 --data-dir 启动 → 期望数据目录 ${relative(expectedDataDir)}`)
    child = spawn(folderExe, ['--no-sandbox', `--user-data-dir=${chromiumDir}`, '--test-mode', `--remote-debugging-port=${port}`], {
      cwd: root,
      env: electronEnv({ MORROW_TEST: '1', MORROW_STUDIO_NO_DEMO: '1', MORROW_SKIP_DESKTOP_SHORTCUT: '1' }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => appendFileSync(join(root, 'docs', 'verification', 'logs', 'smoke-packaged-folder.log'), `[marker:out] ${chunk}`))
    child.stderr.on('data', (chunk) => appendFileSync(join(root, 'docs', 'verification', 'logs', 'smoke-packaged-folder.log'), `[marker:err] ${chunk}`))
    child.on('exit', (code, signal) => {
      child.__exitInfo = { code, signal }
    })
    await waitForCdp(port, child, log, 60_000)
    // 等数据目录落盘（主进程在 app ready 时解析并创建）
    const waitStarted = Date.now()
    while (Date.now() - waitStarted < 10_000) {
      if (existsSync(expectedDataDir)) {
        markerDataDirCreated = true
        break
      }
      if (child.__exitInfo) break
      await delay(250)
    }
    if (markerDataDirCreated) {
      const listing = execFileSync('cmd', ['/c', 'dir', '/b', expectedDataDir], { encoding: 'utf8', timeout: 5000 })
      entries = listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 10)
    }
    if (!markerDataDirCreated) throw new Error(`portable.marker 生效失败：未创建 ${expectedDataDir}`)
    log(`[marker] 通过：数据目录已创建于 exe 同级，含 ${entries.length} 个条目（示例：${entries.slice(0, 4).join(', ')}）`)
    return {
      verified: true,
      markerPath: relative(markerPath),
      markerSize,
      dataDir: relative(expectedDataDir),
      dataDirCreated: true,
      entriesSample: entries,
      note: '验证后已清理该目录，交付文件夹/ zip 未被污染'
    }
  } finally {
    if (child && !child.__exitInfo) {
      taskkill(child.pid)
      await delay(1200)
    }
    // 清理 exe 同级的测试数据目录（不污染交付物）
    try {
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', expectedDataDir], { stdio: 'ignore' })
    } catch {
      // 不存在/占用时忽略
    }
    await delay(400)
    if (existsSync(expectedDataDir)) {
      log(`[marker] 警告：清理 ${relative(expectedDataDir)} 失败，请手工删除后再交付`)
    } else {
      log('[marker] 已清理 exe 同级测试数据目录')
    }
  }
}

/**
 * 跑一种形态的冒烟。
 * @param {'portable'|'folder'} kind
 */
async function runSmoke(kind) {
  const isFolder = kind === 'folder'
  const stamp = Date.now()
  const startedAt = Date.now()
  const defaultExe = isFolder
    ? join(root, 'deliver', `Morrow-${pkg.version}-portable`, 'Morrow.exe')
    : join(root, 'deliver', `Morrow-${pkg.version}-portable.exe`)
  const exe = resolve(getArg('exe', defaultExe))
  const screenshotName = isFolder ? 'packaged-folder-smoke.png' : 'packaged-smoke.png'
  const summaryName = getArg('summary', isFolder ? 'smoke-packaged-folder.json' : 'smoke-packaged.json')
  const summaryPath = join(root, 'docs', 'verification', summaryName)
  const logPath = join(logsDir, `smoke-packaged-${kind}.log`)
  writeFileSync(logPath, '')
  const log = (message) => {
    const line = `[smoke:${kind}] ${message}`
    console.log(line)
    appendFileSync(logPath, line + '\n')
  }

  const tmpBase = join(root, 'tmp')
  const chromiumDir = join(tmpBase, `chromium-packaged-${kind}-${stamp}`)
  const dataDir = join(tmpBase, `data-packaged-${kind}-${stamp}`)
  // 文件夹版默认继承宿主 TEMP（证明无自解压依赖）；单文件必须重定向 TEMP 才能在受限宿主启动
  const tempMode = isFolder && !forceTempRedirect ? 'host-inherit' : 'workspace-redirect'
  const tempDir = join(tmpBase, `${kind}-temp-${stamp}`)
  mkdirSync(chromiumDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  if (tempMode === 'workspace-redirect') mkdirSync(tempDir, { recursive: true })

  const result = {
    ok: false,
    kind,
    mode: kind === 'folder' ? 'folder' : 'portable',
    exe: relative(exe),
    tempMode,
    startedAt: new Date(startedAt).toISOString(),
    log: relative(logPath),
    screenshot: relative(join(screensDir, screenshotName))
  }

  if (!existsSync(exe)) {
    result.error = `未找到打包产物 ${exe}。请先运行 npm run dist`
    writeFileSync(summaryPath, JSON.stringify(result, null, 2))
    log(`失败：${result.error}`)
    return result
  }

  const exeStat = statSync(exe)
  const exeSha = createHash('sha256').update(readFileSync(exe)).digest('hex')
  result.exeSizeBytes = exeStat.size
  result.exeSizeMB = Number((exeStat.size / 1024 / 1024).toFixed(2))
  result.exeSha256 = exeSha
  log(`exe: ${relative(exe)} · ${result.exeSizeMB} MB · sha256=${exeSha.slice(0, 16)}… · tempMode=${tempMode}`)

  let child
  let browser
  try {
    const port = await freePort()
    const args = [
      '--no-sandbox',
      `--user-data-dir=${chromiumDir}`,
      `--data-dir=${dataDir}`,
      '--test-mode',
      `--remote-debugging-port=${port}`
    ]
    const extraEnv = { MORROW_TEST: '1', MORROW_STUDIO_NO_DEMO: '1' }
    if (tempMode === 'workspace-redirect') {
      // 启动器的临时文件/首次解压指到工作区内（受限令牌可写）
      extraEnv.TEMP = tempDir
      extraEnv.TMP = tempDir
      extraEnv.TMPDIR = tempDir
    }
    log(`启动：spawn ${relative(exe)} ${args.join(' ')}`)
    child = spawn(exe, args, { cwd: root, env: electronEnv({ MORROW_SKIP_DESKTOP_SHORTCUT: '1', ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => appendFileSync(logPath, `[app:out] ${chunk}`))
    child.stderr.on('data', (chunk) => appendFileSync(logPath, `[app:err] ${chunk}`))
    child.on('exit', (code, signal) => {
      child.__exitInfo = { code, signal }
    })
    log(`进程 PID=${child.pid}`)

    // 1) 等 CDP 就绪
    const cdp = await waitForCdp(port, child, log)
    result.cdpReadyMs = cdp.readyMs
    log(`CDP 就绪：${cdp.version?.Browser ?? 'unknown'}（端口 ${port}，${cdp.readyMs}ms）`)

    // 2) 连接应用窗口
    const connected = await connectToApp(port)
    browser = connected.browser
    const page = connected.page
    await page.waitForLoadState('domcontentloaded')
    result.windowUrl = page.url()
    log(`窗口 URL：${page.url()}`)

    // 3) 判断运行位置：文件夹版应在 deliver/<folder>/ 原地运行；单文件应发生在 .morrow-runtime-<ver>
    const folderPathFragment = `/${relative(dirname(exe)).replace(/\\/g, '/')}/`
    result.runsFromExtractedTemp = !page.url().includes(folderPathFragment.replace(/\//g, '/'))
    if (isFolder) {
      if (!page.url().includes(folderPathFragment.replace(/\//g, '/'))) {
        throw new Error(`文件夹版未在交付目录原地运行：${page.url()}`)
      }
      log('运行位置校验：文件夹版在交付目录原地运行（无自解压）✓')
    } else if (result.runsFromExtractedTemp) {
      log('运行位置：单文件 exe 已解压到 .morrow-runtime-<ver> 运行（符合预期）')
    }

    // 4) 关掉首次引导层（--test-mode 下 store 可用），让截图展示主界面
    const onboardingDismissed = await page
      .evaluate(async () => {
        const scope = window
        if (!scope.__morrowStore) return false
        try {
          await scope.__morrowStore.getState().updateSettings({ onboardingDone: true })
        } catch {
          // 忽略：设置写入失败不影响截图
        }
        scope.__morrowStore.setState({ onboardingOpen: false })
        return true
      })
      .catch(() => false)
    result.onboardingDismissed = onboardingDismissed
    log(`首次引导层：${onboardingDismissed ? '已关闭（test-mode store）' : '未检测到 store，保持原样'}`)
    await page.waitForTimeout(600)

    // 5) 断言：窗口/标题/预加载/渲染
    const info = await page.evaluate(() => ({
      title: document.title,
      bodyText: (document.body.innerText || '').trim().slice(0, 160),
      hasMorrowApi: typeof window.morrow === 'object' && window.morrow !== null,
      hasTitlebarWordmark: Boolean(document.querySelector('.tb-wordmark')),
      userAgent: navigator.userAgent
    }))
    if (!/Electron/.test(info.userAgent)) throw new Error(`不是 Electron 渲染进程：${info.userAgent}`)
    if (!info.hasMorrowApi) throw new Error('预加载 API window.morrow 未注入')
    if (info.bodyText.length === 0) throw new Error('首屏渲染为空（白屏）')
    if (info.hasTitlebarWordmark) throw new Error('顶栏不应再显示 Morrow 字样（品牌只保留在关于页）')
    result.electronVersion = (info.userAgent.match(/Electron\/([\d.]+)/) || [])[1] ?? null
    result.windowTitle = info.title
    result.bodyTextPreview = info.bodyText
    log(`标题：${info.title}`)
    log(`首屏文本：${info.bodyText.replace(/\n+/g, ' / ')}`)
    log(`预加载 API 正常，渲染正常`)

    result.dataDir = relative(dataDir)
    result.dataDirCreated = existsSync(dataDir)
    log(`数据目录：${relative(dataDir)}（${result.dataDirCreated ? '已创建' : '不存在'}）`)

    // 6) 截图
    const shotPath = join(screensDir, screenshotName)
    await page.screenshot({ path: shotPath })
    log(`截图：${relative(shotPath)}`)

    result.ok = true
    result.durationMs = Date.now() - startedAt
    result.finishedAt = new Date().toISOString()
    log(`通过：${result.exeSizeMB} MB 的打包产物启动、渲染、截图完成（总耗时 ${(result.durationMs / 1000).toFixed(1)}s）`)
  } catch (err) {
    result.error = String(err?.message ?? err)
    result.durationMs = Date.now() - startedAt
    result.finishedAt = new Date().toISOString()
    log(`失败：${err?.stack ?? err}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (child && !child.__exitInfo) {
      log('清理：taskkill 结束应用进程树')
      taskkill(child.pid)
      await delay(1500)
    }
    if (!skipCleanup && tempMode === 'workspace-redirect') {
      try {
        execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', tempDir], { stdio: 'ignore' })
      } catch {
        // 忽略
      }
    }
  }

  // 文件夹版额外验证 portable.marker（不污染交付目录）；失败则整体记为失败
  if (isFolder && result.ok) {
    try {
      result.portableMarker = await verifyPortableMarker(exe, log)
    } catch (err) {
      result.ok = false
      result.markerError = String(err?.message ?? err)
      log(`[marker] 失败：${result.markerError}`)
    }
  }

  writeFileSync(summaryPath, JSON.stringify(result, null, 2))
  log(`摘要：${relative(summaryPath)}`)
  return result
}

const kinds = mode === 'all' ? ['portable', 'folder'] : [mode]
const results = []
for (const kind of kinds) results.push(await runSmoke(kind))
const ok = results.length > 0 && results.every((result) => result.ok)
console.log(
  `\n[smoke] 汇总：${results.map((result) => `${result.kind}=${result.ok ? '通过' : '失败'}`).join(' · ')}`
)
process.exit(ok ? 0 : 1)
