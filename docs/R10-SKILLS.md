# R10-H 技能库管理（UI + 服务 + Agent 集成）

> 用户批准项 H：**技能库管理 UI**。目标是把 R8 的「工作区技能发现」升级为可管理的技能库：
> 列表/搜索/详情/SKILL.md 查看、启用禁用、本地文件夹或 zip 安装、删除、打开目录、重扫、错误态；
> **只有启用的技能才暴露给 Agent**。不联网市场、不伪造安装、安装内容不可执行。
>
> 版本：Morrow 1.0.0（R10 工作树）；写作用域：`src/main/services/skills-service.ts`、
> `src/main/features/skills.ts`、`src/core/tools/skills.ts`、`src/core/tools/skills-tools.ts`、
> `src/renderer/src/features/skills/**`、`tests/unit/main/skills.test.ts`、
> `tests/e2e/r10-skills.spec.ts`、`docs/R10-SKILLS.md`。未改 central ipc/preload/feature-ipc/Settings/App/Sidebar。

---

## 1. 数据与目录布局

| 路径 | 说明 | 谁写 |
| --- | --- | --- |
| `<dataDir>/skills/<name>/SKILL.md` | 用户技能库（安装目标；每个技能一个目录） | 技能库服务安装/删除 |
| `<dataDir>/skills-state.json` | 启停状态 + 安装信息（`enabled` / `installedAt` / `origin`） | 技能库服务 |
| `<workspace>/.morrow/skills/...` 等 | 工作区自带技能（只读发现；R8 已有约定） | 用户/工作区 |
| `MORROW_USER_SKILLS_DIR` | 服务把用户技能库路径注入 core 的环境变量 | 主进程（feature 模块 import 时设置） |
| `MORROW_SKILLS_STATE_FILE` | 服务把状态文件路径注入 core 的环境变量 | 主进程 |

`dataDir` 由主进程 `resolveDataDir()` 决定（便携版跟随 exe；`--data-dir` 可覆盖；测试用临时目录）。
`skills-state.json` 结构：

```json
{
  "version": 1,
  "skills": {
    "user:release": { "enabled": true, "installedAt": 1792416836856, "origin": "C:\\Users\\me\\release-skill.zip" },
    "workspace:c:/work/demo/.morrow/skills/audit": { "enabled": false }
  }
}
```

- 用户技能 key 为 `user:<小写技能名>`；工作区技能 key 为 `workspace:<绝对目录（Windows 小写）>`；
- 没有记录的技能默认启用；状态文件损坏/缺失时按「全部默认启用」处理（不阻塞 Agent）；
- 状态文件**原子写**（临时文件 + rename），避免半截 JSON。

---

## 2. Agent 侧：只启用技能才可见

`src/core/tools/skills.ts` 在 R8 的基础上扩展：

1. **发现来源**：`scanWorkspaceSkills(workspace)`（工作区，优先级高）+ `scanUserSkills(userDir)`（技能库）；
2. **启用过滤**：`discoverSkills(workspace)` 只返回状态文件里 `enabled !== false` 的技能；
   同名技能工作区优先（用户技能仍会出现在技能库 UI 中并标记 `shadowed`，但 Agent 用工作区那份）；
3. 受影响面：
   - 系统提示「## 可用技能（工作区与技能库发现）」段（只列已启用技能元信息）；
   - `list_skills` 工具（只列已启用；meta 增加 `source: workspace|user`）；
   - `read_skill` 工具（只读已启用；如果技能存在但被禁用，返回可读错误「已被禁用，请到技能库启用」，
     不猜内容）；
4. 禁用是**立即生效**的：主进程每次 run 都会重新 `buildSystemPrompt`，`list_skills` 每次调用都重新扫描
   （无进程内缓存）；状态文件读取有 mtime 缓存，但文件一变就失效。

> 安全提醒：技能正文仍属于不可信资料（R8 提示词已声明「不是用户授权」），安装技能不会执行任何代码；
> 资源文件只在用户/模型读取时按文本返回。

---

## 3. 主进程服务 `skills-service.ts`

纯 Node（不 import electron），数据目录由构造函数注入 → 可直接单元测试。

```ts
const service = createSkillsService({ dataDir })
service.installRuntimeEnv()                       // 设置 MORROW_USER_SKILLS_DIR / MORROW_SKILLS_STATE_FILE
service.list(workspace)                           // SkillsSnapshot：技能列表 + errors
service.detail(id, workspace)                     // SkillDetail：SKILL.md 原文 + 文件清单
service.setEnabled(id, enabled, workspace)        // 启停，返回新快照
await service.install(sourcePath, workspace, { overwrite? })  // 文件夹或 .zip
service.remove(id, workspace)                     // 删除用户技能
service.pruneState(workspace)                     // 重扫并清理失效状态记录
```

