import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createComputerTools, resetPowerShellExecutableCacheForTests, resolvePowerShellExecutable } from '../../src/core/tool-media'
import { makeToolContext } from './helpers'
import { makeTempWorkspace } from './helpers'

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function fastRuntime(options: { signature?: string } = {}) {
  const scripts: string[] = []
  const now = { value: 1_000 }
  const runner = async (script: string) => {
    scripts.push(script)
    if (script.includes('[MorrowWindows]::List()')) {
      return {
        ok: true,
        stdout: JSON.stringify([
          { id: 99, title: '记事本', pid: 42, process: 'notepad', class: 'Notepad', x: 0, y: 0, width: 800, height: 600, minimized: false },
          { id: 100, title: '招商银行 - 支付确认', pid: 43, process: 'chrome', class: 'Chrome_WidgetWin_1', x: 0, y: 0, width: 900, height: 700, minimized: false }
        ]),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('AutomationElement]::FromHandle') && script.includes('tree = ')) {
      const shot = /\$shotPath = '([^']+)'/.exec(script)?.[1] ?? ''
      const tree = [
        { depth: 0, path: '', type: 'Window', name: '记事本', id: '', class: 'Notepad', enabled: true, offscreen: false, x: 0, y: 0, width: 800, height: 600, invoke: false, toggle: false, value: false, text: false },
        { depth: 1, path: '0', type: 'Document', name: '正文', id: 'Editor', class: 'Edit', enabled: true, offscreen: false, x: 0, y: 0, width: 800, height: 600, invoke: false, toggle: false, value: false, text: true },
        { depth: 1, path: '1', type: 'Button', name: '保存', id: 'Save', class: 'Button', enabled: true, offscreen: false, x: 0, y: 0, width: 80, height: 30, invoke: true, toggle: false, value: false, text: false }
      ]
      if (shot) {
        mkdirSync(dirname(shot), { recursive: true })
        writeFileSync(shot, ONE_PX_PNG)
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          window: { id: 99, title: '记事本', pid: 42, process: 'notepad', x: 0, y: 0, width: 800, height: 600 },
          tree,
          screenshot: shot ? { path: shot, width: 800, height: 600 } : null
        }),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('TextPattern') && script.includes('payload')) {
      return {
        ok: true,
        stdout: JSON.stringify({ ok: true, text: '正文内容', source: 'text', name: '正文', type: 'Document', path: '0' }),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('InvokePattern') && script.includes('$method')) {
      return {
        ok: true,
        stdout: JSON.stringify({ ok: true, method: 'invoke', name: '保存', type: 'Button', path: '1' }),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('ValuePattern') && script.includes('SetValue')) {
      return { ok: true, stdout: 'OK', stderr: '', exitCode: 0 }
    }
    if (script.includes('Get-StartApps')) {
      return {
        ok: true,
        stdout: JSON.stringify([
          { name: '记事本', target: 'C:/Windows/notepad.exe', args: '', appId: '', source: 'shortcut' },
          { name: 'Visual Studio Code', target: 'C:/Program Files/Microsoft VS Code/Code.exe', args: '', appId: '', source: 'shortcut' }
        ]),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('winget search')) {
      return {
        ok: true,
        stdout: 'Name  Id  Version  Source\nNotepad++  Notepad++.Notepad++  8.9.8.1  winget\n',
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('winget show')) {
      return {
        ok: true,
        stdout: 'Found Notepad++ [Notepad++.Notepad++]\nVersion: 8.9.8.1\nPublisher: Notepad++ Team\nSource: winget\n',
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('winget install')) {
      return { ok: true, stdout: 'Installing...\nWINGET_INSTALL_OK', stderr: '', exitCode: 0 }
    }
    if (script.includes('Invoke-WebRequest')) {
      const path = /\$path = '([^']+)'/.exec(script)?.[1] ?? ''
      if (path) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.alloc(2048, 97))
      }
      const hash = createHash('sha256').update(Buffer.alloc(2048, 97)).digest('hex')
      return {
        ok: true,
        stdout: JSON.stringify({ path, bytes: 2048, sha256: hash }),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('Get-AuthenticodeSignature')) {
      const path = /\$path = '([^']+)'/.exec(script)?.[1] ?? ''
      return {
        ok: true,
        stdout: JSON.stringify({
          path,
          bytes: 2048,
          sha256: 'a'.repeat(64),
          signature: options.signature ?? 'Valid',
          signer: 'CN=Test Publisher',
          thumbprint: 'ABC123'
        }),
        stderr: '',
        exitCode: 0
      }
    }
    if (script.includes('INSTALLER_OK')) {
      return { ok: true, stdout: 'INSTALLER_OK|exe|456', stderr: '', exitCode: 0 }
    }
    if (script.includes('shell:AppsFolder') || (script.includes('$appId =') && script.includes('$proc.Id'))) {
      return { ok: true, stdout: 'OK|exe|123', stderr: '', exitCode: 0 }
    }
    if (script.includes('Start-Process')) {
      return { ok: true, stdout: 'OK|123|notepad', stderr: '', exitCode: 0 }
    }
    if (script.includes('GetForegroundWindow') && script.includes('Title(')) {
      return { ok: true, stdout: '99|记事本|notepad', stderr: '', exitCode: 0 }
    }
    return { ok: true, stdout: 'OK', stderr: '', exitCode: 0 }
  }
  return {
    scripts,
    runtime: {
      platform: 'win32',
      now: () => (now.value += 10),
      runPowerShell: runner,
      minIntervalMs: {
        computer_screenshot: 0,
        computer_click: 0,
        computer_type: 0,
        computer_key: 0,
        computer_list_windows: 0,
        computer_activate_window: 0,
        computer_launch_app: 0,
        computer_observe: 0,
        computer_read: 0,
        computer_invoke: 0,
        computer_set_value: 0,
        computer_drag: 0,
        computer_scroll: 0,
        computer_wait: 0,
        computer_list_apps: 0,
        computer_open_app: 0,
        computer_wait_for_window: 0,
        computer_search_packages: 0,
        computer_package_info: 0,
        computer_install_package: 0,
        computer_download_file: 0,
        computer_run_installer: 0
      },
      maxActionsPerMinute: 200
    }
  }
}

