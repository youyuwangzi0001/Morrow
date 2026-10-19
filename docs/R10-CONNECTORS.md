# R10 连接器：MCP 管理面板（G）与 HTTP/SSE 传输（K2）

> 用户批准项：**G MCP 管理 UI + K2 MCP HTTP/SSE + 通用连接器**。
> 实现文件：
> - 核心传输：`src/core/tools/mcp-tools.ts`（stdio / Streamable HTTP / 旧版 HTTP+SSE）
> - 主进程服务：`src/main/services/mcp-service.ts`（配置 CRUD、密钥加密、测试连接、工作区信任）
> - feature IPC：`src/main/features/connectors.ts`（`feature:connectors:*`，11 个频道）
> - 渲染层面板：`src/renderer/src/features/connectors/ConnectorsPanel.tsx` + `connectors-api.ts` + `ConnectorsPanel.css`
> - 测试：`tests/unit/main/mcp-connectors.test.ts`（27 项）+ `tests/unit/core/mcp-tools.test.ts`（stdio 回归）

---

## 1. Lead 挂载契约（一行 import + 一个受控组件）

```tsx
import { ConnectorsPanel } from './features/connectors/ConnectorsPanel'

// 面板是受控组件：Lead 决定入口与 open 状态
<ConnectorsPanel open={connectorsOpen} onClose={() => setConnectorsOpen(false)} />
// 可选：显式指定工作区；不传时自动取当前会话工作区 / 最近工作区
<ConnectorsPanel open={open} onClose={close} workspace={currentWorkspace} />
```

- **props**：`{ open: boolean; onClose: () => void; workspace?: string | null }`
- **不修改** Settings/App/Sidebar：面板自己用全局 `Modal`（`src/renderer/src/ui`）渲染，样式只用 tokens。
- **不修改 central ipc/preload/feature-ipc**：走 Lead 已建好的 `window.morrow.features.invoke` 窄 IPC。
- Lead 只需在 `src/main/features/index.ts` 的 `registerFeatureModules()` 里加 `import './connectors'`（import 即注册）。
- 建议入口：设置弹窗新增「连接器」tab，或侧栏/命令面板打开；任选，面板不依赖挂载位置。

渲染层 API 封装在 `connectors-api.ts`（类型 + `feature:connectors:*` 频道常量），面板不直接拼 IPC 字符串。

---

## 2. feature IPC 契约（`window.morrow.features.invoke`，统一 `Result<T>`）

| 频道 | payload | 返回 |
| --- | --- | --- |
| `feature:connectors:list` | `{ scope: 'user'\|'workspace', workspace? }` | `ConnectorListResult`（视图已掩码；工作区级含 `workspaceTrust`） |
| `feature:connectors:get` | `{ scope, name, workspace? }` | `ConnectorView \| null` |
| `feature:connectors:save` | `{ scope, workspace?, originalName?, name, transport, command?, args?, cwd?, url?, env?, headers?, timeoutMs?, retries?, allowPrivateNetwork?, description?, enabled? }` | `{ connector, warnings, secretStorage }` |
| `feature:connectors:delete` | `{ scope, name, workspace? }` | `{ deleted, removedSecrets }` |
| `feature:connectors:set-enabled` | `{ scope, name, enabled, workspace? }` | `ConnectorView` |
| `feature:connectors:test` | `{ scope, workspace?, name? }` 或 `{ scope, workspace?, draft }` | `ConnectorTestResult`（ok/latency/tools/error/hint/blockedReason） |
| `feature:connectors:tools` | `{ scope, name, workspace? }` | 同 test（只取工具列表） |
| `feature:connectors:templates` | `{}` | `ConnectorTemplate[]`（全部 `exampleOnly: true`） |
| `feature:connectors:paths` | `{ workspace? }` | `{ dataDir, userConfigPath, secretsPath, trustPath, workspaceConfigPath, secretStorage }` |
| `feature:connectors:trust-workspace` | `{ workspace }` | `WorkspaceTrustStatus`（把当前配置内容哈希登记为信任） |
| `feature:connectors:secret-status` | `{}` | `{ mode: 'encrypted'\|'plaintext-fallback', secretsPath }` |