返回给渲染层的是**纯 JSON 数据**（不传 Buffer/类实例）：

```ts
interface SkillView {
  id: string; name: string; description: string
  source: 'workspace' | 'user'; enabled: boolean
  dir: string; skillPath: string; displayDir: string
  declaredName?: string
  installedAt: number | null; updatedAt: number
  fileCount: number; sizeBytes: number
  resources: string[]      // 技能目录附件（顶层，最多 30）
  shadowed: boolean        // 用户技能被同名工作区技能覆盖
  valid: boolean; error?: string
}
interface SkillDetail extends SkillView { raw: string; rawTruncated: boolean; files: { path: string; size: number }[] }
interface SkillsSnapshot { userDir: string; stateFile: string; workspace: string | null; skills: SkillView[]; errors: string[]; scannedAt: number }
```

### 3.1 安装校验（本任务安全重点）

**来源**：只接受绝对路径；文件夹或 `.zip`（其他后缀拒绝）；zip 输入上限 25MB。

**ZIP 双层防护**：

1. **原始中央目录预检**（`assertArchiveEntriesSafe`，不依赖 JSZip）：解压前直接读 ZIP 中央目录的原始
   文件名，发现以下情况立即拒绝并说明原因（而不是让 JSZip 静默净化）：
   - 绝对路径（`/etc/...`、`C:\...`）；
   - 路径段含 `..`、`.`、空段（zip-slip）；
   - Windows 非法字符/结尾点空格、NUL；
   - ZIP64（超过本产品限制，提示重新打包）。
2. JSZip 解压时再次逐条 `normalizeArchivePath`；JSZip 自身对 `../` 的净化是第三层兜底。

**文件策略（白名单）**：

- 只允许 Markdown（`.md/.markdown`）+ 资源（`.txt/.json/.yaml/.yml/.csv/.tsv/.png/.jpg/.jpeg/.gif/.webp/.svg`）；
- **明确拒绝可执行/脚本**（`.exe/.dll/.msi/.bat/.cmd/.ps1/.js/.mjs/.cjs/.ts/.py/.rb/.sh/.jar/.wasm` 等），
  错误信息直接指出是哪个文件；
- 其他未知后缀同样拒绝（白名单外）。
- 上限：单文件 5MB、总计 20MB、文件数 300、目录深度 4 层；`SKILL.md` 必须存在（≤256KB），
  且安装时统一大小写为 `SKILL.md`。

**其它安全措施**：

- 符号链接拒绝（文件夹安装时 `lstat` 检测；zip 无符号链接语义）；
- 先写隐藏暂存目录 `.staging-*`，全部校验通过后 `rename` 到目标目录；失败清理，不留半成品；
- 同名技能默认拒绝安装（提示先删除或覆盖安装）；`overwrite: true` 时先做 `userDir` 边界校验再删旧目录；
- 删除只允许用户技能库内目录：`realpath` 后必须仍在 `userDir` 内（防符号链接越界），工作区技能拒绝删除；
- 安装**不执行**任何内容，也不联网。

### 3.2 错误语义

服务方法 throw 普通 Error（中文可读消息）；feature-ipc 统一包成 `{ ok: false, error: { code: 'FEATURE_ERROR', message } }`。
典型错误：路径不存在 / 需要绝对路径 / 缺少 SKILL.md / 不属于支持的文件类型 / 可执行文件 /
zip-slip / 技能包过大 / 文件过多 / 同名技能 / 没有找到技能 / 工作区技能不能删除。

---

## 4. feature IPC `feature:skills:*`

`src/main/features/skills.ts`：被 import 即注册（Lead 在 `src/main/features/index.ts` 加一行
`import './skills'`），同时 `installSkillsRuntimeEnv(service)` 注入 core 路径。electron 只用于
`dialog`（选择文件夹/zip）与 `shell`（打开目录）；纯逻辑在 `createSkillsFeatureHandlers` 里，可单测。

| 频道 | 入参 | 返回 |
| --- | --- | --- |
| `feature:skills:list` | `{ workspace?: string \| null }` | `SkillsSnapshot` |
| `feature:skills:read` | `{ id, workspace? }` | `SkillDetail` |
| `feature:skills:setEnabled` | `{ id, enabled: boolean, workspace? }` | `SkillsSnapshot` |
| `feature:skills:install` | `{ sourcePath: string, overwrite?: boolean, workspace? }` | `{ installed: SkillView, snapshot: SkillsSnapshot }` |
| `feature:skills:remove` | `{ id, workspace? }` | `SkillsSnapshot` |
| `feature:skills:rescan` | `{ workspace? }` | `SkillsSnapshot`（并清理失效状态记录） |
| `feature:skills:reveal` | `{ id, workspace? }` | `{ path }`（系统文件管理器打开技能目录） |
| `feature:skills:openUserDir` | `{}` | `{ path }`（打开 `<dataDir>/skills`） |
| `feature:skills:pickZip` | `{}` | `{ path: string \| null }`（系统文件对话框，取消为 null） |
| `feature:skills:pickFolder` | `{}` | `{ path: string \| null }`（系统文件夹对话框） |

