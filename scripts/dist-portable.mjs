// Morrow 打包脚本（electron-builder 封装）—— 三种交付形态 + 证据摘要
//
// 用法：
//   node scripts/dist-portable.mjs             # 默认 = --all：文件夹版 + zip + 单文件 exe（最终交付用）
//   node scripts/dist-portable.mjs --folder    # 只做「便携文件夹」+ zip（推荐交付形态，无自解压）
//   node scripts/dist-portable.mjs --portable  # 只做单文件 portable exe（依赖 %TEMP%，受限宿主可能失败）
//   node scripts/dist-portable.mjs --dir       # 只做 release/win-unpacked（最快，自检/调试用）
//
// 产物：
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
// 环境：自动设置 npmmirror 镜像、把 Electron 下载缓存指到项目 tmp/、清 ELECTRON_RUN_AS_NODE
//      （DSH 受限会话的既有做法）；输出全程写 docs/verification/logs/，摘要写 packaging.json。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
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

const releaseDir = join(root, 'release')
const folderName = `Morrow-${version}-portable`
const folderDir = join(releaseDir, folderName)
const zipPath = join(releaseDir, `${folderName}-win64.zip`)
const portableExe = join(releaseDir, `${folderName}.exe`)
const winUnpacked = join(releaseDir, 'win-unpacked')
const logsDir = join(root, 'docs', 'verification', 'logs')
mkdirSync(logsDir, { recursive: true })
mkdirSync(releaseDir, { recursive: true })

const sevenZip = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

function log(message) {
  const line = `[dist] ${message}`
  console.log(line)
}

function fail(message) {
  console.error(`[dist] 失败：${message}`)
  process.exitCode = 1
  throw new Error(message)
}

// ── 前置检查 ─────────────────────────────────────────────────────────
const mainOut = join(root, 'out', 'main', 'index.js')
const rendererOut = join(root, 'out', 'renderer', 'index.html')
const iconIco = join(root, 'build', 'icon.ico')
if (!existsSync(mainOut) || !existsSync(rendererOut)) fail('缺少构建产物（out/main/index.js 或 out/renderer/index.html）。请先 npm run build。')
if (!existsSync(iconIco)) fail('缺少 build/icon.ico。请先运行 python scripts/make-icons.py 生成图标。')
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

