import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { todoistApi, describeSend, formatDue, clock, type ActionItem, type MeetingTasks } from '@/lib/todoist'
import { Button } from '@/components/ui/button'
import { TaskCheck } from '@/components/TaskCheck'
import { Check, Clock3, ListChecks, Loader2, Play, RefreshCw, Send, UserRound } from '@/components/icons'

const meetingDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : ''
type Entry = { meeting: MeetingTasks; item: ActionItem }

/**
 * Every task found in every meeting: yours first across all meetings, then everyone else's by meeting,
 * newest first. Ticked-off tasks are hidden until asked for; ticking one in Todoist ticks it here.
 */
export function TasksPage() {
  const [meetings, setMeetings] = useState<MeetingTasks[] | null>(null), [connected, setConnected] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const load = useCallback(async () => {
    try { const value = await todoistApi.all(); setMeetings(value.meetings); setConnected(value.connected); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Tasks could not be loaded.') }
  }, [])
  useEffect(() => { void load() }, [load])
  const send = async (recordingId: string, item: ActionItem) => {
    setBusy(item.key); setNotice('')
    try { setNotice(describeSend(await todoistApi.send(recordingId, [item.key]))) } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not send to Todoist.') }
    finally { setBusy(null); void load() }
  }
  const update = (recordingId: string, next: ActionItem) => setMeetings(current => current?.map(meeting => meeting.recordingId !== recordingId ? meeting
    : { ...meeting, tasks: meeting.tasks.map(item => item.key === next.key ? { ...item, doneAt: next.doneAt } : item) }) ?? null)

  const entries = (meetings ?? []).flatMap(meeting => meeting.tasks.map(item => ({ meeting, item })))
  const visible = (entry: Entry) => showDone || !entry.item.doneAt
  const mine = entries.filter(entry => entry.item.mine), others = entries.filter(entry => !entry.item.mine)
  const doneCount = entries.filter(entry => entry.item.doneAt).length
  const othersByMeeting = (meetings ?? []).map(meeting => ({ meeting, items: others.filter(entry => entry.meeting === meeting && visible(entry)).map(entry => entry.item) })).filter(group => group.items.length)

  const row = ({ meeting, item }: Entry, showMeeting: boolean) => <li key={meeting.recordingId + item.key + item.title} className={[item.mine && 'mine', item.doneAt && 'done'].filter(Boolean).join(' ') || undefined}>
    <TaskCheck recordingId={meeting.recordingId} item={item} onChange={next => update(meeting.recordingId, next)} onError={setNotice} />
    <span className="action-item-text">
      <span>{item.title}</span>
      <span className="action-item-meta">
        {!item.mine && <span>{item.assignee || 'Unassigned'}</span>}
        {item.dueDate && <span title={item.dueEvidence ? `“${item.dueEvidence}”` : undefined}><Clock3 />{formatDue(item.dueDate)}</span>}
        {showMeeting && <Link className="task-meeting-link" to={`/recording/${meeting.recordingId}`}>{meeting.title} · {meetingDate(meeting.recordedAt)}</Link>}
      </span>
      {item.start !== null
        ? <Link className="action-item-quote" title={`Open the recording at ${clock(item.start)}`} to={`/recording/${meeting.recordingId}?t=${Math.floor(item.start)}`}><Play />{clock(item.start)} · “{item.context}”</Link>
        : <span className="action-item-quote">“{item.context}”</span>}
    </span>
    {connected && (item.sentAt
      ? <span className="action-item-sent" title={`Added ${new Date(item.sentAt).toLocaleString()}`}><Check />In Todoist</span>
      : !item.doneAt && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void send(meeting.recordingId, item)} aria-label={`Add ${item.title} to Todoist`}>{busy === item.key ? <Loader2 className="animate-spin" /> : <Send />}Todoist</Button>)}
  </li>

  const mineVisible = mine.filter(visible)
  return <div className="tasks-page">
    <header className="tasks-page-heading">
      <div><h1>Tasks</h1><p>{meetings === null ? 'Loading…' : `${entries.length - doneCount} open · ${doneCount} done · from ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`}</p></div>
      <div className="tasks-page-actions">
        <label className="tasks-show-done"><input type="checkbox" checked={showDone} onChange={event => setShowDone(event.target.checked)} />Show completed{doneCount ? ` (${doneCount})` : ''}</label>
        <Button variant="ghost" size="icon" aria-label="Refresh tasks" title="Refresh" onClick={() => void load()}><RefreshCw /></Button>
      </div>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!connected && meetings !== null && <p className="tasks-page-hint">Connect Todoist in <Link to="/settings">Settings</Link> to send tasks there.</p>}
    {meetings === null ? <div className="action-items-empty"><Loader2 className="animate-spin" /></div>
      : !entries.length ? <div className="action-items-empty"><ListChecks /><p>No tasks yet.</p><small>Tasks are found when a recording is summarized.</small></div>
      : <>
        <section className="tasks-meeting tasks-mine">
          <h2><UserRound />Your tasks<small>{mine.filter(entry => !entry.item.doneAt).length} open{connected ? ` · ${mine.filter(entry => entry.item.sentAt).length} in Todoist` : ''}</small></h2>
          {mineVisible.length ? <ul>{mineVisible.map(entry => row(entry, true))}</ul> : <p className="tasks-page-hint">{mine.length ? 'All done.' : 'No tasks of yours yet.'}</p>}
        </section>
        {othersByMeeting.length > 0 && <h2 className="tasks-section-title">Everyone else</h2>}
        {othersByMeeting.map(({ meeting, items }) => <section key={meeting.recordingId} className="tasks-meeting">
          <h3><Link to={`/recording/${meeting.recordingId}`}>{meeting.title}</Link><small>{meetingDate(meeting.recordedAt)}</small></h3>
          <ul>{items.map(item => row({ meeting, item }, false))}</ul>
        </section>)}
      </>}
  </div>
}
