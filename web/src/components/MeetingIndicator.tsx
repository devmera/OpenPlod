import { Link } from 'react-router-dom'
import { Square } from '@/components/icons'
import { api } from '@/lib/api'
import { useElapsed, useMeetingStatus } from '@/lib/meetings'
import { formatDuration } from '@/lib/utils'

/** Sidebar notice while a meeting is being recorded, with a one-click stop. */
export function MeetingIndicator() {
  const { status, setStatus } = useMeetingStatus()
  const elapsed = useElapsed(status?.recording?.startedAt)
  const recording = status?.recording
  if (!recording) return null
  return (
    <div className="meeting-indicator" role="status">
      <span className="meeting-indicator-dot" aria-hidden="true" />
      <Link to="/settings#meetings">
        {recording.starting ? 'Starting recording...' : `Recording ${recording.app?.name ?? 'meeting'}`}
        {!recording.starting && <small>{formatDuration(elapsed)}</small>}
      </Link>
      <button type="button" aria-label="Stop meeting recording" title="Stop recording"
        onClick={() => void api.stopMeeting().then(setStatus).catch(() => undefined)}>
        <Square />
      </button>
    </div>
  )
}
