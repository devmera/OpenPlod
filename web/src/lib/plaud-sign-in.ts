import { invoke } from '@tauri-apps/api/core'
import { getRuntime } from '@/lib/runtime'

/** Tokens the Plaud web client holds after sign-in. Neither is stored by this call. */
export interface PlaudSignIn {
  /** `tokenstr`: authorizes a recorder. */
  userToken: string | null
  /** `workspaceToken`: reads the Plaud cloud library. */
  workspaceToken: string | null
}

/** The sign-in window is a desktop (Tauri) feature; browsers and phones paste a token. */
export const plaudSignInSupported = () => getRuntime().mode === 'desktop'

/** Opens web.plaud.ai in a private window and resolves with its tokens once signed in. */
export const signInToPlaud = () => invoke<PlaudSignIn>('plaud_sign_in')
