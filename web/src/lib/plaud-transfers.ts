import { useEffect, useRef, useState } from 'react'
import { api, type PlaudTransfer } from './api'
import { getRuntime } from './runtime'

/** Recordings currently moving from the Plaud, polled while visible. Calls `onFinished` when one leaves the list. */
export function usePlaudTransfers(onFinished: () => void) {
  const [transfers, setTransfers] = useState<PlaudTransfer[]>([])
  const finished = useRef(onFinished)
  useEffect(() => { finished.current = onFinished })
  useEffect(() => {
    if (getRuntime().mode === 'mobile') return
    let stopped = false, busy = false, previous = new Set<number>()
    const poll = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const next = await api.getPlaudTransfers()
        if (stopped) return
        const ids = new Set(next.map(item => item.sessionId))
        // A transfer that left the list has become a recording (or was abandoned): reload the library now.
        if ([...previous].some(id => !ids.has(id))) finished.current()
        previous = ids
        setTransfers(next)
      } catch { /* The library stays usable; the next poll retries. */ }
      finally { busy = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1500)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  return transfers
}
