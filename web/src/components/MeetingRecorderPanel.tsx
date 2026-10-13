import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, Loader2, Mic, Square } from '@/components/icons'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { api, type MeetingStatus } from '@/lib/api'
import { meetingsSupported, useElapsed, useMeetingStatus } from '@/lib/meetings'
import { formatDuration } from '@/lib/utils'

/**
 * Settings for recording meetings on this Mac: automatic start when a call app
 * holds the microphone, which apps count, and a manual record button. Changes
 * apply immediately; they are not part of the page's Save button.
 */
export function MeetingRecorderPanel() {
  const supported = meetingsSupported()
  const { status, setStatus, error: loadError } = useMeetingStatus(supported)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!supported) return null

  const run = async (action: () => Promise<MeetingStatus>) => {
    setBusy(true); setError('')
    try { setStatus(await action()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const toggleApp = (id: string) => {
    if (!status) return
    const enabledApps = status.enabledApps.includes(id) ? status.enabledApps.filter(app => app !== id) : [...status.enabledApps, id]
    void run(() => api.updateMeetingSettings({ enabledApps }))
  }
  const shownError = error || status?.error || loadError

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Meeting recording</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Records your microphone and the other participants into the local vault, then processes the
          recording with your transcription settings. Nothing is recorded until you turn this on or press Record.
        </p>

        {!status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking the meeting recorder...</div>
        ) : !status.available ? (
          <p className="text-sm text-muted-foreground">{status.reason}</p>
        ) : (
          <>
            <MeetingSwitch label="Record meetings automatically" busy={busy} checked={status.autoRecord}
              description="Starts when a selected app uses the microphone for a few seconds; stops when the call ends."
              onChange={autoRecord => void run(() => api.updateMeetingSettings({ autoRecord }))} />
            <MeetingSwitch label="Show floating bar while recording" busy={busy} checked={status.floatingBar}
              description="A small bar above all windows with a level meter, Stop, and a pen to mark moments as bookmarks."
              onChange={floatingBar => void run(() => api.updateMeetingSettings({ floatingBar }))} />

            <div>
              <p className="text-sm font-medium">Apps</p>
              <p className="mb-3 text-xs text-muted-foreground">A green dot means the app is using the microphone now.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {status.apps.map(app => (
                  <label key={app.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={app.enabled} disabled={busy} onChange={() => toggleApp(app.id)} />
                    {app.name}
                    {app.active && <span className="h-2 w-2 rounded-full bg-green-500" title="Using the microphone" />}
                  </label>
                ))}
              </div>
            </div>

            <RecordingControl status={status} busy={busy} onStart={() => void run(api.startMeeting)} onStop={() => void run(api.stopMeeting)} />
          </>
        )}

        {shownError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{shownError}</span>
          </div>
        )}

        {status && status.recent.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Recent meetings</p>
            <ul className="space-y-1 text-sm">
              {status.recent.map(meeting => (
                <li key={meeting.recordingId} className="flex justify-between gap-3">
                  <Link to={`/recording/${meeting.recordingId}`} className="truncate hover:underline">{meeting.title}</Link>
                  <span className="shrink-0 text-muted-foreground">{formatDuration(meeting.durationSeconds)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MeetingSwitch({ label, description, checked, busy, onChange }: { label: string; description: string; checked: boolean; busy: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={busy} onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-secondary'}`}>
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform shadow-sm ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function RecordingControl({ status, busy, onStart, onStop }: { status: MeetingStatus; busy: boolean; onStart: () => void; onStop: () => void }) {
  const elapsed = useElapsed(status.recording?.startedAt)
  if (status.recording) {
    return (
      <div className="flex items-center justify-between rounded-md border p-3">
        <span className="flex items-center gap-2 text-sm">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
          {status.recording.starting ? 'Starting...' : `Recording ${status.recording.app?.name ?? 'meeting'} · ${formatDuration(elapsed)}`}
        </span>
        <Button variant="outline" size="sm" onClick={onStop} disabled={busy}><Square />Stop</Button>
      </div>
    )
  }
  return <Button variant="outline" onClick={onStart} disabled={busy}><Mic />Record meeting now</Button>
}
