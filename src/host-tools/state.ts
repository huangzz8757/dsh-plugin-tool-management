// 宿主工具关停名单的侧车读写。四态严格读，写锁由调用方持有。
//
// 关键纪律：只有 `missing` 能当空表；`corrupt` / `unreadable` 一律拒绝写入。
// 把「读不出来」当成「空」会在一次坏文件后洗掉用户全部选择。
import type { JsonFileRead } from '../mcp/disabled-tools.js'
import { hubPath } from '../hub.js'
import {
  DEFAULT_HOST_TOOL_SETTINGS,
  normalizeSettings,
  type HostToolFailure,
  type HostToolSettings,
} from './core.js'

const FILE_NAME = 'host-tools.json'

export type HostToolsRead =
  | { status: 'ok'; settings: HostToolSettings }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'unreadable'; error: string }

export interface HostToolsStateDeps {
  /** 严格读：区分 missing / 解析失败 / IO 失败。 */
  readJsonFileStrict(abs: string): Promise<JsonFileRead>
  /** 写文件（调用方已持写锁）。 */
  writeJsonFile(abs: string, data: unknown): Promise<void>
  /** 写成功后的通知：可见性重排由调用方决定。 */
  onWritten?(settings: HostToolSettings): void
}

export interface HostToolsState {
  /** 读一份当前设置。坏文件原样返回状态，不自行清空。 */
  read(): Promise<HostToolsRead>
  /** 读-改-写。调用方负责用写锁包裹整个调用。 */
  mutate(fn: (current: HostToolSettings) => HostToolSettings): Promise<{ ok: true; settings: HostToolSettings } | HostToolFailure>
}

/** 侧车绝对路径，供 op 与界面共用。 */
export function hostToolsPath(): string {
  return hubPath(FILE_NAME)
}

export function createHostToolsState(deps: HostToolsStateDeps): HostToolsState {
  async function read(): Promise<HostToolsRead> {
    let raw: JsonFileRead
    try {
      raw = await deps.readJsonFileStrict(hostToolsPath())
    } catch (e) {
      return { status: 'unreadable', error: String(e) }
    }
    if (raw.status === 'missing') return { status: 'missing' }
    if (raw.status === 'corrupt' || raw.status === 'unreadable') {
      return { status: raw.status, error: raw.error }
    }
    const normalized = normalizeSettings(raw.value)
    if ('ok' in normalized && normalized.ok === false) {
      return { status: 'corrupt', error: normalized.code }
    }
    return { status: 'ok', settings: normalized as HostToolSettings }
  }

  async function mutate(
    fn: (current: HostToolSettings) => HostToolSettings,
  ): Promise<{ ok: true; settings: HostToolSettings } | HostToolFailure> {
    const current = await read()
    if (current.status === 'corrupt' || current.status === 'unreadable') {
      return { ok: false, code: `error.hostTools.${current.status}`, params: { reason: current.error } }
    }
    const base = current.status === 'missing' ? DEFAULT_HOST_TOOL_SETTINGS : current.settings
    const next = fn(base)
    try {
      await deps.writeJsonFile(hostToolsPath(), next)
    } catch (e) {
      return { ok: false, code: 'error.hostTools.writeFailed', params: { reason: String(e) } }
    }
    deps.onWritten?.(next)
    return { ok: true, settings: next }
  }

  return { read, mutate }
}
