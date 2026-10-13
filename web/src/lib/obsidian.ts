import { apiUrl, authenticatedHeaders } from './runtime'

export type ObsidianSettings = { vaultPath: string; folder: string; auto: boolean }
export type ExportResult = { recordingId: string; action: 'created' | 'updated' | 'unchanged' | 'conflict' | 'deleted' | 'skipped'; path?: string; reason?: string }
export type ObsidianStatus = {
  settings: ObsidianSettings; vaults: string[]; pending: number
  conflicts: { recordingId: string; path: string; reason: string; filename: string | null }[]
  lastRun: { at: string; results: ExportResult[] } | null
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/obsidian${path}`), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) })
  const payload = await response.json()
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}

export const obsidianApi = {
  get: () => request<ObsidianStatus>(''),
  save: (settings: ObsidianSettings) => request<ObsidianSettings>('', 'PUT', settings),
  exportAll: () => request<ExportResult[]>('/export', 'POST', { all: true }),
  exportRecording: (recordingId: string, replace = false) => request<ExportResult[]>('/export', 'POST', { recordingId, replace }).then(results => results[0]),
}

/** One line for a toast or status message. */
export function describeExport(result: ExportResult): string {
  switch (result.action) {
    case 'created': return `Created ${result.path} in Obsidian`
    case 'updated': return `Updated ${result.path} in Obsidian`
    case 'unchanged': return `${result.path} is already up to date`
    case 'conflict': return `${result.reason} Use Replace in Settings to overwrite it.`
    case 'deleted': return `${result.reason} Use Replace in Settings to recreate it.`
    default: return result.reason ?? 'Not exported.'
  }
}
