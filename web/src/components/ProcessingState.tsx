import type { Processing } from '@/lib/processing'

const copy = {
  queued: { title: 'Waiting to transcribe', detail: (ahead: number) => ahead === 0 ? 'Next in line.' : `${ahead} ${ahead === 1 ? 'recording' : 'recordings'} ahead in the queue.` },
  'queued-summary': { title: 'Waiting to summarize', detail: (ahead: number) => ahead === 0 ? 'Starting shortly.' : `${ahead} ${ahead === 1 ? 'job' : 'jobs'} ahead in the queue.` },
  transcribing: { title: 'Transcribing…', detail: () => 'Turning the audio into text. The transcript appears here when it is ready.' },
  summarizing: { title: 'Writing summary…', detail: () => 'The transcript is ready; the summary follows shortly.' },
}

/** Animated status shown where the transcript will appear. */
export function ProcessingState({ processing, compact = false }: { processing: Processing; compact?: boolean }) {
  const text = copy[processing.stage]
  return <div className={`processing-state ${compact ? 'compact' : ''} ${processing.stage}`} role="status" aria-live="polite">
    <span className="processing-bars" aria-hidden="true">{[0, 1, 2, 3, 4].map(bar => <i key={bar} />)}</span>
    <strong>{text.title}</strong>
    <p>{text.detail(processing.ahead)}</p>
  </div>
}

/** Small animated chip for rows in the recordings list. */
export function ProcessingChip({ stage }: { stage: Processing['stage'] }) {
  return <span className={`processing-chip ${stage}`}><i aria-hidden="true" />{stage === 'queued' || stage === 'queued-summary' ? 'Queued' : stage === 'transcribing' ? 'Transcribing' : 'Summarizing'}</span>
}
