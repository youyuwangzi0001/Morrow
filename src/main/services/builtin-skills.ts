/**
 * 内置技能（随应用首次启动安装到用户技能库）。
 *
 * 这些技能不联网、不包含可执行代码，只是可被 list_skills/read_skill 按需加载的流程说明。
 * 正文维护在 builtin-skill-content/*.md，构建时以 raw 字符串内联；本文件只保存元数据与安装策略。
 *
 * 安装策略：
 * - 首次启动复制到 <dataDir>/skills/<name>/SKILL.md；
 * - 用户删除后不自动恢复；
 * - 升级时只更新「用户未修改过」的技能（用 sha256 判断），保留用户编辑；
 * - 同名目录已存在时跳过，绝不覆盖用户已有技能。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger'

import brainstormAndScopeBody from '@builtin-skills/brainstorm-and-scope.md?raw'
import planAndExecuteBody from '@builtin-skills/plan-and-execute.md?raw'
import verifyBeforeDeliveryBody from '@builtin-skills/verify-before-delivery.md?raw'
import parallelWorkBody from '@builtin-skills/parallel-work.md?raw'
import codeReviewBody from '@builtin-skills/code-review.md?raw'
import debuggingBody from '@builtin-skills/debugging.md?raw'
import testWriterBody from '@builtin-skills/test-writer.md?raw'
import refactorBody from '@builtin-skills/refactor.md?raw'
import securityAuditBody from '@builtin-skills/security-audit.md?raw'
import frontendArtDirectionBody from '@builtin-skills/frontend-art-direction.md?raw'
import deliverableQualityBody from '@builtin-skills/deliverable-quality.md?raw'
import documentDeliverablesBody from '@builtin-skills/document-deliverables.md?raw'
import dataAnalysisBody from '@builtin-skills/data-analysis.md?raw'
import webResearchBody from '@builtin-skills/web-research.md?raw'
import canvasArtifactsBody from '@builtin-skills/canvas-artifacts.md?raw'
import workspaceGitBody from '@builtin-skills/workspace-git.md?raw'
import mcpIntegrationBody from '@builtin-skills/mcp-integration.md?raw'
import skillAuthorBody from '@builtin-skills/skill-author.md?raw'

export const BUILTIN_SKILLS_VERSION = 5

/**
 * 已并入其它技能的内置技能：升级时删除未修改的旧副本，用户改过的保留为自有技能。
 * - ui-polish → frontend-art-direction
 * - docs-writer / deliverable-report → document-deliverables
 * - release-notes → document-deliverables
 */
const RETIRED_BUILTIN_SKILLS = ['ui-polish', 'docs-writer', 'deliverable-report', 'release-notes']

interface BuiltinSkill {
  name: string
  description: string
  /** SKILL.md 全文（frontmatter + 正文） */
  content: string
}

