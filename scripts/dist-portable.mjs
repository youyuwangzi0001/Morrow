// Morrow 打包脚本（electron-builder 封装）—— 三种交付形态 + 签名 + 干净交付 + 证据摘要
//
// 用法：
//   node scripts/dist-portable.mjs             # 默认 = --all：文件夹版 + zip + 单文件 exe（最终交付用）
//   node scripts/dist-portable.mjs --folder    # 只做「便携文件夹」+ zip（推荐交付形态，无自解压）
//   node scripts/dist-portable.mjs --portable  # 只做单文件 portable exe（依赖 %TEMP%，受限宿主可能失败）
//   node scripts/dist-portable.mjs --dir       # 只做 tmp/electron-builder-output/win-unpacked（最快，自检/调试用）
//
// 产物（release/ 为构建中间目录；默认 npm run dist 仅交付单文件 exe + 使用说明 + SHA256SUMS + LICENSE；--folder/--all 为内部构建检查）：
//   release/Morrow-<ver>-portable/Morrow.exe   便携文件夹（推荐：双击即用、不解压、不依赖 %TEMP%）
//   release/Morrow-<ver>-portable-win64.zip    上方文件夹的 zip（分发用）
//   release/Morrow-<ver>-portable.exe          单文件便携 exe（自研启动器：内嵌 zip，首次解压到 exe 同级缓存，不依赖 %TEMP%）
//
// 为什么主推文件夹版：electron-builder 的便携单文件是 NSIS 自解压外壳，启动时
//   把 ~200MB 应用解压到 %TEMP%\<nsis随机>.tmp 再执行（见 app-builder-lib/templates/nsis/portable.nsi：
//   StrCpy $INSTDIR "$PLUGINSDIR\app"），因此 **%TEMP% 不可写/不存在/已满时必然报
//   「Error writing temporary file. Make sure your temp folder is valid.」**。
//   文件夹版直接运行 Morrow.exe，没有自解压步骤，不依赖 %TEMP%，是更稳的交付形态。
//
// 代码签名（可选，未配置时产物标记 signed:false，不阻断打包）：
//   MORROW_SIGN_PFX + MORROW_SIGN_PFX_PASSWORD    # .pfx 文件 + 密码
//   MORROW_SIGN_THUMBPRINT                        # CurrentUser\My 中证书指纹
//   MORROW_SIGN_SUBJECT                           # CurrentUser\My 中证书主题
//   MORROW_SIGN_AUTO=1                            # 仅当恰好一张可信、未过期、带私钥的代码签名证书时自动使用
//   MORROW_SIGN_TIMESTAMP_URL                     # 默认 http://timestamp.digicert.com
//   签名顺序：Morrow-app.exe → 文件夹版 Morrow.exe → 单文件 exe；signtool SHA-256 + RFC3161 时间戳，
//   签名后同时用 signtool verify 与 PowerShell Get-AuthenticodeSignature 校验，任一失败即打包失败。
//   注意：签名只能解决“发布者未知/信誉不足”的一部分问题；SmartScreen 仍需证书受信任并积累信誉。
//
// 环境：自动设置 npmmirror 镜像、把 Electron 下载缓存指到项目 tmp/、清 ELECTRON_RUN_AS_NODE
//      （DSH 受限会话的既有做法）；输出全程写 docs/verification/logs/，摘要写 packaging.json。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const args = process.argv.slice(2)
const mode = args.includes('--folder')
  ? 'folder'
  : args.includes('--portable')
    ? 'portable'
    : args.includes('--dir')
      ? 'dir'
      : 'all'

const releaseDir = process.env.MORROW_RELEASE_DIR
  ? resolve(root, process.env.MORROW_RELEASE_DIR)
  : join(root, 'release')
const deliverDir = process.env.MORROW_DELIVER_DIR
  ? resolve(root, process.env.MORROW_DELIVER_DIR)
  : join(root, 'deliver')
const folderName = `Morrow-${version}-portable`
// 运行时缓存目录随版本变化；同版本重建由内嵌 zip 的 SHA-256 戳记负责替换旧缓存。
const runtimeRevision = process.env.MORROW_RUNTIME_REVISION || `r${version.replace(/\D/g, '')}`
const runtimeFolderName = `.morrow-runtime-${version}-${runtimeRevision}`
const folderDir = join(releaseDir, folderName)
const zipPath = join(releaseDir, `${folderName}-win64.zip`)
const portableExe = join(releaseDir, `${folderName}.exe`)
let installerExe = join(releaseDir, `Morrow-${version}-setup.exe`)
const usageFileName = '使用说明.txt'
const sha256SumsFileName = 'SHA256SUMS.txt'
// 中间解包目录放到 tmp：避免 release/win-unpacked 被索引/杀毒占用后卡死下一次打包
const builderOutputDir = process.env.MORROW_BUILDER_OUTPUT
  ? resolve(root, process.env.MORROW_BUILDER_OUTPUT)
  : join(root, 'tmp', 'electron-builder-output')
const electronDistArgs = process.env.MORROW_ELECTRON_DIST
  ? [`-c.electronDist=${process.env.MORROW_ELECTRON_DIST}`]
  : []
const winUnpacked = join(builderOutputDir, 'win-unpacked')
const legacyWinUnpacked = join(releaseDir, 'win-unpacked')
const logsDir = join(root, 'docs', 'verification', 'logs')
mkdirSync(logsDir, { recursive: true })
mkdirSync(releaseDir, { recursive: true })

// 保留 Windows 原生反斜杠：7za 的启动路径含中文/空格时，正斜杠形式会被 spawn 当作 ENOENT。
const sevenZip = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

/** 签名配置；在主流程 try 内通过 resolveSigningConfig() 赋值。 */
let signing = { enabled: false, method: 'none', reason: '签名配置尚未解析', timestampUrl: '', signtool: null }

function log(message) {
  const line = `[dist] ${message}`
  console.log(line)
}

function fail(message) {
  console.error(`[dist] 失败：${message}`)
  process.exitCode = 1
  throw new Error(message)
}

// ── 代码签名 ─────────────────────────────────────────────────────────
/** 查找 signtool.exe：显式 MORROW_SIGNTOOL → Windows Kits 最新版本 → PATH。 */
function findSigntool() {
  const explicit = process.env.MORROW_SIGNTOOL
  if (explicit) {
    if (!existsSync(explicit)) fail(`MORROW_SIGNTOOL 指向的文件不存在：${explicit}`)
    return explicit
  }
  const kitsBin = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  if (existsSync(kitsBin)) {
    const versions = readdirSync(kitsBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        const pa = a.split('.').map((part) => Number(part) || 0)
        const pb = b.split('.').map((part) => Number(part) || 0)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const diff = (pb[i] || 0) - (pa[i] || 0)
          if (diff !== 0) return diff
        }
        return 0
      })
    for (const version of versions) {
      const candidate = join(kitsBin, version, 'x64', 'signtool.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  const where = spawnSync('where.exe', ['signtool.exe'], { encoding: 'utf8' })
  if (where.status === 0) {
    const first = where.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && existsSync(line))
    if (first) return first
  }
  return null
}