边界校验（feature 层）：payload 必须是对象；`scope` 枚举；workspace 级必须给 workspace；名称 64 字符以内且 `[A-Za-z0-9][A-Za-z0-9_.-]*`；args 数组或按行字符串；env/headers 每项 `{key, value?}`、key 合法、value ≤8192；transport 枚举；timeout/retries 范围。非法参数 → `Result.ok=false`，不透传到服务层。

### ConnectorView（渲染层能看到什么）

```ts
{
  scope, name, transport: 'stdio'|'http'|'sse', enabled,
  description?, timeoutMs?, retries?, allowPrivateNetwork,
  command?, args?, cwd?, url?,
  env: [{ key, masked: '••••••••', hasSecret, plaintext }],
  headers: [{ ...同上 }],
  configPath, warnings, secretStorage: 'encrypted'|'plaintext-fallback'
}
```

**没有明文密钥、没有 reveal 频道**。渲染层只能写新值；已保存的值永远不回显。

---

## 3. 配置文件格式（用户级 / 工作区级）

路径优先级（core 运行时读取）：

1. 环境变量 `MORROW_MCP_CONFIG`（指向文件）；
2. `<dataDir>/mcp.json`（用户级；管理面板默认写这里）；
3. `<workspace>/.morrow/mcp.json`（工作区级；管理面板可写，需信任）。

`<dataDir>` = `app.getPath('userData')`（主进程 `installMcpRuntimeEnv()` 注入 `MORROW_DATA_DIR`；便携版/`--data-dir=` 规则一致）。

