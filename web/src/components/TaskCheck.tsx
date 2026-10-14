import { useState } from 'react'
import { todoistApi, type ActionItem } from '@/lib/todoist'
import { Check, Loader2 } from '@/components/icons'

/**
 * Ticks a task off, or back on. A task in Todoist is completed there too; if that fails the box
 * returns to its state and `onError` gets the reason.
 */
export function TaskCheck({ recordingId, item, onChange, onError }: { recordingId: string; item: ActionItem; onChange: (item: ActionItem) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const done = Boolean(item.doneAt)
  const toggle = async () => {
    setBusy(true)
    try { onChange(await todoistApi.setDone(recordingId, item.key, !done)) }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not update the task.') }
    finally { setBusy(false) }
  }
  return <button type="button" role="checkbox" aria-checked={done} aria-label={`${done ? 'Reopen' : 'Complete'} ${item.title}`} className="task-check" data-mine={item.mine || undefined} disabled={busy} onClick={() => void toggle()}>
    {busy ? <Loader2 className="animate-spin" /> : done && <Check />}
  </button>
}