/** 读取 Authenticode 状态（PowerShell，路径通过环境变量传入，避免中文/引号转义问题）。 */
function readAuthenticode(file) {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    '$s = Get-AuthenticodeSignature -LiteralPath $env:MORROW_SIGN_CHECK_PATH',
    '$cert = $s.SignerCertificate',
    '$ts = $s.TimeStamperCertificate',
    '$subject = $null; if ($cert) { $subject = $cert.Subject }',
    '$thumbprint = $null; if ($cert) { $thumbprint = $cert.Thumbprint }',
    '$notAfter = $null; if ($cert) { $notAfter = $cert.NotAfter.ToString("o") }',
    '$tsSubject = $null; if ($ts) { $tsSubject = $ts.Subject }',
    '$tsTime = $null; if ($ts) { $tsTime = $ts.NotBefore.ToString("o") }',
    '[pscustomobject]@{',
    '  status = [string]$s.Status',
    '  statusMessage = [string]$s.StatusMessage',
    '  subject = $subject',
    '  thumbprint = $thumbprint',
    '  notAfter = $notAfter',
    '  timestampSubject = $tsSubject',
    '  timestampTime = $tsTime',
    '} | ConvertTo-Json -Compress'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, MORROW_SIGN_CHECK_PATH: file },
    timeout: 60_000
  })
  const text = `${result.stdout || ''}`.replace(/^\uFEFF/, '').trim()
  if (result.status !== 0 || !text) {
    return {
      status: 'Unknown',
      statusMessage: `${result.stderr || result.stdout || 'PowerShell 读取签名失败'}`.trim().slice(0, 500)
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { status: 'Unknown', statusMessage: `无法解析签名状态：${text.slice(0, 300)}` }
  }
}

