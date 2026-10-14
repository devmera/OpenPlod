import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AudioLines, Bluetooth, Check, CheckCircle2, Clock3, CloudUpload, Download, FileAudio, FolderOpen, HardDrive, Loader2, Radio, RefreshCw, ShieldCheck, Trash2, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { NoteDialog } from '@/components/NoteDialogs'
import { DesktopAuthorizations, DesktopImportPreferences } from '@/components/PlaudAuthorization'
import { PlaudCloudImport } from '@/components/PlaudCloudImport'
import { PlaudDeviceAuthorization } from '@/components/PlaudDeviceAuthorization'
import { PlaudSystemCheck } from '@/components/PlaudSystemCheck'
import { api, type DashboardStats, type DeviceRecording, type PlaudStatus } from '@/lib/api'
import { presenceLabel, usePlaudSyncStatus } from '@/lib/plaud-sync'
import { libraryChanged } from '@/lib/library-changes'
import './desktop-plaud.css'

/** The page's three jobs: everyday transfer, one-time setup and diagnostics, and the cloud import. */
const TABS = [
  { id: 'recorder', label: 'Recorder', icon: Bluetooth },
  { id: 'setup', label: 'Setup', icon: ShieldCheck },
  { id: 'cloud', label: 'Plaud cloud', icon: CloudUpload },
] as const
type TabId = typeof TABS[number]['id']
const isTab = (value: string | null): value is TabId => TABS.some(tab => tab.id === value)