function skill(name: string, description: string, body: string): BuiltinSkill {
  return {
    name,
    description,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`
  }
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  skill(
    'brainstorm-and-scope',
    '把模糊需求变成可执行的任务简报：明确用户、目标、边界、验收与方案取舍。当用户说「做个好看的」「优化一下」「你看着办」、需求含糊，或新功能/新视觉作品开工前需要定方向时使用；明确的小修不需要。',
    brainstormAndScopeBody
  ),
  skill(
    'plan-and-execute',
    '为多步骤任务做可验证的计划并持续推进：计划模式提交步骤、目标模式写完成契约、todo 状态与收尾。当任务跨多文件或多轮、用户要求先规划、建立目标、长任务续接时使用。',
    planAndExecuteBody
  ),
  skill(
    'verify-before-delivery',
    '在声称完成、修好或可交付前，用新鲜证据验证代码、UI、文档、表格、报告与打包产物。当准备结束任务、提交、发版或用户问「真的能用吗」时使用；没有运行验证不得宣称通过。',
    verifyBeforeDeliveryBody
  ),
  skill(
    'parallel-work',
    '拆分并派发独立子任务给 task / swarm 集群，合并结果并做集成验证。当任务可拆成互不依赖的探索、审查、测试或文档工作，或用户要求并行/集群时使用；共享文件或强顺序任务不要并行。',
    parallelWorkBody
  ),
  skill(
    'code-review',
    '只读审查代码改动，按严重程度报告正确性、安全、并发、兼容与测试风险，并给出文件位置和触发条件。当用户要求 review、合并前检查或改动自检时使用。',
    codeReviewBody
  ),
  skill(
    'debugging',
    '系统化排查缺陷：先稳定复现和收集证据，再定位根因、最小修复并做红绿验证。当出现报错、测试失败、行为异常或性能退化时使用；禁止未定位根因就改代码。',
    debuggingBody
  ),
  skill(
    'test-writer',
    '补充高价值自动化测试：先写失败用例，覆盖边界、错误、并发与回归，再让实现通过。当用户要求加测试、修缺陷需要回归保护或重构前需要行为基线时使用。',
    testWriterBody
  ),
  skill(
    'refactor',
    '在不改变外部行为的前提下小步重构：先建行为基线，再提取/移动/改名，每步验证，不夹带功能变更。当用户要求整理代码、拆模块、消重复或改善可读性时使用。',
    refactorBody
  ),
  skill(
    'security-audit',
    '围绕信任边界做授权范围内的安全审计：注入、路径、权限、凭据、外部内容、Electron/IPC、MCP 与资源风险，给出可复现证据和修复优先级。当用户要求安全审查、上线检查或功能涉及敏感边界时使用。',
    securityAuditBody
  ),
  skill(
    'frontend-art-direction',
    '为网页、游戏、海报或界面建立明确艺术方向并完成多轮视觉打磨；避免模板感，处理字体、构图、材质、状态、响应式与可访问性。当用户要求好看/惊艳/高级感/有氛围，或要新建/打磨视觉成品时使用。',
    frontendArtDirectionBody
  ),
  skill(
    'deliverable-quality',
    '跨类型交付质量门槛：代码、文档、报告、幻灯片、表格、数据、研究与网页成品在交付前按同一标准自检并修正。用户要求专业/高质量/可直接交付，或成品会交给别人使用时使用。',
    deliverableQualityBody
  ),
  skill(
    'document-deliverables',
    '撰写或生成可交付文档与办公成品：README、规格、方案、报告、发布说明、Word/Excel/PDF/PPT；结论先行、数据可追溯、文件能打开。当用户要写文档/报告/提案/发布说明或处理 Office 文件时使用。',
    documentDeliverablesBody
  ),
  skill(
    'data-analysis',
    '从 CSV/Excel 等真实数据做可复核分析：定义口径、体检清洗、可重跑脚本、交叉验证、图表与报告。当用户要求统计、对比、清洗、汇总、找趋势或生成数据报告时使用。',
    dataAnalysisBody
  ),
  skill(
    'web-research',
    '做有来源的联网调研：拆问题、优先一手资料、交叉验证、记录 URL/日期、区分事实与推断。当需要最新信息、官方文档、价格/版本/政策或比较外部方案时使用。',
    webResearchBody
  ),
  skill(
    'canvas-artifacts',
    '把 HTML/Markdown/SVG/代码成品放进 Morrow 画布：单文件自包含、真实预览、迭代、版本与导出。当用户要直接看到网页/报告/图表成品，或需要画布预览与导出时使用。',
    canvasArtifactsBody
  ),
  skill(
    'workspace-git',
    '在工作区边界内安全读写文件并管理 Git：状态/diff、提交、分支、历史与可逆回退。当需要改文件、查看改动、提交、创建/切换分支或回退时使用；破坏性 Git 操作必须先确认。',
    workspaceGitBody
  ),
  skill(
    'mcp-integration',
    '接入、调用与排查 MCP/连接器：确认传输与信任、查看 schema、逐次审批、处理 OAuth 与外部内容风险。当用户要接入 MCP、使用外部工具或排查连接/工具/资源问题时使用。',
    mcpIntegrationBody
  ),
  skill(
    'skill-author',
    '创建、修改和测试 SKILL.md：判断是否值得沉淀、写触发描述与可执行流程、做触发/压力测试、按技能库规则安装。当用户要求新建/优化技能或把重复流程沉淀为技能时使用。',
    skillAuthorBody
  )
]

interface MarkerSkill {
  hash: string
  /** 用户改过：后续启动不得用内置内容覆盖 */
  modified?: boolean
}

interface MarkerFile {
  version: number
  skills: Record<string, MarkerSkill>
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 先写临时文件再替换，避免崩溃/占用留下半个 SKILL.md 或损坏 marker */
function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, 'utf8')
  try {
    renameSync(temp, path)
  } catch {
    writeFileSync(path, content, 'utf8')
    try {
      unlinkSync(temp)
    } catch {
      // ignore
    }
  }
}

/**
 * 安装/更新内置技能。返回本轮新安装或更新的技能名。
 * - 目录不存在且从未安装过 → 安装；
 * - 用户删除了技能（目录不存在但 marker 有记录）→ 不自动恢复；
 * - 用户修改过（hash 不匹配）→ 不覆盖；
 * - 未修改且版本变化 → 更新。
 */
export function ensureBuiltinSkills(dataDir: string): string[] {
  const root = join(dataDir, 'skills')
  const markerPath = join(root, '.builtin-skills.json')
  let marker: MarkerFile = { version: 0, skills: {} }
  try {
    if (existsSync(markerPath)) {
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<MarkerFile>
      if (parsed && typeof parsed === 'object' && parsed.skills && typeof parsed.skills === 'object') {
        marker = { version: typeof parsed.version === 'number' ? parsed.version : 0, skills: parsed.skills as MarkerFile['skills'] }
      }
    }
  } catch {
    marker = { version: 0, skills: {} }
  }

  const changed: string[] = []
  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    log.warn('builtin skills: cannot create skills dir', { error: String(err) })
    return changed
  }

  for (const builtin of BUILTIN_SKILLS) {
    const dir = join(root, builtin.name)
    const file = join(dir, 'SKILL.md')
    const hash = sha256(builtin.content)
    const previous = marker.skills[builtin.name]
    try {
      if (!existsSync(dir)) {
        if (previous) continue // 用户删除过，尊重选择
        mkdirSync(dir, { recursive: true })
        writeAtomic(file, builtin.content)
        marker.skills[builtin.name] = { hash }
        changed.push(builtin.name)
        continue
      }
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(file)) continue
      if (!previous) continue // 同名目录是用户自己的技能：不覆盖，也不纳入内置管理
      const current = readFileSync(file, 'utf8')
      const currentHash = sha256(current)
      if (currentHash !== previous.hash) {
        // 用户改过：持久化 modified，不能只同步 hash 后下次启动又当未修改覆盖
        marker.skills[builtin.name] = { hash: currentHash, modified: true }
        continue
      }
      if (previous.modified === true) continue
      if (previous.hash !== hash) {
        if (marker.version >= BUILTIN_SKILLS_VERSION) {
          // 旧版 marker 曾把用户编辑同步成 hash；当前版本号下视为用户管理，保留内容
          marker.skills[builtin.name] = { hash: currentHash, modified: true }
          continue
        }
        writeAtomic(file, builtin.content)
        marker.skills[builtin.name] = { hash }
        changed.push(builtin.name)
      }
    } catch (err) {
      log.warn('builtin skills: install failed', { name: builtin.name, error: String(err) })
    }
  }

  for (const name of RETIRED_BUILTIN_SKILLS) {
    const previous = marker.skills[name]
    if (!previous) continue
    const dir = join(root, name)
    const file = join(dir, 'SKILL.md')
    try {
      if (!existsSync(dir)) {
        delete marker.skills[name]
        continue
      }
      const currentHash = existsSync(file) ? sha256(readFileSync(file, 'utf8')) : ''
      if (previous.modified !== true && currentHash === previous.hash) {
        rmSync(dir, { recursive: true, force: true })
        delete marker.skills[name]
        changed.push(name)
      } else {
        // 用户改过：保留内容，但不再按内置技能管理，避免升级时被误删/覆盖。
        delete marker.skills[name]
      }
    } catch (err) {
      log.warn('builtin skills: retire failed', { name, error: String(err) })
    }
  }

  marker.version = Math.max(marker.version, BUILTIN_SKILLS_VERSION)
  try {
    writeAtomic(markerPath, JSON.stringify(marker, null, 2))
  } catch (err) {
    log.warn('builtin skills: marker write failed', { error: String(err) })
  }
  return changed
}
