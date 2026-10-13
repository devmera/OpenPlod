import { useEffect, useRef } from 'react'
import { api } from './api'

/** Fired on window whenever the library changed: new recordings, finished transcripts, summaries, edits. */
export const libraryChanged = 'openplod:library-changed'

/** Run `onChange` after every library change, without re-subscribing when the callback changes. */
export function useLibraryChanges(onChange: () => void) {
  const callback = useRef(onChange)
  useEffect(() => { callback.current = onChange })
  useEffect(() => {
    const listener = () => callback.current()
    window.addEventListener(libraryChanged, listener)
    return () => window.removeEventListener(libraryChanged, listener)
  }, [])
}

/** One poller for the whole app: checks the library fingerprint every 4 s while visible, and on focus. */
export function useLibraryWatcher() {
  useEffect(() => {
    let version = '', busy = false, stopped = false
    const check = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const next = await api.getLibraryVersion(AbortSignal.timeout(5000))
        if (!stopped && version && next !== version) window.dispatchEvent(new CustomEvent(libraryChanged))
        version = next
      } catch { /* Pages report their own load errors; keep probing. */ }
      finally { busy = false }
    }
    void check()
    const timer = window.setInterval(() => void check(), 4000)
    const wake = () => void check()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake) }
  }, [])
}
