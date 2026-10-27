/**
 * R10-K3 受控 Windows computer-use 工具（不要改 registry；Lead 注册）。
 *
 * 安全模型（最高优先级）：
 * - 仅 Windows；动作只作用于**当前前台窗口**，动作前会重新确认前台窗口未变化；
 * - 每次动作都需要审批：工具被登记为「外部动作」（EXTERNAL_ACTION_TOOLS），
 *   read-only 直接拒绝，ask / auto 都逐次询问（不查「始终允许」）；
 * - 密码/支付/银行/系统设置等敏感窗口一律拒绝操作；文本/坐标/频率有硬限制；
 * - 截图只截当前前台窗口，保存为工作区产物（kind=file）并注册到画布，方便撤销/审查；
 * - 所有失败返回可读中文错误，不杀进程、不改系统设置。
 *
 * 测试：createComputerTools() 支持注入 platform / PowerShell runner / 时钟，避免真实鼠标键盘。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { COMPUTER_TOOL_NAMES, type ComputerToolName } from '../permissions'
import { getNumber, getString } from './args'
import { killProcessTree, sanitizeEnv } from './command-tool'
import { snapshotFile } from './fs-tools'
import { resolveWorkspacePath } from './paths'
import { errResult, okResult, type ToolImpl } from './types'
import { truncateText } from '../util'

/* ── 常量与校验 ───────────────────────────────────────────────── */

export { COMPUTER_TOOL_NAMES }
export type { ComputerToolName }

export const COMPUTER_LIMITS = {
  maxTextLength: 2000,
  maxCoordinate: 10_000,
  maxActionsPerMinute: 30,
  screenshotMaxBytes: 32 * 1024 * 1024,
  commandTimeoutMs: 20_000
} as const

/** 动作间隔（毫秒）：降低失控风险（例如模型连续疯狂点击） */
const DEFAULT_MIN_INTERVAL_MS: Record<ComputerToolName, number> = {
  computer_screenshot: 1200,
  computer_click: 250,
  computer_type: 500,
  computer_key: 300
}

const SENSITIVE_TITLE_PATTERN =
  /密码|口令|登录|登陆|验证码|支付|付款|收银|转账|银行|钱包|余额|密钥|凭证|凭据|password|passwd|login|sign[ -]?in|verification|2fa|otp|payment|pay\b|checkout|bank|wallet|credential|secret|api[ -]?key|keeper|1password|bitwarden|lastpass|settings|设置|控制面板|control panel|regedit|注册表|uac|用户账户|security center|安全中心/i

const SENSITIVE_PROCESS_PATTERN = /keepass|1password|bitwarden|lastpass|authenticator|bank|payment|wallet|credential|regedit|mmc|secpol|gpedit|control/i

const KEY_MAP: Record<string, number> = {
  ENTER: 0x0d,
  RETURN: 0x0d,
  ESC: 0x1b,
  ESCAPE: 0x1b,
  TAB: 0x09,
  SPACE: 0x20,
  BACKSPACE: 0x08,
  DELETE: 0x2e,
  HOME: 0x24,
  END: 0x23,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  UP: 0x26,
  DOWN: 0x28,
  LEFT: 0x25,
  RIGHT: 0x27
}

const MODIFIER_MAP: Record<string, number> = { CTRL: 0x11, SHIFT: 0x10, ALT: 0x12 }

export function isWindowsPlatform(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function isSensitiveWindow(title: string, processName: string): boolean {
  return SENSITIVE_TITLE_PATTERN.test(title) || SENSITIVE_PROCESS_PATTERN.test(processName)
}

export interface ClickInput {
  x: number
  y: number
}

export function validateClickInput(input: Record<string, unknown>): ClickInput | string {
  let x: number
  let y: number
  try {
    x = getNumber(input, 'x', { required: true, min: 0, max: COMPUTER_LIMITS.maxCoordinate })
    y = getNumber(input, 'y', { required: true, min: 0, max: COMPUTER_LIMITS.maxCoordinate })
  } catch (err) {
    return err instanceof Error ? err.message : '坐标参数不合法。'
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) return '坐标必须是整数像素（x、y）。'
  return { x, y }
}

export type TypeValidation = { ok: true; text: string } | { ok: false; reason: string }

export function validateTypeInput(input: Record<string, unknown>): TypeValidation {
  let text: string
  try {
    text = getString(input, 'text', { required: true, trim: false })
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '要输入的文字不能为空。' }
  }
  if (!text) return { ok: false, reason: '要输入的文字不能为空。' }
  if (text.length > COMPUTER_LIMITS.maxTextLength) {
    return { ok: false, reason: `输入文字过长（${text.length} 字符，上限 ${COMPUTER_LIMITS.maxTextLength}）。请分段输入。` }
  }
  if (/[\r\n]/.test(text)) {
    return {
      ok: false,
      reason: '输入文字不能包含换行（可能意外提交表单）；需要换行请用 computer_key(keys="ENTER")。'
    }
  }
  return { ok: true, text }
}

