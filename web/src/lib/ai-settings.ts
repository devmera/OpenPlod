import type { AiConfig, SpeechProvider, TextProvider } from '../../../src/ai/config'
import type { speechCapabilities } from '../../../src/ai/capabilities'
import { apiUrl, authenticatedHeaders } from './runtime'
export type { AiConfig, SpeechProvider, TextProvider }
export type AiSettings = AiConfig & { credentials: Record<string, boolean>; capabilities: typeof speechCapabilities }
/** Transcription language choices, shared by Settings and the per-recording dialog. Whisper accepts all of them; codes are ISO 639-1. */
export const transcriptionLanguages: [code: string, label: string][] = [
  ['auto', 'Detect automatically'],
  ...([['ar', 'Arabic'], ['zh', 'Chinese'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['fi', 'Finnish'], ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['hi', 'Hindi'], ['hu', 'Hungarian'], ['is', 'Icelandic'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['vi', 'Vietnamese']] as [string, string][]),
]
export type ProcessingJob = { id: string; type?: string; recordingId: string; provider?: string; status: string; error?: string; priority: number; checkpoint?: { phase: string; remoteId?: string } }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const payload = await response.json()
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}
export const aiSettingsApi = {
  get: () => request<AiSettings>('/ai-settings'),
  save: (settings: AiConfig, credentials: Record<string, string>) => request('/ai-settings', 'PUT', { ...settings, credentials }),
  check: (provider: string) => request(`/ai-settings/check/${provider}`, 'POST'),
  models: () => request<string[]>('/ai-settings/ollama-models'),
  jobs: () => request<ProcessingJob[]>('/jobs'),
  cancel: (id: string) => request(`/jobs/${id}/cancel`, 'POST'),
  resume: (id: string) => request(`/jobs/${id}/resume`, 'POST'),
}