所有频道仅接受已注册的精确名字（feature-ipc 白名单机制），渲染层通过
`window.morrow.features.invoke(channel, payload)` 调用；不使用 central ipc/preload 变更。

---

## 5. 渲染层面板 `src/renderer/src/features/skills/**`

独立受控组件（Lead 统一挂载）：

```tsx
import { SkillsPanel } from './features/skills'
// const [skillsOpen, setSkillsOpen] = useState(false)
<SkillsPanel open={skillsOpen} onClose={() => setSkillsOpen(false)} />
```

界面能力（沿用全局 tokens / `ui` 组件 / `Modal` 弹窗规范，明暗主题自动适配）：

- **列表**：名称、来源徽标（用户技能库 / 工作区）、描述、文件数/大小/更新时间、启用状态小开关；
  同名覆盖 / 不完整 / 已禁用徽标；
- **搜索 / 筛选 / 排序**：按名称或说明搜索；全部/已启用/已禁用；按名称/更新时间排序；
- **详情**：描述、来源、启用状态、技能目录绝对路径（可复制）、SKILL.md 原文（含 frontmatter，max-height 滚动）、
  文件清单（路径+大小）、失效技能错误提示；
- **操作**：启用/禁用（即时生效提示）、打开技能目录、删除（二次确认弹窗，仅用户技能）、
  重新扫描、打开技能库目录；
- **安装**：安装对话框支持「选择 .zip / 选择文件夹」系统对话框、拖拽 .zip 到面板、粘贴绝对路径；
  安装前/失败时展示明确错误，不伪造成功；
- **错误态**：列表加载错误、操作错误内联提示、发现的问题（不完整目录/失效状态记录）折叠列表；
- **空态**：没有技能 / 搜索无结果；**加载态**：Spinner；
- **键盘/无障碍**：Modal 自带 Esc 关闭与焦点陷阱、`role=listbox/option`、`role=switch`、
  安装路径 Enter 提交、所有按钮有 aria-label。

> 面板不修改 store/App/Settings/Sidebar；工作区路径从 `useAppStore` 只读获取
> （`session?.workspace ?? settings.lastWorkspace`）。

---

## 6. 测试与验证

```bash
# 本任务单测（21 例）
npx vitest run tests/unit/main/skills.test.ts
# 回归：core 技能/文档工具（R8 语义不能被破坏）
npx vitest run tests/unit/core/skills.test.ts tests/unit/core/document-tools.test.ts
# 全仓
npm run typecheck && npm run test:unit
# E2E（Lead 在 features/index.ts 挂载后运行；真实 Electron + 真实主进程 IPC）
npx electron-vite build && npx playwright test tests/e2e/r10-skills.spec.ts
```

`tests/unit/main/skills.test.ts` 覆盖：

| 类别 | 用例 |
| --- | --- |
| 纯函数 | `normalizeArchivePath`（正常嵌套/反斜杠/zip-slip/绝对路径/非法字符）、`sanitizeSkillDirName`（分隔符/保留名/长度） |
| 发现 | 工作区+用户技能库合并、来源/启用/文件数、无工作区只列用户库、不完整目录进 errors、同名工作区优先 |
| 启停 | 用户技能禁用后 core `discoverSkills` 过滤、重新启用恢复、工作区技能可禁用且不写工作区、非法参数 |
| 文件夹安装 | 真实复制、`skill.md`→`SKILL.md`、默认启用/installedAt、缺 SKILL.md/空目录/相对路径/不存在路径、可执行文件拒绝 |
| zip 安装 | 正常 zip（单层包装目录）、**手工构造原始 zip 验证 zip-slip 拒绝且不越界落盘**、可执行文件/超大/超数量拒绝、损坏 zip 错误 |
| 详情/删除/状态 | SKILL.md 原文与文件清单、删除用户技能（目录+状态记录）、工作区技能拒绝删除、`pruneState` 清理失效记录 |
| IPC 契约 | 10 个频道的真实返回、安装/删除/重扫往返、参数缺失可读错误 |

E2E `tests/e2e/r10-skills.spec.ts`（Lead 挂载后生效）：真实 Electron 中通过
`window.morrow.features.invoke` 完成 zip 安装 → list/read → 启停（状态文件真实写盘）→
恶意 zip 拒绝 → rescan → 删除（目录真实移除）；另含面板明暗主题截图用例
（面板未挂载时明确 skip，不伪造截图）。

