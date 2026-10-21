/**
 * 连接器目录（A3）：经过核对的官方远程端点 / 官方本机 MCP 服务。
 *
 * 原则：
 * - 只收录能给出准确地址或包名的连接器；目录条目会真实写入 mcp.json，不伪造连接成功。
 * - 本机服务需要用户电脑安装 Node.js（npx）；安装前会检测并明确提示。
 * - OAuth 专用远程服务（如 Sentry、Notion 远程）不放进一键目录，避免伪造授权；
 *   用户仍可在已安装页手动填写 OAuth 端点。
 */

export type ConnectorCatalogCategory = 'remote' | 'local'
export type ConnectorCatalogTransport = 'http' | 'stdio'

export interface ConnectorCatalogEntry {
  id: string
  /** MCP server 名称（只能含字母/数字/下划线/点/短横线） */
  name: string
  /** 界面上显示的名称 */
  label: string
  vendor: string
  description: string
  detail: string
  category: ConnectorCatalogCategory
  transport: ConnectorCatalogTransport
  official: boolean
  /** 远程服务地址（http） */
  url?: string
  /** 需要的请求头（Authorization） */
  headerKey?: string
  /** 本机服务需要的环境变量（如 NOTION_TOKEN） */
  envKey?: string
  /** 需要用户填写密钥 */
  requiresToken: boolean
  tokenLabel?: string
  tokenPlaceholder?: string
  tokenHint?: string
  /** 需要用户选择文件夹（filesystem） */
  requiresFolder?: boolean
  /** 本机服务：npx 包参数（不含 -y），例如 ['@modelcontextprotocol/server-memory'] */
  packageArgs?: string[]
  /** 本机服务需要 npx / Node.js */
  requiresNpx: boolean
  /** 连接测试超时（本机首次运行可能需要下载，给足时间） */
  timeoutMs: number
  docsUrl: string
  docsLabel: string
  notes?: string[]
}

