import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createECDH, randomBytes } from 'node:crypto'

/**
 * 桌面长期密钥持久化。
 *
 * 为什么必须有：B2 的 `PairingService` 每次构造都 `generateKeys()`，
 * 密钥只活在进程内存里。Morrow 重启后桌面公钥变了，
 * 之前所有手机算出的 ECDH 共享秘密全部失效 —— 用户每次开电脑都要重新扫码配对。
 * 这不是「体验不佳」，是功能不可用：手机端会一直连不上。
 *
 * 设计上的三个约束：
 *
 * **一、私钥落盘必须加密。** 用 Electron 的 `safeStorage`（Windows 走 DPAPI，
 * 绑定当前用户账户）。拿到文件也解不开 —— 明文私钥落盘等于把「曾配对过的所有手机」
 * 的会话密钥交给任何能读文件的进程。
 *
 * **二、safeStorage 不可用时不能明文降级。** 有些 Linux 环境没有 keyring。
 * 这时正确的做法是**拒绝持久化**（返回 null，让上层退化为「本次运行内有效」），
 * 而不是偷偷写明文 —— 那会在用户不知情的情况下降低安全性。
 *
 * **三、写入用临时文件 + 重命名。** 直接写目标文件时若进程中途崩溃，
 * 会留下半个文件，下次启动解析失败 → 又回到「重启要重配」。
 * rename 在同一分区上是原子的。
 */

/** safeStorage 的最小接口（便于测试注入） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface KeyStoreOptions {
  /** 用户数据目录 */
  dataDir: string
  /** Electron safeStorage；测试可注入假实现 */
  safeStorage: SafeStorageLike
}

export interface LoadedKey {
  /** P-256 私钥（未压缩点，base64） */
  privateKey: string
  /** 对应的公钥（base64） */
  publicKey: string
  /** 是否来自磁盘（false = 本次新生成） */
  restored: boolean
}

/** 密钥文件路径：<dataDir>/relay/desktop-key.bin */
export function keyPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'desktop-key.bin')
}

/**
 * 从私钥推导公钥。
 *
 * ECDH 的私钥是标量，公钥 = 标量 × 基点。Node 的 createECDH 支持
 * `setPrivateKey(buf)` 后再 `getPublicKey()`，用它来校验与还原。
 */
function publicFromPrivate(privateKeyBase64: string): string {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateKeyBase64, 'base64'))
  return ecdh.getPublicKey().toString('base64')
}

/**
 * 载入或生成长期密钥。
 *
 * 返回 `restored: true` 表示成功复用磁盘上的密钥（重启后设备仍有效）；
 * `restored: false` 表示新生成（首次运行，或无法安全持久化）。
 */
export function loadOrCreateKey(options: KeyStoreOptions): LoadedKey {
  const path = keyPathIn(options.dataDir)

  // ── 先尝试复用 ──
  if (existsSync(path)) {
    try {
      const encrypted = readFileSync(path)
      if (!options.safeStorage.isEncryptionAvailable()) {
        // 文件存在但当前环境无法解密：不覆盖它（可能是换了用户账户），
        // 本次退化为临时密钥。直接删掉会让用户在换回原账户时永久丢失配对。
        return generateTemporary()
      }
      const privateKey = options.safeStorage.decryptString(encrypted)
      // 校验：能被 setPrivateKey 接受，且能导出公钥
      if (!/^[A-Za-z0-9+/=]+$/.test(privateKey)) return generateTemporary()
      const publicKey = publicFromPrivate(privateKey)
      return { privateKey, publicKey, restored: true }
    } catch {
      // 文件损坏：不阻塞启动，退化为新密钥（旧配对失效，但没有更安全的选项）
      return generateTemporary()
    }
  }

  // ── 没有文件：生成并尝试持久化 ──
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const privateKey = ecdh.getPrivateKey().toString('base64')
  const publicKey = ecdh.getPublicKey().toString('base64')
  const created: LoadedKey = { privateKey, publicKey, restored: false }

  // safeStorage 不可用：**不写明文**，直接返回临时密钥
  if (!options.safeStorage.isEncryptionAvailable()) return created

  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const encrypted = options.safeStorage.encryptString(privateKey)
    // 原子写：临时文件 + rename
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, encrypted, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // 落盘失败不影响本次运行，只是下次要重新配对
    return created
  }
  return created
}

function generateTemporary(): LoadedKey {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    privateKey: ecdh.getPrivateKey().toString('base64'),
    publicKey: ecdh.getPublicKey().toString('base64'),
    restored: false
  }
}

/** 删除持久化密钥（用户主动「解除全部设备」时使用） */
export function deleteKey(dataDir: string): boolean {
  const path = keyPathIn(dataDir)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}