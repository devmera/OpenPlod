import { useCallback, useEffect, useState } from 'react'
import { todoistApi, describeSend, formatDue, type ActionItem } from '@/lib/todoist'
import { Button } from '@/components/ui/button'
import { Check, Loader2, Send, UserRound, Clock3 } from '@/components/icons'

/**
 * A recording's action items, marking yours and any deadline, with sending to Todoist when it is
 * connected. `version` reloads the list after a new summary.
 */
export function ActionItems({ recordingId, version }: { recordingId: string; version?: string | null }) {
  const [items, setItems] = useState<ActionItem[]>([]), [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState('')
  const load = useCallback(() => todoistApi.tasks(recordingId).then(value => { setItems(value.tasks); setConnected(value.connected) }).catch(() => setItems([])), [recordingId])
  useEffect(() => { void load() }, [load, version])
  const send = async (key: string, keys?: string[]) => {
    setBusy(key); setNotice('')
    try { setNotice(describeSend(await todoistApi.send(recordingId, keys))) } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not send to Todoist.') }
    finally { setBusy(null); void load() }
  }
  if (!items.length) return null
  const unsentMine = items.filter(item => item.mine && !item.sentAt)
  return <div className="action-items">
    <div className="action-items-heading"><h2>Action items</h2>
      {connected && unsentMine.length > 1 && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void send('mine')}>{busy === 'mine' ? <Loader2 className="animate-spin" /> : <Send />}Add my {unsentMine.length} to Todoist</Button>}
    </div>
    <ul>{items.map(item => <li key={item.key + item.title} className={item.mine ? 'mine' : undefined}>
      <span className="action-item-text">
        <span>{item.title}</span>
        <span className="action-item-meta">
          {item.mine ? <span className="action-item-owner"><UserRound />You</span> : item.assignee && <span>{item.assignee}</span>}
          {item.dueDate && <span title={item.dueEvidence ? `“${item.dueEvidence}”` : undefined}><Clock3 />{formatDue(item.dueDate)}</span>}
        </span>
      </span>
      {connected && (item.sentAt
        ? <span className="action-item-sent" title={`Added ${new Date(item.sentAt).toLocaleString()}`}><Check />In Todoist</span>
        : <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void send(item.key, [item.key])} aria-label={`Add ${item.title} to Todoist`}>{busy === item.key ? <Loader2 className="animate-spin" /> : <Send />}Todoist</Button>)}
    </li>)}</ul>
    {notice && <p role="status" className="action-items-notice">{notice}</p>}
  </div>
}
