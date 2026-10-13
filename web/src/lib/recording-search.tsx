import { Fragment, type ReactNode } from 'react'
import type { TranscriptSegment } from './api'

export type SummaryLine = { id: string; section: string; text: string }
export type SearchHit = { kind: 'summary'; line: SummaryLine } | { kind: 'transcript'; segment: TranscriptSegment }

/** Wrap every case-insensitive occurrence of `query` in <mark>. */
export function highlightText(text: string, query: string): ReactNode {
  if (!query) return text
  const lower = text.toLowerCase(), parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at} className="search-mark">{text.slice(at, at + query.length)}</mark>)
    from = at + query.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</>
}

export function searchRecording(query: string, summary: SummaryLine[], segments: TranscriptSegment[]): SearchHit[] {
  if (!query) return []
  return [
    ...summary.filter(line => line.text.toLowerCase().includes(query)).map(line => ({ kind: 'summary' as const, line })),
    ...segments.filter(segment => segment.text.toLowerCase().includes(query)).map(segment => ({ kind: 'transcript' as const, segment })),
  ]
}
