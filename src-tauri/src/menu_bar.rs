//! Menu bar (tray) item: recorder presence, background sync and meeting
//! recording at a glance, plus Sync now, Open and Quit.
//!
//! It reads the vault server's status over the loopback API every few seconds,
//! the same way the window does, so it never talks to the recorder itself.

use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const POLL: Duration = Duration::from_secs(4);

pub fn install(app: &AppHandle, origin: String, token: String) -> tauri::Result<()> {
  let device = MenuItem::with_id(app, "device", "Note Pro: checking…", false, None::<&str>)?;
  let sync = MenuItem::with_id(app, "sync-status", "Auto-sync: checking…", false, None::<&str>)?;
  let meeting = MenuItem::with_id(app, "meeting", "", false, None::<&str>)?;
  let sync_now = MenuItem::with_id(app, "sync-now", "Sync now", true, None::<&str>)?;
  let open = MenuItem::with_id(app, "open", "Open OpenPlod", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit OpenPlod", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &device, &sync, &meeting,
    &PredefinedMenuItem::separator(app)?,
    &sync_now, &open,
    &PredefinedMenuItem::separator(app)?,
    &quit,
  ])?;

  let action_origin = origin.clone();
  let action_token = token.clone();
  let mut tray = TrayIconBuilder::with_id("openplod")
    .menu(&menu)
    .show_menu_on_left_click(true)
    .tooltip("OpenPlod")
    .on_menu_event(move |app, event| match event.id().as_ref() {
      "sync-now" => {
        let (origin, token) = (action_origin.clone(), action_token.clone());
        std::thread::spawn(move || { let _ = request(&origin, &token, "POST", "/api/plaud/auto-import/sync"); });
      }
      "open" => show_main(app),
      "quit" => app.exit(0),
      _ => {}
    });
  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }
  tray.build(app)?;

  std::thread::spawn(move || {
    let mut meeting_shown = true;
    loop {
      let sync_status = request(&origin, &token, "GET", "/api/plaud/auto-import").ok().and_then(|body| body.get("data").cloned());
      let (device_text, sync_text) = describe_sync(sync_status.as_ref());
      let _ = device.set_text(device_text);
      let _ = sync.set_text(sync_text);
      // Meeting recording exists only in builds that include it; drop the line otherwise.
      match request(&origin, &token, "GET", "/api/meetings").ok().and_then(|body| body.get("data").cloned()) {
        Some(status) => { let _ = meeting.set_text(describe_meeting(&status)); }
        None if meeting_shown => { let _ = menu.remove(&meeting); meeting_shown = false; }
        None => {}
      }
      std::thread::sleep(POLL);
    }
  });
  Ok(())
}