/** 自动检测“安全”的代码签名证书：CurrentUser\My、有私钥、未过期、链可信，且必须恰好一张。 */
function autoDetectSigningCerts() {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$certs = @(Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) })',
    '$trusted = @()',
    'foreach ($c in $certs) {',
    '  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain',
    '  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck',
    '  if ($chain.Build($c)) { $trusted += $c }',
    '}',
    '$trusted | ForEach-Object { [pscustomobject]@{ thumbprint = $_.Thumbprint; subject = $_.Subject; notAfter = $_.NotAfter.ToString("o") } } | ConvertTo-Json -Compress'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (result.status !== 0) return []
  const text = `${result.stdout || ''}`.replace(/^\uFEFF/, '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** 解析签名配置；未配置证书时返回 enabled:false（打包继续，产物记录 signed:false）。 */
function resolveSigningConfig() {
  const timestampUrl = process.env.MORROW_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com'
  const signtool = findSigntool()
  const base = { signtool, timestampUrl }
  const pfx = process.env.MORROW_SIGN_PFX
  const thumbprint = process.env.MORROW_SIGN_THUMBPRINT
  const subject = process.env.MORROW_SIGN_SUBJECT
  if (pfx) {
    const pfxPath = resolve(root, pfx)
    if (!existsSync(pfxPath)) fail(`MORROW_SIGN_PFX 指向的文件不存在：${pfxPath}`)
    if (!signtool) fail('已配置 MORROW_SIGN_PFX，但找不到 signtool.exe。请安装 Windows SDK 或设置 MORROW_SIGNTOOL。')
    return {
      ...base,
      enabled: true,
      method: 'pfx',
      pfxPath,
      pfxPassword: process.env.MORROW_SIGN_PFX_PASSWORD || '',
      description: 'MORROW_SIGN_PFX'
    }
  }
  if (thumbprint) {
    if (!signtool) fail('已配置 MORROW_SIGN_THUMBPRINT，但找不到 signtool.exe。请安装 Windows SDK 或设置 MORROW_SIGNTOOL。')
    return {
      ...base,
      enabled: true,
      method: 'thumbprint',
      thumbprint: thumbprint.replace(/\s+/g, ''),
      store: 'My',
      description: 'MORROW_SIGN_THUMBPRINT'
    }
  }
  if (subject) {
    if (!signtool) fail('已配置 MORROW_SIGN_SUBJECT，但找不到 signtool.exe。请安装 Windows SDK 或设置 MORROW_SIGNTOOL。')
    return {
      ...base,
      enabled: true,
      method: 'subject',
      subject,
      store: 'My',
      description: 'MORROW_SIGN_SUBJECT'
    }
  }
  if (process.env.MORROW_SIGN_AUTO === '1') {
    const certs = autoDetectSigningCerts()
    if (certs.length === 1) {
      if (!signtool) fail('MORROW_SIGN_AUTO=1 检测到证书，但找不到 signtool.exe。请安装 Windows SDK 或设置 MORROW_SIGNTOOL。')
      return {
        ...base,
        enabled: true,
        method: 'auto',
        thumbprint: certs[0].thumbprint,
        store: 'My',
        description: 'MORROW_SIGN_AUTO=1'
      }
    }
    return {
      ...base,
      enabled: false,
      method: 'auto',
      reason:
        certs.length === 0
          ? 'MORROW_SIGN_AUTO=1，但 CurrentUser\\My 中没有带私钥、未过期且链可信的代码签名证书'
          : `MORROW_SIGN_AUTO=1，但检测到 ${certs.length} 张可信代码签名证书；为避免签错证书，请显式设置 MORROW_SIGN_THUMBPRINT`
    }
  }
  return {
    ...base,
    enabled: false,
    method: 'none',
    reason:
      '未配置代码签名证书（MORROW_SIGN_PFX / MORROW_SIGN_THUMBPRINT / MORROW_SIGN_SUBJECT，或 MORROW_SIGN_AUTO=1）；产物保持未签名'
  }
}

/**
 * 对一个 exe 签名并校验。未配置证书时只读取现状（NotSigned），不失败。
 * @returns {{signed:boolean, status:string, statusMessage?:string, subject?:string|null, ...}}
 */
function signFile(file, label) {
  if (!existsSync(file)) fail(`待签名文件不存在：${file}`)
  if (!signing.enabled) {
    const current = readAuthenticode(file)
    logLine(`[sign] ${label}：未配置证书 → ${current.status}（signed:false）`)
    return { signed: false, reason: signing.reason, ...current }
  }
  const certArgs = []
  if (signing.method === 'pfx') {
    certArgs.push('/f', signing.pfxPath)
    if (signing.pfxPassword) certArgs.push('/p', signing.pfxPassword)
  } else if (signing.method === 'thumbprint' || signing.method === 'auto') {
    certArgs.push('/sha1', signing.thumbprint, '/s', signing.store || 'My')
  } else if (signing.method === 'subject') {
    certArgs.push('/n', signing.subject, '/s', signing.store || 'My')
  }
  const args = ['sign', '/fd', 'sha256', '/tr', signing.timestampUrl, '/td', 'sha256', ...certArgs, file]
  const displayArgs = args.map((arg) => (signing.pfxPassword && arg === signing.pfxPassword ? '***' : arg))
  logLine(`[sign] ${label} ← "${signing.signtool}" ${displayArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`)
  const signed = spawnSync(signing.signtool, args, {
    encoding: 'utf8',
    timeout: 5 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (signed.status !== 0) {
    fail(`signtool sign 失败（${label}，exit ${signed.status}）：${`${signed.stdout || ''}${signed.stderr || ''}`.slice(-2000)}`)
  }
  const verified = spawnSync(signing.signtool, ['verify', '/pa', '/v', file], {
    encoding: 'utf8',
    timeout: 2 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const verifyOutput = `${verified.stdout || ''}${verified.stderr || ''}`
  if (verified.status !== 0) {
    fail(`signtool verify 失败（${label}，exit ${verified.status}）：${verifyOutput.slice(-2000)}`)
  }
  const info = readAuthenticode(file)
  if (info.status !== 'Valid') {
    fail(`PowerShell 签名校验未通过（${label}）：${info.status} ${info.statusMessage || ''}`.trim())
  }
  logLine(
    `[sign] ${label} ✓ Valid · ${info.subject || 'unknown signer'}${info.timestampTime ? ` · 时间戳 ${info.timestampTime}` : ' · 无时间戳'}`
  )
  if (!signing.certificate) {
    signing.certificate = {
      subject: info.subject,
      thumbprint: info.thumbprint,
      notAfter: info.notAfter
    }
  }
  return { signed: true, ...info }
}

function signatureSummary(sig) {
  return {
    signed: Boolean(sig?.signed && sig?.status === 'Valid'),
    status: sig?.status ?? 'Unknown',
    statusMessage: sig?.statusMessage ?? undefined,
    signerSubject: sig?.subject ?? null,
    signerThumbprint: sig?.thumbprint ?? null,
    signerNotAfter: sig?.notAfter ?? null,
    timestampSubject: sig?.timestampSubject ?? null,
    timestampTime: sig?.timestampTime ?? null
  }
}


// ── 前置检查 ─────────────────────────────────────────────────────────
const mainOut = join(root, 'out', 'main', 'index.js')
const rendererOut = join(root, 'out', 'renderer', 'index.html')
const iconIco = join(root, 'build', 'icon.ico')
if (!existsSync(mainOut) || !existsSync(rendererOut)) fail('缺少构建产物（out/main/index.js 或 out/renderer/index.html）。请先 npm run build。')
if (!existsSync(iconIco)) fail('缺少 build/icon.ico。图标资产应随源码提交（build/icon.ico）。')
const builderCli = join(root, 'node_modules', 'electron-builder', 'cli.js')
if (!existsSync(builderCli)) fail('未找到 electron-builder（node_modules/electron-builder/cli.js）。请先 npm install。')
if (['folder', 'all'].includes(mode) && !existsSync(sevenZip)) fail(`未找到 7za（zip 压缩需要）：${sevenZip}`)

// ── 环境：镜像 + 缓存/临时目录重定向 ─────────────────────────────────
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
env.npm_config_electron_mirror ||= env.ELECTRON_MIRROR
// DSH 受限会话下默认缓存目录不可写 → 指到项目 tmp/
env.ELECTRON_CACHE ||= join(root, 'tmp', 'electron-cache')
mkdirSync(env.ELECTRON_CACHE, { recursive: true })
// R9：打包缓存统一重定向到项目 tmp/，每次打包前删除，避免历史产物/缓存污染
env.ELECTRON_BUILDER_CACHE ||= join(root, 'tmp', 'electron-builder-cache')
if (env.MORROW_BUILDER_CACHE) env.ELECTRON_BUILDER_CACHE = env.MORROW_BUILDER_CACHE
// Git Bash / 受限宿主常把 TEMP/TMP 指向 /tmp；NSIS 需要真实 Windows 临时目录。
env.TEMP = join(root, 'tmp', 'win-temp')
env.TMP = env.TEMP
mkdirSync(env.TEMP, { recursive: true })

/** 清掉上一次的产物、中间目录、zip 暂存与 electron-builder 打包缓存（保留 release 文档/截图/审计报告）。 */
function cleanPackagingOutputs() {
  const targets = [
    folderDir,
    zipPath,
    // 只打文件夹版时保留现有单文件版（可能正在运行，Windows 不允许删除/覆盖）
    ...(mode === 'folder' ? [] : [portableExe, installerExe]),
    builderOutputDir,
    // 兼容清理旧版脚本留在 release/ 的中间目录（被占用时下面会跳过）
    legacyWinUnpacked,
    join(root, 'tmp', 'launcher-app.zip'),
    join(releaseDir, 'builder-debug.yml')
  ]
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (err) {
      // 杀毒/索引/上一轮进程可能短暂占用；不要因此丢掉已经打好的文件夹版
      logLine(`[dist] 暂时无法清理 ${target}（稍后可手动删除）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (env.ELECTRON_BUILDER_CACHE && process.env.MORROW_KEEP_BUILDER_CACHE !== '1') {
    try {
      rmSync(env.ELECTRON_BUILDER_CACHE, { recursive: true, force: true })
    } catch (err) {
      logLine(`[dist] 暂时无法清理 builder cache：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  logLine('[dist] 已清理历史打包产物与缓存（release 旧版本目录/zip/exe、win-unpacked、launcher zip、electron-builder cache）')
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = join(logsDir, `dist-${mode}-${stamp}.log`)
const latestLogPath = join(logsDir, `dist-${mode}.log`)
writeFileSync(logPath, '')
writeFileSync(latestLogPath, '')
cleanPackagingOutputs()

const startedAt = Date.now()
const startedAtIso = new Date(startedAt).toISOString()

function logLine(line) {
  console.log(line)
  appendFileSync(logPath, line + '\n')
  appendFileSync(latestLogPath, line + '\n')
}

/** 运行 electron-builder 子命令，输出 tee 到控制台 + 日志。返回退出码与耗时。 */
function runBuilder(builderArgs, label) {
  const command = [process.execPath, builderCli, ...builderArgs].join(' ')
  logLine(`[dist] [${label}] ${command}`)
  const stepStarted = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [builderCli, ...builderArgs], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const tee = (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      appendFileSync(logPath, text)
      appendFileSync(latestLogPath, text)
    }
    child.stdout.on('data', tee)
    child.stderr.on('data', tee)
    child.on('error', (err) => {
      logLine(`[dist] [${label}] 无法启动 electron-builder：${err.message}`)
      resolvePromise({ exitCode: 1, durationMs: Date.now() - stepStarted, command })
    })
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1, durationMs: Date.now() - stepStarted, command })
    })
  })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function relPath(path) {
  return path.replace(root + '\\', '').replace(root + '/', '').replace(/\\/g, '/')
}

function deliverRelPath(path) {
  return path.slice(deliverDir.length + 1).replace(/\\/g, '/')
}

function dirSize(dir) {
  let sizeBytes = 0
  let fileCount = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = dirSize(full)
      sizeBytes += sub.sizeBytes
      fileCount += sub.fileCount
      continue
    }
    if (entry.isFile()) {
      sizeBytes += statSync(full).size
      fileCount += 1
    }
  }
  return { sizeBytes, fileCount }
}

/** 把构建目录里的 win-unpacked 整理成 release/Morrow-<ver>-portable/。 */
function organizeFolder() {
  if (!existsSync(winUnpacked)) fail('electron-builder --dir 未产出 win-unpacked（tmp/electron-builder-output）')
  rmSync(folderDir, { recursive: true, force: true })
  // 只复制、不移动：NSIS 安装包还要复用同一份 win-unpacked；移动后被索引/杀毒占用的文件
  // 可能只删掉一半，留下缺少 exe/dll 的目录，安装包会在不报错的情况下缺主程序。
  cpSync(winUnpacked, folderDir, { recursive: true })
  const exe = join(folderDir, 'Morrow.exe')
  if (!existsSync(exe)) fail(`文件夹版缺少 Morrow.exe：${folderDir}`)
  addPortableExtras(folderDir)
  return exe
}

/** 可选启动/快捷方式脚本：用系统自带的 PowerShell 作为宿主，避免资源管理器对未签名 exe 的重复 SmartScreen 检查。
 *  这不是代码签名，也不能保证绕过安全软件；主路径仍是直接双击 Morrow.exe。 */
function writeLaunchScripts(dir, exeName) {
  // 脚本文件名保持 ASCII：PowerShell 5.1 会按 ANSI 读取无 BOM 的中文脚本，路径字面量可能损坏。
  const ps1 = `param([switch]$CreateShortcut)
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$self = $MyInvocation.MyCommand.Path
Get-ChildItem -LiteralPath $root -File | Unblock-File
$exe = Join-Path $root '${exeName}'
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Morrow.lnk'
try {
  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $ps
  $lnk.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $self + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $exe + ',0'
  $lnk.Description = 'Morrow'
  $lnk.WindowStyle = 7
  $lnk.Save()
} catch { }
if ($CreateShortcut) { if (Test-Path -LiteralPath $lnkPath) { exit 0 } else { exit 1 } }
if (-not (Test-Path -LiteralPath $exe)) { exit 1 }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
[void][System.Diagnostics.Process]::Start($psi)
`
  writeFileSync(join(dir, 'morrow-launch.ps1'), ps1, 'utf8')
  const launchCmd = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0morrow-launch.ps1"',
    ''
  ].join('\r\n')
  writeFileSync(join(dir, '启动 Morrow.cmd'), launchCmd, 'utf8')
  const shortcutCmd = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0morrow-launch.ps1" -CreateShortcut',
    'if errorlevel 1 (echo 创建失败，请检查桌面权限) else (echo 完成：桌面已创建 Morrow 图标。这只是启动方式，不是代码签名；安全软件仍可能拦截。)',
    'pause',
    ''
  ].join('\r\n')
  writeFileSync(join(dir, '创建桌面快捷方式.cmd'), shortcutCmd, 'utf8')
}

