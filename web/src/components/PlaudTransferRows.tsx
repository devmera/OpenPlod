import { AlertCircle, Loader2 } from '@/components/icons'
import type { PlaudTransfer } from '@/lib/api'

const phaseLabel: Record<PlaudTransfer['phase'], string> = { queued: 'Queued', downloading: 'Transferring', decoding: 'Decrypting', saving: 'Saving', failed: 'Failed' }
const percent = (item: PlaudTransfer) => item.size ? Math.min(100, Math.floor(item.received / item.size * 100)) : 0

export function PlaudTransferRows({ transfers }: { transfers: PlaudTransfer[] }) {
  return <>{transfers.map(item => {
    const value = percent(item), failed = item.phase === 'failed'
    const status = failed ? `Failed: ${item.error ?? 'transfer stopped'}` : item.phase === 'downloading' ? `${phaseLabel[item.phase]} ${value}%` : phaseLabel[item.phase]
    return <article key={item.sessionId} className={`studio-recording plaud-transfer-row ${failed ? 'failed' : ''}`} aria-label={`Plaud ${item.sessionId}: ${status}`}>
      <div className="studio-row-main">
        <span className="studio-source-icon">{failed ? <AlertCircle /> : <Loader2 className={item.phase === 'queued' ? '' : 'animate-spin'} />}</span>
        <strong>Plaud {item.sessionId}</strong>
      </div>
      <div className="studio-row-tags"><span title={status}>{failed ? 'Failed' : phaseLabel[item.phase]}</span></div>
      <time dateTime={item.recordedAt}>{new Date(item.recordedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      <span className="studio-row-duration">{item.phase === 'downloading' ? `${value}%` : ''}</span>
      <span />
      {!failed && <div className="plaud-transfer-progress" role="progressbar" aria-label={`Transfer of Plaud ${item.sessionId}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.phase === 'queued' ? 0 : value}>
        <div style={{ width: `${item.phase === 'queued' ? 0 : value}%` }} />
      </div>}
      {failed && <span className="sr-only" role="status">{status}</span>}
    </article>
  })}</>
}
