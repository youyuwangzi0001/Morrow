/**
 * 运行钩子：事件载荷、cwd/环境、退出码 2 阻断、失败不阻断、禁用不执行。
 * 使用临时 userData 与 electron mock；钩子命令为当前 Node 可执行文件 + 临时脚本。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  }
}))

import { getSettingsStore } from '../../../src/main/services/settings-store'
import { runHooks, runPromptHooks } from '../../../src/main/services/hooks'

let root: string
let workspace: string
let outputFile: string
let captureScript: string
let blockScript: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-hooks-'))
  electronState.dataDir = join(root, 'data')
  mkdirSync(electronState.dataDir, { recursive: true })
  workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  outputFile = join(root, 'hook-output.json')
  process.env.HOOK_OUT = outputFile
  captureScript = join(root, 'capture.js')
  blockScript = join(root, 'block.js')
  writeFileSync(
    captureScript,
    `const fs = require('fs')
let data = ''
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.HOOK_OUT, JSON.stringify({
    event: process.env.MORROW_HOOK_EVENT,
    workspace: process.env.MORROW_WORKSPACE,
    cwd: process.cwd(),
    payload: JSON.parse(data)
  }))
})
`,
    'utf8'
  )
  writeFileSync(blockScript, `process.stdout.write('missing version')\nprocess.exit(2)\n`, 'utf8')
})

afterAll(() => {
  delete process.env.HOOK_OUT
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

function commandFor(script: string): string {
  return `"${process.execPath}" "${script}"`
}

function setHooks(hooks: Array<{ id: string; event: 'user_prompt_submit' | 'post_tool_use' | 'run_finished'; command: string; enabled: boolean }>): void {
  getSettingsStore().update({ hooks })
}

describe('运行钩子', () => {
  it('post_tool_use：载荷写入 stdin，cwd 与工作区环境正确，禁用项不执行', async () => {
    setHooks([
      { id: 'capture', event: 'post_tool_use', command: commandFor(captureScript), enabled: true },
      { id: 'disabled', event: 'post_tool_use', command: commandFor(captureScript), enabled: false }
    ])
    rmSync(outputFile, { force: true })
    const results = await runHooks('post_tool_use', { tool: 'read_file', ok: true }, workspace)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ hookId: 'capture', exitCode: 0, timedOut: false })
    const captured = JSON.parse(readFileSync(outputFile, 'utf8')) as {
      event: string
      workspace: string
      cwd: string
      payload: { tool: string }
    }
    expect(captured.event).toBe('post_tool_use')
    expect(captured.workspace).toBe(workspace)
    expect(captured.cwd).toBe(workspace)
    expect(captured.payload.tool).toBe('read_file')
  })

  it('user_prompt_submit：退出码 2 阻止、带出输出并停止后续钩子', async () => {
    rmSync(outputFile, { force: true })
    setHooks([
      { id: 'block', event: 'user_prompt_submit', command: commandFor(blockScript), enabled: true },
      { id: 'after', event: 'user_prompt_submit', command: commandFor(captureScript), enabled: true }
    ])
    const verdict = await runPromptHooks({ text: 'hi' }, workspace)
    expect(verdict.blocked).toBe(true)
    expect(verdict.reason).toContain('missing version')
    expect(existsSync(outputFile)).toBe(false)
  })

  it('非 2 的失败只记录，不阻止发送', async () => {
    const failScript = join(root, 'fail.js')
    writeFileSync(failScript, `process.stderr.write('lint failed')\nprocess.exit(1)\n`, 'utf8')
    setHooks([{ id: 'fail', event: 'user_prompt_submit', command: commandFor(failScript), enabled: true }])
    const verdict = await runPromptHooks({ text: 'hi' }, workspace)
    expect(verdict.blocked).toBe(false)
    const results = await runHooks('user_prompt_submit', { text: 'hi' }, workspace)
    expect(results[0]?.exitCode).toBe(1)
    expect(results[0]?.stderr).toContain('lint failed')
  })
})
