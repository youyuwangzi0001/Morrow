# B1 · morrow-relay 服务骨架

> 轨道 B（远程通道）第 1 张卡。这是整份规划里**唯一需要动桌面仓库**的卡：
> 在 Morrow 桌面端新增一个可选的本地中继服务，让手机能通过它与桌面通信。

## 1. 这张卡要解决什么

手机端要「实时跟盯桌面进度、远程派活」，前提是桌面愿意被远程访问。
这个「愿意」不能是默认打开的 —— 一旦默认开，用户装上 Morrow 就等于在自己机器上
开了个后门。所以 B1 的核心不是「怎么开」，而是**「怎么保证不开的时候真的是关的」**。

蓝图 B1 的四条验收原文：

| # | 验收 | 本文档对应 |
|---|---|---|
| 1 | 开关关闭时端口不监听（netstat 验证） | §4 场景 1、§5 单测 |
| 2 | 开启后只接受白名单通道，非白名单返回 `CHANNEL_DENIED` | §3 白名单、§4 场景 2 |
| 3 | 每次调用写 `relay/audit.jsonl`，不含参数原文 | §3 审计、§4 场景 2 |
| 4 | 默认关闭，需用户在设置里显式开启 | §2 设置、§5 归一化 |

## 2. 交付物

### 新增（桌面仓库 `Morrow/`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/relay/allowlist.ts` | 116 | 17 条白名单通道，每条带放行理由；精确匹配，不做前缀通配 |
| `src/relay/audit.ts` | 87 | 审计写入；只记结构指纹（键名 + 类型 + 长度），不记值 |
| `src/relay/registry.ts` | 75 | 通道 → 实现的绑定表；白名单与实现**双重约束** |
| `src/relay/server.ts` | 183 | HTTP 服务；只绑回环、默认端口 0、2MB 请求体上限 |
| `src/relay/index.ts` | 90 | 生命周期：把设置开关接到真实服务，改设置立即生效 |

### 修改（最小改动，四处）

| 文件 | 改动 | 为什么必须改 |
|---|---|---|
| `src/shared/types.ts` | `Settings` 加 `relayEnabled` / `relayPort` | 没有字段就存不了开关 |
| `src/shared/contracts.ts` | `defaultSettings()` 加两个默认值 | 出厂默认必须关闭 |
| `src/main/settings.ts` | 归一化 + `update()` 白名单 + 赋值校验 | **只加接口字段不够**：`update()` 有字段白名单，不加就存不进去 |
| `src/main/index.ts` | 启动时 `applyRelaySettings()`、退出时 `shutdownRelay()` | 不接线的话，设置里开启了也没人启动服务 |
| `tsconfig.node.json` | `include` 加 `src/relay/**/*.ts` | 不加则类型检查报 TS6307 |

### 测试与验收

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `tests/unit/relay.test.ts` | 22 | 默认关闭、端口监听、白名单、审计、端到端、边界 |
| `tests/unit/relay-settings.test.ts` | 5 | 出厂默认、旧配置升级、真值陷阱、端口收敛、持久化 |
| `tests/unit/relay-lifecycle.test.ts` | 7 | 开关与真实服务的接线（端口可连接性断言） |
| `scripts/verify-relay-netstat.mjs` | 8 | 真实进程 + netstat 外部观察 |

## 3. 三个关键设计决策

### 3.1 白名单：精确匹配，17 条，每条有理由

白名单是整条通道的信任边界。最容易犯的错是写成 `session:*` 这种前缀通配 ——
那样以后新增任何 `session:` 通道都会**自动获得远程授权**，白名单等于失效。

所以这里只做精确匹配，且每条都写明为什么放行：

```
app:bootstrap            冷启动取全量状态，工位页首屏依赖它
session:list             工位页会话列表（只读）
session:load             对话页加载单个会话（只读）
session:rename           会话重命名：可从标题识别，误操作可改回
chat:send                手机发新指令（核心能力）
chat:cancel              停止正在运行的回合，避免失控消耗
permission:respond       审批通过/拒绝（蓝图称手机端最重要功能）
question:respond         回答 Agent 的提问，否则任务会一直等
collaboration:projection 成员卡与总目标卡的数据来源（只读）
collaboration:send-message / stop-task / retry-task
artifact:read / versions / export
plan:approve / reject
```

**刻意不放**的（每条都是真实攻击面）：

| 通道 | 为什么不放 |
|---|---|
| `app:change-data-dir` | 改数据目录 = 把工作区指向任意位置 |
| `app:reset-data-dir` | 误触一次清空全部数据 |
| `app:open-external` | 远程拉起本机程序 |
| `session:delete` / `clear-all` | 手机上误触就毁掉会话历史 |
| `settings:save-provider` | 涉及 API Key，凭据绝不能走远程 |
| `terminal:start-task` | 直接执行本机命令 |

单测里有一项专门验证「危险通道都不在白名单里」，另一项验证「前缀通配会被抓出来」。

