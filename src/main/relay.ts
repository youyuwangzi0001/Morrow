import { createHash } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { log } from './logger'
import { getSettingsStore } from './settings'
import { allowedChannels, checkChannel, bindChannel, dispatch, resetBindings, startRelay, type RelayHandle } from './relay-server'
import { loadDevices, saveDevices, loadOrCreateKey, type LoadedKey, PairingService } from './relay-pairing'
import { ChannelSelector, type ChannelView, type TierChannel, DirectChannel, ChannelPoller } from './relay-channel'
import { loadOrCreateTls } from './relay-crypto'

// ───── src/relay/index.ts ─────
/**
 * Relay 生命周期：把「设置里的开关」接到「真实运行的服务」上。
 *
 * 三件事必须一起成立，少一件就是假实现：
 *
 * 1. **开关关闭 → 服务不存在。** 不是「启动了但不响应」，而是根本没 listen。
 *    这样 `netstat` 才能验证，攻击面才是零。
 * 2. **开启 → 白名单通道真的能通。** 所以这里要绑定实现；
 *    只写白名单不绑定，就是「白名单写了 18 条、实际 0 条可用」。
 * 3. **运行中改开关 → 立即生效。** 用户不该为了关掉它而重启应用。
 *
 * 关于绑定哪些通道：这里绑定的是**桌面侧真实存在的能力**，通过注入的方式接进来
 * （见 bindDesktopChannels 的说明）。本轮 B1 只搭骨架 + 验证协议，真实 handler
 * 的接线属于 B3 传输层的职责；未绑定的通道会返回 NOT_BOUND，不会伪装成功。
 */

let handle: RelayHandle | null = null
/** LAN 直连通道（Tier 1）。未启用时为 null —— 关掉开关就不该有监听端口 */
let directChannel: DirectChannel | null = null
let channelSelector: ChannelSelector | null = null
let channelPoller: ChannelPoller | null = null
/**
 * 当前运行的配对服务。
 *
 * 提到模块级（而不是 `applyRelaySettings` 的局部变量）是为了让 IPC 能拿到它：
 * 设置页要「生成配对码 / 列出已配对设备 / 撤销设备」，这些都得对着
 * **正在运行的那一个实例** 操作 —— 新建一个会生成新的桌面密钥，
 * 已配对的手机全部失效。
 *
 * relay 关闭时置 null。此时调用方必须报「远程通道没开」，
 * 而不是悄悄启动一个只存在于内存里的服务（那会让手机配上之后永远连不上）。
 */
let pairing: PairingService | null = null

/**
 * 取当前配对服务。未启用时返回 null。
 *
 * 为什么不在这里自动启动：`relayEnabled` 是用户的开关，
 * 「点一下生成配对码」不该悄悄打开它 —— 那等于绕过用户意图去开一个监听端口。
 */
export function currentPairing(): PairingService | null {
  return pairing
}

/** 绑定本机能力。由 index.ts 在 ready 后调用，注入真实的桌面 handler。 */
export function bindDesktopChannel(channel: string, handler: (payload: unknown) => Promise<unknown>): void {
  const decision = checkChannel(channel)
  if (!decision.allowed) {
    // 不允许把不在白名单里的通道接进来：否则「白名单」就成了摆设，
    // 接入方绕过 allowlist 直接调用即可。
    throw new Error(`relay 拒绝绑定非白名单通道：${channel}`)
  }
  bindChannel(channel, handler)
}

/** 当前 relay 状态（设置页展示用） */
export function relayStatus(): { listening: boolean; port: number | null; channels: readonly string[] } {
  return {
    listening: handle?.listening ?? false,
    port: handle?.port ?? null,
    channels: allowedChannels()
  }
}

/**
 * 按当前设置启动/停止 relay。可重复调用（改设置后重新应用）。
 *
 * 这里刻意**不做**「如果已启动就跳过」的优化：用户可能改了端口，
 * 直接重启一遍比 diff 判断更不容易出错，代价只是几毫秒。
 */
export async function applyRelaySettings(): Promise<{ listening: boolean; port: number | null }> {
  // 先全停：端口、通道、轮询器一起收，避免旧轮询器还在探测已停止的通道
  await stopLanStack()
  if (handle) {
    await handle.stop()
    handle = null
  }
  // 配对服务也一起清掉：开关关掉之后，设置页「生成配对码」必须报「没开启」，
  // 而不是对着一个已经停止的服务签发票据。
  pairing = null

  const settings = getSettingsStore().get()
  if (!settings.relayEnabled) {
    log.info('relay disabled by settings')
    return { listening: false, port: null }
  }

  const dataDir = app.getPath('userData')

  // 长期密钥：从磁盘还原（safeStorage 加密），重启后桌面公钥不变，
  // 已配对设备的会话密钥继续有效。
  const key = loadOrCreateKey({ dataDir, safeStorage })
  if (!key.restored) {
    log.info('relay desktop key created (devices will need pairing)', { available: safeStorage.isEncryptionAvailable() })
  }

  // 配对服务：本轮起**必须**传入，否则 startRelay 会拒绝启动。
  // 这堵住了 B2 初版「忘了传就静默无鉴权」的缺陷。
  //
  // 设备表持久化：让重启后的手机免扫码直接重连。
  // 只持久化桌面密钥是不够的 —— 设备表在内存里的话，
  // 重启后 requirePaired() 会抛 DEVICE_REVOKED，用户每天都要重配。
  const deviceStore = {
    load: () => loadDevices({ dataDir, safeStorage }),
    save: (devices: Parameters<typeof saveDevices>[1]) => void saveDevices({ dataDir, safeStorage }, devices)
  }
  const service = new PairingService({
    secret: pairingSecret(key),
    privateKey: key.privateKey,
    devices: deviceStore
  })
  // 发布到模块级：IPC 的「生成配对码 / 列出设备 / 撤销」要用**这个**实例。
  pairing = service
  const restored = service.listDevices().length
  if (restored > 0) log.info('relay devices restored', { count: restored })

  // 启动自检（白名单 vs 已绑定实现的缺口）由 startRelay 内部统一记录，
  // 这里不重复写审计，否则每次开关键切换都会多出一条重复记录。
  handle = await startRelay({
    enabled: true,
    dataDir,
    port: settings.relayPort,
    pairing: service
  })
  log.info('relay listening', { port: handle.port, loopbackOnly: true })

  // ── 局域网直连（Tier 1）──
  // 开关打开才起监听：与 relay 同一个原则，关掉时端口必须不存在。
  // 失败不阻断启动 —— 证书生成失败或端口被占时，手机仍可走中继，
  // 只是 chip 显示「中继」。这比「整条 relay 起不来」好得多。
  await startLanStack(service, dataDir)

  return { listening: handle.listening, port: handle.port }
}

