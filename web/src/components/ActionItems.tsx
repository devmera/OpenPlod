import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { todoistApi, describeSend, formatDue, clock, type ActionItem, type TodoistSettings } from '@/lib/todoist'
import { Button } from '@/components/ui/button'
import { TaskCheck } from '@/components/TaskCheck'
import { AlignLeft, Check, Clock3, ListChecks, Loader2, Play, RefreshCw, Send, UserRound } from '@/components/icons'

type Status = { settings: TodoistSettings; lastRun: { at: string; error?: string } | null }
type Group = { owner: string; mine: boolean; items: ActionItem[] }

/** Groups tasks by who owns them: yours first, then each named person, then unassigned. */
function groupTasks(items: ActionItem[]): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const owner = item.mine ? 'You' : item.assignee?.trim() || 'Unassigned'
    const group = groups.get(owner) ?? { owner, mine: Boolean(item.mine), items: [] }
    group.items.push(item)
    groups.set(owner, group)
  }
  const rank = (group: Group) => group.mine ? 0 : group.owner === 'Unassigned' ? 2 : 1
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.owner.localeCompare(b.owner))
}

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * A recording's action items with sending to Todoist when it is connected. `full` shows every task
 * grouped by owner with the Todoist connection and each task's sync state; otherwise a flat list.
 * `version` reloads the list after a new summary.
 */
export function ActionItems({ recordingId, version, full = false, summarized = true, error, onSeek }: { recordingId: string; version?: string | null; full?: boolean; summarized?: boolean; error?: string | null; onSeek?: (seconds: number) => void }) {
  const [items, setItems] = useState<ActionItem[] | null>(null), [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    const [tasks, todoist] = await Promise.all([todoistApi.tasks(recordingId).catch(() => null), todoistApi.get().catch(() => null)])
    setItems(tasks?.tasks ?? []); setStatus(todoist)
  }, [recordingId])
  useEffect(() => { void load() }, [load, version])
  const send = async (key: string, keys?: string[]) => {
    setBusy(key); setNotice('')
    try { setNotice(describeSend(await todoistApi.send(recordingId, keys))) } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not send to Todoist.') }
    finally { setBusy(null); void load() }
  }
  const summarize = async () => {
    setBusy('summarize'); setNotice('')
    try { await api.summarize(recordingId); setNotice('Summarizing. Tasks appear here when it finishes.'); void load() }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Could not summarize.') }
    finally { setBusy(null) }
  }
  const connected = Boolean(status?.settings.connected), auto = connected && Boolean(status?.settings.auto)
  if (items === null) return full ? <div className="action-items-empty"><Loader2 className="animate-spin" /></div> : null
  if (!items.length) return full ? <div className="action-items-empty"><ListChecks />
    <p>{error ? 'The last summary failed, so no tasks were saved.' : summarized ? 'No tasks were identified in this recording.' : 'This recording has not been summarized yet.'}</p>
    {error && <small role="alert" className="action-items-error">{error}</small>}
    <small>{summarized ? 'Summarize again to look for tasks once more.' : 'Tasks are found when the recording is summarized.'}</small>
    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void summarize()}>{busy === 'summarize' ? <Loader2 className="animate-spin" /> : <AlignLeft />}{summarized ? 'Summarize again' : 'Summarize'}</Button>
    {notice && <small role="status">{notice}</small>}
  </div> : null
  const unsentMine = items.filter(item => item.mine && !item.sentAt && !item.doneAt)
  // Only your tasks go to Todoist on their own, so progress counts yours; others are sent by hand.
  const mine = items.filter(item => item.mine), mineSent = mine.filter(item => item.sentAt).length
  const othersSent = items.filter(item => !item.mine && item.sentAt).length

  const update = (next: ActionItem) => setItems(current => current?.map(item => item.key === next.key ? { ...item, doneAt: next.doneAt } : item) ?? null)
  const row = (item: ActionItem) => <li key={item.key + item.title} className={[item.mine && 'mine', item.doneAt && 'done'].filter(Boolean).join(' ') || undefined}>
    <TaskCheck recordingId={recordingId} item={item} onChange={update} onError={setNotice} />
    <span className="action-item-text">
      <span>{item.title}</span>
      <span className="action-item-meta">
        {!full && (item.mine ? <span className="action-item-owner"><UserRound />You</span> : item.assignee && <span>{item.assignee}</span>)}
        {item.dueDate && <span title={item.dueEvidence ? `“${item.dueEvidence}”` : undefined}><Clock3 />{formatDue(item.dueDate)}</span>}
        {full && (onSeek && item.start !== null
          ? <button type="button" className="action-item-quote" title={`Play from ${clock(item.start)}: ${item.context}`} onClick={() => onSeek(item.start!)}><Play />{clock(item.start)} · “{item.context}”</button>
          : <span className="action-item-quote" title={item.context}>“{item.context}”</span>)}
      </span>
    </span>
    {connected && (item.sentAt
      ? <span className="action-item-sent" title={`Added ${new Date(item.sentAt).toLocaleString()}`}><Check />In Todoist</span>
      : <span className="action-item-actions">
          {full && auto && item.mine && !item.doneAt && <span className="action-item-waiting">Waiting to send</span>}
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void send(item.key, [item.key])} aria-label={`Add ${item.title} to Todoist`}>{busy === item.key ? <Loader2 className="animate-spin" /> : <Send />}Todoist</Button>
        </span>)}
  </li>

  const addMine = connected && unsentMine.length > 1 && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void send('mine')}>{busy === 'mine' ? <Loader2 className="animate-spin" /> : <Send />}Add my {unsentMine.length} to Todoist</Button>

  if (!full) return <div className="action-items">
    <div className="action-items-heading"><h2>Action items</h2>{addMine}</div>
    <ul>{items.map(row)}</ul>
    {notice && <p role="status" className="action-items-notice">{notice}</p>}
  </div>

  return <div className="action-items full">
    <div className="todoist-status" role="status">
      <span className="todoist-dot" data-state={!connected ? 'off' : status?.lastRun?.error ? 'error' : 'ok'} />
      <span className="todoist-status-text">
        {!connected ? <>Todoist not connected · <Link to="/settings">Connect in Settings</Link></>
          : <>Todoist · {mine.length ? `${mineSent} of your ${mine.length} task${mine.length === 1 ? '' : 's'} sent` : 'none of these tasks are yours'}{othersSent ? ` · ${othersSent} other${othersSent === 1 ? '' : 's'} added by hand` : ''}{auto ? ' · yours are sent automatically' : ' · automatic sending off'}
            {status?.lastRun && <> · {status.lastRun.error ? `last automatic send failed: ${status.lastRun.error}` : `last automatic send ${time(status.lastRun.at)}`}</>}</>}
      </span>
      <Button variant="ghost" size="icon" aria-label="Refresh tasks" title="Refresh" onClick={() => void load()}><RefreshCw /></Button>
      {addMine}
    </div>
    {groupTasks(items).map(group => <section key={group.owner} className="action-items-group">
      <h3>{group.mine && <UserRound />}{group.owner}<small>{group.items.length}</small></h3>
      <ul>{group.items.map(row)}</ul>
    </section>)}
    {notice && <p role="status" className="action-items-notice">{notice}</p>}
  </div>
}
