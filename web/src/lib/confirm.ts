/**
 * In-app confirmation. The desktop app's web view (Tauri/wry on macOS) does not implement
 * window.confirm: it returns false without showing anything, so every "Are you sure?" silently
 * cancelled. confirmAction shows an in-app dialog instead, in the browser and the desktop app alike.
 */
export type ConfirmRequest = { message: string; confirmLabel?: string; destructive?: boolean; resolve: (ok: boolean) => void }

let listener: ((request: ConfirmRequest) => void) | null = null
export function onConfirmRequest(next: typeof listener) { listener = next }

export function confirmAction(message: string, options: { confirmLabel?: string; destructive?: boolean } = {}): Promise<boolean> {
  return new Promise(resolve => {
    if (!listener) { resolve(window.confirm(message)); return }
    listener({ message, ...options, resolve })
  })
}
