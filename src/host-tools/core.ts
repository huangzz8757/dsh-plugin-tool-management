// 宿主工具开关的纯判据与名单归一化。无 fs、无 ctx、无时钟，便于单独推理与验证。
//
// 「宿主工具」的边界：注册在全局层、可被 tools.restrict() 摘除，且不属于下面三类：
//   1. MCP 工具（`mcp__` 前缀）与官方三个共享资源工具 —— 归 MCP 页自己的停用表；
//   2. 本插件注册的工具（`selfToolNames`）—— 归兼容页的模型工具表；
//   3. 无法限制的名字（不在 `restrictableNames` 里）—— 交给官方 restrict 会整份抛错。
import { MCP_TOOL_PREFIX, MCP_RESOURCE_TOOL_NAMES } from '../host-names.js'

/** 关掉这些会让 agent 失去基本工作能力，界面应禁用对应开关。 */
export const PROTECTED_TOOLS = [
  'pwsh', 'edit', 'read', 'write', 'glob', 'grep',
] as const

const PROTECTED_SET: ReadonlySet<string> = new Set<string>(PROTECTED_TOOLS)

/** 判断某个名字是否受保留名单保护。 */
export function isProtectedTool(name: string): boolean {
  return PROTECTED_SET.has(String(name ?? ''))
}

/**
 * 判据所需的运行时事实，由调用方注入（纯函数不碰 ctx）。
 *
 * `restrictableNames` 必须来自 `tools.view(agent).restrictableNames`，不能拿
 * `knownNames` 或 `visible` 代替：前者含本 scope 自己注册的工具（restrict 会拒），
 * 后者已被遮罩（用它校验会随自身屏蔽而缩小）。
 */
export interface HostToolFacts {
  /** 本插件注册过的工具名。 */
  selfToolNames: ReadonlySet<string>
  /** 宿主全局层可被 restrict 摘除的工具名。 */
  restrictableNames: ReadonlySet<string>
}

/** 这个名字是不是本插件可以关掉的宿主工具。 */
export function isHostToolName(name: string, facts: HostToolFacts): boolean {
  const n = String(name ?? '')
  if (n === '') return false
  if (n.startsWith(MCP_TOOL_PREFIX)) return false
  if ((MCP_RESOURCE_TOOL_NAMES as readonly string[]).includes(n)) return false
  if (facts.selfToolNames.has(n)) return false
  return facts.restrictableNames.has(n)
}

/** 归一化一份关停名单：只收非空字符串、去重、按上限截断。 */
export function normalizeHidden(list: unknown, max = 512): string[] {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || out.indexOf(name) >= 0) continue
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/** 业务失败形状：只给 code 与参数，句子由界面按当前语言拼。 */
export interface HostToolFailure {
  ok: false
  code: string
  params?: Record<string, unknown>
}

/**
 * 把一份关停名单收敛到当前真实可关的宿主工具。
 *
 * 名字过期（插件卸了、工具没了）是常态：静默丢掉并在 `dropped` 里如实报，
 * 不升级成整份损坏 —— 否则一个失效名字会让用户其余所有选择一并失效。
 */
export function filterHidden(
  hidden: readonly string[],
  facts: HostToolFacts,
): { hidden: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  for (const name of hidden) {
    if (isHostToolName(name, facts)) kept.push(name)
    else dropped.push(name)
  }
  return { hidden: kept, dropped }
}

/** 侧车文件的形状。 */
/** 按作用域分桶的关停名单：全局一份 + 工作区 / 会话各自的覆盖。 */
export interface HostToolSettings {
  version: 1
  /** 全局层名单，所有会话的默认模板。 */
  hidden: string[]
  /** 工作区键 → 该工作区的关停名单。 */
  workspaces: Record<string, string[]>
  /** 会话键 → 该会话的关停名单。 */
  sessions: Record<string, string[]>
}

export const DEFAULT_HOST_TOOL_SETTINGS: HostToolSettings = {
  version: 1, hidden: [], workspaces: {}, sessions: {},
}

/** 生效层级键：来自面板顶部的作用域选择器，与 scopeMode 对齐。 */
export type HostToolScopeKind = 'global' | 'workspace' | 'session'

export interface HostToolScope {
  kind: HostToolScopeKind
  /** kind='workspace' | 'session' 时的作用域键；global 时为空串。 */
  key: string
}

/**
 * 按作用域读一份生效名单：会话 → 工作区 → 全局，上层存在就完全取代下层。
 * 与 `sessionToolTableHidden` 同一条顺序（作者注释里写明工具表是这个形状，不是逐格布尔）。
 */
export function hiddenForScope(settings: HostToolSettings, scope: HostToolScope): string[] {
  if (scope.kind === 'session' && scope.key && Object.prototype.hasOwnProperty.call(settings.sessions, scope.key)) {
    return settings.sessions[scope.key].slice()
  }
  if (scope.kind !== 'global' && scope.key && Object.prototype.hasOwnProperty.call(settings.workspaces, scope.key)) {
    return settings.workspaces[scope.key].slice()
  }
  return settings.hidden.slice()
}

/** 把一份名单写进指定作用域，返回新的整份设置。 */
export function withScopeHidden(settings: HostToolSettings, scope: HostToolScope, hidden: readonly string[]): HostToolSettings {
  const list = [...hidden]
  if (scope.kind === 'global') {
    return { ...settings, hidden: list }
  }
  if (scope.kind === 'workspace') {
    return { ...settings, workspaces: { ...settings.workspaces, [scope.key]: list } }
  }
  return { ...settings, sessions: { ...settings.sessions, [scope.key]: list } }
}

/** 宽松归一化：字段可缺，但一旦存在就必须形状正确（类型错要判损坏，不能自愈成空）。 */
export function normalizeSettings(raw: unknown): HostToolSettings | HostToolFailure {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'error.hostTools.shape' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.version !== undefined && obj.version !== 1) {
    return { ok: false, code: 'error.hostTools.version', params: { version: obj.version } }
  }
  for (const field of ['hidden'] as const) {
    if (obj[field] !== undefined && !Array.isArray(obj[field])) {
      return { ok: false, code: `error.hostTools.${field}Shape` }
    }
  }
  const buckets: Record<string, Record<string, string[]>> = {}
  for (const field of ['workspaces', 'sessions'] as const) {
    const val = obj[field]
    if (val === undefined) { buckets[field] = {}; continue }
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      return { ok: false, code: `error.hostTools.${field}Shape` }
    }
    const out: Record<string, string[]> = {}
    for (const [key, list] of Object.entries(val as Record<string, unknown>)) {
      if (!Array.isArray(list)) return { ok: false, code: `error.hostTools.${field}Shape` }
      out[key] = normalizeHidden(list)
    }
    buckets[field] = out
  }
  return {
    version: 1,
    hidden: normalizeHidden(obj.hidden),
    workspaces: buckets.workspaces,
    sessions: buckets.sessions,
  }
}
