import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { Check, KeyRound, Loader2, ShieldCheck, Trash2, Unplug } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type PlaudIdentityStatus, type PlaudKeySource, type PlaudStatus } from '@/lib/api'
import './plaud-device-authorization.css'

/**
 * Authorizes this computer to read recordings off the paired recorder.
 *
 * A Plaud recorder refuses downloads unless the client can present a key pair,
 * a serial signature and a binding token minted by Plaud. Those are obtained
 * here from the account's sign-in token, so no macOS client is required.
 *
 * The key pair either comes from Plaud or is generated on this computer. A local
 * key binds only to an unlinked recorder (it asks for a key during the handshake)
 * and then exists nowhere else; Plaud still signs the serial number.
 *
 * `status` is optional: when the recorder has already been scanned the serial
 * and address are shown up front, otherwise the backend scans while authorizing.
 */
export function PlaudDeviceAuthorization({ status, onAuthorized, variant = 'page' }: {
  status?: PlaudStatus | null
  onAuthorized?: () => void
  variant?: 'page' | 'dialog'
}) {
  const [identity, setIdentity] = useState<PlaudIdentityStatus | null>(null)
  const [token, setToken] = useState('')
  const [domain, setDomain] = useState('platform-us.plaud.ai')
  const [keySource, setKeySource] = useState<PlaudKeySource>('plaud')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  const load = useCallback(async () => {
    try { setIdentity(await api.getPlaudIdentity()) } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read the recorder authorization.') }
  }, [])
  useEffect(() => { void load() }, [load])

  const authorize = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.authorizePlaudDevice({
        token: token.trim() || undefined, domain,
        serial: status?.deviceSerial || undefined, identifier: status?.deviceIdentifier || undefined, keySource,
      })
      setToken('')
      setNotice(result.keySource === 'local'
        ? `${result.deviceType} ${result.serial} is now bound to a key that exists only on this computer.`
        : `${result.deviceType} ${result.serial} is now authorized on this computer.`)
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not authorize the recorder.')
    } finally { setBusy(false) }
  }

  const importIdentity = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setError(''); setNotice('')
    try {
      let parsed: unknown
      try { parsed = JSON.parse(await file.text()) } catch { throw new Error('That file is not a JSON identity.') }
      const result = await api.importPlaudIdentity(parsed)
      setNotice(`Identity for ${result.deviceType} ${result.serial} imported.${result.previousKept ? ' The identity it replaced was kept as plaud-device.previous.json.' : ''}`)
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not import the identity.')
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.unlinkPlaudRecorder()
      setConfirmUnlink(false)
      setNotice(result.confirmed
        ? 'The recorder is unlinked. Its recordings stayed on it; the key was kept as plaud-device.previous.json.'
        : 'The unlink request was sent and the recorder disconnected, which is how it usually completes. The key was kept as plaud-device.previous.json.')
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not unlink the recorder.')
    } finally { setBusy(false) }
  }

  const forget = async () => {
    if (identity?.keySource === 'local' && !window.confirm('The recorder stays bound to this key, and the Plaud app cannot unlink it. The key will be moved to plaud-device.previous.json, not deleted. Continue?')) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.clearPlaudIdentity()
      setNotice(identity?.keySource === 'local'
        ? 'Device authorization removed. The key was kept as plaud-device.previous.json; import it to restore access.'
        : 'Device authorization removed from this computer.')
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove the authorization.')
    } finally { setBusy(false) }
  }

  const domains = identity?.domains?.length ? identity.domains : ['platform-us.plaud.ai', 'platform-jp.plaud.ai']
  // Without a scan result there is nothing to check yet; the backend scans during authorization.
  const waitingForDevice = status ? !status.deviceSerial : false

  return <section className={`plaud-authorize plaud-authorize--${variant}`} aria-label="Authorize this Plaud recorder">
    <div className="plaud-authorize-heading">
      <KeyRound />
      <h2>Authorize this Note Pro</h2>
      {identity?.authorized && <Check className="plaud-authorize-done" aria-label="Authorized" />}
    </div>
    {identity?.authorized ? <>
      <p>This computer can read and download recordings from the recorder over Bluetooth.</p>
      <dl className="plaud-authorize-facts">
        {identity.deviceType && <div><dt>Model</dt><dd>{identity.deviceType}</dd></div>}
        <div><dt>Serial number</dt><dd>{identity.serial}</dd></div>
        <div><dt>Bluetooth address</dt><dd>{identity.identifier}</dd></div>
        <div><dt>Recorder key</dt><dd>{identity.keySource === 'local' ? 'Generated on this computer' : 'Issued by Plaud'}</dd></div>
      </dl>
      {identity.keySource === 'local' && <p>This key exists only in <code>{identity.identityPath}</code>. Include that file in your backups: without it, neither OpenPlod nor the Plaud app can reach the recorder.</p>}
      <div className="plaud-authorize-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void forget()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}Remove authorization</Button>
        <Button variant="outline" size="sm" disabled={busy || confirmUnlink} onClick={() => setConfirmUnlink(true)}><Unplug />Unlink this recorder</Button>
      </div>
      {confirmUnlink && <div className="plaud-authorize-confirm" role="group" aria-label="Confirm unlinking">
        <p>Unlinking removes this computer's key from the recorder, as Unlink does in the Plaud app. Recordings stay on the recorder, but they remain encrypted to this key: import them first. The recorder does not record again until OpenPlod or the Plaud app binds it to a key.</p>
        <p>Wake the recorder, then unlink.</p>
        <div className="plaud-authorize-actions">
          <Button size="sm" disabled={busy} onClick={() => void unlink()}>{busy ? <Loader2 className="animate-spin" /> : <Unplug />}Unlink now</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnlink(false)}>Cancel</Button>
        </div>
      </div>}
    </> : <>
      <p>Your Note Pro only accepts downloads from a client it has authorized. Paste a Plaud sign-in token to authorize this computer.</p>
      {waitingForDevice
        ? <p>Wake the Note Pro and keep it near this computer so its serial number and Bluetooth address can be read.</p>
        : status?.deviceSerial && <p>Recorder detected: {status.deviceName || 'Plaud'} / <code>{status.deviceSerial}</code></p>}
      <fieldset className="plaud-authorize-keys">
        <legend>Recorder key</legend>
        <label><input type="radio" name="plaud-key-source" checked={keySource === 'plaud'} onChange={() => setKeySource('plaud')} />
          <span><strong>Use my Plaud account key</strong><small>Works while the recorder is linked to the Plaud app. Plaud issues and also holds the key.</small></span></label>
        <label><input type="radio" name="plaud-key-source" checked={keySource === 'local'} onChange={() => setKeySource('local')} />
          <span><strong>Generate a key on this computer</strong><small>For an unlinked recorder: unlink it in the Plaud app first (keep recordings), then wake it. Plaud only signs the serial number and never sees this key; the Plaud app cannot connect while it is in use.</small></span></label>
      </fieldset>
      {identity?.bindPending && keySource === 'local' && <p className="plaud-authorize-notice">The recorder was offered a key from this computer but the bind was not confirmed. Wake it and authorize again to finish with the same key.</p>}
      <label className="plaud-authorize-field"><span>Plaud sign-in token</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder="Paste tokenstr from web.plaud.ai" aria-label="Plaud sign-in token" onChange={event => setToken(event.target.value)} />
      </label>
      <label className="plaud-authorize-field"><span>Plaud region</span>
        <select value={domain} aria-label="Plaud region" onChange={event => setDomain(event.target.value)}>{domains.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
      {identity?.developerCredentialsAvailable && <p>Plaud developer credentials are configured on this computer, so the token may be left empty.</p>}
      {keySource === 'local' && <p>If this computer has authorized this recorder before, leave the token empty: its serial signature is reused and Plaud is not contacted.</p>}
      <div className="plaud-authorize-actions">
        <Button disabled={busy || waitingForDevice} onClick={() => void authorize()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Authorize this computer</Button>
      </div>
      <details className="plaud-authorize-help"><summary>Import an identity file instead</summary>
        <p>Already bound this recorder to your own key with another tool? Import its identity (<code>identifier</code>, <code>serial</code>, <code>bindingToken</code>, <code>signature</code>, <code>publicKey</code>, <code>privateKey</code>). An identity already on this computer is kept beside it.</p>
        <label className="plaud-authorize-import"><input type="file" accept="application/json,.json" disabled={busy} onChange={event => void importIdentity(event)} aria-label="Identity file" /></label>
      </details>
      <details className="plaud-authorize-help"><summary>Where do I find this token?</summary>
        <p>Sign in at <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>, then open your browser developer tools, go to Application / Local Storage / <code>https://web.plaud.ai</code> and copy the value of <code>tokenstr</code>.</p>
      </details>
    </>}
    {notice && <p role="status" className="plaud-authorize-notice">{notice}</p>}
    {error && <p role="alert" className="plaud-authorize-error">{error}</p>}
  </section>
}