### 3.2 审计：只记结构指纹，不记值

蓝图要求「不含参数原文」。这条最容易被做成假实现：看起来写了日志，
实际把整个 payload `JSON.stringify` 进去，于是用户的工作区路径、提示词、
密钥片段全都落盘 —— 这不是审计，是泄密。

所以只记：

```jsonc
{ "at": "...", "channel": "chat:send", "outcome": "ok", "ms": 3,
  "shape": { "sessionId": "string(3)", "prompt": "string(47)" } }
```

键名可以记（来自固定的 payload schema），值一律不记。
单测里塞入 `'这是用户输入的机密提示词-super-secret-token-abc123'`，
断言日志文件里**不含这个字符串**，也不含 `sessionId` 的值。

用 `appendFileSync` 而非异步写：审计的价值在于「即使进程崩了这条记录也在」，
异步写在崩溃场景会丢 —— 而那正是最需要它的时候。

### 3.3 只绑回环 + 默认端口 0

- **`127.0.0.1` 而不是 `0.0.0.0`**。监听 `0.0.0.0` 意味着同网段任何人都能访问，
  而这条通道能「发指令、批权限」—— 等于把电脑交出去。手机是通过后续 B3 的
  WSS 中继接入的，不需要直连这个回环端口。
- **端口默认 0（系统分配）**。固定端口会撞车，且等于把攻击面固化。
  用户可在设置里指定，但归一化会把非法值收敛回 0。

**不在 HTTP 层做鉴权**：鉴权是 B2（配对与密钥协商）的职责。
把鉴权塞进这里会造成两套并存的鉴权逻辑，反而更容易出错。

## 4. 验收结果

### 4.1 netstat 真实验收（`docs/evidence/relay-netstat.log`）

```
PASS  打包 src/relay/server.ts 成功 — 8.8 KB
PASS  关闭时 netstat 无该端口监听 — 47833 无监听
PASS  关闭时不产生审计文件 — 无
PASS  开启后 netstat 出现 47833 — 127.0.0.1:47833 pid=21412
PASS  只绑回环地址（不对局域网开放） — 绑定 127.0.0.1
PASS  白名单通道可达（未绑定返回 NOT_BOUND） — HTTP 500 NOT_BOUND
PASS  非白名单通道被拒绝 — HTTP 403 CHANNEL_DENIED
PASS  调用后写入审计日志 — audit.jsonl
PASS  审计不含请求参数原文 — 3 条

8/8 通过
```

这不是内存断言：脚本把 `src/relay/server.ts` 打成单文件，在**独立子进程**里启动，
父进程用 `netstat -ano` 从系统套接字表读取事实。

### 4.2 单元测试（`docs/evidence/relay-unit.log`）

```
Tests  34 passed (34)
```

分布：relay 22 / settings 5 / lifecycle 7。

## 5. 反向验证（证明断言真的会失败）

单测全绿不代表它们有效。每条关键断言都注入了对应的错误实现，确认会失败：

| 注入的错误 | 结果 | 证明 |
|---|---|---|
| 白名单改成前缀通配 | 4 项失败 | 那条「前缀通配会被抓出来」的断言有效 |
| 审计写入 payload 原文 | 1 项失败 | 「不含参数原文」真的在检查 |
| `enabled=false` 也启动服务 | 3 项失败 | 「默认关闭」真的在检查 |
| 监听 `0.0.0.0` | 1 项失败 | 「只绑回环」真的在检查 |
| 生命周期忽略 `enabled` | 2 项失败 | 「切回关闭端口真的断开」有效 |

### 一处自查发现的「假测试」

`relay-settings.test.ts` 第一版写成「复刻一遍归一化表达式再断言」。
反向验证时把源码 `parsed.relayEnabled === true` 改成 `Boolean(...)`，
测试**照样 4 项全绿** —— 因为它测的是自己抄的一份逻辑，一行源码都没验证。

这是最危险的一类测试：看起来在保护，实际什么都没保护。
改为实例化真实的 `SettingsStore` 并写入真实 `settings.json` 后，
再注入同样的错误，如期报 1 项失败。

**同一轮还因此发现一个真实缺陷**：`update()` 有独立的字段白名单和赋值校验，
只在 `Settings` 接口加字段是不够的 —— 设置页保存时会抛「不支持的设置项：relayEnabled」。
已经四处一起补齐（接口 / 默认值 / 归一化 / update）。

## 6. 已知限制（必须让后续卡知道）

1. **真实 GUI 应用未能验证。** 本机 GUI 模式的 Electron 起不来
   （stdout/stderr 全空、进程立即退出，与 A 轨记录的模拟器问题同源）。
   用户机器上正运行着 Morrow 主实例，单实例锁也会让新实例退出 —— 不能去动它。
   替代方案是「真实子进程 + netstat 外部观察」，验证了套接字事实，
   但**没有验证「桌面应用启动时真的会调 applyRelaySettings」**。
   这一条只能靠代码审查 + 用户实测：开启开关后 netstat 应出现端口。
