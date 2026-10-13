import { useEffect, useState } from 'react'
import { describeExport, obsidianApi, type ObsidianSettings, type ObsidianStatus } from '@/lib/obsidian'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Save, RefreshCw, Loader2 } from '@/components/icons'

const selectClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm'

/** Where recordings are written in Obsidian, automatic export, and notes that need a decision. */
export function ObsidianPanel() {
  const [status, setStatus] = useState<ObsidianStatus | null>(null)
  const [settings, setSettings] = useState<ObsidianSettings>({ vaultPath: '', folder: 'OpenPlod', auto: false })
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => { const value = await obsidianApi.get(); setStatus(value); setSettings(value.settings) }
  useEffect(() => { load().catch(e => setError(e.message)) }, [])
  const action = async (run: () => Promise<string>) => { setBusy(true); setError(''); setNotice(''); try { setNotice(await run()); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Obsidian export unavailable.') } finally { setBusy(false) } }
  const custom = settings.vaultPath && !status?.vaults.includes(settings.vaultPath)
  return <section className="border-t pt-5 space-y-4" aria-label="Obsidian">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Obsidian</h2>
      <Button disabled={busy} onClick={() => void action(async () => { await obsidianApi.save(settings); return 'Obsidian settings saved' })}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Save</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <p className="text-sm text-muted-foreground">Each transcribed recording becomes a note with its summary, action items and transcript. OpenPlod only rewrites the part between its markers, so your own notes and properties around it are kept.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-2 text-sm">Vault
        <select className={selectClass} value={custom ? '__custom' : settings.vaultPath} onChange={e => setSettings({ ...settings, vaultPath: e.target.value === '__custom' ? (custom ? settings.vaultPath : '') : e.target.value })}>
          <option value="">Choose a vault</option>
          {status?.vaults.map(vault => <option key={vault} value={vault}>{vault.split('/').pop()} — {vault.replace(/^\/Users\/[^/]+/, '~')}</option>)}
          <option value="__custom">Other folder…</option>
        </select>
      </label>
      <label className="grid gap-2 text-sm">Folder in the vault<Input value={settings.folder} maxLength={256} onChange={e => setSettings({ ...settings, folder: e.target.value })} placeholder="OpenPlod" /></label>
    </div>
    {(custom || (settings.vaultPath === '' && status && !status.vaults.length)) && <label className="grid gap-2 text-sm">Vault folder path<Input value={settings.vaultPath} onChange={e => setSettings({ ...settings, vaultPath: e.target.value })} placeholder="~/Documents/My vault" /></label>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.auto} onChange={e => setSettings({ ...settings, auto: e.target.checked })} />Export automatically when a transcript or summary is ready</label>
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button variant="outline" disabled={busy || !status?.settings.vaultPath} onClick={() => void action(async () => {
        const results = await obsidianApi.exportAll()
        const count = (kind: string) => results.filter(result => result.action === kind).length
        return `Exported: ${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged${count('conflict') + count('deleted') ? `, ${count('conflict') + count('deleted')} need a decision` : ''}`
      })}><RefreshCw />Export all now</Button>
      {status && <span className="text-muted-foreground">{status.pending ? `${status.pending} waiting to export` : 'All notes up to date'}</span>}
    </div>
    {!!status?.conflicts.length && <div className="space-y-2 text-sm">
      <p className="font-medium">Notes OpenPlod did not overwrite</p>
      <ul className="divide-y rounded-md border">{status.conflicts.map(item => <li key={item.recordingId} className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="min-w-0"><span className="block truncate">{item.path}</span><span className="text-muted-foreground">{item.reason}</span></span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Replace the OpenPlod part of ${item.path}? Your text outside the OpenPlod markers is kept.`)) void action(async () => describeExport(await obsidianApi.exportRecording(item.recordingId, true))) }}>Replace</Button>
      </li>)}</ul>
    </div>}
  </section>
}