/** 解析按键组合，返回 VK 序列（含按下顺序）；只允许白名单键与 CTRL+字母。 */
export function parseKeySequence(keys: string): number[] | string {
  const raw = keys.trim().toUpperCase()
  if (!raw) return '按键不能为空。'
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 3) return '按键格式不合法（示例：ENTER、TAB、CTRL+A）。'
  const sequence: number[] = []
  const modifiers: string[] = []
  let keyCount = 0
  let keyPart = ''
  for (const part of parts) {
    if (MODIFIER_MAP[part]) {
      // ALT 组合可能切换窗口/菜单（如 ALT+TAB、ALT+F4），不允许；需要时请用户自己操作
      if (part === 'ALT') return '不允许 ALT 组合键（可能切换窗口或关闭程序）；只支持 Ctrl/Shift 组合。'
      modifiers.push(part)
      sequence.push(MODIFIER_MAP[part])
      continue
    }
    keyCount += 1
    if (keyCount > 1) return '一次只能按一个普通键（修饰键除外）。'
    keyPart = part
    if (KEY_MAP[part]) {
      sequence.push(KEY_MAP[part])
      continue
    }
    if (/^[A-Z]$/.test(part)) {
      sequence.push(part.charCodeAt(0))
      continue
    }
    return `不允许的按键「${part}」。只支持 Enter/Esc/Tab/Space/Backspace/Delete/方向键/Home/End/PageUp/PageDown/字母 与 Ctrl/Shift/Alt 组合。`
  }
  if (keyCount !== 1) return '需要包含一个普通键（例如 CTRL+A）。'
  // 危险系统组合：Ctrl+Esc 开始菜单、Ctrl+Shift+Esc 任务管理器、Ctrl/Shift+Delete 绕过回收站等
  if (
    ((modifiers.includes('CTRL') || modifiers.includes('SHIFT')) && (keyPart === 'ESC' || keyPart === 'ESCAPE')) ||
    ((modifiers.includes('CTRL') || modifiers.includes('SHIFT')) && keyPart === 'DELETE')
  ) {
    return `不允许的按键组合「${raw}」（可能触发系统级操作）。`
  }
  return sequence
}

/* ── PowerShell 执行 ─────────────────────────────────────────── */

export interface PowerShellResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export type PowerShellRunner = (script: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<PowerShellResult>

const POWERSHELL_UTF8_PREFIX =
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $ProgressPreference='SilentlyContinue'; "

export function runPowerShellDefault(script: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<PowerShellResult> {
  return new Promise<PowerShellResult>((resolve) => {
    let output = ''
    const append = (chunk: Buffer): void => {
      if (output.length >= 64 * 1024) return
      output += chunk.toString('utf8').slice(0, 64 * 1024 - output.length)
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: PowerShellResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
      }
      killProcessTree(child.pid)
      finish({ ok: false, stdout: '', stderr: '操作已取消。', exitCode: -1 })
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_UTF8_PREFIX + script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeEnv(process.env)
    })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (err) => finish({ ok: false, stdout: '', stderr: `无法启动 PowerShell：${err.message}`, exitCode: -1 }))
    child.on('close', (code) => {
      const text = output.trim()
      const ok = code === 0 && !/^\s*(错误|Exception|error)/i.test(text)
      finish({ ok, stdout: text, stderr: text, exitCode: code ?? -1 })
    })
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
      }
      killProcessTree(child.pid)
      finish({ ok: false, stdout: '', stderr: '电脑操作超时（20 秒），已终止。', exitCode: -1 })
    }, options.timeoutMs)
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/* ── Windows 脚本（PowerShell/Add-Type） ──────────────────────── */

