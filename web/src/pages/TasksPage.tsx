import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { todoistApi, describeSend, formatDue, clock, type ActionItem, type MeetingTasks } from '@/lib/todoist'
import { Button } from '@/components/ui/button'
import { Check, Clock3, ListChecks, Loader2, Play, RefreshCw, Send, UserRound } from '@/components/icons'

type Filter = 'everyone' | 'mine'
const meetingDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : ''

/** Every task found in every meeting, newest meeting first, with where it was said and its Todoist state. */
export function TasksPage() {
  const [meetings, setMeetings] = useState<MeetingTasks[] | null>(null), [connected, setConnected] = useState(false)
  const [filter, setFilter] = useState<Filter>('everyone')
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

  const shown = (meetings ?? []).map(meeting => ({ ...meeting, tasks: filter === 'mine' ? meeting.tasks.filter(task => task.mine) : meeting.tasks })).filter(meeting => meeting.tasks.length)
  const all = (meetings ?? []).flatMap(meeting => meeting.tasks)
  const mine = all.filter(task => task.mine)

  return <div className="tasks-page">
    <header className="tasks-page-heading">
      <div><h1>Tasks</h1><p>{meetings === null ? 'Loading…' : `${all.length} tasks from ${meetings.length} meeting${meetings.length === 1 ? '' : 's'} · ${mine.length} yours${connected ? ` · ${mine.filter(task => task.sentAt).length} of yours in Todoist` : ''}`}</p></div>
      <div className="tasks-page-actions">
        <div className="tasks-filter" role="group" aria-label="Show tasks">
          {(['everyone', 'mine'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'mine' ? 'Mine' : 'Everyone'}</button>)}
        </div>
        <Button variant="ghost" size="icon" aria-label="Refresh tasks" title="Refresh" onClick={() => void load()}><RefreshCw /></Button>
      </div>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!connected && meetings !== null && <p className="tasks-page-hint">Connect Todoist in <Link to="/settings">Settings</Link> to send tasks there.</p>}
    {meetings === null ? <div className="action-items-empty"><Loader2 className="animate-spin" /></div>
      : !shown.length ? <div className="action-items-empty"><ListChecks /><p>{filter === 'mine' ? 'No tasks of yours yet.' : 'No tasks yet.'}</p><small>Tasks are found when a recording is summarized.</small></div>
      : shown.map(meeting => <section key={meeting.recordingId} className="tasks-meeting">
          <h2><Link to={`/recording/${meeting.recordingId}`}>{meeting.title}</Link><small>{meetingDate(meeting.recordedAt)}</small></h2>
          <ul>{meeting.tasks.map(item => <li key={item.key + item.title} className={item.mine ? 'mine' : undefined}>
            <span className="action-item-text">
              <span>{item.title}</span>
              <span className="action-item-meta">
                {item.mine ? <span className="action-item-owner"><UserRound />You</span> : <span>{item.assignee || 'Unassigned'}</span>}
                {item.dueDate && <span title={item.dueEvidence ? `“${item.dueEvidence}”` : undefined}><Clock3 />{formatDue(item.dueDate)}</span>}
              </span>
              {item.start !== null
                ? <Link className="action-item-quote" title={`Open the recording at ${clock(item.start)}`} to={`/recording/${meeting.recordingId}?t=${Math.floor(item.start)}`}><Play />{clock(item.start)} · “{item.context}”</Link>
                : <span className="action-item-quote">“{item.context}”</span>}
            </span>
            {connected && (item.sentAt
              ? <span className="action-item-sent" title={`Added ${new Date(item.sentAt).toLocaleString()}`}><Check />In Todoist</span>
              : <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void send(meeting.recordingId, item)} aria-label={`Add ${item.title} to Todoist`}>{busy === item.key ? <Loader2 className="animate-spin" /> : <Send />}Todoist</Button>)}
          </li>)}</ul>
        </section>)}
  </div>
}