2. **白名单里 17 条通道，本轮只接了骨架，没有绑定实现。**
   调用会返回 `NOT_BOUND`（不是伪装成功）。真实 handler 的接线属于 B3 传输层。
   启动时 `startRelay` 会写一条 `$startup` 审计记录，说明「白名单 N 条、已绑定 M 条」，
   避免沉默的「以为通了其实没通」。这条记录每次启动都会写（不是只在首次开启时），
   所以用户关掉再打开也能看到当时的缺口。
3. **鉴权未做。** 当前服务假设「只有本机回环能访问」。配对鉴权是 B2 的职责，
   在 B2 完成前，这个端口不应暴露给中继。
4. **HTTP 而非 WSS。** 回环内的明文是可接受的（不出本机），
   跨设备传输必须走 B3 的 WSS 中继。
5. **未做速率限制。** 单用户本机场景暂不需要；若 B3 开放给中继，必须补。

## 7. 与蓝图的偏差

| 蓝图 | 实际 | 原因 |
|---|---|---|
| 「通过 Electron 的 ipcMain 或本机 HTTP 回环调既有 handler」 | 新建独立的 `src/relay/`，用绑定表注入能力 | 现有 100+ handler 直接挂在 `ipcMain` 上，没有「按通道调用」的入口。为了 relay 把全部 handler 重构成注册表，是在改一套稳定代码的架构，风险远大于收益 |
| 设置页开关 | 先落设置字段与生命周期接线，UI 开关留给 C5 设置页 | 手机/桌面设置页 UI 属于 C 组；B1 只保证「字段存在 + 改了立即生效」 |

## 8. 验收命令

```bash
cd Morrow

# 单测（34 项）
npx vitest run tests/unit/relay.test.ts tests/unit/relay-settings.test.ts tests/unit/relay-lifecycle.test.ts

# netstat 真实验收（8 项）
node scripts/verify-relay-netstat.mjs

# 类型检查（必须零错误）
npx tsc -p tsconfig.node.json --noEmit
```

## 9. 交付前审查记录

### 第一轮（写卡时自审）修掉 4 处

1. **白名单理由过短**：`plan:reject` 的理由只有 4 个字，被「每条理由 > 4 字」的断言抓到。
   没有放宽断言，而是把理由补全为「打回计划并说明原因，避免桌面空等」。
2. **假测试**（最重要）：见 §5，测试复刻逻辑而非测真实代码，已重写。
3. **真实缺陷**：`update()` 字段白名单缺失，导致设置存不进去，已四处补齐。
4. **netstat 脚本三次失败**：
   - `npx` 在子进程不可用 → 改用本地 esbuild 入口；
   - ESM 导入 Windows 绝对路径 → 改用 `pathToFileURL().href`；
   - Python 替换把正则写成真实换行导致语法错误 → 改为精确重写该行。

### 第二轮（交付前专项审查）修掉 2 处

审查方式是「用独立探针核对报告里的每条事实性主张」，而不是重读文档。

1. **重复审计 + 报告写错通道名**（真实缺陷）：
   §6 说「启动时写一条 `$bind` 审计记录」，实跑探针发现实际写的是 `$startup`
   —— 而且 `$bind` 与 `$startup` **两处都在写**，都记录「未绑定通道数」：
   `server.ts` 每次启动写 `$startup`，`index.ts` 首次开启写 `$bind`。
   职责重叠，用户开关一次开关就会多出一条重复记录。
   已删掉 `index.ts` 里那段（连同 `boundOnce` 状态与 3 个无用 import），
   统一由 `server.ts` 记录 —— 它每次启动都写，信息不会因为「非首次」而丢失。
   报告 §6 的通道名同步改为 `$startup`。
2. **白名单条数写错**：报告三处写「18 条」，`grep -c '{ channel:'` 实际是 **17 条**。
   已全部改正。这个错危害在于后续卡会按 18 去核对，对不上又得重查。

### 反向验证复跑

§5 表格里的 5 条注入逐条重跑，失败项数与表格完全一致（4 / 1 / 3 / 1 / 2），
全部恢复后 34 项通过。表格不是回忆录，是可复现的。

## 10. 下一张卡

**B2 配对与密钥协商**：二维码票据（TTL 90s）+ 六位人工比对码 + ECDH 会话密钥 + 桌面撤销设备。
验收原文：票据过期后扫码返回 `TICKET_EXPIRED`；六位码不符时拒绝且记录尝试；
配对后票据立即作废（重放失败）；桌面撤销设备后手机在 1 次请求内收到 `DEVICE_REVOKED`。

B1 为它准备了三样东西：`checkChannel()` 的信任边界、`audit.jsonl` 的取证能力、
`bindDesktopChannel()` 的注入点。B2 只需要在这里加一层「请求来自已配对设备」的判定。