export interface ConnectorRuntimeStatus {
  platform: string
  npx: { available: boolean; version?: string }
  /** 检测失败时给用户的可读提示 */
  note?: string
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'github-remote',
    name: 'github',
    label: 'GitHub',
    vendor: 'GitHub 官方',
    description: '搜索仓库、读取 Issue / PR、查看代码与提交。',
    detail: '通过 GitHub 官方在线服务连接。需要 GitHub Token，只保存在本机；Morrow 不会把令牌发给模型。',
    category: 'remote',
    transport: 'http',
    official: true,
    url: 'https://api.githubcopilot.com/mcp/',
    headerKey: 'Authorization',
    requiresToken: true,
    tokenLabel: 'GitHub Token',
    tokenPlaceholder: 'github_pat_… 或 ghp_…',
    tokenHint: '建议只授予需要的仓库和只读权限；令牌会加密保存在本机。',
    requiresNpx: false,
    timeoutMs: 30_000,
    docsUrl: 'https://github.com/github/github-mcp-server',
    docsLabel: 'GitHub MCP 文档',
    notes: ['地址来自 GitHub 官方；如果组织禁用了远程 MCP，请改用 GitHub 官方提供的其他安装方式。']
  },
  {
    id: 'linear-remote',
    name: 'linear',
    label: 'Linear',
    vendor: 'Linear 官方',
    description: '查看与创建 Issue、项目与团队动态。',
    detail: '通过 Linear 官方在线服务连接。使用 API Key，无需在本机安装服务。',
    category: 'remote',
    transport: 'http',
    official: true,
    url: 'https://mcp.linear.app/mcp',
    headerKey: 'Authorization',
    requiresToken: true,
    tokenLabel: 'Linear API Key',
    tokenPlaceholder: 'lin_api_…',
    tokenHint: '在 Linear 的 Settings → API 创建个人 API Key；只保存在本机。',
    requiresNpx: false,
    timeoutMs: 30_000,
    docsUrl: 'https://linear.app/docs/mcp',
    docsLabel: 'Linear MCP 文档'
  },
  {
    id: 'filesystem-local',
    name: 'filesystem',
    label: '文件系统',
    vendor: 'MCP 官方参考服务',
    description: '让 Morrow 通过 MCP 读写你指定的一个文件夹。',
    detail: '官方 filesystem 参考服务。安装时选择一个文件夹，Morrow 只会把该文件夹作为服务参数，不会自动扩大范围。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    requiresFolder: true,
    packageArgs: ['@modelcontextprotocol/server-filesystem'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    docsLabel: 'filesystem 文档',
    notes: ['需要电脑已安装 Node.js。首次安装会下载服务，可能需要一两分钟。']
  },
  {
    id: 'memory-local',
    name: 'memory',
    label: '长期记忆',
    vendor: 'MCP 官方参考服务',
    description: '一份由本地 MCP 服务保存的长期知识图谱。',
    detail: '官方 memory 参考服务，数据只保存在本机。与 Morrow 自带的「记忆中心」不同：这是给 Agent 调用的独立 MCP 工具。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@modelcontextprotocol/server-memory'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    docsLabel: 'memory 文档',
    notes: ['需要电脑已安装 Node.js。']
  },
  {
    id: 'sequential-local',
    name: 'sequential-thinking',
    label: '顺序思考',
    vendor: 'MCP 官方参考服务',
    description: '把复杂问题拆成可检查的思考步骤。',
    detail: '官方 sequential-thinking 参考服务，适合需要显式推理链的任务。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@modelcontextprotocol/server-sequential-thinking'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    docsLabel: 'sequential-thinking 文档',
    notes: ['需要电脑已安装 Node.js。']
  },
  {
    id: 'notion-local',
    name: 'notion',
    label: 'Notion',
    vendor: 'Notion 官方',
    description: '搜索、读取和编辑 Notion 页面与数据库。',
    detail: 'Notion 官方本机 MCP 服务。安装后把你的 Integration Token 填入环境变量；记得在 Notion 中把目标页面共享给这个 Integration。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: true,
    tokenLabel: 'Notion Integration Token',
    tokenPlaceholder: 'secret_… 或 ntn_…',
    tokenHint: '在 Notion 的 Integrations 页面创建内部集成并复制 Token；它只保存在本机。',
    envKey: 'NOTION_TOKEN',
    packageArgs: ['@notionhq/notion-mcp-server'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
    docsLabel: 'Notion MCP 文档',
    notes: ['需要电脑已安装 Node.js。', '安装前请在 Notion 中把相关页面授权给这个 Integration。']
  },
  {
    id: 'playwright-local',
    name: 'playwright',
    label: 'Playwright',
    vendor: 'Microsoft 官方',
    description: '用 Playwright 打开浏览器、截图、点击与读取页面。',
    detail: 'Microsoft 官方 Playwright MCP。与 Morrow 自带浏览器不同：它通过 MCP 工具提供更完整的网页自动化能力。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@playwright/mcp@latest'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    docsLabel: 'Playwright MCP 文档',
    notes: ['需要电脑已安装 Node.js；首次运行可能还需要下载浏览器组件。']
  },
  {
    id: 'context7-local',
    name: 'context7',
    label: 'Context7 文档',
    vendor: 'Upstash 社区',
    description: '查询各类开源库的最新文档与代码示例。',
    detail: 'Context7 的本地 MCP 服务。适合查库文档；安装会运行社区维护的服务，请只在你信任的电脑上使用。',
    category: 'local',
    transport: 'stdio',
    official: false,
    requiresToken: false,
    packageArgs: ['@upstash/context7-mcp'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/upstash/context7',
    docsLabel: 'Context7 文档',
    notes: ['需要电脑已安装 Node.js。', '这是社区服务，不是 Morrow 官方内置工具。']
  }
] as const

export function findCatalogEntry(id: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null
}