const WIN32_INFO_TYPE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MorrowWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static bool EnableDpiAwareness() {
    try { return SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { return SetProcessDPIAware(); } catch { return false; } }
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
'@
`

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function foregroundInfoScript(): string {
  return `${WIN32_INFO_TYPE}
$h = [MorrowWin]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { throw '当前没有可操作的前台窗口。' }
$title = [MorrowWin]::Title($h)
$procId = 0
[void][MorrowWin]::GetWindowThreadProcessId($h, [ref]$procId)
$proc = ''
try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
[Console]::Out.Write(("{0}|{1}|{2}" -f $h.ToInt64(), $title.Replace('|','/'), $proc))
`
}

function assertForegroundSnippet(expectedHwnd: number): string {
  return `
$expectedHwnd = ${Math.trunc(expectedHwnd)}
$current = [MorrowWin]::GetForegroundWindow()
if ($current.ToInt64() -ne $expectedHwnd) { throw '前台窗口在操作前发生了变化，已取消（请重试并保持目标窗口在前台）。' }
`
}

function screenshotScript(path: string, expectedHwnd: number): string {
  return `${WIN32_INFO_TYPE}
[void][MorrowWin]::EnableDpiAwareness()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$expectedHwnd = ${Math.trunc(expectedHwnd)}
if ([MorrowWin]::GetForegroundWindow().ToInt64() -ne $expectedHwnd) { throw '前台窗口在截图前发生了变化，已取消。' }
$rect = New-Object MorrowWin+RECT
if (-not [MorrowWin]::GetWindowRect([IntPtr]$expectedHwnd, [ref]$rect)) { throw '无法读取前台窗口尺寸。' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw '前台窗口尺寸无效，无法截图。' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  $bitmap.Save(${psQuote(path)}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
[Console]::Out.Write(("{0}|{1}" -f $width, $height))
`
}

function clickScript(x: number, y: number, expectedHwnd: number): string {
  return `${WIN32_INFO_TYPE}[void][MorrowWin]::EnableDpiAwareness()
${assertForegroundSnippet(expectedHwnd)}
$rect = New-Object MorrowWin+RECT
if (-not [MorrowWin]::GetWindowRect([IntPtr]$expectedHwnd, [ref]$rect)) { throw '无法读取前台窗口尺寸。' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$x = ${Math.trunc(x)}
$y = ${Math.trunc(y)}
if ($x -lt 0 -or $y -lt 0 -or $x -ge $width -or $y -ge $height) { throw "坐标超出当前前台窗口范围（窗口 \${width}x\${height}）。" }
[void][MorrowWin]::SetCursorPos($rect.Left + $x, $rect.Top + $y)
Start-Sleep -Milliseconds 30
[MorrowWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MorrowWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
[Console]::Out.Write('OK')
`
}

function typeScript(text: string, expectedHwnd: number): string {
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  return `${WIN32_INFO_TYPE}${assertForegroundSnippet(expectedHwnd)}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MorrowInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void TypeText(string text) {
    foreach (char ch in text) {
      INPUT down = new INPUT(); down.type = 1; down.u.ki.wScan = (ushort)ch; down.u.ki.dwFlags = 0x0004;
      INPUT up = new INPUT(); up.type = 1; up.u.ki.wScan = (ushort)ch; up.u.ki.dwFlags = 0x0004 | 0x0002;
      SendInput(1, new INPUT[]{ down }, Marshal.SizeOf(typeof(INPUT)));
      SendInput(1, new INPUT[]{ up }, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(base64)}))
[MorrowInput]::TypeText($text)
[Console]::Out.Write(("OK|{0}" -f $text.Length))
`
}

function keyScript(sequence: number[], expectedHwnd: number): string {
  const keyCodes = sequence.join(',')
  return `${WIN32_INFO_TYPE}${assertForegroundSnippet(expectedHwnd)}
$codes = @(${keyCodes})
$down = @()
foreach ($code in $codes) {
  [MorrowWin]::keybd_event([byte]$code, 0, 0, [UIntPtr]::Zero)
  $down += $code
  Start-Sleep -Milliseconds 25
}
[array]::Reverse($down)
foreach ($code in $down) {
  [MorrowWin]::keybd_event([byte]$code, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 25
}
[Console]::Out.Write('OK')
`
}

/* ── 前台窗口与速率限制 ──────────────────────────────────────── */

interface ForegroundInfo {
  hwnd: number
  title: string
  processName: string
}

export function parseForegroundInfo(stdout: string): ForegroundInfo | null {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  const parts = line.split('|')
  if (parts.length < 3) return null
  const hwnd = Number(parts[0])
  if (!Number.isFinite(hwnd) || hwnd <= 0) return null
  return { hwnd, title: parts[1] ?? '', processName: parts[2] ?? '' }
}

/* ── 工具工厂 ─────────────────────────────────────────────────── */

export interface ComputerRuntime {
  platform?: NodeJS.Platform | string
  now?: () => number
  runPowerShell?: PowerShellRunner
  minIntervalMs?: Partial<Record<ComputerToolName, number>>
  maxActionsPerMinute?: number
}

function securityDeny(ctx: ToolContext): ToolResult | null {
  if (ctx.demo) {
    return errResult('演示模式不能操作电脑。', 'computer-use 只用于用户明确授权的工作会话；演示模式不会控制真实鼠标键盘。')
  }
  if (ctx.permissionMode === 'read-only') {
    return errResult('当前是「只读模式」，computer-use 已被拒绝。', '需要操作电脑时请把权限切到「询问」或「完全访问」。')
  }
  return null
}

export function createComputerTools(runtime: ComputerRuntime = {}): ToolImpl[] {
  const platform = runtime.platform ?? process.platform
  const now = runtime.now ?? Date.now
  const runner = runtime.runPowerShell ?? runPowerShellDefault
  const actionTimes: number[] = []
  const lastActionAt = new Map<string, number>()

  const rateLimit = (tool: ComputerToolName): string | null => {
    const minInterval = runtime.minIntervalMs?.[tool] ?? DEFAULT_MIN_INTERVAL_MS[tool]
    const current = now()
    const last = lastActionAt.get(tool) ?? 0
    if (last > 0 && current - last < minInterval) {
      return `操作过于频繁（${tool} 间隔需 ≥ ${minInterval}ms），已取消。`
    }
    const maxPerMinute = runtime.maxActionsPerMinute ?? COMPUTER_LIMITS.maxActionsPerMinute
    while (actionTimes.length > 0 && current - actionTimes[0] > 60_000) actionTimes.shift()
    if (actionTimes.length >= maxPerMinute) {
      return `一分钟内电脑操作过多（上限 ${maxPerMinute} 次），已暂停；请稍后再试。`
    }
    lastActionAt.set(tool, current)
    actionTimes.push(current)
    return null
  }

  const guardPlatform = (): ToolResult | null => {
    if (!isWindowsPlatform(String(platform))) {
      return errResult('computer-use 目前只支持 Windows。', '当前系统不是 Windows，鼠标键盘/截图工具不可用；请改用文件与命令工具。')
    }
    return null
  }

  const readForeground = async (ctx: ToolContext): Promise<ForegroundInfo | ToolResult> => {
    const result = await runner(foregroundInfoScript(), {
      signal: ctx.signal,
      timeoutMs: COMPUTER_LIMITS.commandTimeoutMs
    })
    if (!result.ok) {
      return errResult('无法读取当前前台窗口。', truncateText(result.stderr || result.stdout || '未知错误', 300))
    }
    const info = parseForegroundInfo(result.stdout)
    if (!info) return errResult('无法识别当前前台窗口（可能是安全桌面/锁屏）。', '请先解锁桌面并保持目标窗口在前台。')
    if (isSensitiveWindow(info.title, info.processName)) {
      return errResult(
        `当前前台窗口「${truncateText(info.title || info.processName, 80)}」可能是密码/支付/系统设置等敏感窗口，已拒绝操作。`,
        '请切换到普通应用窗口后再试；Morrow 不会在密码、支付、银行或系统设置界面上操作。'
      )
    }
    return info
  }

  const toolError = (err: unknown): ToolResult =>
    errResult(`电脑操作失败：${err instanceof Error ? err.message : String(err)}`, '桌面可能已变化或被锁定；请保持目标窗口在前台后重试。')

  const screenshot: ToolImpl = {
    definition: {
      name: 'computer_screenshot',
      description:
        '截取当前前台窗口并保存到工作区（Windows）。只截前台窗口、不截整个桌面；敏感窗口（密码/支付/系统设置）会被拒绝；' +
        '每次调用都需要用户审批。截图会注册为画布产物方便查看。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选：保存相对工作区的 .png 路径（默认 computer/screenshot-<时间>.png）' }
        }
      },
      category: 'exec',
      risk: 'high',
      titleFor: () => '截取当前前台窗口'
    },
    async execute(input, ctx): Promise<ToolResult> {
      const denied = securityDeny(ctx)
      if (denied) return denied
      const platformGuard = guardPlatform()
      if (platformGuard) return platformGuard
      const rateMessage = rateLimit('computer_screenshot')
      if (rateMessage) return errResult(rateMessage, '请稍等片刻再重试。')
      const workspace = ctx.workspace
      if (!workspace) return errResult('需要先绑定工作文件夹才能保存截图。', '请选择工作文件夹后重试。')
      const relativePath = getString(input, 'path', { defaultValue: `computer/screenshot-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.png` })
      if (!/\.png$/i.test(relativePath)) return errResult('截图路径必须以 .png 结尾。', '例如 computer/screenshot.png。')
      const resolved = resolveWorkspacePath(relativePath, workspace, { escapeApproved: ctx.escapeApproved })
      const foreground = await readForeground(ctx)
      if ('ok' in foreground) return foreground as ToolResult
      try {
        mkdirSync(dirname(resolved.absolute), { recursive: true })
        const snapshot = snapshotFile(resolved.absolute, ctx)
        const result = await runner(screenshotScript(resolved.absolute, foreground.hwnd), {
          signal: ctx.signal,
          timeoutMs: COMPUTER_LIMITS.commandTimeoutMs
        })
        if (!result.ok) return errResult('截图失败。', truncateText(result.stderr || result.stdout || '未知错误', 300))
        if (!existsSync(resolved.absolute)) return errResult('截图命令执行完成，但没有生成文件。', '请确认前台窗口未被最小化，并重试。')
        const stat = statSync(resolved.absolute)
        if (stat.size <= 8 || stat.size > COMPUTER_LIMITS.screenshotMaxBytes) {
          return errResult('截图文件大小异常。', '请重试；如果问题持续，请改用文件/命令方式。')
        }
        const [width, height] = result.stdout.trim().split('|').map((part) => Number(part))
        const artifact = {
          id: `artifact_computer_${Date.now().toString(36)}`,
          title: `屏幕截图 ${new Date(now()).toLocaleString('zh-CN')}`,
          kind: 'file' as const,
          path: resolved.absolute,
          createdAt: now(),
          updatedAt: now()
        }
        ctx.addArtifact(artifact)
        return okResult(
          `已截取当前前台窗口「${truncateText(foreground.title || foreground.processName, 60)}」：${relativePath}（${width || '?'}×${height || '?'}）。截图已作为画布产物注册。`,
          {
            path: relativePath,
            absolutePath: resolved.absolute,
            artifactId: artifact.id,
            width,
            height,
            windowTitle: foreground.title,
            ...(snapshot ? { snapshotId: snapshot.snapshotId, beforeHash: snapshot.beforeHash } : {})
          }
        )
      } catch (err) {
        return toolError(err)
      }
    }
  }

  const click: ToolImpl = {
    definition: {
      name: 'computer_click',
      description:
        '点击当前前台窗口内的坐标（Windows，坐标相对窗口左上角，整数像素）。会先确认窗口未变化；' +
        '敏感窗口拒绝；每次点击都需要用户审批。不要用它绕过其它工具做批量自动化。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '相对前台窗口左上角的 X 像素（整数）' },
          y: { type: 'number', description: '相对前台窗口左上角的 Y 像素（整数）' }
        },
        required: ['x', 'y']
      },
      category: 'exec',
      risk: 'high',
      titleFor: (input) => `点击 (${typeof input.x === 'number' ? input.x : '?'}, ${typeof input.y === 'number' ? input.y : '?'})`
    },
    async execute(input, ctx): Promise<ToolResult> {
      const denied = securityDeny(ctx)
      if (denied) return denied
      const platformGuard = guardPlatform()
      if (platformGuard) return platformGuard
      const rateMessage = rateLimit('computer_click')
      if (rateMessage) return errResult(rateMessage, '请稍等片刻再重试。')
      const clickInput = validateClickInput(input)
      if (typeof clickInput === 'string') return errResult(clickInput, '坐标必须是非负整数；请先截图确认位置。')
      const foreground = await readForeground(ctx)
      if ('ok' in foreground) return foreground as ToolResult
      try {
        const result = await runner(clickScript(clickInput.x, clickInput.y, foreground.hwnd), {
          signal: ctx.signal,
          timeoutMs: COMPUTER_LIMITS.commandTimeoutMs
        })
        if (!result.ok) return errResult('点击失败。', truncateText(result.stderr || result.stdout || '未知错误', 300))
        return okResult(`已点击「${truncateText(foreground.title || foreground.processName, 60)}」内坐标 (${clickInput.x}, ${clickInput.y})。`, {
          x: clickInput.x,
          y: clickInput.y,
          windowTitle: foreground.title,
          processName: foreground.processName
        })
      } catch (err) {
        return toolError(err)
      }
    }
  }

  const type: ToolImpl = {
    definition: {
      name: 'computer_type',
      description:
        '向当前前台窗口输入一段文本（Windows）。不支持换行（需换行请用 computer_key ENTER）；' +
        '限制 2000 字符；敏感窗口拒绝；每次输入都需要用户审批。不要在密码/支付/系统设置窗口使用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要输入的文本（不能包含换行，最多 2000 字符）' } },
        required: ['text']
      },
      category: 'exec',
      risk: 'high',
      titleFor: (input) => `输入文字（${typeof input.text === 'string' ? `${Math.min(input.text.length, 40)} 字` : '?'}）`
    },
    async execute(input, ctx): Promise<ToolResult> {
      const denied = securityDeny(ctx)
      if (denied) return denied
      const platformGuard = guardPlatform()
      if (platformGuard) return platformGuard
      const rateMessage = rateLimit('computer_type')
      if (rateMessage) return errResult(rateMessage, '请稍等片刻再重试。')
      const validated = validateTypeInput(input)
      if (!validated.ok) {
        return errResult(validated.reason, '请缩短文本（≤2000 字符）并去掉换行后再试。')
      }
      const text = validated.text
      const foreground = await readForeground(ctx)
      if ('ok' in foreground) return foreground as ToolResult
      try {
        const result = await runner(typeScript(text, foreground.hwnd), {
          signal: ctx.signal,
          timeoutMs: COMPUTER_LIMITS.commandTimeoutMs
        })
        if (!result.ok) return errResult('输入失败。', truncateText(result.stderr || result.stdout || '未知错误', 300))
        return okResult(`已向「${truncateText(foreground.title || foreground.processName, 60)}」输入 ${text.length} 个字符。`, {
          length: text.length,
          windowTitle: foreground.title,
          processName: foreground.processName
        })
      } catch (err) {
        return toolError(err)
      }
    }
  }

  const key: ToolImpl = {
    definition: {
      name: 'computer_key',
      description:
        '向当前前台窗口发送按键（Windows）。支持 Enter/Esc/Tab/Space/Backspace/Delete/方向键/Home/End/PageUp/PageDown、字母与 Ctrl/Shift/Alt 组合；' +
        '每次按键都需要用户审批；敏感窗口拒绝。不要用它执行关机/登录等危险组合。',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'string', description: '按键组合，例如 ENTER、TAB、CTRL+A' } },
        required: ['keys']
      },
      category: 'exec',
      risk: 'high',
      titleFor: (input) => `按键 ${typeof input.keys === 'string' ? input.keys : '?'}`
    },
    async execute(input, ctx): Promise<ToolResult> {
      const denied = securityDeny(ctx)
      if (denied) return denied
      const platformGuard = guardPlatform()
      if (platformGuard) return platformGuard
      const rateMessage = rateLimit('computer_key')
      if (rateMessage) return errResult(rateMessage, '请稍等片刻再重试。')
      const keys = getString(input, 'keys', { required: true })
      const sequence = parseKeySequence(keys)
      if (typeof sequence === 'string') return errResult(sequence, '只支持白名单按键与 Ctrl/Shift/Alt 组合；一次一个普通键。')
      const foreground = await readForeground(ctx)
      if ('ok' in foreground) return foreground as ToolResult
      try {
        const result = await runner(keyScript(sequence, foreground.hwnd), {
          signal: ctx.signal,
          timeoutMs: COMPUTER_LIMITS.commandTimeoutMs
        })
        if (!result.ok) return errResult('按键失败。', truncateText(result.stderr || result.stdout || '未知错误', 300))
        return okResult(`已向「${truncateText(foreground.title || foreground.processName, 60)}」发送按键 ${keys.toUpperCase()}。`, {
          keys: keys.toUpperCase(),
          windowTitle: foreground.title,
          processName: foreground.processName
        })
      } catch (err) {
        return toolError(err)
      }
    }
  }

  return [screenshot, click, type, key]
}

/** 默认实例：Lead 在 registry 注册这些工具（不要改 registry 由 Lead 集成） */
export const computerTools: ToolImpl[] = createComputerTools()

/** 这些工具属于「每次动作必问」的外部动作，已在 permissions.ts 的 EXTERNAL_ACTION_TOOLS 中登记 */
export const COMPUTER_TOOL_DEFINITIONS = computerTools.map((tool) => tool.definition)

