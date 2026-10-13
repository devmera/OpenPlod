import { useMemo, useState } from 'react'
import { Check, ChevronRight, Pencil, X } from '@/components/icons'
import type { TranscriptSegment } from '@/lib/api'
import { formatDuration } from '@/lib/utils'

export type SpeakerSummary = { label: string; id: number | string; index: number; lines: number; seconds: number }

/**
 * Every speaker in the transcript at a glance: talk time and lines, a filter to read one person,
 * a jump to their next line, and an inline name field. Renaming uses the transcript's rename
 * operation, so OpenPlod also learns that voice for later recordings.
 */
export function SpeakerBar({ segments, colorIndex, filter, onFilter, onNext, onRename }: {
  segments: TranscriptSegment[]
  colorIndex: Map<string, number>
  filter: string | null
  onFilter: (label: string | null) => void
  onNext: (label: string) => void
  onRename: (from: number | string, to: string) => Promise<void>
}) {
  const speakers = useMemo(() => {
    const byLabel = new Map<string, SpeakerSummary>()
    for (const segment of segments) {
      if (segment.speakerId === null) continue
      const entry = byLabel.get(segment.speaker) ?? { label: segment.speaker, id: segment.speakerId, index: colorIndex.get(segment.speaker) ?? 0, lines: 0, seconds: 0 }
      entry.lines++
      entry.seconds += Math.max(0, segment.endTime - segment.startTime)
      byLabel.set(segment.speaker, entry)
    }
    return [...byLabel.values()].sort((a, b) => b.seconds - a.seconds)
  }, [segments, colorIndex])
  const [editing, setEditing] = useState<string | null>(null), [name, setName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!speakers.length) return null
  const save = async (speaker: SpeakerSummary) => {
    const next = name.trim()
    if (!next || next === speaker.label) { setEditing(null); return }
    setBusy(true); setError('')
    try { await onRename(speaker.id, next); setEditing(null); if (filter === speaker.label) onFilter(next) }
    catch (e) { setError(e instanceof Error ? e.message : 'Rename failed.') }
    finally { setBusy(false) }
  }
  return <div className="speaker-bar" role="group" aria-label="Speakers">
    {speakers.map(speaker => editing === speaker.label ? (
      <form key={speaker.label} className="speaker-chip editing" onSubmit={event => { event.preventDefault(); void save(speaker) }}>
        <span className={`speaker-mark speaker-${speaker.index % 6}`} />
        <input autoFocus value={name} maxLength={80} disabled={busy} aria-label={`Name for ${speaker.label}`} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditing(null) }} />
        <button type="submit" disabled={busy} aria-label="Save name" title="Save name (Enter)"><Check /></button>
        <button type="button" disabled={busy} aria-label="Cancel" title="Cancel (Esc)" onClick={() => setEditing(null)}><X /></button>
        {speakers.some(other => other.label !== speaker.label && other.label.toLowerCase() === name.trim().toLowerCase()) && <small>Merges with {name.trim()}</small>}
      </form>
    ) : (
      <div key={speaker.label} className={`speaker-chip ${filter === speaker.label ? 'selected' : ''}`}>
        <button type="button" className="speaker-chip-main" aria-pressed={filter === speaker.label} title={filter === speaker.label ? 'Show everyone' : `Show only ${speaker.label}`} onClick={() => onFilter(filter === speaker.label ? null : speaker.label)}>
          <span className={`speaker-mark speaker-${speaker.index % 6}`} />
          <strong>{speaker.label}</strong>
          <small>{formatDuration(speaker.seconds)} · {speaker.lines} {speaker.lines === 1 ? 'line' : 'lines'}</small>
        </button>
        <button type="button" aria-label={`Rename ${speaker.label}`} title="Rename" onClick={() => { setEditing(speaker.label); setName(typeof speaker.id === 'string' ? speaker.id : ''); setError('') }}><Pencil /></button>
        <button type="button" aria-label={`Next line from ${speaker.label}`} title="Jump to their next line" onClick={() => onNext(speaker.label)}><ChevronRight /></button>
      </div>
    ))}
    {error && <p role="alert" className="speaker-bar-error">{error}</p>}
  </div>
}
