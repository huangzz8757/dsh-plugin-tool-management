// 宿主工具 op 门面：把 core/state 适配成统一 op 协议。
//
// 与技能域 service 同形：`wrap()` 统一包装成功 / 业务失败，写操作过写锁串行化，
// `writeOps` 与 op 表同文件维护（HTTP 门禁从那张表派生）。
import {
  DEFAULT_HOST_TOOL_SETTINGS,
  filterHidden,
  isHostToolName,
  isProtectedTool,
  normalizeHidden,
  type HostToolFacts,
  type HostToolFailure,
  type HostToolSettings,
} from './core.js'
import { createHostToolsState, type HostToolsState } from './state.js'

export interface HostToolsServiceDeps {
  /** 串行写锁：与其余设置写入共用同一条队列。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 严格读 / 写 JSON（由 index.ts 提供）。 */
  readJsonFileStrict(abs: string): Promise<any>
  writeJsonFile(abs: string, data: unknown): Promise<void>
  /** 取当前运行时的判据事实。取不到时返回 null = 本轮不列任何宿主工具。 */
  facts(): Promise<HostToolFacts | null>
  /** 写成功后通知可见性重排。 */
  onWritten?: (settings: HostToolSettings) => void
}

export interface HostToolsService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 当前生效的隐藏名单（供可见性模块读取，同步路径用）。 */
  hiddenSync(): readonly string[]
  /** 读一份最新设置。 */
  read(args: any): Promise<any>
}

export function createHostToolsService(deps: HostToolsServiceDeps): HostToolsService {
  const state: HostToolsState = createHostToolsState({
    readJsonFileStrict: deps.readJsonFileStrict,
    writeJsonFile: deps.writeJsonFile,
    onWritten: deps.onWritten,
  })

  /** 同步可见名单：装配期预热一次，写成功后刷新。取不到事实时为空集（不误关）。 */
  let hiddenCache: readonly string[] = []

  /** 成功 → {ok:true, data}；业务失败原样透传 {ok:false, code, params}。 */
  const wrap = (fn: (args: any) => Promise<any>) => async (args: any): Promise<any> => {
    const result = await fn(args)
    if (result && result.ok === false) return result
    return { ok: true, data: result }
  }

  /** 读侧：返回关停名单 + 当前可关的宿主工具清单 + 每条的体积估算。 */
  async function readState(args: any): Promise<any> {
    const read = await state.read()
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return { ok: false, code: `error.hostTools.${read.status}`, params: { reason: read.error } } as HostToolFailure
    }
    const settings = read.status === 'missing' ? DEFAULT_HOST_TOOL_SETTINGS : read.settings
    const facts = await deps.facts()
    const rows = facts ? listRows(facts) : []
    const filtered = facts ? filterHidden(settings.hidden, facts) : { hidden: settings.hidden, dropped: [] }
    hiddenCache = filtered.hidden
    return {
      hidden: filtered.hidden,
      dropped: filtered.dropped,
      tools: rows,
      state: read.status,
    }
  }

  /** 列出当前可关的宿主工具（按名字排序），界面据此渲染平铺列表。 */
  function listRows(facts: HostToolFacts): Array<{ name: string; protectedTool: boolean }> {
    const out: Array<{ name: string; protectedTool: boolean }> = []
    for (const name of facts.restrictableNames) {
      if (!isHostToolName(name, facts)) continue
      out.push({ name, protectedTool: isProtectedTool(name) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 整份替换关停名单。保留名单与过期名字在写盘前收窄。 */
  const setHidden = wrap(async (args: any): Promise<any> => {
    const facts = await deps.facts()
    const requested = normalizeHidden(args?.hidden)
    const kept: string[] = []
    const rejected: string[] = []
    for (const name of requested) {
      if (isProtectedTool(name)) { rejected.push(name); continue }
      if (facts && !isHostToolName(name, facts)) { rejected.push(name); continue }
      kept.push(name)
    }
    const result = await deps.withWriteLock(() => state.mutate(() => ({ version: 1, hidden: kept })))
    if (result.ok === false) return result
    hiddenCache = result.settings.hidden
    return { hidden: result.settings.hidden, rejected }
  })

  /** 逐条改：在当前名单上增删，不整份替换（避免两个写者互相覆盖）。 */
  const toggle = wrap(async (args: any): Promise<any> => {
    const toggles = Array.isArray(args?.toggle)
      ? normalizeHidden((args.toggle as any[]).map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean))
      : []
    const wants = Array.isArray(args?.toggle)
      ? (args.toggle as any[]).filter((t) => t && typeof t.name === 'string')
      : []
    const facts = await deps.facts()
    const valid = wants.filter((t) => !isProtectedTool(t.name) && (!facts || isHostToolName(t.name, facts)))
    if (valid.length === 0) {
      return { ok: false, code: 'error.hostTools.noValidTarget' } as HostToolFailure
    }
    const result = await deps.withWriteLock(() => state.mutate((current) => {
      const next = new Set(current.hidden)
      for (const t of valid) {
        if (t.hidden === true) next.add(t.name)
        else next.delete(t.name)
      }
      return { version: 1, hidden: [...next] }
    }))
    if (result.ok === false) return result
    hiddenCache = result.settings.hidden
    return { hidden: result.settings.hidden }
  })

  const op = async (args: any): Promise<any> => {
    if (args?.set === true || Array.isArray(args?.toggle)) {
      return args?.set === true ? setHidden(args) : toggle(args)
    }
    return wrap(readState)(args)
  }

  return {
    ops: { 'host-tools': op },
    hiddenSync: () => hiddenCache,
    read: readState,
  }
}
