import type { HookEvent } from './types'

export const HOOK_EVENTS: readonly HookEvent[] = ['user_prompt_submit', 'post_tool_use', 'run_finished']
export const MAX_HOOKS = 20
export const MAX_ENABLED_HOOKS_PER_EVENT = 5

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}