```json
{
  "mcpServers": {
    "local-filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["C:\\tools\\fs-server.mjs", "C:\\work"],
      "cwd": "C:\\work",
      "env": { "API_KEY": "$MORROW_SECRET:user/local-filesystem/env/API_KEY" },
      "timeoutMs": 15000
    },
    "remote-mcp": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "$MORROW_SECRET:user/remote-mcp/headers/Authorization" },
      "retries": 2,
      "allowPrivateNetwork": false
    },
    "legacy-sse": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

字段：
- `transport`：`stdio` | `http`（Streamable HTTP）| `sse`（旧版 HTTP+SSE）；省略时按 `url`/`command` 推断。
- stdio：`command`（必填）、`args`、`env`、`cwd`、`timeoutMs`。
- http/sse：`url`（必填，仅 http/https）、`headers`、`timeoutMs`、`retries`（0–5，瞬时网络错误/断线重连）、`allowPrivateNetwork`。
- 通用：`disabled`、`description`。
- `timeoutMs` 范围 250–120000，默认 15000。

模板（filesystem / memory / fetch / generic HTTP / generic SSE）**只是配置示例**：`exampleOnly: true`，Morrow 不内置、不托管、不伪造这些服务。

---

## 4. 传输实现（K2）

### stdio
保持 R8 行为：spawn command → `initialize` → `notifications/initialized` → `tools/list` / `tools/call`，每行一条 JSON-RPC；超时 kill 进程树；stderr 只留末尾 4KB 诊断。

### Streamable HTTP（MCP 2025-03-26）
- 单个 endpoint，POST JSON-RPC；`Accept: application/json, text/event-stream`；
- 响应支持 `application/json` 与 `text/event-stream`（从 SSE `message` 事件里取对应 id 的结果）；
- 捕获并回传 `Mcp-Session-Id`（后续请求带上）；`202/204` 用于通知；
- 不跟随重定向（3xx 直接报错，防被跳到内网）；
- 连接/请求超时、外部 AbortSignal 取消、响应体上限 2MB；
- `initialize` 与 `tools/list` 为幂等请求，可重试（`retries`）；`tools/call` 不自动重试，避免重复副作用。

### 旧版 HTTP+SSE
- GET SSE 流等待 `event: endpoint` 得到 POST endpoint；
- POST JSON-RPC，响应从 SSE `event: message` 回到 pending 请求；
- 监听流断开后按指数退避自动重连（`retries` 次）；重连期间挂起请求以 `network` 错误失败并提示重试，不猜成功；
- 断线/协议错误/超时都会清理流与等待中的请求。

### 错误分类（给 UI 的 `blockedReason` / 给模型的 hint）
`config`（配置/协议白名单）→ invalid-config；`ssrf-blocked`；`http-status`（401/403 提示配置请求头）；`network`；`timeout`；`protocol`；`tool-error`；`aborted`。

### 未额外实现「通用 HTTP request 工具」
本项任务标记为可选：为避免模型用任意 HTTP 方法绕过 SSRF/审批边界，**没有**新增通用 `http_request` 工具。只读网页有 `web_fetch`（仅 GET、SSRF 防护、默认 ask），外部操作走 MCP 工具（每次 ask）。如未来需要，必须默认 ask 且复用同一套 URL 安全校验。

---

## 5. 安全矩阵

| 风险 | 处理 |
| --- | --- |
| 非 HTTP 协议 / `file://` / `javascript:` / `data:` | 配置校验阶段直接拒绝（`normalizeMcpServerInput` + `validateMcpServerUrl`） |
| URL 内嵌账号密码 | 拒绝；凭据只能用 headers（加密存储） |
| localhost / 127/8 / 10/8 / 172.16/12 / 192.168/16 / 169.254/16 / CGNAT / IPv6 本地 | 默认拒绝（SSRF），DNS 解析后逐个 IP 校验；需用户显式 `allowPrivateNetwork=true`（面板有风险说明）才能连本机 |
| 重定向跳内网 | 不跟随 HTTP 重定向，3xx 直接报错 |
| 响应过大/协议脏数据/卡死 | 2MB 响应上限、SSE 单条 512KB、事件行 256KB、请求超时、abort 取消、SSE 重连上限 |
| 密钥泄露给渲染层 | 视图只返回掩码；无 reveal IPC；密钥只写不读 |
| 密钥落盘 | Electron `safeStorage`（Windows DPAPI）加密到 `<dataDir>/mcp-secrets.json`（0600）；不可用时降级为 `plaintext-fallback` 并在面板显著警告 |
| 工作区配置供应链攻击 | `.morrow/mcp.json` 默认不信任、不自动启动；面板保存/手动信任时登记 `<dataDir>/mcp-trust.json` 的「工作区路径 → 配置内容 sha256」；仓库改配置后哈希失效，需重新信任 |
| 外部调用越权 | `mcp_call` 仍是 `exec + high`，每次调用走权限审批；`mcp_list` 只列清单 |
| 配置注入（换行/非法键） | env/headers key 与 value 校验，拒绝换行、超长、非法键名 |
| MCP server 本身是任意代码 | 只保证配置来源可信 + 用户显式测试/保存 + 每次调用审批 + 进程/连接清理；不沙箱化 server（文档明示） |

---

## 6. 测试

```bash
npx vitest run tests/unit/main/mcp-connectors.test.ts tests/unit/core/mcp-tools.test.ts
```

