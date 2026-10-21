/**
 * R10 功能模块注册清单（Lead 统一维护，队友请勿改本文件）。
 *
 * 两类模块：
 * - files / editor-history / connectors / search：import 即注册（无 app ready 依赖）；
 * - memory / projects / skills / browser：导出 registerXxx(register, options?)，在 app ready 后调用。
 *
 * 必须由 main/index.ts 在 app.whenReady() 内先 registerFeatureModules() 再 installFeatureIpc()。
 */
import { registerFeatureHandler } from '../feature-ipc'
import './files'
import './editor-history'
import './connectors'
import './search'
import './terminal'
import './git'
import './commands'
import './agents'
import './sidechat'
import './rules'
import './permissions'
import { registerMemoryFeature } from './memory'
import { registerProjectsFeature } from './projects'
import { registerSchedulesFeature } from './schedules'
import { registerSkillsFeature } from './skills'
import { registerBrowserFeature } from './browser'
import { warmSearchIndex } from './search'

export function registerFeatureModules(): void {
  registerMemoryFeature(registerFeatureHandler)
  registerProjectsFeature(registerFeatureHandler)
  registerSchedulesFeature(registerFeatureHandler)
  registerSkillsFeature(registerFeatureHandler)
  registerBrowserFeature()
  warmSearchIndex()
}
