import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthesizeCloudSpeech } from '../../../src/main/studio/audio'

describe('云端配音', () => {
  let server: Server | null = null
  let dir = ''

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('向兼容 /audio/speech 的接口发送真实请求并写入音频', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-cloud-tts-'))
    let captured: Record<string, unknown> | null = null
    let auth = ''
    server = createServer((req, res) => {
      auth = String(req.headers.authorization ?? '')
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        captured = JSON.parse(body) as Record<string, unknown>
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
        res.end(Buffer.alloc(4096, 1))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const output = join(dir, 'voice.mp3')
    await synthesizeCloudSpeech({
      text: '今天不修伞。',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'alloy',
      outputPath: output,
      workDir: dir
    })
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(output).length).toBe(4096)
    expect(auth).toBe('Bearer sk-test')
    expect(captured).toMatchObject({ model: 'tts-1', input: '今天不修伞。', voice: 'alloy', response_format: 'mp3' })
  })

  it('接口报错时抛出包含状态码的信息', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-cloud-tts-'))
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid key' }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await expect(synthesizeCloudSpeech({
      text: '台词',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'bad',
      model: 'tts-1',
      voice: 'alloy',
      outputPath: join(dir, 'voice.mp3'),
      workDir: dir
    })).rejects.toThrow(/HTTP 401/)
  })
})