const sessionDate = (session: DeviceRecording) => new Date(session.sessionId * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function DesktopPlaud() {
  const [status, setStatus] = useState<PlaudStatus | null>(null)
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'listing' | 'downloading' | 'deleting' | 'cancelling'>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanned, setScanned] = useState<DeviceRecording[] | null>(null)
  // The list from the last background sync, shown until (or instead of) a manual connect.
  const [cached, setCached] = useState<{ sessions: DeviceRecording[]; checkedAt: string } | null>(null)
  const sync = usePlaudSyncStatus()
  const presence = presenceLabel(sync)
  const [selected, setSelected] = useState<number[]>([])
  const [confirmation, setConfirmation] = useState<DeviceRecording[] | null>(null)
  const [removal, setRemoval] = useState<DeviceRecording[] | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const requestedTab = searchParams.get('tab')
  // Without an explicit tab, open Setup until this computer is authorized for the recorder.
  const tab: TabId = isTab(requestedTab) ? requestedTab : authorized === false ? 'setup' : 'recorder'
  const selectTab = useCallback((next: TabId) => {
    setSearchParams(current => { const params = new URLSearchParams(current); params.set('tab', next); return params }, { replace: true })
  }, [setSearchParams])
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})
  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(entry => entry.id === tab)
    const target = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1
    if (target < 0) return
    event.preventDefault()
    selectTab(TABS[target].id)
    tabRefs.current[TABS[target].id]?.focus()
  }
  const wasAuthorized = useRef<boolean | null>(null)
  const loadAuthorization = useCallback(() => {
    void api.getPlaudIdentity().then(identity => {
      if (!mounted.current) return
      // Finishing setup leads straight to the recordings.
      if (wasAuthorized.current === false && identity.authorized) selectTab('recorder')
      wasAuthorized.current = identity.authorized
      setAuthorized(identity.authorized)
    }).catch(() => undefined)
  }, [selectTab])
  const mounted = useRef(true)
  const active = useRef<AbortController | null>(null)
  const cancelling = useRef(false)
  const recordingSection = useRef<HTMLElement>(null)
  const busy = phase !== 'idle'
  const sessions = scanned ?? cached?.sessions ?? null
  const fromBackground = scanned === null && cached !== null
  const pending = sessions?.filter(session => !session.recordingId) || []
  const imported = sessions?.filter(session => session.recordingId) || []

  const loadCached = useCallback(() => {
    void api.getCachedDeviceRecordings().then(value => { if (mounted.current) setCached(value) }).catch(() => undefined)
  }, [])
  // A finished background round may have changed the list or imported recordings.
  const lastRound = sync?.lastSync?.at ?? sync?.lastChecked ?? null
  useEffect(() => { loadCached(); loadStats() }, [lastRound, loadCached]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadStats = useCallback(() => {
    void api.getStats().then(value => { if (mounted.current) { setStats(value); setStatsError('') } })
      .catch(() => { if (mounted.current) setStatsError('Vault summary unavailable') })
  }, [])
  useEffect(() => {
    mounted.current = true; loadStats(); loadAuthorization()
    window.addEventListener('plaud:sync-complete', loadStats)
    window.addEventListener(libraryChanged, loadStats)
    return () => { mounted.current = false; active.current?.abort(); window.removeEventListener('plaud:sync-complete', loadStats); window.removeEventListener(libraryChanged, loadStats) }
  }, [loadStats, loadAuthorization])

  const scan = async () => {
    if (active.current) return
    const controller = new AbortController(); active.current = controller
    setPhase('scanning'); setError(''); setNotice(''); setScanned(null); setSelected([]); setStatus(null); setCheckedAt(null)
    try {
      const result = await api.getPlaudStatus(controller.signal)
      if (controller.signal.aborted) return
      setStatus(result)
      if (result.directTransferAvailable) {
        setPhase('listing')
        const files = await api.getDeviceRecordings(controller.signal)
        if (!controller.signal.aborted) { setScanned(files); setCheckedAt(new Date()) }
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Bluetooth scan failed.')
    } finally { if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) setPhase('idle') } }
  }

  const download = async () => {
    if (active.current || !confirmation?.length) return
    const items = confirmation
    const controller = new AbortController(); active.current = controller
    setConfirmation(null); setPhase('downloading'); setError(''); setNotice('')
    let saved = 0
    try {
      for (const session of items) {
        controller.signal.throwIfAborted(); setDownloading(session.sessionId)
        const id = await api.importDeviceRecording(session.sessionId, controller.signal)
        if (controller.signal.aborted) return
        saved++
        setScanned(current => current?.map(item => item.sessionId === session.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) ?? null)
        setCached(current => current && { ...current, sessions: current.sessions.map(item => item.sessionId === session.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) })
        setSelected(current => current.filter(value => value !== session.sessionId))
        setNotice(`${saved} recording${saved === 1 ? '' : 's'} saved to your vault`)
        window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Download failed')
    } finally {
      if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
    }
  }
  // Frees the recorder's storage. The server deletes only recordings it holds a verified copy of and
  // confirms each by listing the recorder again, so the list is updated from its answer.
  const removeFromDevice = async () => {
    if (active.current || !removal?.length) return
    const items = removal
    const controller = new AbortController(); active.current = controller
    setRemoval(null); setPhase('deleting'); setError(''); setNotice('')
    try {
      const outcomes = await api.deleteDeviceRecordings(items.map(session => session.sessionId), controller.signal)
      if (controller.signal.aborted) return
      const gone = new Set(outcomes.filter(outcome => outcome.deleted).map(outcome => outcome.sessionId))
      const kept = outcomes.filter(outcome => !outcome.deleted)
      setScanned(current => current?.filter(item => !gone.has(item.sessionId)) ?? null)
      setCached(current => current && { ...current, sessions: current.sessions.filter(item => !gone.has(item.sessionId)) })
      setNotice(`${gone.size} recording${gone.size === 1 ? '' : 's'} deleted from the Note Pro${kept.length ? `; ${kept.length} kept: ${kept[0].reason}` : ''}`)
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Delete from the Note Pro failed')
    } finally {
      if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) setPhase('idle') }
    }
  }
  const cancel = async () => {
    if (cancelling.current) return
    cancelling.current = true; setPhase('cancelling')
    active.current?.abort()
    try { await api.cancelDeviceOperation(); if (mounted.current) setNotice('Operation cancelled. Recordings already saved remain in the vault.') }
    catch { if (mounted.current) setError('Could not confirm cancellation. Check the library before retrying.') }
    finally { cancelling.current = false; active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
  }

  const access = sessions !== null
  // Manual operations first, then what background sync currently knows about the recorder.
  const statusLabel = phase === 'cancelling' ? 'Cancelling' : phase === 'scanning' ? 'Searching nearby' : phase === 'listing' ? 'Reading device' : phase === 'downloading' ? 'Importing audio' : phase === 'deleting' ? 'Deleting from device'
    : presence?.live ? presence.label : scanned !== null ? 'Access verified' : presence ? presence.label
    : status?.deviceDetected ? 'Device detected' : status ? 'Not detected' : 'Not connected'
  const live = access && (scanned !== null || Boolean(presence?.live))
  const states = [
    { icon: Radio, name: 'Bluetooth discovery', value: status ? status.deviceDetected ? 'Detected' : 'Not detected' : phase === 'scanning' ? 'Searching' : 'Not checked', ok: !!status?.deviceDetected },
    { icon: Bluetooth, name: 'Bluetooth connection', value: access || status?.connectionVerified ? 'Verified' : 'Not verified', ok: access || !!status?.connectionVerified },
    { icon: FileAudio, name: 'Recording access', value: access ? 'Verified' : phase === 'listing' ? 'Checking' : 'Unknown', ok: access },
    { icon: ShieldCheck, name: 'Device authorization', value: status ? status.directTransferAvailable ? 'Configured' : 'Not configured' : 'Not checked', ok: !!status?.directTransferAvailable },
    { icon: AudioLines, name: 'Recordings found', value: sessions === null ? 'Unknown' : String(sessions.length), ok: access },
  ]

  return <div className="plaud-workspace">
    <header className="plaud-page-heading"><div className="plaud-page-title"><span className="plaud-heading-icon"><Bluetooth /></span><div><h1>Plaud Note Pro</h1><p>Device, recordings &amp; imports</p></div></div>
      <div className="plaud-status-strip" role="status"><span className="plaud-state" data-verified={live}><i />{statusLabel}</span>{checkedAt && <span className="plaud-checked"><Clock3 />Checked {checkedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}</div>
    </header>
    <div className="plaud-tabs" role="tablist" aria-label="Plaud sections">
      {TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`plaud-tab-${id}`} aria-controls={`plaud-panel-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} ref={node => { tabRefs.current[id] = node }}
        onClick={() => selectTab(id)} onKeyDown={onTabKey}>
        <Icon />{label}{id === 'setup' && authorized === false && <span className="plaud-tab-attention" aria-label="Action needed" />}
      </button>)}
    </div>
    {(error || notice) && <div className={`plaud-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <Radio /> : <Check />}<span>{error || notice}</span><IconButton label="Dismiss device message" onClick={() => { setError(''); setNotice('') }}><X /></IconButton></div>}
    <div className="plaud-workspace-grid plaud-tab-recorder" role="tabpanel" id="plaud-panel-recorder" aria-labelledby="plaud-tab-recorder" hidden={tab !== 'recorder'}>
      {authorized === false && <div className="plaud-setup-callout" role="status"><ShieldCheck /><span>This computer is not authorized for your Note Pro yet, so it cannot read its recordings.</span><Button size="sm" variant="outline" onClick={() => selectTab('setup')}>Open setup</Button></div>}
      <section className="plaud-device-overview" aria-label="Desktop Plaud connection">
        <div className="plaud-product-image"><img src="/plaud-note-pro.png" alt="Plaud Note Pro recorder" width="220" height="280" /></div>
        <div className="plaud-device-info"><h2>{status?.deviceName || 'Plaud Note Pro'}</h2><p>AI voice recorder</p>
          <dl><div><dt><Bluetooth />Bluetooth</dt><dd className="plaud-state" data-verified={live}><i />{statusLabel}</dd></div><div><dt><FileAudio />On device</dt><dd>{sessions === null ? 'Unknown' : `${sessions.length} recordings`}</dd></div><div><dt><ShieldCheck />Original audio</dt><dd>Kept on Plaud</dd></div></dl>
          <div className="plaud-connect-actions"><Button disabled={busy} onClick={() => void scan()}>{busy ? <Loader2 className="animate-spin" /> : status ? <RefreshCw /> : <Bluetooth />}{phase === 'scanning' ? 'Connecting' : phase === 'listing' ? 'Reading recordings' : status ? 'Refresh recordings' : 'Connect Note Pro'}</Button>
            {busy && <IconButton label="Cancel device operation" onClick={() => void cancel()}><X /></IconButton>}</div>
          <div className="plaud-secondary-actions"><Button size="sm" variant="outline" disabled={busy || !pending.length} onClick={() => setConfirmation(pending)}><Download />Import new</Button><Button asChild variant="outline" size="sm"><Link to="/recordings"><FolderOpen />Open library</Link></Button>
            <Button size="sm" variant="outline" disabled={busy || !imported.length} onClick={() => setRemoval(imported)}><Trash2 />Free up space</Button></div>
        </div>
      </section>
      <section className="plaud-device-recordings" aria-label="Recordings on Note Pro" ref={recordingSection}>
        <header className="plaud-section-heading"><span className="plaud-section-icon"><FileAudio /></span><div><h2>On your Note Pro</h2><p>{sessions === null ? 'Recording count unknown' : `${sessions.length} recordings / ${pending.length} new`}{fromBackground && cached && ` · as of ${new Date(cached.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}</p></div><Button size="sm" disabled={busy || !selected.length} onClick={() => setConfirmation(pending.filter(session => selected.includes(session.sessionId)))}><Download /><span>Import selected{selected.length ? ` (${selected.length})` : ''}</span></Button></header>
        {sessions === null ? <div className="plaud-recordings-empty">{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />}<h3>{busy ? 'Reading your Note Pro' : 'Connect to see recordings'}</h3><p>{status && !status.directTransferAvailable ? 'Device authorization is not configured on this computer.' : error ? 'The device list is unavailable. No recording count has been reported.' : 'No recording list has been received yet.'}</p>{!busy && <Button variant="outline" size="sm" onClick={() => void scan()}><RefreshCw />{error ? 'Try again' : 'Check device'}</Button>}</div>
          : sessions.length === 0 ? <div className="plaud-recordings-empty"><FileAudio /><h3>No completed recordings returned</h3><p>Finish a recording on the Note Pro, then refresh.</p></div> : <>
            <label className="plaud-select-all"><input type="checkbox" aria-label="Select all new recordings" checked={pending.length > 0 && selected.length === pending.length} ref={node => { if (node) node.indeterminate = selected.length > 0 && selected.length < pending.length }} disabled={busy || !pending.length} onChange={event => setSelected(event.target.checked ? pending.map(session => session.sessionId) : [])} /><span>Select all new</span><small>{sessions.length} on device</small></label>
            <div className="plaud-session-list">{sessions.map(session => <div className="plaud-session" key={session.sessionId}>
              <input type="checkbox" aria-label={`Select recording ${session.sessionId}`} disabled={busy || !!session.recordingId} checked={selected.includes(session.sessionId)} onChange={event => setSelected(current => event.target.checked ? [...current, session.sessionId] : current.filter(id => id !== session.sessionId))} />
              <FileAudio /><div className="plaud-session-name"><strong>{sessionDate(session)}</strong><small>Session {session.sessionId}</small></div><span className="plaud-session-size">{Math.round(session.size / 1024)} KB</span>
              <span className="plaud-session-state" data-imported={!!session.recordingId}>{session.retentionState === 'trash' ? 'In Trash' : session.recordingId ? 'Imported' : 'New'}</span>
              {session.recordingId ? <><Button asChild variant="ghost" size="icon"><Link title="Open recording" aria-label={`Open recording ${session.sessionId}`} to={`/recording/${session.recordingId}`}><FolderOpen /></Link></Button><IconButton label={`Delete recording ${session.sessionId} from the Note Pro`} disabled={busy} onClick={() => setRemoval([session])}><Trash2 /></IconButton></> : <IconButton label={`Import recording ${session.sessionId}`} disabled={busy} onClick={() => setConfirmation([session])}>{downloading === session.sessionId ? <Loader2 className="animate-spin" /> : <Download />}</IconButton>}
            </div>)}</div>
          </>}
        {phase === 'deleting' && <div className="plaud-import-progress" role="status"><Loader2 className="animate-spin" /><span>Deleting from the Note Pro</span></div>}
        {phase === 'downloading' && <div className="plaud-import-progress" role="status"><Loader2 className="animate-spin" /><span>Importing session {downloading}</span><Button variant="ghost" size="sm" onClick={() => void cancel()}><X />Cancel</Button></div>}
      </section>
      <div className="plaud-vault-column">
        <section className="plaud-vault-summary" aria-label="Saved recordings"><header className="plaud-section-heading"><span className="plaud-section-icon"><HardDrive /></span><div><h2>Saved recordings</h2><p>Stored in your desktop vault</p></div><IconButton asChild label="Open saved recordings"><Link to="/recordings"><FolderOpen /></Link></IconButton></header>
          {statsError ? <p className="plaud-muted" role="status">{statsError} <button onClick={loadStats}>Retry</button></p> : <div className="plaud-vault-count"><strong>{stats?.totalRecordings ?? '...'}</strong><span>Total recordings in vault</span>{stats && <small>{stats.totalHours.toFixed(1)} h of audio</small>}</div>}
        </section>
        <DesktopImportPreferences />
      </div>
    </div>
    <div className="plaud-authorizations plaud-tab-setup" role="tabpanel" id="plaud-panel-setup" aria-labelledby="plaud-tab-setup" hidden={tab !== 'setup'}>
      <PlaudDeviceAuthorization status={status} onAuthorized={() => { loadAuthorization(); void scan() }} />
      <PlaudSystemCheck />
      <section className="plaud-health" aria-label="Connection health"><header className="plaud-section-heading"><span className="plaud-section-icon"><ShieldCheck /></span><div><h2>Connection health</h2><p>{access ? 'Recording list verified on this computer' : 'Awaiting verified device access'}</p></div>{access && <CheckCircle2 className="plaud-positive" />}</header>
        <dl>{states.map(({ icon: Icon, name, value, ok }) => <div key={name}><dt><Icon />{name}</dt><dd className="plaud-state" data-verified={ok}><i />{value}</dd></div>)}</dl>
        {status?.detail && <details className="plaud-diagnostics"><summary>Connection details</summary><p>{status.detail}</p></details>}
      </section>
      <DesktopAuthorizations />
    </div>
    <div className="plaud-authorizations plaud-tab-cloud" role="tabpanel" id="plaud-panel-cloud" aria-labelledby="plaud-tab-cloud" hidden={tab !== 'cloud'}>
      <PlaudCloudImport />
    </div>
    {confirmation && <NoteDialog title="Import from Plaud" description={`${confirmation.length} recording${confirmation.length === 1 ? '' : 's'}`} busy={false} onClose={() => setConfirmation(null)}>
      <p className="plaud-confirm-copy">Save the selected audio to your OpenPlod vault? Original recordings will stay on your Plaud.</p><ul className="plaud-confirm-list">{confirmation.map(session => <li key={session.sessionId}><FileAudio /><span>{sessionDate(session)}</span><small>{Math.round(session.size / 1024)} KB</small></li>)}</ul>
      <footer><Button variant="ghost" onClick={() => setConfirmation(null)}><X />Cancel</Button><Button onClick={() => void download()}><Download />Import {confirmation.length} recording{confirmation.length === 1 ? '' : 's'}</Button></footer>
    </NoteDialog>}
    {removal && <NoteDialog title="Delete from Note Pro" description={`${removal.length} recording${removal.length === 1 ? '' : 's'}`} busy={false} onClose={() => setRemoval(null)}>
      <p className="plaud-confirm-copy">Delete these recordings from the recorder to free its storage? OpenPlod keeps its copies, including the original recorder files, and skips any recording it does not hold a complete copy of. This cannot be undone on the recorder.</p><ul className="plaud-confirm-list">{removal.map(session => <li key={session.sessionId}><FileAudio /><span>{sessionDate(session)}</span><small>{Math.round(session.size / 1024)} KB</small></li>)}</ul>
      <footer><Button variant="ghost" onClick={() => setRemoval(null)}><X />Cancel</Button><Button variant="destructive" onClick={() => void removeFromDevice()}><Trash2 />Delete {removal.length} from Note Pro</Button></footer>
    </NoteDialog>}
  </div>
}
