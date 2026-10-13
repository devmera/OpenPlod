//! Swift-facing operations of the OpenPlod iOS companion.
//!
//! Swift owns Bluetooth (CoreBluetooth, so iOS can wake the app in the background when the
//! recorder advertises) and hands this library a `RecorderTransport` for the connected recorder.
//! This library runs the Plaud protocol over it: key exchange, login, listing, download and
//! decryption. It only reads: it never pairs, binds, unlinks, force-clears or changes settings.
//! The key comes from OpenPlod's encrypted enrollment and stays in the iOS Keychain; it is passed
//! in per call and not stored here.

mod driver;
mod link;

use std::sync::Arc;

use anyhow::Context;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::RsaPrivateKey;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CompanionError {
    #[error("{message}")]
    Failed { message: String },
}

impl From<anyhow::Error> for CompanionError {
    fn from(error: anyhow::Error) -> Self {
        CompanionError::Failed { message: format!("{error:#}") }
    }
}

/// The recorder key exactly as OpenPlod's enrollment delivers it.
#[derive(uniffi::Record, Clone)]
pub struct RecorderKey {
    pub serial: String,
    /// 32-hex login token the recorder expects after the key exchange.
    pub binding_token: String,
    /// Base64 of the 256-byte serial-number signature.
    pub signature: String,
    /// Base64 DER (PKCS#8 or PKCS#1) RSA private key.
    pub private_key: String,
}

/// The result of one sync attempt.
#[derive(uniffi::Record)]
pub struct SyncOutcome {
    /// The recorder is recording right now: nothing was listed or downloaded, so a recording in
    /// progress is never fetched half-written. Try again once it has stopped.
    pub recording: bool,
    /// Everything on the recorder (empty when `recording`).
    pub files: Vec<RecorderFile>,
}

#[derive(uniffi::Record)]
pub struct RecorderFile {
    /// Session id: the recording's start time in Unix seconds.
    pub session_id: u32,
    pub size: u32,
}

/// A connected recorder, provided by Swift: frames go to characteristic 0x2BB1 (write without
/// response) and replies arrive as notifications on 0x2BB0.
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait RecorderTransport: Send + Sync {
    async fn write(&self, frame: Vec<u8>) -> Result<(), CompanionError>;
    /// The next notification, or an error once `timeout_ms` passes without one.
    async fn next(&self, timeout_ms: u64) -> Result<Vec<u8>, CompanionError>;
}

#[uniffi::export(with_foreign)]
pub trait PullListener: Send + Sync {
    /// `state` is `started`, `saved` or `failed`.
    fn on_progress(&self, session_id: u32, state: String, detail: Option<String>);
}

struct Foreign {
    transport: Arc<dyn RecorderTransport>,
    timeout_ms: u64,
}

impl link::Link for Foreign {
    async fn write(&mut self, frame: &[u8]) -> anyhow::Result<()> {
        self.transport.write(frame.to_vec()).await.map_err(|error| anyhow::anyhow!("{error}"))
    }
    async fn next(&mut self) -> anyhow::Result<Vec<u8>> {
        self.transport.next(self.timeout_ms).await.map_err(|error| anyhow::anyhow!("{error}"))
    }
}

struct Key {
    serial: String,
    token: String,
    signature: Vec<u8>,
    private: RsaPrivateKey,
}

fn decode(key: &RecorderKey) -> anyhow::Result<Key> {
    let der = BASE64.decode(key.private_key.trim()).context("the private key is not base64")?;
    let private = RsaPrivateKey::from_pkcs8_der(&der)
        .or_else(|_| RsaPrivateKey::from_pkcs1_der(&der))
        .context("the private key is neither PKCS#8 nor PKCS#1 DER")?;
    let signature = BASE64.decode(key.signature.trim()).context("the signature is not base64")?;
    anyhow::ensure!(signature.len() == 256, "the serial signature must be 256 bytes");
    Ok(Key { serial: key.serial.clone(), token: key.binding_token.clone(), signature, private })
}

/// Key exchange and login on an already connected recorder.
async fn open(link: &mut Foreign, key: &Key) -> anyhow::Result<(plaud_protocol::session::Session, u8)> {
    let keys = driver::handshake(link, &key.signature, &key.private).await
        .with_context(|| format!("connecting to recorder {}", key.serial))?;
    let mut session = plaud_protocol::session::Session::phone(keys);
    let port = driver::login(link, &mut session, &key.token).await?;
    Ok((session, port))
}

/// What the recorder is doing, for the app to show and to know when a recording has stopped.
#[derive(uniffi::Enum, PartialEq, Eq)]
pub enum RecorderActivity {
    Idle,
    Recording,
    /// Transferring, switching on/off, or unknown.
    Busy,
}

