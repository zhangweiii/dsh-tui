/**
 * Transport selection: prefer the live Web Host, keep an explicit standalone
 * escape hatch, and fall back to the in-tree Host when implicit discovery finds
 * nothing.
 *
 * @module @zhangweiii/dsh-tui/host/selection
 */

import { DEFAULT_WEB_ORIGIN, RemoteTransport } from './remote.ts'
import { HostApiClient } from './client.ts'

import type { TuiStartupValues } from '../startup.ts'

const AUTO_CONNECT_TIMEOUT_MS = 500
const EXPLICIT_CONNECT_TIMEOUT_MS = 5_000

/** Selected carrier plus whether the Host belongs to the Web process. */
export interface TuiApiSelection {
  /** Client used by the controller. */
  api: HostApiClient
  /** Whether the client speaks to a Web Host process. */
  remote: boolean
}

type RemoteFactory = (origin: string) => HostApiClient

/**
 * Prefer the live Web Host, while retaining an explicit standalone escape hatch.
 * @param config - Parsed TUI connection flags.
 * @param local - Same-process client used for standalone mode and implicit fallback.
 * @param createRemote - Remote client factory overridden by focused tests.
 * @returns The selected client and whether it belongs to the Web Host.
 */
export async function selectTuiApi(
  config: TuiStartupValues,
  local: HostApiClient,
  createRemote: RemoteFactory = origin => new HostApiClient(new RemoteTransport(origin)),
): Promise<TuiApiSelection> {
  if (config.standalone === true) return { api: local, remote: false }
  const explicit = config.connect !== undefined
  const origin = config.connect ?? DEFAULT_WEB_ORIGIN
  try {
    const remote = createRemote(origin)
    const response = await remote.host.describe(
      {}, AbortSignal.timeout(explicit ? EXPLICIT_CONNECT_TIMEOUT_MS : AUTO_CONNECT_TIMEOUT_MS),
    )
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { api: remote, remote: true }
  } catch (error) {
    if (explicit) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法连接 Web Host ${origin}：${detail}`)
    }
    return { api: local, remote: false }
  }
}
