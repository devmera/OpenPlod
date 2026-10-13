import { useEffect, useState } from 'react'
import { speakersApi, type Speakers } from '@/lib/speakers'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Save, RefreshCw, Trash2, Loader2 } from '@/components/icons'

/** Your name for Mac meeting captures, and the voices OpenPlod has learned from speaker renames. */
export function SpeakersPanel() {
  const [speakers, setSpeakers] = useState<Speakers | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => { const value = await speakersApi.get(); setSpeakers(value); setName(value.self?.name ?? '') }
  useEffect(() => { load().catch(e => setError(e.message)) }, [])
  const action = async (run: () => Promise<string>) => { setBusy(true); setError(''); setNotice(''); try { setNotice(await run()); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Speakers unavailable.') } finally { setBusy(false) } }
  const others = speakers?.people.filter(person => person.category !== 'self') ?? []
  return <section className="border-t pt-5 space-y-4" aria-label="Speakers">
    <h2 className="text-base font-semibold">Speakers</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <form className="grid gap-2 text-sm" onSubmit={event => { event.preventDefault(); void action(async () => { await speakersApi.setSelf(name); return 'Your name is saved' }) }}>
      <label htmlFor="self-speaker-name">Your name</label>
      <div className="flex gap-2"><Input id="self-speaker-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Used for your microphone in meetings recorded on this Mac" /><Button type="submit" disabled={busy || !name.trim()}><Save />Save</Button></div>
    </form>
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">Rename a speaker in a transcript and OpenPlod remembers their voice, then names them in new recordings when it is confident. Voiceprints stay on this computer.</p>
      {others.length ? <ul className="divide-y rounded-md border">{others.map(person => <li key={person.id} className="flex items-center justify-between gap-3 px-3 py-2">
        <span>{person.name} <span className="text-muted-foreground">· {person.samples} {person.samples === 1 ? 'sample' : 'samples'}</span></span>
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`Forget ${person.name}'s voice`} onClick={() => void action(async () => { await speakersApi.forget(person.id); return `Forgot ${person.name}'s voice` })}><Trash2 />Forget</Button>
      </li>)}</ul> : speakers && <p className="text-muted-foreground">No voices learned yet.</p>}
      {speakers?.self && <p className="text-muted-foreground">Your voice: {speakers.people.find(person => person.category === 'self')?.samples ?? 0} samples from meeting captures.</p>}
      <Button variant="outline" disabled={busy || !speakers} onClick={() => void action(async () => {
        const result = await speakersApi.reapply()
        return result.recordings ? `Updated ${result.renamed} speaker ${result.renamed === 1 ? 'name' : 'names'} in ${result.recordings} ${result.recordings === 1 ? 'recording' : 'recordings'}` : 'Past recordings already use the names known now'
      })}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}Re-apply names to past recordings</Button>
    </div>
  </section>
}