/** 交付/文件夹内的短说明（UTF-8 BOM + CRLF，Windows 记事本/写字板可直接打开）。 */
function buildUsageText(_singleOnly = false) {
  const withInstaller = existsSync(installerExe)
  const signed = signing.enabled && signing.certificate
  const signatureLine = signed
    ? `- 已签名：${signing.certificate.subject || '代码签名证书'}${signing.certificate.thumbprint ? `（${signing.certificate.thumbprint.slice(0, 12)}…）` : ''}。SmartScreen 仍可能需要下载信誉。`
    : '- 当前版本未配置代码签名证书，产物未签名；首次运行可能触发 SmartScreen。'
  const smartScreenLine = signed
    ? '3. 已签名，但 Windows 仍可能在积累下载信誉前提示；点「更多信息」→「仍要运行」。'
    : '3. 如果 Windows 弹出「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」；这是未签名提示，不是病毒提示。'
  return [
    `Morrow ${version} · Windows 10/11 x64（便携版 + 安装包）`,
    '================================================',
    '',
    '本次交付文件',
    `- ${folderName}.exe：单文件便携版`,
    ...(withInstaller ? [`- Morrow-${version}-setup.exe：安装包（推荐日常使用）`] : []),
    '',
    '本版重点',
    '- 权限卡、订阅详情与终端/浏览器/画布/Git/项目/Office 页签统一为顶层 UI 令牌；页签统一 24px 高、5px 微圆角。',
    '- 应用字号 12–15（默认 14），代码字号 11–14（默认 12）；代码字体默认 JetBrains Mono。',
    '- 本机/局域网模型服务可留空 API Key；多媒体「添加本机模型」支持 llama.cpp、Ollama、LM Studio 与 ComfyUI API 工作流。',
    '- 修复 ChatGPT 订阅工具参数丢失、登录端口复用、灵动岛跟随当前会话、审看媒体优先当前模型视觉四个断点。',
    '- 修复订阅登录等待时无法再次拉起浏览器，以及多轮对话中 assistant 历史内容被上游 400 拒绝的问题。',
    '- 为保护第三方凭据，本构建未内置 Antigravity OAuth secret；使用该订阅时请先设置 MORROW_ANTIGRAVITY_CLIENT_SECRET。',
    '- 扁平化：13 个单元套件 / 942 用例，17 个 E2E 套件 / 206 用例；源码与构建脚本已在 GitHub 开源。',
    '',
    '安装包（推荐）',
    ...(withInstaller ? [
      `1. 如果 Morrow-${version}-setup.exe 是从浏览器或聊天工具下载的，先右键 exe → 属性 → 勾选“解除锁定” → 确定。`,
      '2. 双击安装包，选择安装目录；默认按当前用户安装，并创建开始菜单/桌面快捷方式。',
      '3. 安装版数据默认保存在 %APPDATA%\\Morrow，可在「设置 → 关于」更改数据目录（会重启，可迁移现有数据）。',
      '4. 卸载：Windows 设置 → 应用 → Morrow → 卸载；用户数据默认保留，可在卸载后手动清理。'
    ] : ['- 本次未生成安装包，请使用便携版。']),
    '',
    '单文件便携版',
    `1. 如果 ${folderName}.exe 是从浏览器或聊天工具下载的，先右键 exe → 属性 → 勾选“解除锁定” → 确定，再双击。`,
    `2. 首次会在 exe 同级解压 ${runtimeFolderName}（约 5–10 秒，带进度小窗），之后启动更快。`,
    smartScreenLine,
    '4. 便携版数据默认保存在 exe 同级的 “Morrow Data” 文件夹；可在「设置 → 关于」更改数据目录。',
    '   交付包不包含任何用户数据、缓存或密钥。',
    `5. 运行后不要删除 ${runtimeFolderName}；删除后下次会重新解压。`,
    '',
    '签名与完整性',
    signatureLine,
    `- SHA-256 见同目录 ${sha256SumsFileName}。`,
    '- Windows 校验：certutil -hashfile <文件名> SHA256；或 PowerShell Get-FileHash <文件名> -Algorithm SHA256。',
    '- 代码签名只能改善“发布者未知”的一部分提示；SmartScreen 仍需要证书受信任并积累下载信誉。'
  ].join('\r\n') + '\r\n'
}

function writeUsageFile(path, singleOnly = false) {
  writeFileSync(path, '\uFEFF' + buildUsageText(singleOnly), 'utf8')
}