/** 清掉上一次的产物、中间目录、zip 暂存与 electron-builder 打包缓存（保留 release 文档/截图/审计报告）。 */
function cleanPackagingOutputs() {
  const targets = [
    folderDir,
    zipPath,
    portableExe,
    winUnpacked,
    join(root, 'tmp', 'launcher-app.zip'),
    join(releaseDir, 'builder-debug.yml')
  ]
  for (const target of targets) rmSync(target, { recursive: true, force: true })
  if (env.ELECTRON_BUILDER_CACHE) rmSync(env.ELECTRON_BUILDER_CACHE, { recursive: true, force: true })
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

/** 把 release/win-unpacked 整理成 release/Morrow-<ver>-portable/。 */
function organizeFolder() {
  if (!existsSync(winUnpacked)) fail('electron-builder --dir 未产出 release/win-unpacked')
  rmSync(folderDir, { recursive: true, force: true })
  try {
    renameSync(winUnpacked, folderDir)
  } catch {
    // 极端情况（跨设备/被占用）退化为复制
    cpSync(winUnpacked, folderDir, { recursive: true })
    rmSync(winUnpacked, { recursive: true, force: true })
  }
  const exe = join(folderDir, 'Morrow.exe')
  if (!existsSync(exe)) fail(`文件夹版缺少 Morrow.exe：${folderDir}`)
  addPortableExtras(folderDir)
  return exe
}

/** 文件夹版附加文件：
 *  - portable.marker：主进程 resolveDataDir() 见到它就数据目录落到 exe 同级 `Morrow Data/`（真正便携）
 *  - 启动 Morrow（兼容模式）.cmd：受限宿主（如 DSH 卡片「打开」）双击 Morrow.exe 无反应时的兜底入口
 */
function addPortableExtras(folderDir) {
  writeFileSync(join(folderDir, 'portable.marker'), '', 'utf8')
  const compatScript = [
    '@echo off',
    'cd /d "%~dp0"',
    'start "" "%~dp0Morrow.exe" --no-sandbox',
    ''
  ].join('\r\n')
  writeFileSync(join(folderDir, '启动 Morrow（兼容模式）.cmd'), compatScript, 'utf8')
  // 桌面快捷方式：Windows 任务栏/窗口使用 exe 内嵌图标；桌面图标由一键脚本创建（不静默写入用户桌面）
  const shortcutScript = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Get-Location).Path; $exe = Join-Path $root \'Morrow.exe\'; $ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath(\'Desktop\')) \'Morrow.lnk\')); $lnk.TargetPath = $exe; $lnk.WorkingDirectory = $root; $lnk.IconLocation = ($exe + \',0\'); $lnk.Description = \'Morrow - AI 工作伙伴\'; $lnk.Save(); Write-Host (\'已创建桌面快捷方式：\' + $exe)"',
    'if errorlevel 1 (echo 创建失败，请检查权限) else (echo 完成：桌面上的 Morrow 图标使用本应用图标)',
    'pause',
    ''
  ].join('\r\n')
  writeFileSync(join(folderDir, '创建桌面快捷方式.cmd'), shortcutScript, 'utf8')

  // 推荐入口：先清除下载文件的安全标记（MOTW），再创建桌面快捷方式并启动。
  // Windows 对带 MOTW 的未签名 exe 会弹 SmartScreen；通过 cmd 清除标记后启动不会再弹。
  const launchScript = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath (Get-Location).Path -Recurse -File -Include *.exe,*.dll -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue; $root = (Get-Location).Path; $exe = Join-Path $root \'Morrow.exe\'; $lnkPath = Join-Path ([Environment]::GetFolderPath(\'Desktop\')) \'Morrow.lnk\'; if (-not (Test-Path $lnkPath)) { $ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut($lnkPath); $lnk.TargetPath = $exe; $lnk.WorkingDirectory = $root; $lnk.IconLocation = ($exe + \',0\'); $lnk.Description = \'Morrow - AI 工作伙伴\'; $lnk.Save() }"',
    'start "" "Morrow.exe"',
    ''
  ].join('\r\n')
  writeFileSync(join(folderDir, '启动 Morrow.cmd'), launchScript, 'utf8')

  // Windows Explorer 会缓存 exe 图标：重打包后任务栏正确、文件管理器仍旧时，用本脚本重建缓存与快捷方式。
  const iconFixScript = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'echo 正在重建桌面快捷方式并刷新 Windows 图标缓存…',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Get-Location).Path; $exe = Join-Path $root \'Morrow.exe\'; $ws = New-Object -ComObject WScript.Shell; $lnkPath = Join-Path ([Environment]::GetFolderPath(\'Desktop\')) \'Morrow.lnk\'; $lnk = $ws.CreateShortcut($lnkPath); $lnk.TargetPath = $exe; $lnk.WorkingDirectory = $root; $lnk.IconLocation = ($exe + \',0\'); $lnk.Description = \'Morrow - AI 工作伙伴\'; $lnk.Save()"',
    'taskkill /f /im explorer.exe >nul 2>&1',
    'del /f /q "%LocalAppData%\\IconCache.db" >nul 2>&1',
    'del /f /q "%LocalAppData%\\Microsoft\\Windows\\Explorer\\iconcache_*.db" >nul 2>&1',
    'start "" explorer.exe',
    'ie4uinit.exe -show >nul 2>&1',
    'echo 完成：桌面快捷方式已指向新图标，文件管理器图标缓存已重建。',
    'pause',
    ''
  ].join('\r\n')
  writeFileSync(join(folderDir, '修复图标显示.cmd'), iconFixScript, 'utf8')
}

/** 用 7za 把文件夹压成 zip（zip 内保留文件夹根目录，解压即得同构目录）。 */
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const launcherSrc = join(root, 'build', 'launcher', 'MorrowLauncher.cs')

/**
 * 编译 C# 启动器。
 * defineFolder=true：文件夹版启动器（启动同目录 Morrow-app.exe，无需内嵌 zip）
 * resourceZip：单文件版启动器要内嵌的应用 zip
 */