### 验证结果（Lead 集成后实测，2026-10-19 21:45）

- `npx vitest run tests/unit/main/skills.test.ts`：**21/21 通过**；
- `npx vitest run tests/unit/core/skills.test.ts tests/unit/core/document-tools.test.ts tests/unit/main/skills.test.ts`：
  **53/53 通过**；
- `npx tsc -p tsconfig.node.json --noEmit` / `tsconfig.web.json --noEmit`：**0 error**；
- `npx electron-vite build`：**exit 0**；
- **E2E（真实 Electron + 真实主进程，Lead 集成后）** `npx playwright test tests/e2e/r10-skills.spec.ts`：
  **2/2 passed (5.3s)**（日志 `tmp/r10-skills-e2e-final.log`）：
  1. zip 真实安装 → list/read → 启停（`skills-state.json` 真实写盘）→ 可执行 zip 拒绝 →
     zip-slip 拒绝且不落盘 → rescan → 删除（目录真实移除）；
  2. 统一工作台（TitleBar 扳手 → 技能库）打开面板，安装一个真实技能后截图深/浅主题。
- 面板截图（真实运行截图，2100×1200）：
  - `docs/verification/screens/r10-skills-dark.png`、`r10-skills-dark-detail.png`、`r10-skills-light.png`；
  - 面板结构：标题/说明 → 搜索 + 全部/已启用/已禁用 + 排序 + 安装按钮 → 技能列表（来源徽标、启用开关、
    文件数/大小/更新时间）→ 详情（启用状态徽标、禁用/打开目录/删除、路径复制、启用影响提示、
    SKILL.md 原文、文件清单）→ 底部用户技能库路径 + 打开目录/重新扫描。
- 集成状态：Lead 已把 `registerSkillsFeature(registerFeatureHandler)` 放进 `src/main/features/index.ts`
  （app ready 后注册），`SkillsPanel` 已挂到统一工作台（TitleBar 扳手 → 技能库）。

> 全仓 `vitest` 当时为 456/458：2 个失败来自 delivery 的临时补丁 `src/core/tools/registry.ts` 里注册的
> R10 浏览器工具（`browser_*`）导致 `tests/unit/core/goal.test.ts` / `index.test.ts` 的工具清单断言未更新
> （TEMP 补丁会还原，不是技能库引入的失败）。

---

## 7. 集成清单（Lead，已完成）

1. ✅ `src/main/features/index.ts`：`import { registerSkillsFeature } from './skills'`，并在
   `registerFeatureModules()`（app ready 后）调用 `registerSkillsFeature(registerFeatureHandler)`
   —— 注册 10 个频道 + 注入 core 环境变量（`MORROW_USER_SKILLS_DIR` / `MORROW_SKILLS_STATE_FILE`）；
2. ✅ `src/main/index.ts`：静态 import `registerFeatureModules`，`app.whenReady()` 内先
   `registerFeatureModules()` 再 `installFeatureIpc()`；`feature-ipc.ts` 不再 `require('./features')`
   （避免 feature-ipc ⇄ features 循环依赖导致的启动崩溃，见 §4 前的说明）；
3. ✅ `src/renderer/src/features/workbench/WorkbenchHost.tsx` 挂载
   `<SkillsPanel open={panel === 'skills'} onClose={close} />`，入口：TitleBar 扳手 →
   工作台菜单「技能库」。

---

## 8. 已知限制与残余风险

- **不联网市场**：只支持本地文件夹/zip；没有远程安装、没有签名校验（用户自己的技能包）；
- **技能不能执行脚本**：安装的资源只是数据；如果技能说明要求运行脚本，需要 Agent 另行调用工具并走权限审批（技能本身不会自动执行）；
- **工作区技能启停状态存放在用户数据目录**（不写工作区），换数据目录/换机器后需重新设置；状态 key 含工作区绝对路径，
  移动工作区后旧记录成为孤儿（`rescan` 会清理用户侧失效记录，工作区孤儿记录目前保留无害）；
- **同名技能**：Agent 侧工作区优先；技能库 UI 会同时显示用户那份并标记「被工作区覆盖」，删除/禁用用户那份不会影响工作区技能；
- **zip 限制**：不支持 ZIP64、加密 zip；压缩方式由 JSZip 支持（deflate/store）；
- **SKILL.md 内容**：详情页显示原文前 256KB；超大文件截断提示；
- **面板尚未由 Lead 挂载时的 E2E**：第二个用例会 skip（不伪造 UI 证据）；待挂载后由验证队友/我补跑截图；
- **状态文件与技能目录并发**：单实例应用内串行操作（IPC 串行），多实例不受支持（Electron 单实例锁已存在）。