describe('desktop computer use (fake Windows runner)', () => {
  it('@core:computer 列出窗口、隐藏敏感标题并切换普通窗口', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const list = tools.find((tool) => tool.definition.name === 'computer_list_windows')!
      const ctx = makeToolContext(ws)
      const listed = await list.execute({}, ctx)
      expect(listed.ok).toBe(true)
      expect(String(listed.output)).toContain('记事本')
      expect(String(listed.output)).toContain('[敏感窗口已隐藏标题]')
      expect(String(listed.output)).not.toContain('招商银行')

      const activate = tools.find((tool) => tool.definition.name === 'computer_activate_window')!
      const switched = await activate.execute({ title: '记事本' }, ctx)
      expect(switched.ok).toBe(true)
      expect(String(switched.output)).toContain('已切换到窗口')

      const refused = await activate.execute({ title: '招商银行' }, ctx)
      expect(refused.ok).toBe(false)
      expect(String(refused.error)).toContain('敏感')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer 观察后台窗口、生成 ref、读文本并按 ref 操作', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!
      const ctx = makeToolContext(ws, {}, { todos: [], artifacts: [], progressNotes: [] })

      const observed = await byName('computer_observe').execute({ window_id: 99 }, ctx)
      expect(observed.ok, String(observed.error)).toBe(true)
      expect(String(observed.output)).toContain('[e2] Document「正文」')
      expect(String(observed.output)).toContain('[e3] Button「保存」')
      const meta = observed.meta as { screenshotPath: string; refCount: number }
      expect(meta.refCount).toBeGreaterThanOrEqual(3)
      expect(existsSync(meta.screenshotPath)).toBe(true)
      expect(ctx.getArtifacts().some((artifact) => artifact.path === meta.screenshotPath)).toBe(true)

      const read = await byName('computer_read').execute({ ref: 'e2' }, ctx)
      expect(read.ok, String(read.error)).toBe(true)
      expect(String(read.output)).toContain('正文内容')

      const invoked = await byName('computer_invoke').execute({ ref: 'e3', action: 'invoke' }, ctx)
      expect(invoked.ok, String(invoked.error)).toBe(true)
      expect(String(invoked.output)).toContain('invoke')

      const set = await byName('computer_set_value').execute({ ref: 'e2', text: '新的正文' }, ctx)
      expect(set.ok, String(set.error)).toBe(true)
      expect(fake.scripts.some((script) => script.includes('SetValue'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer 支持右键双击、拖拽、滚轮、启动应用与等待', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!
      const ctx = makeToolContext(ws)

      const clicked = await byName('computer_click').execute({ x: 12, y: 18, button: 'right', click_count: 2 }, ctx)
      expect(clicked.ok).toBe(true)
      const clickScript = fake.scripts.at(-1) ?? ''
      expect(clickScript).toContain('mouse_event(0x0008')
      expect(clickScript).toContain('mouse_event(0x0010')
      expect(clickScript).toContain('$i -lt 2')

      const dragged = await byName('computer_drag').execute({ from_x: 10, from_y: 10, to_x: 100, to_y: 120 }, ctx)
      expect(dragged.ok, String(dragged.error)).toBe(true)
      expect(fake.scripts.at(-1)).toContain('mouse_event(0x0002')

      const scrolled = await byName('computer_scroll').execute({ direction: 'down', amount: 2, x: 20, y: 30 }, ctx)
      expect(scrolled.ok, String(scrolled.error)).toBe(true)
      expect(fake.scripts.at(-1)).toContain('0x0800')

      const rejected = await byName('computer_launch_app').execute({ app: 'evil.bat' }, ctx)
      expect(rejected.ok).toBe(false)
      const launched = await byName('computer_launch_app').execute({ app: 'notepad', args: ['a.txt'] }, ctx)
      expect(launched.ok, String(launched.error)).toBe(true)
      expect(String(launched.output)).toContain('PID 123')

      const waited = await byName('computer_wait').execute({ ms: 120 }, ctx)
      expect(waited.ok).toBe(true)
      expect(String(waited.output)).toContain('120ms')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer 应用目录：列举、按名称打开并等待窗口', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!
      const ctx = makeToolContext(ws)

      const listed = await byName('computer_list_apps').execute({ query: '记事本' }, ctx)
      expect(listed.ok, String(listed.error)).toBe(true)
      expect(String(listed.output)).toContain('记事本')
      expect(String(listed.output)).toContain('C:/Windows/notepad.exe')

      const opened = await byName('computer_open_app').execute({ name: '记事本' }, ctx)
      expect(opened.ok, String(opened.error)).toBe(true)
      expect(opened.meta).toMatchObject({ windowId: 99, windowTitle: '记事本' })

      const waited = await byName('computer_wait_for_window').execute({ title: '记事本', timeout_ms: 1000 }, ctx)
      expect(waited.ok, String(waited.error)).toBe(true)
      expect(waited.meta).toMatchObject({ windowId: 99, windowTitle: '记事本' })
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer winget：搜索、查看发布者与按精确 ID 安装', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!
      const ctx = makeToolContext(ws)

      const searched = await byName('computer_search_packages').execute({ query: 'Notepad++' }, ctx)
      expect(searched.ok, String(searched.error)).toBe(true)
      expect(String(searched.output)).toContain('Notepad++.Notepad++')

      const info = await byName('computer_package_info').execute({ id: 'Notepad++.Notepad++' }, ctx)
      expect(info.ok, String(info.error)).toBe(true)
      expect(String(info.output)).toContain('Publisher: Notepad++ Team')

      const badId = await byName('computer_install_package').execute({ id: 'bad id; rm -rf' }, ctx)
      expect(badId.ok).toBe(false)

      const installed = await byName('computer_install_package').execute({ id: 'Notepad++.Notepad++' }, ctx)
      expect(installed.ok, String(installed.error)).toBe(true)
      expect(String(installed.output)).toContain('winget 已完成安装')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer 下载与安装程序：内网拒绝、哈希返回、签名门槛', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!
      const ctx = makeToolContext(ws)

      const rejected = await byName('computer_download_file').execute({ url: 'https://localhost/setup.exe' }, ctx)
      expect(rejected.ok).toBe(false)
      expect(String(rejected.error)).toContain('内网')

      const downloaded = await byName('computer_download_file').execute({ url: 'https://example.com/setup.exe' }, ctx)
      expect(downloaded.ok, String(downloaded.error)).toBe(true)
      const meta = downloaded.meta as { path: string; sha256: string }
      expect(meta.path).toContain('downloads/setup.exe')
      expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(existsSync(join(ws.root, 'downloads', 'setup.exe'))).toBe(true)

      const installed = await byName('computer_run_installer').execute({ path: 'downloads/setup.exe' }, ctx)
      expect(installed.ok, String(installed.error)).toBe(true)
      expect(String(installed.output)).toContain('已启动安装程序')
      expect(installed.meta).toMatchObject({ signature: 'Valid', verified: true })

      const unsigned = createComputerTools(fastRuntime({ signature: 'NotSigned' }).runtime)
      const blocked = await unsigned.find((tool) => tool.definition.name === 'computer_run_installer')!.execute(
        { path: 'downloads/setup.exe' },
        ctx
      )
      expect(blocked.ok).toBe(false)
      expect(String(blocked.error)).toContain('签名不是 Valid')

      const allowed = await unsigned.find((tool) => tool.definition.name === 'computer_run_installer')!.execute(
        { path: 'downloads/setup.exe', allow_unverified: true },
        ctx
      )
      expect(allowed.ok, String(allowed.error)).toBe(true)
      expect(allowed.meta).toMatchObject({ signature: 'NotSigned', verified: false })
    } finally {
      ws.cleanup()
    }
  })

  it('@core:computer 桌面脚本优先 PowerShell 7，可显式覆盖', () => {
    const ws = makeTempWorkspace()
    const previous = process.env.MORROW_POWERSHELL
    try {
      const fake = join(ws.root, 'pwsh.exe')
      writeFileSync(fake, '')
      resetPowerShellExecutableCacheForTests()
      process.env.MORROW_POWERSHELL = fake
      expect(resolvePowerShellExecutable()).toBe(fake)
      delete process.env.MORROW_POWERSHELL
      resetPowerShellExecutableCacheForTests()
      const resolved = resolvePowerShellExecutable()
      if (process.platform === 'win32' && existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')) {
        expect(resolved.toLowerCase()).toContain('pwsh')
      } else if (process.platform === 'win32') {
        expect(resolved.toLowerCase()).toContain('powershell')
      }
    } finally {
      if (previous === undefined) delete process.env.MORROW_POWERSHELL
      else process.env.MORROW_POWERSHELL = previous
      resetPowerShellExecutableCacheForTests()
      ws.cleanup()
    }
  })

  it('@core:computer 只读/演示模式仍然拒绝', async () => {
    const ws = makeTempWorkspace()
    const fake = fastRuntime()
    try {
      const tools = createComputerTools(fake.runtime)
      const observe = tools.find((tool) => tool.definition.name === 'computer_observe')!
      const readonly = await observe.execute({}, makeToolContext(ws, { permissionMode: 'read-only' }))
      expect(readonly.ok).toBe(false)
      expect(String(readonly.error)).toContain('只读')
      const demo = await observe.execute({}, makeToolContext(ws, { permissionMode: 'auto', demo: true }))
      expect(demo.ok).toBe(false)
      expect(String(demo.error)).toContain('演示模式')
    } finally {
      ws.cleanup()
    }
  })
})
