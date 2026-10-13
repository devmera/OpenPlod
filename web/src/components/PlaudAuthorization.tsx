import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as Switch from '@radix-ui/react-switch'
import { Check, Download, FileText, KeyRound, Loader2, RefreshCw, Settings2, ShieldCheck, Smartphone, Speech, X } from "@/components/icons"
import { Button } from './ui/button'
import { api, type PlaudSyncStatus, type Settings } from "@/lib/api"
import { apiUrl, authenticatedHeaders } from '@/lib/runtime'
import { deviceCommand, vaultArguments } from '@/lib/plaud-device'
import { confirmAction } from '@/lib/confirm'

async function plaudRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(apiUrl(`/plaud${path}`), { method: method || (body ? 'POST' : 'GET'),
    headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error(result.error || 'Plaud request failed.')
  return result.data
}
type Enrollment = { id: string; name: string; code: string; expiresAt: number; state: string }
type ApprovedPhone = { id: string; name: string; code: string; serial: string; approvedAt: string }
type AutoImportStatus = PlaudSyncStatus
export function DesktopImportPreferences() {
  const [state, setState] = useState<AutoImportStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => { let stopped = false; api.getSettings().then(value => { if (!stopped) setSettings(value) }).catch(e => { if (!stopped) setError((e as Error).message) }); return () => { stopped = true } }, [])
  useEffect(() => {
    let stopped = false
    const poll = async () => { try { const next = await plaudRequest<AutoImportStatus>('/auto-import'); if (!stopped) setState(next) } catch (e) { if (!stopped) setError((e as Error).message) } }
    void poll(); const timer = setInterval(() => void poll(), 4000); return () => { stopped = true; clearInterval(timer) }
  }, [])
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { setState(await plaudRequest<AutoImportStatus>('/auto-import', { enabled }, 'PATCH')) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const syncNow = async () => {
    setError('')
    try { setState(await api.syncPlaudNow()) } catch (e) { setError((e as Error).message) }
  }
  const updateProcessing = async (key: 'autoTranscribe' | 'autoSummarize', enabled: boolean) => {
    setBusy(true); setError('')
    try { setSettings(await api.updateSettings({ [key]: enabled })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="device-section plaud-preferences"><div className="device-section-heading"><Settings2 /><h2>Import preferences</h2></div>
    <label className="plaud-preference-row"><Download /><span><strong>Automatically import new recordings</strong><small>Syncs when your Note Pro is nearby, at most every 2 minutes, while OpenPlod runs (also from the menu bar)</small></span><Switch.Root className="plaud-switch" aria-label="Automatically import new recordings" checked={state?.enabled || false} disabled={busy || !state} onCheckedChange={enabled => void toggle(enabled)}><Switch.Thumb /></Switch.Root></label>
    <div className="plaud-preference-row"><ShieldCheck /><span><strong>Keep originals on device</strong><small>Direct imports never delete Plaud audio</small></span><Check className="plaud-positive" aria-label="Always retained" /></div>
    <label className="plaud-preference-row"><Speech /><span><strong>Transcribe after import</strong><small>{settings?.openWhistleForwarding ? 'Processing is managed by OpenWhistle' : 'Use your configured transcription provider'}</small></span><Switch.Root className="plaud-switch" aria-label="Transcribe after import" checked={settings?.autoTranscribe || false} disabled={busy || !settings || settings.openWhistleForwarding} onCheckedChange={enabled => void updateProcessing('autoTranscribe', enabled)}><Switch.Thumb /></Switch.Root></label>
    <label className="plaud-preference-row"><FileText /><span><strong>Summarize after transcription</strong><small>Generate an AI summary when transcription finishes</small></span><Switch.Root className="plaud-switch" aria-label="Summarize after transcription" checked={settings?.autoSummarize || false} disabled={busy || !settings || settings.openWhistleForwarding} onCheckedChange={enabled => void updateProcessing('autoSummarize', enabled)}><Switch.Thumb /></Switch.Root></label>
    {state?.running && <p role="status" className="device-muted">Checking and importing recordings...</p>}
    {state?.enabled && <div className="plaud-sync-line">
      <p className="device-muted">{state.running ? 'Syncing now…' : state.lastSync ? `Last synced ${new Date(state.lastSync.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${state.lastSync.imported ? `${state.lastSync.imported} new` : 'nothing new'}` : state.lastChecked ? `Last checked ${new Date(state.lastChecked).toLocaleTimeString()}` : 'Waiting for your Note Pro'}</p>
      <Button size="sm" variant="outline" disabled={busy || state.running} onClick={() => void syncNow()}>{state.running ? <Loader2 className="animate-spin" /> : <RefreshCw />}{state.watch?.syncPending ? 'Waiting for Note Pro' : 'Sync now'}</Button>
    </div>}
    {state?.skipped ? <p className="device-muted">{state.skipped} recording{state.skipped === 1 ? ' was' : 's were'} made under a key this computer does not hold and {state.skipped === 1 ? 'is' : 'are'} not imported.</p> : null}
    {(error || state?.error) && <p className="device-error" role="alert">{error || state?.error}</p>}
    {state?.events.slice(0, 3).map(event => <p className="device-muted" key={event.id}>Saved to vault / {new Date(event.createdAt).toLocaleString()}</p>)}
  </section>
}

export function PhoneAuthorization({ onDone }: { onDone: () => void }) {
  const [request, setRequest] = useState<Enrollment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true); setError('')
    try {
      if (!request || request.expiresAt <= Date.now()) setRequest(await deviceCommand<Enrollment>('requestAuthorization', vaultArguments()))
      else { await deviceCommand('finishAuthorization', vaultArguments()); onDone() }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="device-section" aria-label="Authorize phone">
    <div className="device-section-heading"><h2><KeyRound className="inline size-4 mr-2" />Add your Note Pro</h2></div>
    <p className="device-muted">{request ? 'On your desktop, open Plaud device and approve this verification code.' : 'Authorize this phone once from your paired desktop. Audio will download directly over this phone\'s Bluetooth.'}</p>
    {request && <p className="text-2xl font-mono py-4" aria-label="Verification code">{request.code}</p>}
    {error && <p role="alert" className="device-error">{error}</p>}
    <Button disabled={busy} onClick={() => void run()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{request && request.expiresAt > Date.now() ? 'I approved on my desktop' : 'Request authorization'}</Button>
  </section>
}

export function DesktopAuthorizations({ inline = false }: { inline?: boolean }) {
  const [requests, setRequests] = useState<Enrollment[]>([])
  const [phones, setPhones] = useState<ApprovedPhone[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      try {
        const [rows, approved] = await Promise.all([plaudRequest<Enrollment[]>('/authorizations'), plaudRequest<ApprovedPhone[]>('/approved-phones')])
        if (!stopped) { setRequests(rows.filter(r => r.state === 'pending')); setPhones(approved) }
      } catch (e) { if (!stopped) setError((e as Error).message) }
    }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])
  const act = async (request: Enrollment, approve: boolean) => {
    setBusy(request.id); setError('')
    // Approving confirms the code the user compared on both screens; a request from another device shows a different code.
    try {
      await plaudRequest(`/authorizations/${request.id}${approve ? '/approve' : ''}`, approve ? { confirm: true, code: request.code } : undefined, approve ? 'POST' : 'DELETE')
      setRequests(rows => rows.filter(r => r.id !== request.id))
      if (approve) setPhones(await plaudRequest<ApprovedPhone[]>('/approved-phones'))
    }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const forget = async (phone: ApprovedPhone) => {
    if (!(await confirmAction(`Remove "${phone.name}" from this list? This does not take the recorder key back: unlink the phone in its app to remove it there.`, { confirmLabel: 'Remove from list' }))) return
    setBusy(phone.id); setError('')
    try { await plaudRequest(`/approved-phones/${phone.id}`, undefined, 'DELETE'); setPhones(rows => rows.filter(row => row.id !== phone.id)) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return <section className="device-section" aria-label="Phone authorizations">
    <div className="device-section-heading"><Smartphone className="size-5" /><h2>Authorize a phone</h2>{!inline && <Button asChild size="sm" variant="outline"><Link to="/android"><Smartphone />Pair a phone</Link></Button>}</div>
    {requests.length === 0 && <p className="device-muted">After pairing, request recorder access on the phone. Approving copies your recorder key here, encrypted for that phone only.</p>}
    {requests.map(request => <div key={request.id} className="device-recording-row">
      <span><strong>{request.name}</strong><small>Approve only if the phone shows this same code.</small></span>
      <code className="phone-approval-code" aria-label={`Verification code ${request.code.split('').join(' ')}`}>{request.code}</code>
      <Button size="sm" title="Approve phone" disabled={!!busy} onClick={() => void act(request, true)}><Check />Codes match</Button>
      <Button size="icon" variant="ghost" title="Decline phone" aria-label="Decline phone" disabled={!!busy} onClick={() => void act(request, false)}><X /></Button>
    </div>)}
    {phones.length > 0 && <div className="approved-phones">
      <h3>Approved phones</h3>
      {phones.map(phone => <div key={phone.id} className="device-recording-row">
        <span><strong>{phone.name}</strong><small>Approved {new Date(phone.approvedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · code {phone.code}</small></span>
        <ShieldCheck className="approved-phone-icon" aria-label="Has recorder access" />
        <Button size="icon" variant="ghost" title="Remove from list" aria-label={`Remove ${phone.name} from list`} disabled={!!busy} onClick={() => void forget(phone)}><X /></Button>
      </div>)}
      <p className="device-muted">Each approved phone holds its own copy of the recorder key until it is unlinked in the phone app.</p>
    </div>}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section>
}
