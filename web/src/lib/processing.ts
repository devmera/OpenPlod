import { useEffect, useState } from 'react'
import type { Recording } from './api'
import { aiSettingsApi, type ProcessingJob } from './ai-settings'

/** Where a recording is in processing, or null when nothing is running or queued for it. */
export type Processing = { stage: 'queued' | 'transcribing' | 'summarizing'; ahead: number }

/** Reads the job queue so "queued" is shown only when a job for this recording really waits. */
export function useProcessing(recording: Pick<Recording, 'id' | 'status'> | null): Processing | null {
  const [jobs, setJobs] = useState<ProcessingJob[] | null>(null)
  const busy = recording && ['pending', 'transcribing', 'summarizing'].includes(recording.status)
  useEffect(() => {
    if (!busy) return
    let active = true
    const load = () => aiSettingsApi.jobs().then(rows => { if (active) setJobs(rows) }).catch(() => { if (active) setJobs([]) })
    void load()
    // The queue moves as other recordings finish; refresh the position while waiting.
    const timer = window.setInterval(() => void load(), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [busy, recording?.id, recording?.status])
  if (!recording || !busy) return null
  if (recording.status === 'transcribing') return { stage: 'transcribing', ahead: 0 }
  if (recording.status === 'summarizing') return { stage: 'summarizing', ahead: 0 }
  const open = (jobs ?? []).filter(job => job.status === 'pending' || job.status === 'running')
  const index = open.findIndex(job => job.recordingId === recording.id)
  return index === -1 ? null : { stage: 'queued', ahead: index }
}

/** Processing stage per recording for the library list; one queue read for all rows. */
export function useProcessingStages(recordings: Pick<Recording, 'id' | 'status'>[]): Map<string, Processing['stage']> {
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const busy = recordings.some(row => ['pending', 'transcribing', 'summarizing'].includes(row.status))
  useEffect(() => {
    if (!busy) return
    let active = true
    const load = () => aiSettingsApi.jobs()
      .then(rows => { if (active) setQueued(new Set(rows.filter(job => job.status === 'pending' || job.status === 'running').map(job => job.recordingId))) })
      .catch(() => {})
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [busy])
  const stages = new Map<string, Processing['stage']>()
  for (const row of recordings) {
    if (row.status === 'transcribing' || row.status === 'summarizing') stages.set(row.id, row.status)
    else if (row.status === 'pending' && queued.has(row.id)) stages.set(row.id, 'queued')
  }
  return stages
}
