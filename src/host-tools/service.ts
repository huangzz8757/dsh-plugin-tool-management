// 宿主工具 op 门面：把 core/state 适配成统一 op 协议，并按作用域分层。
//
// 与技能域 service 同形：wrap() 统一包装成功 / 业务失败，写操作过写锁串行化。
import {
  DEFAULT_HOST_TOOL_SETTINGS,
  filterHidden,
  hiddenForScope,
  isHostToolName,
  isProtectedTool,
  normalizeHidden,
  withScopeHidden,
  type HostToolFacts,
  type HostToolFailure,
  type HostToolScope,
  type HostToolSettings,
} from './core.js'
import { createHostToolsState, type HostToolsState } from './state.js'

/** 界面 / overlay 都要的作用域解析：由 index.ts 注入（与 scopeMode 同源）。 */
export interface HostToolsScopeDeps {
  /** 当前模式：global / workspace / session。 */
  mode(): 'global' | 'workspace' | 'session'
  /** 面板当前编辑的作用域键（来自 scope-get）；global 时为空串。 */
  panelScope(): { kind: 'global' | 'workspace' | 'session'; key: string }
  /** 某个 agent 属于哪个作用域键（逐 agent 的 overlay 用）。 */
  scopeOfAgent(agent: unknown): { kind: 'global' | 'workspace' | 'session'; key: string }
}

export interface HostToolsServiceDeps extends HostToolsScopeDeps {
  /** 串行写锁：与其余设置写入共用同一条队列。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 严格读 / 写 JSON（由 index.ts 提供）。 */
  readJsonFileStrict(abs: string): Promise<any>
  writeJsonFile(abs: string, data: unknown): Promise<void>
  /** 取当前运行时的判据事实。取不到时返回 null = 本轮不列任何宿主工具。 */
  facts(): Promise<HostToolFacts | null>
  /** 取某个 agent 当前可见的工具名（分母口径与界面一致）。 */
  visibleTools(agent: unknown): Promise<readonly string[] | null>
  /** 写成功后通知可见性重排。 */
  onWritten?: (settings: HostToolSettings) => void
}

export interface HostToolsService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 逐 agent 的可见性覆盖：{deny} 装进该 agent 的 restrict 层。 */
  overlayFor(agent: unknown): Promise<{ allow?: readonly string[]; deny?: readonly string[] }>
  /** 读一份最新设置。 */
  read(args: any): Promise<any>
}

/** 把 args.scope 折成一个作用域；没给就退回面板当前选中的层。 */
function scopeOfArgs(args: any, deps: HostToolsScopeDeps): HostToolScope {
  const raw = args?.scope
  if (raw && typeof raw === 'object') {
    const kind = raw.kind
    if (kind === 'global') return { kind: 'global', key: '' }
    if ((kind === 'workspace' || kind === 'session') && typeof raw.key === 'string' && raw.key !== '') {
      return { kind, key: raw.key }
    }
  }
  const panel = deps.panelScope()
  return { kind: panel.kind, key: panel.key }
}