/** 交付文件夹里不能有运行时缓存/用户数据；它们是测试或本机使用留下的污染。 */
function cleanFolderRuntimeDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.name === 'Morrow Data') {
      fail(`交付文件夹包含用户数据目录：${full}。请先移走用户数据再打包，绝不能把 Morrow Data 发给别人。`)
    }
    if (entry.name.startsWith('.morrow-runtime-') || entry.name === '.morrow-temp') {
      try {
        rmSync(full, { recursive: true, force: true })
        logLine(`[dist] 已清理交付文件夹内的运行时目录：${entry.name}`)
      } catch (err) {
        fail(`无法清理交付文件夹内的运行时目录 ${full}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

/** 文件夹版附加文件：
 *  - portable.marker：主进程 resolveDataDir() 见到它就数据目录落到 exe 同级 `Morrow Data/`（真正便携）
 *  - 使用说明.txt：首次运行/安全提示/数据位置
 *  - 启动 Morrow.cmd / 创建桌面快捷方式.cmd：可选入口（PowerShell 宿主，减少资源管理器重复拦截）
 */
function addPortableExtras(folderDir) {
  cleanFolderRuntimeDirs(folderDir)
  writeFileSync(join(folderDir, 'portable.marker'), '', 'utf8')
  writeUsageFile(join(folderDir, usageFileName))
  writeLaunchScripts(folderDir, 'Morrow.exe')
  const licenseSrc = join(root, 'LICENSE')
  if (existsSync(licenseSrc)) copyFileSync(licenseSrc, join(folderDir, 'LICENSE'))
}

/** 用 7za 把文件夹压成 zip（zip 内保留文件夹根目录，解压即得同构目录）。 */
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const launcherSrc = join(root, 'build', 'launcher', 'MorrowLauncher.cs')
const launcherManifest = join(root, 'build', 'launcher', 'MorrowLauncher.manifest')
const launcherBuildInfo = join(root, 'tmp', 'launcher-build-info.cs')

/** 版本号只有一个来源（package.json）；启动器源码只读取生成的常量。 */
function writeLauncherBuildInfo() {
  mkdirSync(dirname(launcherBuildInfo), { recursive: true })
  const assemblyVersion = version.includes('.') ? version.split('.').length >= 3 ? version : `${version}.0` : `${version}.0.0`
  writeFileSync(
    launcherBuildInfo,
    `using System.Reflection;
[assembly: AssemblyTitle("Morrow")]
[assembly: AssemblyProduct("Morrow")]
[assembly: AssemblyDescription("Morrow - 住在你电脑里的 AI 工作伙伴")]
[assembly: AssemblyCompany("Morrow Studio")]
[assembly: AssemblyVersion("${assemblyVersion}")]
[assembly: AssemblyFileVersion("${assemblyVersion}")]
[assembly: AssemblyInformationalVersion("${version}")]

internal static class MorrowLauncherBuildInfo
{
    public const string Version = "${version}";
    public const string RuntimeRevision = "${runtimeRevision}";
}
`,
    'utf8'
  )
}

/**
 * 编译 C# 启动器。
 * defineFolder=true：文件夹版启动器（启动同目录 Morrow-app.exe，无需内嵌 zip）
 * resourceZip：单文件版启动器要内嵌的应用 zip
 */
/**
 * 给 exe 打 Medium 完整性标签。
 * 交付目录可能被宿主标成 Low（例如自动化工作区），从那里启动的进程会继承低完整性：
 * COM 激活被拒绝、explorer.exe 以 0xC0000142 退出。exe 自身的 Medium 标签决定进程
 * 完整性上限，覆盖目录继承的 Low 标签后，文件管理器定位与系统程序打开才能正常工作。
 */
function ensureMediumIntegrity(filePath) {
  if (process.platform !== 'win32' || !existsSync(filePath)) return
  const icacls = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
  const result = spawnSync(icacls, [filePath, '/setintegritylevel', 'Medium'], { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`无法设置 Medium 完整性标签（${filePath}）：${(result.stdout || '') + (result.stderr || '')}`)
  }
  logLine(`[dist] 完整性标签 Medium：${relPath(filePath)}`)
}

function compileLauncher(outPath, options = {}) {
  if (!existsSync(cscPath)) fail('缺少 C# 编译器 csc.exe（Windows .NET Framework 4.x）')
  if (!existsSync(launcherSrc)) fail('缺少启动器源码 build/launcher/MorrowLauncher.cs')
  if (!existsSync(launcherManifest)) fail('缺少启动器清单 build/launcher/MorrowLauncher.manifest')
  writeLauncherBuildInfo()
  const args = [
    '-nologo',
    '-target:winexe',
    `-out:${outPath}`,
    `-win32icon:${iconIco}`,
    `-win32manifest:${launcherManifest}`,
    ...(options.defineFolder ? ['-define:FOLDER_MODE'] : []),
    ...(options.resourceZip ? [`-resource:${options.resourceZip},MorrowApp.zip`] : []),
    '-r:System.Core.dll',
    '-r:System.IO.Compression.dll',
    '-r:System.IO.Compression.FileSystem.dll',
    '-r:System.Windows.Forms.dll',
    '-r:System.Drawing.dll',
    launcherSrc,
    launcherBuildInfo
  ]
  const result = spawnSync(cscPath, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`启动器编译失败（${outPath}）：${(result.stdout || '') + (result.stderr || '')}`)
  }
}

/**
 * 把 electron-builder 的 win-unpacked 变成「文件夹版」：
 *   Morrow.exe（Electron）→ Morrow-app.exe；再放一个小的 C# 启动器作为 Morrow.exe。
 * 启动器会追加 --no-sandbox 再启动应用——本机/受限环境下 Chromium 沙箱会在初始化阶段
 * 直接崩溃（0x80000003，双击无窗口、进程秒退），这是为了确保双击一定能打开的兼容取舍。
 */
function prepareUnpackedWithLauncher() {
  const electronExe = join(winUnpacked, 'Morrow.exe')
  const appExe = join(winUnpacked, 'Morrow-app.exe')
  if (!existsSync(appExe)) {
    if (!existsSync(electronExe)) fail('win-unpacked 内缺少 Morrow.exe，无法生成启动器')
    renameSync(electronExe, appExe)
  }
  compileLauncher(join(winUnpacked, 'Morrow.exe'), { defineFolder: true })
  logLine('[dist] 已生成文件夹启动器 Morrow.exe（→ Morrow-app.exe，自动 --no-sandbox）')
}

function zipFolder() {
  rmSync(zipPath, { force: true })
  const zipStarted = Date.now()
  // -mcu=on：zip 内文件名强制 UTF-8（含中文启动脚本名）
  const result = spawnSync(sevenZip, ['a', '-tzip', '-mx=5', '-mcu=on', '-bso0', '-bsp0', zipPath, folderName], {
    cwd: releaseDir,
    env
  })
  const durationMs = Date.now() - zipStarted
  if (result.status !== 0) {
    const out = `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.slice(-2000)
    logLine(`[dist] [zip] 7za 失败 code=${result.status}\n${out}`)
    fail(`zip 压缩失败（7za code=${result.status}）`)
  }
  return { durationMs }
}

/**
 * 把 release/ 里的产物整理到 deliver/：只保留本次三份产物 + 使用说明 + SHA256SUMS + LICENSE。
 * 先清理旧产物（旧的 runtime 缓存、日志、旧包），但保留根目录的 `Morrow Data`——那是用户数据，
 * 不属于分发文件，也不能在“清理交付目录”时被误删。
 */
function stageDelivery() {
  const singleOnly = mode === 'portable' || (!existsSync(folderDir) && !existsSync(zipPath))
  mkdirSync(deliverDir, { recursive: true })
  for (const entry of readdirSync(deliverDir, { withFileTypes: true })) {
    if (entry.name === 'Morrow Data') continue
    try {
      rmSync(join(deliverDir, entry.name), { recursive: true, force: true })
    } catch (err) {
      fail(
        `无法清理旧交付物 deliver/${entry.name}：${err instanceof Error ? err.message : String(err)}\n` +
          '请先完全退出正在运行的 Morrow（包括托盘图标），并关闭正在索引/扫描 deliver 的编辑器、杀毒软件或索引服务，再重新打包。'
      )
    }
  }

  const staged = {
    dir: 'deliver',
    cleaned: true,
    createdAt: new Date().toISOString(),
    folder: null,
    artifacts: [],
    usage: `deliver/${usageFileName}`,
    sha256Sums: `deliver/${sha256SumsFileName}`
  }

  if (!singleOnly && existsSync(folderDir)) {
    cleanFolderRuntimeDirs(folderDir)
    const dest = join(deliverDir, folderName)
    cpSync(folderDir, dest, { recursive: true })
    const stat = dirSize(dest)
    const folderExe = join(dest, 'Morrow.exe')
    const appExe = join(dest, 'Morrow-app.exe')
    const appAsar = join(dest, 'resources', 'app.asar')
    staged.folder = {
      path: `deliver/${folderName}`,
      exePath: `deliver/${folderName}/Morrow.exe`,
      appExePath: `deliver/${folderName}/Morrow-app.exe`,
      sizeBytes: stat.sizeBytes,
      sizeMB: Number((stat.sizeBytes / 1024 / 1024).toFixed(2)),
      fileCount: stat.fileCount,
      exeSizeBytes: statSync(folderExe).size,
      exeSha256: sha256(folderExe),
      appExeSizeBytes: statSync(appExe).size,
      appExeSha256: sha256(appExe),
      appAsarSha256: existsSync(appAsar) ? sha256(appAsar) : null
    }
    staged.artifacts.push({
      name: 'portable-folder',
      path: staged.folder.path,
      sizeBytes: staged.folder.sizeBytes,
      sizeMB: staged.folder.sizeMB,
      fileCount: staged.folder.fileCount
    })
  }

  for (const [name, src] of [
    ['portable-zip', zipPath],
    ['portable-exe', portableExe],
    ['installer', installerExe]
  ]) {
    if (singleOnly && name === 'portable-zip') continue
    if (!existsSync(src)) continue
    const dest = join(deliverDir, src.slice(releaseDir.length + 1))
    cpSync(src, dest)
    staged.artifacts.push({
      name,
      path: relPath(dest),
      sizeBytes: statSync(dest).size,
      sizeMB: Number((statSync(dest).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(dest)
    })
  }

  // 复制到交付目录后再打一次标签：Windows 复制/继承可能把 Low 标签带回来。
  ensureMediumIntegrity(join(deliverDir, `${folderName}.exe`))
  ensureMediumIntegrity(join(deliverDir, `Morrow-${version}-setup.exe`))
  ensureMediumIntegrity(join(deliverDir, folderName, 'Morrow-app.exe'))
  ensureMediumIntegrity(join(deliverDir, folderName, 'Morrow.exe'))

  writeUsageFile(join(deliverDir, usageFileName), singleOnly)
  const licenseSrc = join(root, 'LICENSE')
  if (existsSync(licenseSrc)) copyFileSync(licenseSrc, join(deliverDir, 'LICENSE'))

  const checksumTargets = [
    join(deliverDir, `${folderName}-win64.zip`),
    join(deliverDir, `${folderName}.exe`),
    join(deliverDir, `Morrow-${version}-setup.exe`),
    join(deliverDir, folderName, 'Morrow.exe'),
    join(deliverDir, folderName, 'Morrow-app.exe'),
    join(deliverDir, folderName, 'resources', 'app.asar'),
    join(deliverDir, folderName, 'portable.marker'),
    join(deliverDir, folderName, usageFileName),
    join(deliverDir, folderName, 'LICENSE'),
    join(deliverDir, usageFileName),
    join(deliverDir, 'LICENSE')
  ].filter((path) => existsSync(path))
  const checksumLines = checksumTargets.map((path) => `${sha256(path)}  ${deliverRelPath(path)}`)
  writeFileSync(join(deliverDir, sha256SumsFileName), checksumLines.join('\n') + '\n', 'utf8')
  staged.checksums = checksumTargets.map((path) => ({
    path: deliverRelPath(path),
    sizeBytes: statSync(path).size,
    sha256: sha256(path)
  }))

  const total = dirSize(deliverDir)
  const localDataDir = join(deliverDir, 'Morrow Data')
  const localData = existsSync(localDataDir)
    ? { path: 'deliver/Morrow Data', ...dirSize(localDataDir), preserved: true }
    : null
  // 分发文件不包含本机用户数据；目录总大小用于现场检查，交付统计只算分发文件。
  staged.totalSizeBytes = total.sizeBytes - (localData?.sizeBytes ?? 0)
  staged.totalSizeMB = Number((staged.totalSizeBytes / 1024 / 1024).toFixed(2))
  staged.totalFileCount = total.fileCount - (localData?.fileCount ?? 0)
  staged.localData = localData
  return staged
}

// ── 主流程 ───────────────────────────────────────────────────────────
const artifacts = {}
const steps = []
const summary = {
  ok: false,
  mode,
  version,
  electronVersion: JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  electronBuilderVersion: JSON.parse(readFileSync(join(root, 'node_modules', 'electron-builder', 'package.json'), 'utf8')).version,
  startedAt: startedAtIso,
  mirrors: {
    electron: env.ELECTRON_MIRROR,
    electronBuilderBinaries: env.ELECTRON_BUILDER_BINARIES_MIRROR
  },
  steps,
  artifacts: {},
  logs: { combined: logPath.replace(root + '\\', '').replace(/\\/g, '/') }
}

logLine(`[dist] Morrow ${version} · mode=${mode} · 构建 release/ → 交付 deliver/`)
logLine(`[dist] 镜像：ELECTRON_MIRROR=${env.ELECTRON_MIRROR} · ELECTRON_CACHE=${env.ELECTRON_CACHE}`)

try {
  signing = resolveSigningConfig()
  summary.signing = {
    enabled: signing.enabled,
    method: signing.method,
    description: signing.description || null,
    reason: signing.enabled ? null : signing.reason,
    timestampUrl: signing.timestampUrl,
    signtool: signing.signtool || null,
    certificate: null,
    artifacts: {}
  }
  if (signing.enabled) {
    logLine(`[dist] 代码签名：已启用（${signing.method}）· 时间戳 ${signing.timestampUrl}`)
  } else {
    logLine(`[dist] 代码签名：未启用 → 产物标记 signed:false。原因：${signing.reason}`)
  }

  if (mode === 'dir') {
    steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never', `-c.directories.output=${builderOutputDir}`, ...electronDistArgs], 'dir')) })
  } else if (mode === 'folder' || mode === 'all') {
    steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never', `-c.directories.output=${builderOutputDir}`, ...electronDistArgs], 'dir')) })
    const dirStep = steps[steps.length - 1]
    if (dirStep.exitCode !== 0) fail(`electron-builder --dir 失败（exit ${dirStep.exitCode}）`)
    prepareUnpackedWithLauncher()

    // 先签名应用本体和文件夹启动器，再压缩 zip：这样 zip 里携带的也是已签名 exe。
    const folderAppSig = signFile(join(winUnpacked, 'Morrow-app.exe'), 'Morrow-app.exe')
    const folderLauncherSig = signFile(join(winUnpacked, 'Morrow.exe'), 'Morrow.exe（文件夹版）')
    ensureMediumIntegrity(join(winUnpacked, 'Morrow-app.exe'))
    ensureMediumIntegrity(join(winUnpacked, 'Morrow.exe'))

    const folderExe = organizeFolder()
    ensureMediumIntegrity(join(folderDir, 'Morrow-app.exe'))
    ensureMediumIntegrity(folderExe)
    const folderStat = dirSize(folderDir)
    const folderAppExe = join(folderDir, 'Morrow-app.exe')
    artifacts.portableFolder = {
      kind: 'folder',
      path: relPath(folderDir),
      exePath: relPath(folderExe),
      exeSizeBytes: statSync(folderExe).size,
      exeSha256: sha256(folderExe),
      appExePath: relPath(folderAppExe),
      appExeSizeBytes: statSync(folderAppExe).size,
      appExeSha256: sha256(folderAppExe),
      appAsarSha256: sha256(join(folderDir, 'resources', 'app.asar')),
      sizeBytes: folderStat.sizeBytes,
      sizeMB: Number((folderStat.sizeBytes / 1024 / 1024).toFixed(2)),
      fileCount: folderStat.fileCount,
      extras: ['portable.marker', usageFileName, 'LICENSE', '启动 Morrow.cmd', '创建桌面快捷方式.cmd', 'morrow-launch.ps1'],
      signed: signatureSummary(folderAppSig).signed && signatureSummary(folderLauncherSig).signed,
      signatures: {
        launcher: signatureSummary(folderLauncherSig),
        app: signatureSummary(folderAppSig)
      },
      note:
        '推荐交付形态：Morrow.exe 为轻量启动器（带完整 Win32 manifest，自动 --no-sandbox 后启动 Morrow-app.exe），' +
        '无需解压/不依赖 %TEMP%；含 portable.marker（数据目录跟随 exe）；' +
        '未签名时首次运行仍可能被 SmartScreen 拦截，需「更多信息 → 仍要运行」；配置受信任证书后打包会自动签名。'
    }
    logLine(`[dist] 文件夹版：${artifacts.portableFolder.path} · ${artifacts.portableFolder.sizeMB} MB · ${folderStat.fileCount} files`)
    logLine(`[dist] 文件夹版签名：launcher=${signatureSummary(folderLauncherSig).status} · app=${signatureSummary(folderAppSig).status}`)

    logLine('[dist] 压缩 zip…')
    const zipResult = zipFolder()
    steps.push({ name: 'zip', exitCode: 0, durationMs: zipResult.durationMs })
    artifacts.portableZip = {
      kind: 'zip',
      path: relPath(zipPath),
      sizeBytes: statSync(zipPath).size,
      sizeMB: Number((statSync(zipPath).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(zipPath),
      signed: false,
      signature: null,
      note: 'zip 本身不参与 Authenticode 签名；zip 内 Morrow.exe / Morrow-app.exe 的签名状态见 portableFolder.signatures'
    }
    logLine(`[dist] zip：${artifacts.portableZip.path} · ${artifacts.portableZip.sizeMB} MB · sha256=${artifacts.portableZip.sha256.slice(0, 16)}…`)
  }

  if (mode === 'portable' || mode === 'all') {
    // 单文件便携版：使用仓库内的自研启动器（build/launcher/MorrowLauncher.cs）
    // 把应用打成 zip 内嵌进 exe；首次运行解压到 exe 同级隐藏缓存目录
    // （.morrow-runtime-<ver>），不依赖 %TEMP%；之后直接复用；目录只读时回退 LOCALAPPDATA。
    // 之所以不用 electron-builder 的 NSIS portable：NSIS 自解压把内容写到 %TEMP%，
    // 受限启动环境（%TEMP% 不可写）会直接报 “Error writing temporary file”。
    const appZip = join(root, 'tmp', 'launcher-app.zip').replace(/\\/g, '/')
    const unpackedReady =
      existsSync(join(winUnpacked, 'Morrow-app.exe')) && existsSync(join(winUnpacked, 'resources', 'app.asar'))
    const folderReady = existsSync(join(folderDir, 'Morrow-app.exe'))
    // win-unpacked 被系统索引/杀毒占用且已整理成 folder 时，直接从 folder 打单文件，避免重复解压。
    // 刚跑完 electron-builder 时只有 Morrow.exe，需先补启动器；sourceDir 必须在补完后重新判断，
    // 否则 portable 模式会去 cwd 指向不存在的 folderDir，7za 返回 ENOENT。
    if (!unpackedReady && !folderReady) {
      steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never', `-c.directories.output=${builderOutputDir}`, ...electronDistArgs], 'dir')) })
      if (steps[steps.length - 1].exitCode !== 0) fail('electron-builder dir 失败（单文件启动器需要 win-unpacked）')
      prepareUnpackedWithLauncher()
    }
    const sourceDir = unpackedReady || !folderReady ? winUnpacked : folderDir
    if (sourceDir === winUnpacked) {
      prepareUnpackedWithLauncher()
      // 单文件形态没有单独的文件夹交付物，但内嵌 zip 里的 Morrow-app.exe / Morrow.exe 仍然签名，
      // 避免解压后留下未签名 exe 被安全软件反复扫描。
      signFile(join(winUnpacked, 'Morrow-app.exe'), 'Morrow-app.exe（单文件内嵌）')
      signFile(join(winUnpacked, 'Morrow.exe'), 'Morrow.exe（单文件内嵌，文件夹启动器）')
    }

    const packStarted = Date.now()
    rmSync(appZip, { force: true })
    logLine(`[dist] [portable] 打包 ${sourceDir === folderDir ? '便携文件夹' : 'win-unpacked'} 为内嵌 zip…`)
    const zipArgs = ['a', '-tzip', '-mx=5', appZip, '*']
    // folder 里的 portable.marker 只适用于文件夹版；带进单文件运行时会改变数据目录位置
    if (sourceDir === folderDir) zipArgs.push('-x!portable.marker')
    const zipResult = spawnSync(sevenZip, zipArgs, { cwd: sourceDir, encoding: 'utf8' })
    if (zipResult.status !== 0) fail(`内嵌 zip 打包失败：status=${zipResult.status} error=${zipResult.error?.message ?? ''} stdout=${(zipResult.stdout || '').slice(-300)} stderr=${(zipResult.stderr || '').slice(-300)}`)
    logLine(`[dist] [portable] 内嵌 zip ${(statSync(appZip).size / 1024 / 1024).toFixed(2)} MB，编译启动器…`)
    compileLauncher(portableExe, { resourceZip: appZip })
    rmSync(appZip, { force: true })
    if (!existsSync(portableExe)) fail(`未找到单文件产物：${portableExe}`)
    const portableSig = signFile(portableExe, 'Morrow 单文件 exe')
    ensureMediumIntegrity(portableExe)
    steps.push({ name: 'portable', exitCode: 0, durationMs: Date.now() - packStarted, command: `launcher(${portableExe})` })
    artifacts.portableExe = {
      kind: 'portable-exe',
      path: relPath(portableExe),
      sizeBytes: statSync(portableExe).size,
      sizeMB: Number((statSync(portableExe).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(portableExe),
      signed: signatureSummary(portableSig).signed,
      signature: signatureSummary(portableSig),
      note:
        '自研单文件启动器：内嵌应用 zip，首次运行解压到 exe 同级 .morrow-runtime-<ver> 缓存（不依赖 %TEMP%），之后秒开；' +
        '自动加 --no-sandbox 以兼容本机受限环境；未签名时首次运行仍可能被 SmartScreen 拦截。'
    }
    logLine(`[dist] 单文件 exe：${artifacts.portableExe.path} · ${artifacts.portableExe.sizeMB} MB · sha256=${artifacts.portableExe.sha256.slice(0, 16)}… · signed=${artifacts.portableExe.signed}`)

    // NSIS 安装包：从同一份 win-unpacked 生成，便携版与安装包共享应用本体。
    if (!existsSync(winUnpacked)) {
      fail('生成安装包需要 tmp/electron-builder-output/win-unpacked；请先解除占用后重试。')
    }
    const nsisStarted = Date.now()
    const nsisStep = await runBuilder(
      [
        '--win',
        'nsis',
        '--x64',
        '--prepackaged',
        winUnpacked,
        '--publish',
        'never',
        `-c.directories.output=${releaseDir}`,
        ...electronDistArgs
      ],
      'nsis'
    )
    steps.push({ name: 'nsis', ...nsisStep })
    if (nsisStep.exitCode !== 0) fail(`electron-builder nsis 失败（exit ${nsisStep.exitCode}）`)
    if (!existsSync(installerExe)) {
      const found = [releaseDir, builderOutputDir]
        .flatMap((dir) => (existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []))
        .find((path) => /-setup\.exe$/i.test(path) && statSync(path).isFile())
      if (!found) fail('electron-builder nsis 完成但未找到安装包 -setup.exe')
      installerExe = found
    }
    const installerSig = signFile(installerExe, 'Morrow 安装包')
    ensureMediumIntegrity(installerExe)
    artifacts.installer = {
      kind: 'nsis-installer',
      path: relPath(installerExe),
      sizeBytes: statSync(installerExe).size,
      sizeMB: Number((statSync(installerExe).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(installerExe),
      signed: signatureSummary(installerSig).signed,
      signature: signatureSummary(installerSig),
      note:
        'NSIS 安装包：可选安装目录、创建开始菜单/桌面快捷方式，按当前用户安装；安装版数据目录默认为 %APPDATA%\\Morrow，可在设置中更改。'
    }
    steps.push({ name: 'installer', exitCode: 0, durationMs: Date.now() - nsisStarted, command: `installer(${installerExe})` })
    logLine(`[dist] 安装包：${artifacts.installer.path} · ${artifacts.installer.sizeMB} MB · sha256=${artifacts.installer.sha256.slice(0, 16)}… · signed=${artifacts.installer.signed}`)

    if (mode === 'all' && existsSync(winUnpacked)) {
      try {
        rmSync(winUnpacked, { recursive: true, force: true })
        logLine('[dist] 已清理中间目录 tmp/electron-builder-output/win-unpacked（文件夹版已包含同构内容）')
      } catch (err) {
        logLine(`[dist] 中间目录被占用，暂未清理 tmp/electron-builder-output（不影响产物）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 只把本次产物整理进 deliver/：旧包、缓存、Morrow Data、日志一律清掉。
  if (Object.keys(artifacts).length > 0) {
    const delivery = stageDelivery()
    summary.delivery = delivery
    if (artifacts.portableFolder && delivery.folder) {
      artifacts.portableFolder.path = delivery.folder.path
      artifacts.portableFolder.exePath = delivery.folder.exePath
      artifacts.portableFolder.appExePath = delivery.folder.appExePath
    }
    for (const artifact of Object.values(artifacts)) {
      const match = delivery.artifacts.find((entry) => artifact.path.endsWith(entry.path.split('/').pop()))
      if (match) artifact.path = match.path
    }
    // 交付目录里的文件才是最终产物：重新读一次签名，避免 JSON 里出现 release/tmp 的旧路径。
    if (artifacts.portableFolder && delivery.folder) {
      const launcherSig = signatureSummary(readAuthenticode(join(deliverDir, folderName, 'Morrow.exe')))
      const appSig = signatureSummary(readAuthenticode(join(deliverDir, folderName, 'Morrow-app.exe')))
      artifacts.portableFolder.signatures = { launcher: launcherSig, app: appSig }
      artifacts.portableFolder.signed = launcherSig.signed && appSig.signed
    }
    if (artifacts.portableExe) {
      const exeSig = signatureSummary(readAuthenticode(join(deliverDir, `${folderName}.exe`)))
      artifacts.portableExe.signature = exeSig
      artifacts.portableExe.signed = exeSig.signed
    }
    if (artifacts.portableZip) {
      artifacts.portableZip.signed = false
      artifacts.portableZip.signature = {
        signed: false,
        status: 'NotApplicable',
        note: 'zip 不参与 Authenticode 签名；zip 内 exe 的签名状态见 portableFolder.signatures'
      }
    }
    const singleDelivery = !delivery.folder && !delivery.artifacts.some((item) => item.name === 'portable-zip')
    const deliveryFormat = artifacts.installer ? '便携版 exe + 安装包' : '单文件 exe'
    logLine(
      `[dist] 交付目录：deliver/ · ${delivery.totalSizeMB} MB · ${delivery.totalFileCount} 个分发文件（${deliveryFormat} + 使用说明 + SHA256SUMS + LICENSE）${
        delivery.localData
          ? `；另保留本机用户数据 Morrow Data（${delivery.localData.fileCount} 个文件，不计入分发）`
          : ''
      }`
    )
  }

  // 主推产物：文件夹版 > zip > 单文件
  const primaryKey = artifacts.portableFolder
    ? 'portableFolder'
    : artifacts.portableZip
      ? 'portableZip'
      : artifacts.portableExe
        ? 'portableExe'
        : null
  summary.ok = steps.every((step) => step.exitCode === 0) && Object.keys(artifacts).length > 0 && Boolean(summary.delivery)
  summary.primaryArtifact = primaryKey
  summary.artifacts = artifacts
  summary.signing.certificate = signing.certificate || null
  summary.signing.artifacts = Object.fromEntries(
    Object.entries(artifacts).map(([key, artifact]) => {
      if (key === 'portableFolder' && artifact.signatures) return [key, artifact.signatures]
      if (artifact.signature) return [key, artifact.signature]
      return [key, { signed: Boolean(artifact.signed), status: artifact.signed ? 'Valid' : 'NotSigned' }]
    })
  )
  const singleDelivery =
    Boolean(summary.delivery) &&
    !summary.delivery.folder &&
    !summary.delivery.artifacts.some((item) => item.name === 'portable-zip')
  const hasInstaller = Boolean(artifacts.installer)
  summary.notes =
    `Morrow ${version} 打包完成：启动器嵌入完整 Win32 manifest；` +
    (hasInstaller ? '交付便携版 exe 与安装包。' : '交付单文件 exe。') +
    (signing.enabled ? `已使用 ${signing.method} 证书签名并校验。` : '未配置代码签名证书，产物 signed:false。') +
    (singleDelivery
      ? hasInstaller
        ? ' deliver/ 保留便携版、安装包、使用说明、SHA256SUMS 与 LICENSE；首次运行仍可能遇到 SmartScreen。'
        : ' deliver/ 只保留单文件 exe、使用说明、SHA256SUMS 与 LICENSE；首次运行仍可能遇到 SmartScreen。'
      : ' deliver/ 保留三份便携产物、使用说明、SHA256SUMS 与 LICENSE；首次运行仍可能遇到 SmartScreen。')
  summary.finishedAt = new Date().toISOString()
  summary.durationMs = Date.now() - startedAt
  writeFileSync(join(root, 'docs', 'verification', 'packaging.json'), JSON.stringify(summary, null, 2))
  logLine(`[dist] 完成 · ${(summary.durationMs / 1000).toFixed(1)}s · 摘要 docs/verification/packaging.json`)
  if (summary.ok) {
    for (const [key, artifact] of Object.entries(artifacts)) {
      logLine(`[dist]   ${key}: ${artifact.path} · ${artifact.sizeMB} MB · signed=${Boolean(artifact.signed)}${artifact.sha256 ? ` · sha256=${artifact.sha256}` : ''}`)
    }
    logLine(
      `[dist] 签名状态：${signing.enabled ? `已配置证书（${signing.method}）` : '未配置证书，产物未签名（signed:false）'}`
    )
  }
  process.exitCode = summary.ok ? 0 : 1
} catch (err) {
  summary.ok = false
  summary.error = err instanceof Error ? err.message : String(err)
  summary.finishedAt = new Date().toISOString()
  summary.durationMs = Date.now() - startedAt
  try {
    writeFileSync(join(root, 'docs', 'verification', 'packaging.json'), JSON.stringify(summary, null, 2))
  } catch {
    // 忽略
  }
  logLine(`[dist] 失败：${summary.error}`)
  logLine(`[dist] 完整日志：${logPath}`)
  process.exitCode = 1
}