/// Asks the connected recorder what it is doing; changes nothing on it.
#[uniffi::export(async_runtime = "tokio")]
pub async fn recorder_activity(key: RecorderKey, transport: Arc<dyn RecorderTransport>) -> Result<RecorderActivity, CompanionError> {
    let key = decode(&key)?;
    let mut link = Foreign { transport, timeout_ms: 5000 };
    let (mut session, _) = open(&mut link, &key).await?;
    Ok(match driver::state(&mut link, &mut session).await? {
        driver::DeviceState::Idle => RecorderActivity::Idle,
        driver::DeviceState::Recording => RecorderActivity::Recording,
        driver::DeviceState::Other => RecorderActivity::Busy,
    })
}

/// Recordings stored on the connected recorder.
#[uniffi::export(async_runtime = "tokio")]
pub async fn list_recordings(key: RecorderKey, transport: Arc<dyn RecorderTransport>, timeout_secs: u64) -> Result<Vec<RecorderFile>, CompanionError> {
    let key = decode(&key)?;
    let mut link = Foreign { transport, timeout_ms: timeout_secs * 1000 };
    let (mut session, port) = open(&mut link, &key).await?;
    Ok(driver::list(&mut link, &mut session, port).await?
        .into_iter().map(|r| RecorderFile { session_id: r.id, size: r.size }).collect())
}

/// One sync on the connected recorder, in a single session: lists its recordings, then downloads
/// and decrypts every one not in `skip` into `out_dir` as `<session>.ogg|.opus`. Returns the full
/// list. Recordings stay on the recorder; one failure does not stop the others.
#[uniffi::export(async_runtime = "tokio")]
pub async fn pull_new_recordings(
    key: RecorderKey,
    transport: Arc<dyn RecorderTransport>,
    timeout_secs: u64,
    skip: Vec<u32>,
    out_dir: String,
    listener: Arc<dyn PullListener>,
) -> Result<SyncOutcome, CompanionError> {
    let key = decode(&key)?;
    std::fs::create_dir_all(&out_dir).context("creating the download folder")?;
    let mut link = Foreign { transport, timeout_ms: timeout_secs * 1000 };
    let (mut session, port) = open(&mut link, &key).await?;
    let normal = std::mem::replace(&mut link.timeout_ms, 3000);
    let state = driver::state(&mut link, &mut session).await.unwrap_or(driver::DeviceState::Other);
    link.timeout_ms = normal;
    if state == driver::DeviceState::Recording {
        return Ok(SyncOutcome { recording: true, files: Vec::new() });
    }
    // Show the recorder's app icon while syncing, as Plaud's app does, but only when it clearly
    // reports idle: SET_ACTIVE stops a recording in progress. Setting it failing only costs the icon.
    let active = state == driver::DeviceState::Idle && signal_active(&mut link, &mut session).await;
    let result = pull_listed(&mut link, &mut session, port, &key, &skip, &out_dir, &listener).await;
    if active {
        let normal = std::mem::replace(&mut link.timeout_ms, 3000);
        let _ = driver::set_active(&mut link, &mut session, false).await;
        link.timeout_ms = normal;
    }
    Ok(SyncOutcome { recording: false, files: result? })
}

/// SET_ACTIVE on (the caller checked the recorder is idle); true when set, so it must be cleared.
async fn signal_active(link: &mut Foreign, session: &mut plaud_protocol::session::Session) -> bool {
    let normal = std::mem::replace(&mut link.timeout_ms, 3000);
    let set = driver::set_active(link, session, true).await.is_ok();
    link.timeout_ms = normal;
    set
}

async fn pull_listed(
    link: &mut Foreign,
    session: &mut plaud_protocol::session::Session,
    port: u8,
    key: &Key,
    skip: &[u32],
    out_dir: &str,
    listener: &Arc<dyn PullListener>,
) -> anyhow::Result<Vec<RecorderFile>> {
    let listed = driver::list(link, session, port).await?;
    for recording in listed.iter().filter(|r| !skip.contains(&r.id)) {
        listener.on_progress(recording.id, "started".into(), None);
        match driver::pull(link, session, recording, &key.private).await {
            Ok(audio) => {
                let extension = if audio.starts_with(b"OggS") { "ogg" } else { "opus" };
                let path = std::path::Path::new(out_dir).join(format!("{}.{extension}", recording.id));
                let partial = path.with_extension(format!("{extension}.part"));
                std::fs::write(&partial, &audio).context("saving the recording")?;
                std::fs::rename(&partial, &path).context("saving the recording")?;
                listener.on_progress(recording.id, "saved".into(), Some(path.display().to_string()));
            }
            Err(error) => listener.on_progress(recording.id, "failed".into(), Some(format!("{error:#}"))),
        }
    }
    Ok(listed.into_iter().map(|r| RecorderFile { session_id: r.id, size: r.size }).collect())
}