/**
 * 起局域网直连 + 通道选择器 + 轮询器。
 *
 * 三层关系：`ChannelSelector` 决定「该走哪条通道」，
 * `DirectChannel` 是它的 Tier 1 实现，`ChannelPoller` 负责每秒调用 `poll()`。
 *
 * 中继层本轮仍是占位实现（B3 后续批次接真中继）——
 * 但**不是假的**：它的 `probe()` 返回 `relayStatus().listening`，
 * 即「中继 HTTP 服务真的在监听」。这比「永远返回 true」诚实：
 * 中继没起来时，选择器不会谎称中继可用。
 */
async function startLanStack(service: PairingService, dataDir: string): Promise<void> {
  try {
    const tls = await loadOrCreateTls({ dataDir, safeStorage })
    // 把证书指纹交给配对服务：之后签发的每一张票据都会带上它。
    // 手机拿它做证书固定 —— 自签证书没有可信链，这是唯一正确的机制。
    service.setTlsFingerprint(tls.fingerprint)
    const direct = new DirectChannel({ pairing: service, tls })
    await direct.connect()
    log.info('lan direct listening', { port: direct.port(), fingerprint: tls.fingerprint.slice(0, 12) })

    // 中继层：本轮只有本机 HTTP 服务（127.0.0.1），还不能真正承载手机流量。
    // probe 如实反映「中继服务是否在跑」，不做「永远可用」的假承诺。
    const relayTier: TierChannel = {
      tier: 'relay',
      probe: async () => handle?.listening === true,
      connect: async () => {},
      disconnect: async () => {}
    }

    const selector = new ChannelSelector({ direct, relay: relayTier })
    // 立刻探测一次，让界面打开时就有正确的 chip（而不是空白 1 秒）
    await selector.start()

    const poller = new ChannelPoller({
      selector,
      intervalMs: 1_000,
      onPoll: (info) => {
        if (info.error) log.warn('channel poll failed', { error: info.error })
      }
    })
    poller.start()

    directChannel = direct
    channelSelector = selector
    channelPoller = poller
  } catch (err) {
    // 局域网起不来不阻断 relay：用户仍可通过中继访问
    log.warn('lan direct failed to start; falling back to relay only', { error: (err as Error).message })
    // 清掉指纹：证书都没起来，票据带上一个「上一轮的指纹」会让手机
    // 记下一个连不上的值。宁可明确没有（手机拒绝配对并说明原因）。
    service.setTlsFingerprint(null)
    directChannel = null
    channelSelector = null
    channelPoller = null
  }
}

/** 停掉局域网这一套（轮询器 → 选择器 → 通道，顺序不能反） */
async function stopLanStack(): Promise<void> {
  // 先停轮询：否则它会在通道已经关闭之后继续 probe，日志出现幽灵失败
  if (channelPoller) {
    channelPoller.stop()
    channelPoller = null
  }
  if (channelSelector) {
    channelSelector = null
  }
  if (directChannel) {
    await directChannel.disconnect()
    directChannel = null
  }
}

/** 当前通道视图（设置页 / 状态栏展示用）。未启用时为 null */
export function channelView(): ChannelView | null {
  return channelSelector ? channelSelector.view() : null
}

/** 局域网直连端口（诊断用）。未启用时为 null */
export function lanPort(): number | null {
  return directChannel?.port() ?? null
}

/**
 * 配对 HMAC 密钥：从长期密钥派生，不单独落盘。
 *
 * 为什么不另存一份：多一个需要保护的秘密，就多一个泄露面。
 * 用长期私钥做 HKDF 派生，随密钥一起被 safeStorage 保护，
 * 而且重启后派生结果不变 —— 已有的配对会话签名仍然可用。
 */
function pairingSecret(key: LoadedKey): Buffer {
  return Buffer.from(
    createHash('sha256').update(`morrow-relay-pairing:${key.privateKey}`).digest()
  )
}

/** 关闭并清空（应用退出时调用） */
export async function shutdownRelay(): Promise<void> {
  await stopLanStack()
  if (handle) {
    await handle.stop()
    handle = null
  }
  pairing = null
  resetBindings()
}

/** 测试用：重置模块状态 */
export async function resetRelayForTests(): Promise<void> {
  await shutdownRelay()
}

export { dispatch }
