import { ChevronDown, ChevronUp, Search, X } from '@/components/icons'
import { highlightText, type SearchHit } from '@/lib/recording-search'
import { formatDuration } from '@/lib/utils'

/** Search box with match count, previous/next, and a result list under the document toolbar. */
export function RecordingSearch({ value, onChange, query, hits, current, onStep, onOpen }: {
  value: string; onChange: (value: string) => void; query: string; hits: SearchHit[]; current: number
  onStep: (direction: 1 | -1) => void; onOpen: (index: number) => void
}) {
  const summaryCount = hits.filter(hit => hit.kind === 'summary').length
  return <div className="recording-search">
    <div className="recording-search-box">
      <Search />
      <input type="search" value={value} placeholder="Search transcript and summary" aria-label="Search transcript and summary"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && hits.length) { event.preventDefault(); onStep(event.shiftKey ? -1 : 1) }
          if (event.key === 'Escape') onChange('')
        }} />
      {query && <span className="recording-search-count" aria-live="polite">{hits.length ? `${current + 1} of ${hits.length}` : 'No matches'}</span>}
      {query && <>
        <button type="button" disabled={!hits.length} onClick={() => onStep(-1)} aria-label="Previous match" title="Previous (Shift+Enter)"><ChevronUp /></button>
        <button type="button" disabled={!hits.length} onClick={() => onStep(1)} aria-label="Next match" title="Next (Enter)"><ChevronDown /></button>
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" title="Clear (Esc)"><X /></button>
      </>}
    </div>
    {query && hits.length > 0 && <div className="recording-search-results">
      <p>{summaryCount} in summary · {hits.length - summaryCount} in transcript</p>
      <ul>{hits.slice(0, 200).map((hit, index) => <li key={hit.kind === 'summary' ? hit.line.id : hit.segment.id}>
        <button type="button" className={index === current ? 'current' : ''} onClick={() => onOpen(index)}>
          <span className="recording-search-where">{hit.kind === 'summary' ? hit.line.section : `${formatDuration(hit.segment.startTime)} · ${hit.segment.speaker}`}</span>
          <span>{highlightText(hit.kind === 'summary' ? hit.line.text : hit.segment.text, query)}</span>
        </button>
      </li>)}</ul>
      {hits.length > 200 && <p>Showing the first 200 matches.</p>}
    </div>}
  </div>
}
