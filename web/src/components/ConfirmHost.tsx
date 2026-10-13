import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { onConfirmRequest, type ConfirmRequest } from '@/lib/confirm'

/** Renders confirmAction() requests; mounted once at the app root. */
export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  useEffect(() => {
    onConfirmRequest(next => setRequest(current => { current?.resolve(false); return next }))
    return () => onConfirmRequest(null)
  }, [])
  const answer = (ok: boolean) => { request?.resolve(ok); setRequest(null) }
  return <Dialog.Root open={!!request} onOpenChange={open => { if (!open) answer(false) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="confirm-overlay" />
      <Dialog.Content className="confirm-dialog" aria-describedby={undefined}>
        <Dialog.Title className="confirm-message">{request?.message}</Dialog.Title>
        <div className="confirm-buttons">
          <Button variant="outline" onClick={() => answer(false)}>Cancel</Button>
          <Button variant={request?.destructive ? 'destructive' : 'default'} autoFocus onClick={() => answer(true)}>{request?.confirmLabel ?? 'OK'}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