`tests/unit/main/mcp-connectors.test.ts`（27 项，全部离线）：
- 配置规范化/校验：stdio/http/sse 推断、协议白名单、userinfo、名称、timeout/retries、env/headers 过滤与密钥标记；
- URL 安全：localhost/回环/私网/IPv6、DNS 注入解析到内网、`allowPrivateNetwork`、未授权时连接前拒绝；
- Streamable HTTP：JSON 响应、SSE 响应、Mcp-Session-Id、工具错误、401、不可达；
- 旧版 SSE：endpoint/initialize/list/call；
- 超时、AbortSignal 取消；
- stdio 回归（mock stdio server）；
- 管理服务：保存后 mcp.json 只有 `$MORROW_SECRET:` 标记、secrets 文件无明文、视图掩码、测试连接解密后真实连接、启停、改名密钥迁移、删除清理密钥、草稿测试不写盘、SSRF 草稿拒绝；
- 工作区级：写入 `.morrow/mcp.json`、信任登记、core `loadMcpConfig` 按哈希信任、篡改后失效、手动重新信任；
- feature IPC：list/save/test/set-enabled/templates/secretStatus 正常路径 + 非法参数被边界校验拦下；
- 密钥存储：safeStorage 加密模式 + plaintext 回退模式标记。

`tests/unit/core/mcp-tools.test.ts`（23 项）：R8 stdio/配置/权限语义回归；原「HTTP 暂不支持」断言已更新为「HTTP 已支持，连接失败时明确诊断」。

### E2E（真实 Electron，`tests/e2e/r10-connectors.spec.ts`，2 项）

```bash
npm run build
npx playwright test tests/e2e/r10-connectors.spec.ts
```

- 打开 TitleBar 扳手 → 工作台 → 「连接器」卡片（验证 Lead 挂载）；
- 面板 UI 添加 Streamable HTTP 连接器：未勾选「允许本机/内网」时测试连接被 SSRF 拒绝（`ssrf-blocked`），勾选后连接成功并显示 echo/list_items 工具；
- 保存后验证磁盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记、密钥文件无明文、IPC 视图全掩码；
- 再次测试已保存连接器：主进程解密 `Authorization` 并真实发到本地 mock server（含 `Mcp-Session-Id`）；
- 启停开关真实写盘；`file://` URL 被配置校验拒绝；删除后配置与密钥都清理；
- 工作区级：未打开工作区时明确提示，`paths` 返回 `workspaceConfigPath: null`；
- 截图：`docs/verification/screens/r10-connectors-panel.png`、`r10-connectors-tools.png`。

E2E 曾抓到一个集成缺口：`main/index.ts` 只 import 未调用 `installMcpRuntimeEnv()`（导致 core 的数据目录注入与全局密钥解析器缺失）；已在 `docs`/完成消息中报给 Lead。面板侧对「测试连接」做了服务内解密兜底，但 Agent 运行时仍需要主进程补那一行调用。

---

## 7. 残余风险

1. **safeStorage 不可用**（部分 Linux 无 keyring）：降级明文存储，面板会警告；若安全要求高，建议改为不保存密钥、只从环境变量读取。
2. **URL 查询参数中的密钥**：`url` 以明文存于 mcp.json（面板不把 query 当密钥）；带 token 的 URL 请改用 headers。
3. **MCP server 信任模型**：stdio 配置等价于本机执行命令；HTTP/SSE 配置等价于向该地址发请求。目前没有 OAuth 授权流程/证书自定义/代理配置。
4. **工作区信任的 TOCTOU**：信任绑定配置内容哈希，但「读取配置→建立连接」之间文件若被并发替换存在极短窗口；高风险环境建议只用用户级配置。
5. **SSE 旧版传输**：重连只恢复监听流，挂起的请求会失败并要求重试；有状态 server 需自行处理。
6. **通用 HTTP 请求工具**：明确未提供（见 §4），避免绕过审批/SSRF 边界。
7. **UI 入口未挂载**：面板已完成但按分工由 Lead 挂到 Settings/App；挂载前用户无法从界面打开（IPC 与面板代码均已就绪）。

---

## 8. 与 R8 文档的关系

R8 的 `docs/EXTERNAL-TOOLS.md` 描述的 stdio 配置、`mcp_list`/`mcp_call` 工具语义、审批规则继续有效；本文档补充 R10 新增的 HTTP/SSE 传输、管理面板、密钥加密与工作区信任。两处冲突时以本文档为准（R8 文档已加注 R10 更新提示）。