export function createHostToolsService(deps: HostToolsServiceDeps): HostToolsService {
  const state: HostToolsState = createHostToolsState({
    readJsonFileStrict: deps.readJsonFileStrict,
    writeJsonFile: deps.writeJsonFile,
    onWritten: deps.onWritten,
  })

  /** 成功 → {ok:true, data}；业务失败原样透传 {ok:false, code, params}。 */
  const wrap = (fn: (args: any) => Promise<any>) => async (args: any): Promise<any> => {
    const result = await fn(args)
    if (result && result.ok === false) return result
    return { ok: true, data: result }
  }

  /** 列出当前可关的宿主工具（按名字排序）。 */
  function listRows(facts: HostToolFacts, visible: readonly string[] | null): Array<{ name: string; protectedTool: boolean }> {
    // 分母口径：界面用全局全集，overlay 用当前 agent 可见集。传 null = 用全集。
    const names = visible === null ? facts.restrictableNames : visible
    const out: Array<{ name: string; protectedTool: boolean }> = []
    for (const name of names) {
      if (!isHostToolName(name, facts)) continue
      out.push({ name, protectedTool: isProtectedTool(name) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 读侧：返回当前作用域的关停名单 + 可关的工具清单。 */
  async function readState(args: any): Promise<any> {
    const read = await state.read()
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return { ok: false, code: `error.hostTools.${read.status}`, params: { reason: read.error } } as HostToolFailure
    }
    const settings = read.status === 'missing' ? DEFAULT_HOST_TOOL_SETTINGS : read.settings
    const scope = scopeOfArgs(args, deps)
    const facts = await deps.facts()
    const rows = facts ? listRows(facts, null) : []
    const hidden = hiddenForScope(settings, scope)
    const filtered = facts ? filterHidden(hidden, facts) : { hidden, dropped: [] }
    return {
      hidden: filtered.hidden,
      dropped: filtered.dropped,
      tools: rows,
      state: read.status,
      scope,
    }
  }

  /** 把一批名字收窄到当前可关的宿主工具；保留名单与过期名字都拒掉。 */
  function narrow(requested: readonly string[], facts: HostToolFacts | null): { kept: string[]; rejected: string[] } {
    const kept: string[] = []
    const rejected: string[] = []
    for (const name of normalizeHidden(requested)) {
      if (isProtectedTool(name)) { rejected.push(name); continue }
      if (facts && !isHostToolName(name, facts)) { rejected.push(name); continue }
      kept.push(name)
    }
    return { kept, rejected }
  }

  /** 整份替换当前作用域的关停名单。 */
  const setHidden = wrap(async (args: any): Promise<any> => {
    const scope = scopeOfArgs(args, deps)
    const facts = await deps.facts()
    const { kept, rejected } = narrow(args?.hidden, facts)
    const result = await deps.withWriteLock(() => state.mutate(
      (current) => withScopeHidden(current, scope, kept),
    ))
    if (result.ok === false) return result
    return { hidden: hiddenForScope(result.settings, scope), rejected, scope }
  })

  /** 逐条改：在当前作用域名单上增删，不整份替换。 */
  const toggle = wrap(async (args: any): Promise<any> => {
    const scope = scopeOfArgs(args, deps)
    const facts = await deps.facts()
    const wants = Array.isArray(args?.toggle)
      ? (args.toggle as any[]).filter((t) => t && typeof t.name === 'string')
      : []
    const valid = wants.filter((t) => !isProtectedTool(t.name) && (!facts || isHostToolName(t.name, facts)))
    if (valid.length === 0) {
      return { ok: false, code: 'error.hostTools.noValidTarget' } as HostToolFailure
    }
    const result = await deps.withWriteLock(() => state.mutate((current) => {
      const next = new Set(hiddenForScope(current, scope))
      for (const t of valid) {
        if (t.hidden === true) next.add(t.name)
        else next.delete(t.name)
      }
      return withScopeHidden(current, scope, [...next])
    }))
    if (result.ok === false) return result
    return { hidden: hiddenForScope(result.settings, scope), scope }
  })

  /**
   * 逐 agent 的可见性覆盖。
   *
   * 只返回 deny（不在名单里 = 可见），不返回 allow —— 宿主工具没有别的 overlay 路径会
   * 关掉它们，不需要"减掉"。上层存在就完全取代下层（hiddenForScope 的顺序）。
   */
  async function overlayFor(agent: unknown): Promise<{ allow?: readonly string[]; deny?: readonly string[] }> {
    const read = await state.read()
    if (read.status === 'missing') return { deny: [] }
    if (read.status === 'corrupt' || read.status === 'unreadable') return { deny: [] }
    const scope = deps.scopeOfAgent(agent)
    const hidden = hiddenForScope(read.settings, scope)
    const facts = await deps.facts()
    const visible = await deps.visibleTools(agent)
    const valid = facts && visible
      ? hidden.filter((name) => isHostToolName(name, { selfToolNames: facts.selfToolNames, restrictableNames: new Set(visible) }))
      : hidden
    return { deny: valid }
  }

  const op = async (args: any): Promise<any> => {
    if (args?.set === true || Array.isArray(args?.toggle)) {
      return args?.set === true ? setHidden(args) : toggle(args)
    }
    return wrap(readState)(args)
  }

  return {
    ops: { 'host-tools': op },
    overlayFor,
    read: readState,
  }
}
