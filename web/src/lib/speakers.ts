import { apiUrl, authenticatedHeaders } from './runtime'

export type Person = { id: string; name: string; category: string; samples: number }
export type Speakers = { self: { profileId: string; name: string } | null; people: Person[] }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/speakers${path}`), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) })
  const payload = await response.json()
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}

export const speakersApi = {
  get: () => request<Speakers>(''),
  setSelf: (name: string) => request('/self', 'PUT', { name }),
  forget: (id: string) => request(`/${id}`, 'DELETE'),
  reapply: () => request<{ recordings: number; renamed: number }>('/reapply', 'POST'),
}
