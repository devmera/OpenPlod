//! Sign in to Plaud inside OpenPlod instead of copying tokens out of browser
//! developer tools.
//!
//! web.plaud.ai opens in its own private (incognito) window, so no Plaud session
//! is kept on disk. The page has no access to OpenPlod's IPC: only the `main`
//! window has a capability. After sign-in, an initialization script reads the
//! tokens the Plaud web client keeps in local storage and navigates to an
//! `openplod-signin:` URL, which `on_navigation` intercepts and cancels in this
//! process. The tokens never travel anywhere else; the window then closes and the
//! caller decides what to do with them (nothing is stored here).

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

const WINDOW_LABEL: &str = "plaud-sign-in";
const SIGN_IN_URL: &str = "https://web.plaud.ai/";
const CALLBACK_SCHEME: &str = "openplod-signin";

/// Runs on every page load in the sign-in window. It waits for the user token
/// (`tokenstr`), gives the workspace list a few seconds to appear, then hands
/// both over through the callback URL.
const CAPTURE_SCRIPT: &str = r#"
(() => {
  if (!/(^|\.)plaud\.ai$/.test(location.hostname)) return;
  const findWorkspaceToken = value => {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.workspaceToken === 'string' && value.workspaceToken) return value.workspaceToken;
    for (const child of Object.values(value)) {
      const found = findWorkspaceToken(child);
      if (found) return found;
    }
    return null;
  };
  const read = () => {
    let user = null, workspace = null;
    try {
      user = localStorage.getItem('tokenstr');
      for (let index = 0; index < localStorage.length && !workspace; index++) {
        const key = localStorage.key(index);
        if (!key || !key.endsWith(':workspaceList')) continue;
        try { workspace = findWorkspaceToken(JSON.parse(localStorage.getItem(key) || 'null')); } catch (_) {}
      }
    } catch (_) {}
    return { user, workspace };
  };
  let firstSeen = 0;
  const timer = setInterval(() => {
    const { user, workspace } = read();
    if (!user && !workspace) return;
    firstSeen = firstSeen || Date.now();
    if (!(user && workspace) && Date.now() - firstSeen < 5000) return;
    clearInterval(timer);
    const query = new URLSearchParams();
    if (user) query.set('user', user);
    if (workspace) query.set('workspace', workspace);
    location.href = 'openplod-signin://done?' + query.toString();
  }, 1000);
})();
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaudSignIn {
  /// `tokenstr`: the account's user token (recorder authorization).
  user_token: Option<String>,
  /// `workspaceToken`: the workspace token (Plaud cloud import).
  workspace_token: Option<String>,
}

type Reply = Arc<Mutex<Option<oneshot::Sender<Option<PlaudSignIn>>>>>;

fn reply(slot: &Reply, value: Option<PlaudSignIn>) {
  if let Some(sender) = slot.lock().ok().and_then(|mut sender| sender.take()) {
    let _ = sender.send(value);
  }
}

#[tauri::command]
pub async fn plaud_sign_in(app: AppHandle) -> Result<PlaudSignIn, String> {
  if let Some(open) = app.get_webview_window(WINDOW_LABEL) {
    let _ = open.set_focus();
    return Err("The Plaud sign-in window is already open.".into());
  }
  let (sender, receiver) = oneshot::channel();
  let slot: Reply = Arc::new(Mutex::new(Some(sender)));

  let navigation = slot.clone();
  let window = WebviewWindowBuilder::new(
    &app,
    WINDOW_LABEL,
    WebviewUrl::External(SIGN_IN_URL.parse().map_err(|_| "Invalid Plaud sign-in address.")?),
  )
  .title("Sign in to Plaud")
  .inner_size(480.0, 760.0)
  .incognito(true)
  .initialization_script(CAPTURE_SCRIPT)
  .on_navigation(move |url| {
    if url.scheme() != CALLBACK_SCHEME {
      return true;
    }
    let mut result = PlaudSignIn { user_token: None, workspace_token: None };
    for (key, value) in url.query_pairs() {
      let value = value.trim();
      if value.is_empty() || value.len() > 8192 {
        continue;
      }
      match key.as_ref() {
        "user" => result.user_token = Some(value.to_owned()),
        "workspace" => result.workspace_token = Some(value.to_owned()),
        _ => {}
      }
    }
    if result.user_token.is_some() || result.workspace_token.is_some() {
      reply(&navigation, Some(result));
    }
    false
  })
  .build()
  .map_err(|error| format!("The Plaud sign-in window could not open: {error}"))?;

  let closed = slot.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::Destroyed) {
      reply(&closed, None);
    }
  });

  let result = receiver.await.ok().flatten();
  let _ = window.close();
  result.ok_or_else(|| "Plaud sign-in was closed before it finished.".into())
}
