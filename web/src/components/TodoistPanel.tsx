import { useEffect, useState } from 'react'
import { todoistApi, describeSend, type TodoistProject, type TodoistSettings } from '@/lib/todoist'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Save, Loader2, Unplug } from '@/components/icons'

const selectClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm'

/** Connection, target project and automatic sending of your action items to Todoist. */
export function TodoistPanel() {
  const [settings, setSettings] = useState<TodoistSettings>({ connected: false, projectId: '', auto: false, principal: '' })
  const [projects, setProjects] = useState<TodoistProject[]>([])
  const [token, setToken] = useState(''), [lastRun, setLastRun] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => {
    const value = await todoistApi.get()
    setSettings(value.settings)
    setLastRun(value.lastRun ? `Last automatic send ${new Date(value.lastRun.at).toLocaleString()}: ${value.lastRun.error ?? describeSend(value.lastRun.results)}` : '')
    setProjects(value.settings.connected ? await todoistApi.projects().catch(() => []) : [])
  }
  useEffect(() => { load().catch(e => setError(e.message)) }, [])
  const action = async (run: () => Promise<string>) => { setBusy(true); setError(''); setNotice(''); try { setNotice(await run()); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Todoist unavailable.') } finally { setBusy(false) } }
  const save = () => action(async () => {
    await todoistApi.save({ ...settings, ...(token.trim() ? { token: token.trim() } : {}) })
    setToken('')
    return token.trim() ? 'Connected to Todoist' : 'Todoist settings saved'
  })
  const inbox = projects.find(project => project.inbox)
  return <section className="border-t pt-5 space-y-4" aria-label="Todoist">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Todoist</h2>
      <Button disabled={busy || (!settings.connected && !token.trim())} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{settings.connected ? 'Save' : 'Connect'}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <p className="text-sm text-muted-foreground">Action items from summaries become Todoist tasks, with the quote that created them and a stated deadline as the due date. A task is sent once: summarizing again never duplicates it, and OpenPlod never changes it in Todoist afterwards.</p>
    {!settings.connected
      ? <label className="grid gap-2 text-sm">API token
          <Input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="Todoist → Settings → Integrations → Developer" />
        </label>
      : <div className="flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">Connected</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(async () => { await todoistApi.disconnect(); return 'Todoist disconnected. Tasks already sent stay in Todoist.' })}><Unplug />Disconnect</Button></div>}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-2 text-sm">Project
        <select className={selectClass} value={settings.projectId} disabled={!settings.connected} onChange={e => setSettings({ ...settings, projectId: e.target.value })}>
          <option value="">{inbox?.name ?? 'Inbox'}</option>
          {projects.filter(project => !project.inbox).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm">Your name in meetings<Input value={settings.principal} maxLength={120} onChange={e => setSettings({ ...settings, principal: e.target.value })} placeholder="The name marked as you in Speakers" /></label>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.auto} onChange={e => setSettings({ ...settings, auto: e.target.checked })} />Add my action items automatically after each new summary</label>
    <p className="text-xs text-muted-foreground">An action item is yours when you said you would do it, were asked by name, or were made responsible. A voice the transcript could not identify never counts as you. Other action items can be sent from the recording.</p>
    {lastRun && <p className="text-xs text-muted-foreground">{lastRun}</p>}
  </section>
}
