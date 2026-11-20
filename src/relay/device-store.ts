import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isWellFormedDevice, type PairedDevice } from './pairing'
import type { SafeStorageLike } from './keystore'

/**
 * 已配对设备表持久化。
 *
 * 为什么必须有：B3 第一批只让**桌面公钥**跨重启不变，设备表仍在内存里。
 * 探针实测：配对 1 台 → 重启 → `listDevices()` 返回 0 台，`requirePaired()` 抛
 * `DEVICE_REVOKED`。用户的观感就是「每天开电脑都要重新扫码」——
 * 这不是体验问题，是功能不可用。
 *
 * 三个安全约束：
 *
 * **一、必须加密，不能明文落盘。** 设备表里存着每台手机的 `sessionKey`，
 * 它足以伪造该设备的全部请求签名（见 pairing.ts 的 verifyRequest）。
 * 明文落盘等于把「冒充任意已配对手机」的能力交给任何能读文件的进程。
 * 用 safeStorage（Windows DPAPI，绑定当前用户账户）。
 *
 * **二、`safeStorage` 不可用时不降级为明文。** 读不出就当作空表，
 * 让用户重新配对 —— 宁可麻烦，也不能悄悄降低安全性。
 *
 * **三、撤销必须立即落盘。** 这是本文件里最容易漏、后果最严重的一条：
 * 如果 `revokeDevice()` 只删内存不写盘，应用重启后那台被撤销的设备
 * 会从文件里「复活」，等于撤销从来没发生过。用户的直觉是「我踢掉它了」，
 * 而系统在下次启动时又把它请回来 —— 这是真实的安全漏洞，不是体验瑕疵。
 */

/** 文件格式版本，便于以后迁移 */
const STORE_VERSION = 1

interface StoreFile {
  v: number
  devices: PairedDevice[]
}

/** 设备表文件路径：<dataDir>/relay/devices.bin */
export function devicesPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'devices.bin')
}

export interface DeviceStoreOptions {
  dataDir: string
  safeStorage: SafeStorageLike
}

/**
 * 读取设备表。
 *
 * 任何异常都退化为空表 —— 设备表损坏不该让整个 relay 启动失败，
 * 用户重新配对即可恢复。但**不覆盖**损坏的文件：
 * 万一只是临时读失败（比如换回原用户账户），旧数据还有救。
 */
export function loadDevices(options: DeviceStoreOptions): PairedDevice[] {
  const path = devicesPathIn(options.dataDir)
  if (!existsSync(path)) return []

  if (!options.safeStorage.isEncryptionAvailable()) return []

  try {
    const encrypted = readFileSync(path)
    const json = options.safeStorage.decryptString(encrypted)
    const parsed = JSON.parse(json) as Partial<StoreFile>
    if (parsed?.v !== STORE_VERSION || !Array.isArray(parsed.devices)) return []
    // 逐条校验形状：损坏的条目直接丢弃，而不是让整个表失效
    return parsed.devices.filter(isWellFormedDevice)
  } catch {
    return []
  }
}

/**
 * 写入设备表（全量覆盖）。
 *
 * 用临时文件 + rename 保证原子性：直接写目标文件时若进程崩在中间，
 * 会留下半个文件，下次启动解析失败 → 回到「每次都要重配」。
 *
 * @returns 是否成功落盘（false 表示只存在内存里，重启会丢）
 */
export function saveDevices(options: DeviceStoreOptions, devices: PairedDevice[]): boolean {
  if (!options.safeStorage.isEncryptionAvailable()) return false

  const path = devicesPathIn(options.dataDir)
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const payload: StoreFile = { v: STORE_VERSION, devices }
    const encrypted = options.safeStorage.encryptString(JSON.stringify(payload))

    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, encrypted, { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 清空设备表（用户「解除全部设备」） */
export function clearDevices(options: DeviceStoreOptions): boolean {
  const path = devicesPathIn(options.dataDir)
  if (!existsSync(path)) return true
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}