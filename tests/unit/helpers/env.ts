/**
 * 测试辅助：包装 run_command 的 sanitizeEnv（从 command-tool 导入，避免测试重复实现）。
 */
import { sanitizeEnv } from '../../../src/core/tool-media'

export function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return sanitizeEnv(env)
}
