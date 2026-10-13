import { AlignLeft, AudioLines, Loader2, RotateCcw, Star, Trash2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'

export type BulkAction = 'transcribe' | 'summarize' | 'star' | 'unstar' | 'trash' | 'restore' | 'purge'
export type BulkProgress = { label: string; done: number; total: number }

/** Shown above the list while recordings are picked; replaces the batch-transcribe banner. */
export function BulkActions({ count, total, trash, allStarred, progress, onRun, onSelectAll, onClear }: {
  count: number
  total: number
  trash: boolean
  allStarred: boolean
  progress: BulkProgress | null
  onRun: (action: BulkAction) => void
  onSelectAll: () => void
  onClear: () => void
}) {
  const busy = progress !== null
  return <div className="bulk-actions" role="toolbar" aria-label="Actions for selected recordings">
    <span className="bulk-count">
      {busy ? <><Loader2 className="animate-spin" />{progress.label} {progress.done} of {progress.total}…</> : `${count} selected`}
    </span>
    {!busy && count < total && <button className="bulk-link" onClick={onSelectAll}>Select all {total}</button>}
    <div className="bulk-buttons">
      {trash ? <>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun('restore')}><RotateCcw />Restore</Button>
        <Button variant="outline" size="sm" className="danger" disabled={busy} onClick={() => onRun('purge')}><Trash2 />Delete permanently</Button>
      </> : <>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun('transcribe')}><AudioLines />Transcribe</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun('summarize')}><AlignLeft />Summarize</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun(allStarred ? 'unstar' : 'star')}><Star />{allStarred ? 'Unstar' : 'Star'}</Button>
        <Button variant="outline" size="sm" className="danger" disabled={busy} onClick={() => onRun('trash')}><Trash2 />Move to Trash</Button>
      </>}
      <Button variant="ghost" size="icon" aria-label="Clear selection" title="Clear selection (Esc)" disabled={busy} onClick={onClear}><X /></Button>
    </div>
  </div>
}
