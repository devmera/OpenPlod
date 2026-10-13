//! Swift-facing operations of the OpenPlod iOS companion.
//!
//! The companion only reads from a recorder that is already linked to the key it holds: it scans,
//! lists, downloads and decrypts. It never pairs, binds, unlinks, force-clears or changes settings.
//! The key comes from OpenPlod's encrypted enrollment and stays in the iOS Keychain; it is passed
//! in per call and not stored by this library.

mod ble;
mod driver;
mod link;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::RsaPrivateKey;
use tokio::sync::Mutex;

uniffi::setup_scaffolding!();

/// One Bluetooth conversation at a time.
static DEVICE: Mutex<()> = Mutex::const_new(());

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

#[derive(uniffi::Record)]
pub struct NearbyRecorder {
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
}

#[derive(uniffi::Record)]
pub struct RecorderFile {
    /// Session id: the recording's start time in Unix seconds.
    pub session_id: u32,
    pub size: u32,
}

#[derive(uniffi::Record)]
pub struct PulledFile {
    pub session_id: u32,
    /// Decrypted Opus audio, in an Ogg container when the recorder supplies one.
    pub path: String,
}

#[uniffi::export(with_foreign)]
pub trait PullListener: Send + Sync {
    /// `state` is `started`, `saved` or `failed`.
    fn on_progress(&self, session_id: u32, state: String, detail: Option<String>);
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

struct Connected {
    link: ble::BleLink,
    session: plaud_protocol::session::Session,
    port: u8,
}

async fn connect(key: &Key, device: Option<&str>, timeout_secs: u64) -> anyhow::Result<Connected> {
    let mut link = ble::BleLink::connect(device, Duration::from_secs(timeout_secs)).await?;
    let keys = driver::handshake(&mut link, &key.signature, &key.private).await
        .with_context(|| format!("connecting to recorder {}", key.serial))?;
    let mut session = plaud_protocol::session::Session::phone(keys);
    let port = driver::login(&mut link, &mut session, &key.token).await?;
    Ok(Connected { link, session, port })
}

/// Plaud recorders advertising nearby.
#[uniffi::export(async_runtime = "tokio")]
pub async fn scan(seconds: u64) -> Result<Vec<NearbyRecorder>, CompanionError> {
    let _guard = DEVICE.lock().await;
    Ok(ble::scan(seconds, false).await?.into_iter()
        .map(|found| NearbyRecorder { id: found.id, name: found.name, rssi: found.rssi })
        .collect())
}

/// Recordings stored on the linked recorder.
#[uniffi::export(async_runtime = "tokio")]
pub async fn list_recordings(key: RecorderKey, device: Option<String>, timeout_secs: u64) -> Result<Vec<RecorderFile>, CompanionError> {
    let _guard = DEVICE.lock().await;
    let key = decode(&key)?;
    let mut c = connect(&key, device.as_deref(), timeout_secs).await?;
    let listed = driver::list(&mut c.link, &mut c.session, c.port).await;
    c.link.disconnect().await.ok();
    Ok(listed?.into_iter().map(|r| RecorderFile { session_id: r.id, size: r.size }).collect())
}

/// Downloads and decrypts the given sessions into `out_dir` as `<session>.ogg|.opus`, in one
/// connection. Recordings stay on the recorder. One failure does not stop the others.
#[uniffi::export(async_runtime = "tokio")]
pub async fn pull_recordings(
    key: RecorderKey,
    device: Option<String>,
    timeout_secs: u64,
    session_ids: Vec<u32>,
    out_dir: String,
    listener: Arc<dyn PullListener>,
) -> Result<Vec<PulledFile>, CompanionError> {
    let _guard = DEVICE.lock().await;
    let key = decode(&key)?;
    std::fs::create_dir_all(&out_dir).context("creating the download folder")?;
    let mut c = connect(&key, device.as_deref(), timeout_secs).await?;
    let result = async {
        let wanted: Vec<_> = driver::list(&mut c.link, &mut c.session, c.port).await?
            .into_iter().filter(|r| session_ids.contains(&r.id)).collect();
        let mut pulled = Vec::new();
        for recording in &wanted {
            listener.on_progress(recording.id, "started".into(), None);
            match driver::pull(&mut c.link, &mut c.session, recording, &key.private).await {
                Ok(audio) => {
                    let extension = if audio.starts_with(b"OggS") { "ogg" } else { "opus" };
                    let path = std::path::Path::new(&out_dir).join(format!("{}.{extension}", recording.id));
                    let partial = path.with_extension(format!("{extension}.part"));
                    std::fs::write(&partial, &audio).context("saving the recording")?;
                    std::fs::rename(&partial, &path).context("saving the recording")?;
                    listener.on_progress(recording.id, "saved".into(), Some(path.display().to_string()));
                    pulled.push(PulledFile { session_id: recording.id, path: path.display().to_string() });
                }
                Err(error) => listener.on_progress(recording.id, "failed".into(), Some(format!("{error:#}"))),
            }
        }
        anyhow::Ok(pulled)
    }.await;
    c.link.disconnect().await.ok();
    Ok(result?)
}