pub fn show_main(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

fn request(origin: &str, token: &str, method: &str, path: &str) -> Result<Value, String> {
  let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|error| error.to_string())?;
  let builder = if method == "POST" { client.post(format!("{origin}{path}")) } else { client.get(format!("{origin}{path}")) };
  let response = builder.header("X-OpenPlod-Token", token).send().map_err(|error| error.to_string())?;
  if !response.status().is_success() {
    return Err(format!("HTTP {}", response.status()));
  }
  serde_json::from_str(&response.text().map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn describe_sync(status: Option<&Value>) -> (String, String) {
  let Some(status) = status else {
    return ("Note Pro: status unavailable".into(), "Auto-sync: OpenPlod is starting…".into());
  };
  let watch = status.get("watch");
  let running = status.get("running").and_then(Value::as_bool).unwrap_or(false);
  let in_range = watch.and_then(|watch| watch.get("inRange")).and_then(Value::as_bool).unwrap_or(false);
  let last_seen = watch.and_then(|watch| watch.get("lastSeenAt")).and_then(Value::as_str).and_then(ago);
  let device = if running {
    "Note Pro: syncing…".to_string()
  } else if in_range {
    "Note Pro: nearby".to_string()
  } else if let Some(seen) = last_seen {
    format!("Note Pro: last seen {seen}")
  } else {
    "Note Pro: not seen yet".to_string()
  };

  let enabled = status.get("enabled").and_then(Value::as_bool).unwrap_or(false);
  let last_sync = status.get("lastSync");
  let sync = if !enabled {
    "Auto-sync: off".to_string()
  } else if let Some(error) = status.get("error").and_then(Value::as_str) {
    format!("Sync: {}", shorten(error, 60))
  } else if let Some(at) = last_sync.and_then(|sync| sync.get("at")).and_then(Value::as_str).and_then(ago) {
    match last_sync.and_then(|sync| sync.get("imported")).and_then(Value::as_u64).unwrap_or(0) {
      0 => format!("Last sync {at} · nothing new"),
      1 => format!("Last sync {at} · 1 new recording"),
      count => format!("Last sync {at} · {count} new recordings"),
    }
  } else {
    "Auto-sync: waiting for the Note Pro".to_string()
  };
  (device, sync)
}

fn describe_meeting(status: &Value) -> String {
  if let Some(recording) = status.get("recording").filter(|value| !value.is_null()) {
    let app = recording.get("app").and_then(|app| app.get("name")).and_then(Value::as_str).unwrap_or("meeting");
    return format!("● Recording {app}");
  }
  match status.get("autoRecord").and_then(Value::as_bool) {
    Some(true) => "Meetings: recorded automatically".into(),
    _ => "Meetings: automatic recording off".into(),
  }
}

fn shorten(text: &str, limit: usize) -> String {
  if text.chars().count() <= limit { return text.to_string(); }
  format!("{}…", text.chars().take(limit - 1).collect::<String>())
}

/// "just now", "4 min ago", "2 h ago" for an ISO-8601 UTC timestamp.
fn ago(iso: &str) -> Option<String> {
  let then = epoch_seconds(iso)?;
  let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
  let elapsed = (now - then).max(0);
  Some(match elapsed {
    0..=59 => "just now".into(),
    60..=3599 => format!("{} min ago", elapsed / 60),
    3600..=86_399 => format!("{} h ago", elapsed / 3600),
    _ => format!("{} days ago", elapsed / 86_400),
  })
}

/// Seconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.fff]Z`.
fn epoch_seconds(iso: &str) -> Option<i64> {
  let number = |range: std::ops::Range<usize>| iso.get(range)?.parse::<i64>().ok();
  let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
  let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
  // Days from civil (Howard Hinnant's algorithm).
  let shifted = if month <= 2 { year - 1 } else { year };
  let era = shifted.div_euclid(400);
  let year_of_era = shifted - era * 400;
  let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  let days = era * 146_097 + day_of_era - 719_468;
  Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_utc_timestamps() {
    assert_eq!(epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(epoch_seconds("2026-10-13T10:41:21.390Z"), Some(1_791_888_081));
    assert_eq!(epoch_seconds("not a date"), None);
  }

  #[test]
  fn describes_sync_states() {
    let off = serde_json::json!({ "enabled": false, "running": false, "watch": { "inRange": true } });
    assert_eq!(describe_sync(Some(&off)), ("Note Pro: nearby".into(), "Auto-sync: off".into()));
    let synced = serde_json::json!({ "enabled": true, "running": false, "error": null,
      "lastSync": { "at": "1970-01-01T00:00:00Z", "imported": 2 }, "watch": { "inRange": false, "lastSeenAt": null } });
    let (device, sync) = describe_sync(Some(&synced));
    assert_eq!(device, "Note Pro: not seen yet");
    assert!(sync.ends_with("· 2 new recordings"), "{sync}");
    let failing = serde_json::json!({ "enabled": true, "running": true, "error": "Bluetooth disconnected" });
    assert_eq!(describe_sync(Some(&failing)), ("Note Pro: syncing…".into(), "Sync: Bluetooth disconnected".into()));
  }

  #[test]
  fn describes_meetings() {
    assert_eq!(describe_meeting(&serde_json::json!({ "recording": { "app": { "name": "Zoom" } } })), "● Recording Zoom");
    assert_eq!(describe_meeting(&serde_json::json!({ "recording": null, "autoRecord": true })), "Meetings: recorded automatically");
  }
}
