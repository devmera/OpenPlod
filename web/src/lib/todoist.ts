import { apiUrl, authenticatedHeaders } from './runtime'

export type TodoistSettings = { connected: boolean; projectId: string; auto: boolean; principal: string }
export type TodoistProject = { id: string; name: string; inbox: boolean }
export type SendResult = { key: string; title: string; action: 'created' | 'already' | 'failed'; reason?: string }
export type ActionItem = {
  key: string; title: string; description?: string; assignee?: string; dueDate?: string; dueEvidence?: string; mine?: boolean; context: string
  todoistId: string | null; sentAt: string | null
  /** Where the quote was said, in seconds. */
  start: number | null
}
export type MeetingTasks = { recordingId: string; title: string; recordedAt: string | null; tasks: ActionItem[] }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/todoist${path}`), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) })
  const payload = await response.json()
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}

export const todoistApi = {
  get: () => request<{ settings: TodoistSettings; lastRun: { at: string; results: SendResult[]; error?: string } | null }>(''),
  save: (settings: Omit<TodoistSettings, 'connected'> & { token?: string }) => request<TodoistSettings>('', 'PUT', settings),
  disconnect: () => request<TodoistSettings>('', 'DELETE'),
  projects: () => request<TodoistProject[]>('/projects'),
  all: () => request<{ connected: boolean; meetings: MeetingTasks[] }>('/tasks'),
  tasks: (recordingId: string) => request<{ connected: boolean; tasks: ActionItem[] }>(`/recordings/${encodeURIComponent(recordingId)}`),
  send: (recordingId: string, keys?: string[]) => request<SendResult[]>(`/recordings/${encodeURIComponent(recordingId)}`, 'POST', keys ? { keys } : {}),
}

/** One line for a status message. */
export function describeSend(results: SendResult[]): string {
  const count = (action: SendResult['action']) => results.filter(result => result.action === action).length
  const failed = results.find(result => result.action === 'failed')
  if (!results.length) return 'No action items of yours to send.'
  return [count('created') && `Added ${count('created')} to Todoist`, count('already') && `${count('already')} already there`, failed && `${count('failed')} failed: ${failed.reason}`].filter(Boolean).join(' · ')
}

/** "2026-10-16" or "2026-10-16T14:00" as a short local date. */
export function formatDue(due: string): string {
  const [date, time] = due.split('T'), [year, month, day] = date.split('-').map(Number)
  const label = new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return time ? `${label} ${time}` : label
}

/** Seconds as m:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}