function compileLauncher(outPath, options = {}) {
  if (!existsSync(cscPath)) fail('缺少 C# 编译器 csc.exe（Windows .NET Framework 4.x）')
  if (!existsSync(launcherSrc)) fail('缺少启动器源码 build/launcher/MorrowLauncher.cs')
  const args = [
    '-nologo',
    '-target:winexe',
    `-out:${outPath}`,
    `-win32icon:${iconIco}`,
    ...(options.defineFolder ? ['-define:FOLDER_MODE'] : []),
    ...(options.resourceZip ? [`-resource:${options.resourceZip},MorrowApp.zip`] : []),
    '-r:System.IO.Compression.dll',
    '-r:System.IO.Compression.FileSystem.dll',
    '-r:System.Windows.Forms.dll',
    '-r:System.Drawing.dll',
    launcherSrc
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
  // -mcu=on：zip 内文件名强制 UTF-8（含「启动 Morrow（兼容模式）.cmd」这类中文名）
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

logLine(`[dist] Morrow ${version} · mode=${mode} · 输出 release/`)
logLine(`[dist] 镜像：ELECTRON_MIRROR=${env.ELECTRON_MIRROR} · ELECTRON_CACHE=${env.ELECTRON_CACHE}`)

try {
  if (mode === 'dir') {
    steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never'], 'dir')) })
  } else if (mode === 'folder' || mode === 'all') {
    steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never'], 'dir')) })
    const dirStep = steps[steps.length - 1]
    if (dirStep.exitCode !== 0) fail(`electron-builder --dir 失败（exit ${dirStep.exitCode}）`)
    prepareUnpackedWithLauncher()

    const folderExe = organizeFolder()
    const folderStat = dirSize(folderDir)
    artifacts.portableFolder = {
      kind: 'folder',
      path: folderDir.replace(root + '\\', '').replace(/\\/g, '/'),
      exePath: folderExe.replace(root + '\\', '').replace(/\\/g, '/'),
      exeSizeBytes: statSync(folderExe).size,
      sizeBytes: folderStat.sizeBytes,
      sizeMB: Number((folderStat.sizeBytes / 1024 / 1024).toFixed(2)),
      fileCount: folderStat.fileCount,
      extras: ['portable.marker', '启动 Morrow.cmd', '启动 Morrow（兼容模式）.cmd', '创建桌面快捷方式.cmd', '修复图标显示.cmd'],
      note: '推荐交付形态：Morrow.exe 为轻量启动器（自动 --no-sandbox 后启动 Morrow-app.exe），无需解压/不依赖 %TEMP%；含 portable.marker（数据目录跟随 exe）与兼容模式启动脚本'
    }
    logLine(`[dist] 文件夹版：${artifacts.portableFolder.path} · ${artifacts.portableFolder.sizeMB} MB · ${folderStat.fileCount} files`)

    logLine('[dist] 压缩 zip…')
    const zipResult = zipFolder()
    steps.push({ name: 'zip', exitCode: 0, durationMs: zipResult.durationMs })
    artifacts.portableZip = {
      kind: 'zip',
      path: zipPath.replace(root + '\\', '').replace(/\\/g, '/'),
      sizeBytes: statSync(zipPath).size,
      sizeMB: Number((statSync(zipPath).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(zipPath)
    }
    logLine(`[dist] zip：${artifacts.portableZip.path} · ${artifacts.portableZip.sizeMB} MB · sha256=${artifacts.portableZip.sha256.slice(0, 16)}…`)
  }

  if (mode === 'portable' || mode === 'all') {
    // 单文件便携版：使用仓库内的自研启动器（build/launcher/MorrowLauncher.cs）
    // 把 win-unpacked 打成 zip 内嵌进 exe；首次运行解压到 exe 同级隐藏缓存目录
    // （.morrow-runtime-<ver>），不依赖 %TEMP%；之后直接复用；目录只读时回退 LOCALAPPDATA。
    // 之所以不用 electron-builder 的 NSIS portable：NSIS 自解压把内容写到 %TEMP%，
    // 受限启动环境（%TEMP% 不可写）会直接报 “Error writing temporary file”。
    const appZip = join(root, 'tmp', 'launcher-app.zip')
    if (!existsSync(join(winUnpacked, 'Morrow-app.exe')) && !existsSync(join(winUnpacked, 'Morrow.exe'))) {
      steps.push({ name: 'dir', ...(await runBuilder(['--win', '--x64', '--dir', '--publish', 'never'], 'dir')) })
      if (steps[steps.length - 1].exitCode !== 0) fail('electron-builder dir 失败（单文件启动器需要 win-unpacked）')
    }
    prepareUnpackedWithLauncher()

    const packStarted = Date.now()
    rmSync(appZip, { force: true })
    logLine('[dist] [portable] 打包 win-unpacked 为内嵌 zip…')
    const zipResult = spawnSync(sevenZip, ['a', '-tzip', '-mx=5', appZip, '*'], { cwd: winUnpacked, encoding: 'utf8' })
    if (zipResult.status !== 0) fail(`内嵌 zip 打包失败：${(zipResult.stderr || '').slice(0, 400)}`)
    logLine(`[dist] [portable] 内嵌 zip ${(statSync(appZip).size / 1024 / 1024).toFixed(2)} MB，编译启动器…`)
    compileLauncher(portableExe, { resourceZip: appZip })
    rmSync(appZip, { force: true })
    if (!existsSync(portableExe)) fail(`未找到单文件产物：${portableExe}`)
    steps.push({ name: 'portable', exitCode: 0, durationMs: Date.now() - packStarted, command: `launcher(${portableExe})` })
    artifacts.portableExe = {
      kind: 'portable-exe',
      path: portableExe.replace(root + '\\', '').replace(/\\/g, '/'),
      sizeBytes: statSync(portableExe).size,
      sizeMB: Number((statSync(portableExe).size / 1024 / 1024).toFixed(2)),
      sha256: sha256(portableExe),
      note: '自研单文件启动器：内嵌应用 zip，首次运行解压到 exe 同级 .morrow-runtime-<ver> 缓存（不依赖 %TEMP%），之后秒开；自动加 --no-sandbox 以兼容本机受限环境；无代码签名，SmartScreen 可能提示未知发布者'
    }
    logLine(`[dist] 单文件 exe：${artifacts.portableExe.path} · ${artifacts.portableExe.sizeMB} MB · sha256=${artifacts.portableExe.sha256.slice(0, 16)}…`)
    if (mode === 'all' && existsSync(winUnpacked)) {
      rmSync(winUnpacked, { recursive: true, force: true })
      logLine('[dist] 已清理中间目录 release/win-unpacked（文件夹版已包含同构内容）')
    }
    // 单文件 exe 首次直接双击仍可能触发 SmartScreen（无签名）；提供“先清除安全标记再启动”的伴随脚本
    if (existsSync(portableExe)) {
      const singleLaunch = [
        '@echo off',
        'chcp 65001 >nul',
        'setlocal',
        'cd /d "%~dp0"',
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '.\\${folderName}.exe' -ErrorAction SilentlyContinue"`,
        `start "" "${folderName}.exe"`,
        ''
      ].join('\r\n')
      writeFileSync(join(releaseDir, '启动单文件版（清除安全标记）.cmd'), singleLaunch, 'utf8')
    }
  }

  // 清理 Mark-of-the-Web（若存在），减少 SmartScreen 打扰（无代码签名仍可能提示）
  try {
    const unblockTargets = [portableExe, zipPath, join(folderDir, 'Morrow.exe'), join(folderDir, 'Morrow-app.exe'), join(releaseDir, '启动 Morrow.cmd'), join(releaseDir, 'Morrow-1.0.0-portable', '启动 Morrow.cmd')].filter((p) => existsSync(p))
    if (unblockTargets.length > 0) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', unblockTargets.map((p) => `Unblock-File -LiteralPath '${p.replace(/'/g, "''")}'`).join('; ')], { stdio: 'ignore' })
    }
  } catch {
    // 忽略：无签名仍可能触发 SmartScreen，这不是致命问题
  }

  // 主推产物：文件夹版 > zip > 单文件
  const primaryKey = artifacts.portableFolder
    ? 'portableFolder'
    : artifacts.portableZip
      ? 'portableZip'
      : artifacts.portableExe
        ? 'portableExe'
        : null
  summary.ok = steps.every((step) => step.exitCode === 0) && Object.keys(artifacts).length > 0
  summary.primaryArtifact = primaryKey
  summary.artifacts = artifacts
  summary.finishedAt = new Date().toISOString()
  summary.durationMs = Date.now() - startedAt
  writeFileSync(join(root, 'docs', 'verification', 'packaging.json'), JSON.stringify(summary, null, 2))
  logLine(`[dist] 完成 · ${(summary.durationMs / 1000).toFixed(1)}s · 摘要 docs/verification/packaging.json`)
  if (summary.ok) {
    for (const [key, artifact] of Object.entries(artifacts)) {
      logLine(`[dist]   ${key}: ${artifact.path} · ${artifact.sizeMB} MB${artifact.sha256 ? ` · sha256=${artifact.sha256}` : ''}`)
    }
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
