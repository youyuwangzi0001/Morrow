/**
 * R10-H 技能库 feature IPC（`feature:skills:*`）。
 *
 * 集成方式（Lead 在 `src/main/features/index.ts` 中调用）：
 * ```ts
 * import { registerFeatureHandler } from '../feature-ipc'
 * import { registerSkillsFeature } from './skills'
 * export function registerFeatureModules(): void {
 *   registerSkillsFeature(registerFeatureHandler)
 * }
 * ```
 * 注意：本模块**不在 import 时创建服务**。原因：
 * - `resolveDataDir()`/`app.getPath()` 必须在 `app.whenReady()` 之后调用；
 * - 功能模块在 import 时 `import '../feature-ipc'` 再调用 register 会形成
 *   feature-ipc ⇄ features 的循环依赖（打包后 `handlers` 初始化前就被调用）。
 * 因此由 Lead 的 `registerFeatureModules()`（app ready 后执行）把注册函数传进来。
 *
 * 注册时会把用户技能库路径/启停状态文件注入 core 环境变量，
 * 让 Agent 的 `list_skills / read_skill / 系统提示` 只看到已启用的技能。
 *
 * 频道（全部返回普通 JSON 数据，错误 throw，由 feature-ipc 统一包成 Result）：
 * - feature:skills:list         { workspace? } → SkillsSnapshot
 * - feature:skills:read         { id, workspace? } → SkillDetail
 * - feature:skills:setEnabled   { id, enabled, workspace? } → SkillsSnapshot
 * - feature:skills:install      { sourcePath, overwrite?, workspace? } → InstallResult
 * - feature:skills:remove       { id, workspace? } → SkillsSnapshot
 * - feature:skills:rescan       { workspace? } → SkillsSnapshot
 * - feature:skills:reveal       { id, workspace? } → { path }
 * - feature:skills:openUserDir  {} → { path }
 * - feature:skills:pickZip      {} → { path: string | null }（系统文件对话框）
 * - feature:skills:pickFolder   {} → { path: string | null }（系统文件夹对话框）
 */
import { dialog, shell } from 'electron'
import { resolveDataDir } from '../services/paths'
import {
  createSkillsFeatureHandlers,
  createSkillsService,
  installSkillsRuntimeEnv,
  type SkillsFeatureEffects
} from '../services/skills-service'

/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 一致；模块不直接依赖 feature-ipc） */
export type RegisterFeatureChannel = (channel: string, handler: (payload: unknown) => Promise<unknown>) => void

/** 本模块注册的全部频道，便于集成/测试断言 */
export const SKILLS_FEATURE_CHANNELS = [
  'feature:skills:list',
  'feature:skills:read',
  'feature:skills:setEnabled',
  'feature:skills:install',
  'feature:skills:remove',
  'feature:skills:rescan',
  'feature:skills:reveal',
  'feature:skills:openUserDir',
  'feature:skills:pickZip',
  'feature:skills:pickFolder'
] as const

const effects: SkillsFeatureEffects = {
  async revealPath(path: string): Promise<void> {
    const error = await shell.openPath(path)
    if (error) throw new Error(`打开技能目录失败：${error}`)
  },
  async openUserDir(path: string): Promise<void> {
    const error = await shell.openPath(path)
    if (error) throw new Error(`打开技能库目录失败：${error}`)
  },
  async pickZip(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择技能包（.zip）',
      buttonLabel: '安装技能包',
      properties: ['openFile'],
      filters: [{ name: '技能包', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  },
  async pickFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择技能文件夹（必须包含 SKILL.md）',
      buttonLabel: '选择文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
}

/**
 * 注册技能库 feature 频道（必须在 app ready 之后、主进程 IPC 挂载之前调用）。
 * 同时把用户技能库路径/状态文件注入 core 环境变量。
 */
export function registerSkillsFeature(register: RegisterFeatureChannel): void {
  const service = createSkillsService({ dataDir: resolveDataDir() })
  installSkillsRuntimeEnv(service)
  for (const [channel, handler] of Object.entries(createSkillsFeatureHandlers(service, effects))) {
    register(channel, handler)
  }
}
