import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'

/**
 * LAN WSS 的 TLS 证书管理。
 *
 * 为什么需要它：`DirectChannel` 要起一个 `wss://` 服务，就必须有证书。
 * 如果不提供生成/持久化的入口，调用方只能自己造一个 —— 那就等于
 * 「DirectChannel 只能在测试里用」，是半成品。
 *
 * 三个设计约束：
 *
 * **一、证书必须持久化，不能每次启动重新生成。**
 * 手机在配对时记住桌面证书的指纹（见 `certFingerprint()`），
 * 每次重启换一张新证书 = 每台手机都要重新确认指纹 = 回到「天天重新配对」。
 *
 * **二、私钥加密落盘，证书本身明文。**
 * 证书是公开信息（握手时明文发给对方），加密它没有意义；
 * 私钥必须保护 —— 拿到私钥就能冒充桌面服务端，把手机的请求全部收走。
 * 用与 keystore 同一套 `safeStorage`。
 *
 * **三、`safeStorage` 不可用时不生成落盘证书。**
 * 无法保护私钥时，宁可用「本次运行内有效」的临时证书（手机需要重新确认指纹），
 * 也不能把明文私钥写进文件。
 */

export interface TlsMaterial {
  /** PEM 私钥 */
  key: string
  /** PEM 证书链（自签名时就是一张） */
  cert: string
  /** 证书 SHA-256 指纹（base64url），配对时交给手机做固定 */
  fingerprint: string
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface TlsStoreOptions {
  dataDir: string
  safeStorage: SafeStorageLike
  /** 证书有效期（天）。默认 3650（10 年）—— 这是本机自用证书，不该频繁过期 */
  days?: number
  /** 生成器，测试可注入固定证书 */
  generate?: () => Promise<{ private: string; cert: string }>
}

/** 证书文件路径：<dataDir>/relay/tls.crt（公开） */
export function certPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'tls.crt')
}

/** 私钥文件路径：<dataDir>/relay/tls-key.bin（加密） */
export function tlsKeyPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'tls-key.bin')
}

/** 计算证书指纹。用 DER 而不是 PEM：PEM 的换行/首尾空格会随生成器变化 */
export function certFingerprint(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(body, 'base64')
  return createHash('sha256').update(der).digest('base64url')
}

/**
 * 载入或生成 TLS 材料。
 *
 * 与 `loadOrCreateKey` 的判断顺序一致：先复用，复用不了才生成，
 * 生成后只有在能安全持久化时才落盘。
 */
export async function loadOrCreateTls(options: TlsStoreOptions): Promise<TlsMaterial> {
  const certPath = certPathIn(options.dataDir)
  const keyPath = tlsKeyPathIn(options.dataDir)

  // ── 先尝试复用 ──
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      if (!options.safeStorage.isEncryptionAvailable()) {
        // 文件在但解不开（换用户账户等）：本次用临时证书，不覆盖旧文件
        return generateEphemeral(options)
      }
      const cert = readFileSync(certPath, 'utf8')
      const key = options.safeStorage.decryptString(readFileSync(keyPath))
      if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) {
        return generateEphemeral(options)
      }
      return { key, cert, fingerprint: certFingerprint(cert) }
    } catch {
      return generateEphemeral(options)
    }
  }

  // ── 没有文件：生成并尝试持久化 ──
  const fresh = await runGenerator(options)
  const material: TlsMaterial = {
    key: fresh.private,
    cert: fresh.cert,
    fingerprint: certFingerprint(fresh.cert)
  }

  if (!options.safeStorage.isEncryptionAvailable()) return material

  try {
    const dir = dirname(certPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 证书明文（公开信息）
    writeFileSync(certPath, material.cert, 'utf8')
    // 私钥加密，原子写
    const tmp = `${keyPath}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, options.safeStorage.encryptString(material.key), { mode: 0o600 })
    renameSync(tmp, keyPath)
  } catch {
    // 落盘失败不影响本次运行，只是下次启动会换证书、手机要重新确认指纹
  }
  return material
}

async function generateEphemeral(options: TlsStoreOptions): Promise<TlsMaterial> {
  const fresh = await runGenerator(options)
  return { key: fresh.private, cert: fresh.cert, fingerprint: certFingerprint(fresh.cert) }
}

async function runGenerator(options: TlsStoreOptions): Promise<{ private: string; cert: string }> {
  if (options.generate) return options.generate()
  // 动态 import：selfsigned 只在需要生成证书时加载，
  // 已有多数场景（启动时复用证书）不必付这个代价
  const mod = (await import('selfsigned')) as unknown as {
    generate: (
      attrs: Array<{ name: string; value: string }>,
      opts: Record<string, unknown>
    ) => Promise<{ private: string; cert: string }>
  }
  return mod.generate([{ name: 'commonName', value: 'morrow-lan' }], {
    days: options.days ?? 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          // mDNS 主机名：手机通过 _morrow._tcp.local 找到桌面后，
          // 用它作为 Host 建立 TLS，证书里必须含这个名字，否则主机名校验失败
          { type: 2, value: 'morrow.local' }
        ]
      }
    ]
  })
}
