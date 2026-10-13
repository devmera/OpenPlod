//! Drives the handshake and simple session commands over any `Link`.

use anyhow::{bail, Context, Result};
use rsa::RsaPrivateKey;
use plaud_protocol::frame::{self, Bulk, Frame, Reassembler};
use plaud_protocol::{crc, file};
use plaud_protocol::handshake::{self, OP_USER_KEY, OP_WANTS_USER_KEY};
use plaud_protocol::session::{Session, SessionKeys};

use crate::link::Link;

pub const OP_LOGIN: u16 = 0x01;
pub const OP_LIST: u16 = 0x1A; // 26: GetRecSessions
pub const OP_GET_STATE: u16 = 0x03;
/// SET_ACTIVE (109): "a phone app is active" – the recorder shows its app icon and stays awake.
/// Setting it while a recording runs STOPS that recording (firmware `[SET_ACTIVE REQ] stop recording`).
pub const OP_SET_ACTIVE: u16 = 0x6D;
/// GetState's status value that also means "recording" (SDK `s0.h`).
const STATUS_RECORDING: u32 = 4099;
pub const OP_READ: u16 = 0x1C; // 28: SyncFileStart
pub const OP_TAIL: u16 = 0x1D; // 29: SyncFileStop (carries CRC-16)

/// Login (opcode 1), the first encrypted frame after the key exchange:
/// `01 01 00` + the 32-char ASCII user id. Byte-for-byte what the official app
/// sends (decrypted from capture 1); the device ignores commands until then.
pub fn login_frame(user_id: &str) -> Result<Vec<u8>> {
    if user_id.len() != 32 || !user_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("user id must be 32 hex characters");
    }
    Ok(frame::control(OP_LOGIN, &[&[1, 1, 0][..], user_id.as_bytes()].concat()))
}

/// Logs in and returns the device's protocol version from the reply.
/// Observed reply payload: `00 14 00 02 00 …` (status 0, port version 0x14 = 20).
pub async fn login<L: Link>(link: &mut L, session: &mut Session, user_id: &str) -> Result<u8> {
    link.write(&session.seal(&login_frame(user_id)?)).await?;
    loop {
        let plain = session.open(&link.next().await?)?;
        if let Frame::Control { opcode: OP_LOGIN, payload } = frame::parse(&plain)? {
            match payload {
                [0, port, ..] => return Ok(*port),
                [status, ..] => bail!("device rejected the login (status {status}); wrong account for this device?"),
                [] => bail!("empty login reply"),
            }
        }
    }
}

/// Runs the key exchange with a recorder already bound to this key and returns the session keys.
///
/// The companion never binds, re-pairs or force-clears a recorder: if the recorder asks for a
/// user key (`0xFE11`) it is not linked to this key, and the handshake stops.
pub async fn handshake<L: Link>(link: &mut L, signature: &[u8], private_key: &RsaPrivateKey) -> Result<SessionKeys> {
    for f in handshake::signature_frames(signature)? {
        link.write(&f).await?;
    }

    let mut blob = Reassembler::default();
    loop {
        let n = link.next().await?;
        if n.len() < 2 {
            continue;
        }
        match u16::from_le_bytes([n[0], n[1]]) {
            OP_WANTS_USER_KEY => bail!("This recorder is not linked to the key on this phone. Link it from OpenPlod on the Mac first."),
            OP_USER_KEY => {
                let chunk = frame::parse_chunk(&n)?;
                if let Some(full) = blob.push(&chunk) {
                    return handshake::session_keys(private_key, &full)
                        .context("could not unwrap the device's session key with this private key");
                }
            }
            // Anything else (e.g. unsolicited status) is not part of the handshake.
            _ => {}
        }
    }
}






/// One recording on the device.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Recording {
    /// Session id = recording start time (Unix epoch seconds).
    pub id: u32,
    pub size: u32,
    pub scene: u8,
}

/// Lists recordings (opcode 26). The reply (`q2`) is `totals u16 @7, page u16 @9`
/// then fixed-size entries from byte 11; entry width depends on the port version
/// (8/9/10 bytes). The list can span several notifications.
pub async fn list<L: Link>(link: &mut L, session: &mut Session, port: u8) -> Result<Vec<Recording>> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as u32;
    // p2: reqId u32 (epoch), startSessionId u32 (0), flag u8.
    let mut req = now.to_le_bytes().to_vec();
    req.extend_from_slice(&0u32.to_le_bytes());
    req.push(0);
    link.write(&session.seal(&frame::control(OP_LIST, &req))).await?;

    let entry = if port >= 7 { 10 } else if port >= 2 { 9 } else { 8 };
    let mut out = Vec::new();
    let mut totals: Option<usize> = None;
    loop {
        let plain = session.open(&link.next().await?)?;
        let Frame::Control { opcode: OP_LIST, payload } = frame::parse(&plain)? else { continue };
        // payload is the frame after `01 1A 00`; q2 indexes from the frame start, so
        // totals@7 and page@9 are payload[4] and payload[6].
        if payload.len() >= 8 {
            totals.get_or_insert(u16::from_le_bytes([payload[4], payload[5]]) as usize);
        }
        for e in payload[8..].chunks(entry) {
            if e.len() < 8 {
                break;
            }
            out.push(Recording {
                id: u32::from_le_bytes(e[0..4].try_into().unwrap()),
                size: u32::from_le_bytes(e[4..8].try_into().unwrap()),
                scene: if entry >= 9 { e[8] } else { 0 },
            });
        }
        if totals.is_some_and(|t| out.len() >= t) {
            break;
        }
    }
    Ok(out)
}

/// Downloads one recording's raw (still-encrypted) bytes, resuming on a gap the
/// way the SDK does: on a missing offset it re-issues the read from the last good
/// offset (up to `MAX_RESUMES` times). Verifies the opcode-29 tail CRC-16.
pub async fn download<L: Link>(link: &mut L, session: &mut Session, rec: &Recording) -> Result<Vec<u8>> {
    const MAX_RESUMES: u32 = 3;
    let mut buf = vec![0u8; rec.size as usize];
    let mut have = 0u32; // next contiguous offset we still need
    let mut resumes = 0u32;

    'outer: loop {
        // y6: sessionId u32, startOffset u32, endOffset u32 (0 = to end).
        let mut req = rec.id.to_le_bytes().to_vec();
        req.extend_from_slice(&have.to_le_bytes());
        req.extend_from_slice(&0u32.to_le_bytes());
        link.write(&session.seal(&frame::control(OP_READ, &req))).await?;

        loop {
            let plain = session.open(&link.next().await?)?;
            match frame::parse(&plain)? {
                Frame::Control { opcode: OP_READ, payload } => {
                    // s6 head: sessionId u32 @ payload[0..4], status u8 @ payload[4].
                    if let Some(&status) = payload.get(4) {
                        if status != 0 {
                            bail!("device refused to read recording {} (status {status})", rec.id);
                        }
                    }
                }
                Frame::Bulk(Bulk::Data { offset, data, .. }) => {
                    if offset == have {
                        let end = (offset as usize + data.len()).min(buf.len());
                        buf[offset as usize..end].copy_from_slice(&data[..end - offset as usize]);
                        have = end as u32;
                    } else if offset > have {
                        // Gap: restart from the last good offset.
                        if resumes >= MAX_RESUMES {
                            bail!("recording {}: too many gaps, giving up at offset {have}", rec.id);
                        }
                        resumes += 1;
                        continue 'outer;
                    }
                    // offset < have: already have it, ignore (duplicate).
                }
                Frame::Bulk(Bulk::End { end_code, .. }) => {
                    if end_code != 1 {
                        // Packet loss marker: resume if we are short.
                        if have < rec.size && resumes < MAX_RESUMES {
                            resumes += 1;
                            continue 'outer;
                        }
                    }
                    break 'outer;
                }
                _ => {}
            }
        }
    }

    if have < rec.size {
        bail!("recording {}: only received {have} of {} bytes", rec.id, rec.size);
    }

    // Tail (opcode 29) carries a CRC-16/CCITT-FALSE over the file bytes.
    link.write(&session.seal(&frame::control(OP_TAIL, &[]))).await?;
    for _ in 0..8 {
        let plain = session.open(&link.next().await?)?;
        if let Frame::Control { opcode: OP_TAIL, payload } = frame::parse(&plain)? {
            // t6: sessionId u32 @0, crc u16 @4.
            if payload.len() >= 6 {
                let want = u16::from_le_bytes([payload[4], payload[5]]);
                let got = crc::crc16_ccitt_false(&buf);
                if want != 0xFFFF && want != got {
                    bail!("recording {}: CRC mismatch (device {want:#06x}, computed {got:#06x})", rec.id);
                }
            }
            break;
        }
    }
    Ok(buf)
}

/// Downloads and decrypts a recording to Ogg Opus bytes.
pub async fn pull<L: Link>(
    link: &mut L,
    session: &mut Session,
    rec: &Recording,
    private_key: &RsaPrivateKey,
) -> Result<Vec<u8>> {
    let raw = download(link, session, rec).await?;
    file::decrypt(private_key, &raw).context("decrypting recording")
}

/// GetState (opcode 3). True only when the reply clearly says idle: state byte 0 (SDK `s0.g`:
/// 0 idle, 1 record, 2 transfer, 3/4 switching on/off) and a status other than 4099 (recording).
/// A short or unexpected reply counts as not idle.
pub async fn is_idle<L: Link>(link: &mut L, session: &mut Session) -> Result<bool> {
    link.write(&session.seal(&frame::control(OP_GET_STATE, &[]))).await?;
    loop {
        let plain = session.open(&link.next().await?)?;
        let Frame::Control { opcode: OP_GET_STATE, payload } = frame::parse(&plain)? else { continue };
        // The SDK reads status u32 @3 and state @8 of the frame, i.e. payload[0..4] and payload[5].
        if payload.len() < 6 {
            return Ok(false);
        }
        let status = u32::from_le_bytes(payload[0..4].try_into().unwrap());
        return Ok(status != STATUS_RECORDING && payload[5] == 0);
    }
}

/// SET_ACTIVE (109): sends the flag and waits for the recorder's acknowledgement.
pub async fn set_active<L: Link>(link: &mut L, session: &mut Session, active: bool) -> Result<()> {
    link.write(&session.seal(&frame::control(OP_SET_ACTIVE, &[active as u8]))).await?;
    loop {
        let plain = session.open(&link.next().await?)?;
        if let Frame::Control { opcode: OP_SET_ACTIVE, .. } = frame::parse(&plain)? {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::{EncodePublicKey, LineEnding};
    use rsa::Pkcs1v15Encrypt;
    use std::collections::VecDeque;
    use std::sync::OnceLock;

    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

    fn test_key() -> &'static RsaPrivateKey {
        static KEY: OnceLock<RsaPrivateKey> = OnceLock::new();
        KEY.get_or_init(|| RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap())
    }

    fn keys() -> SessionKeys {
        SessionKeys { key: [4; 32], nonce: [5; 12], aad: [6; 12] }
    }

    /// Plays the device side of the protocol.
    struct FakeDevice {
        wants_key: bool,
        signature: Reassembler,
        user_key: Reassembler,
        received_pem: Option<String>,
        session: Option<Session>,
        logged_in: bool,
        /// (recording, raw encrypted bytes, remaining allowed gaps to inject)
        file: Option<(Recording, Vec<u8>, u32)>,
        outbox: VecDeque<Vec<u8>>,
        /// GetState reply: (status, state).
        state: (u32, u8),
        active: Vec<bool>,
    }

    impl FakeDevice {
        fn new(wants_key: bool) -> Self {
            Self {
                wants_key,
                signature: Reassembler::default(),
                user_key: Reassembler::default(),
                received_pem: None,
                session: None,
                logged_in: false,
                file: None,
                outbox: VecDeque::new(),
                state: (0, 0),
                active: Vec::new(),
            }
        }

        fn with_file(mut self, rec: Recording, raw: Vec<u8>, gaps: u32) -> Self {
            self.file = Some((rec, raw, gaps));
            self
        }

        fn send_session_blob(&mut self) {
            let k = keys();
            let proof = ChaCha20Poly1305::new(Key::from_slice(&k.key))
                .encrypt(Nonce::from_slice(&k.nonce), Payload { msg: handshake::MAGIC, aad: &k.aad })
                .unwrap();
            let plain = [&k.key[..], &k.nonce, &k.aad, &proof].concat();
            let blob = test_key()
                .to_public_key()
                .encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, &plain)
                .unwrap();
            self.outbox.extend(frame::chunk(OP_USER_KEY, &blob).unwrap());
            // Like the real device: the handshake counts as the phone's seq 1.
            self.session = Some(Session::with_last_seqs(k, 0, 1));
        }
    }

    impl Link for FakeDevice {
        async fn write(&mut self, f: &[u8]) -> Result<()> {
            if let Some(session) = self.session.as_mut() {
                let plain = session.open(f)?;
                match frame::parse(&plain)? {
                    Frame::Control { opcode: OP_LOGIN, payload } => {
                        assert_eq!(&payload[..3], &[1, 1, 0]);
                        let ok = &payload[3..] == USER_ID.as_bytes();
                        self.logged_in = ok;
                        let reply = session.seal(&frame::control(OP_LOGIN, &[if ok { 0 } else { 1 }, 0x14, 0]));
                        self.outbox.push_back(reply);
                        if ok {
                            // Unsolicited battery push, as seen in the capture.
                            self.outbox.push_back(session.seal(&frame::control(OP_BATTERY, &[1, 87])));
                        }
                    }
                    Frame::Control { opcode: OP_LIST, .. } if self.logged_in => {
                        let entries: Vec<u8> = self
                            .file
                            .iter()
                            .flat_map(|(r, _, _)| {
                                let mut e = r.id.to_le_bytes().to_vec();
                                e.extend_from_slice(&r.size.to_le_bytes());
                                e.push(r.scene);
                                e
                            })
                            .collect();
                        let total = self.file.iter().count() as u16;
                        // frame = 01 1A 00 | pad3 | totals u16 @7 | page u16 @9 | entries @11
                        let mut fr = vec![0x01, 0x1A, 0x00, 0, 0, 0, 0];
                        fr.extend_from_slice(&total.to_le_bytes());
                        fr.extend_from_slice(&0u16.to_le_bytes());
                        fr.extend_from_slice(&entries);
                        let out = session.seal(&fr);
                        self.outbox.push_back(out);
                    }
                    Frame::Control { opcode: OP_READ, payload } if self.logged_in => {
                        // A new read abandons any half-sent stream (as the real device does).
                        self.outbox.clear();
                        let start = u32::from_le_bytes(payload[4..8].try_into().unwrap()) as usize;
                        if let Some((rec, raw, gaps)) = self.file.as_mut() {
                            // Head: 01 1C 00 | sessionId u32 | status 0
                            let mut head = vec![0x01, 0x1C, 0x00];
                            head.extend_from_slice(&rec.id.to_le_bytes());
                            head.push(0);
                            self.outbox.push_back(session.seal(&head));
                            // Bulk frames of <=100 bytes. Inject one gap on the first pass.
                            let mut off = start;
                            let mut injected = false;
                            while off < raw.len() {
                                let n = (raw.len() - off).min(100);
                                if *gaps > 0 && !injected && off > start + 150 {
                                    // Skip this chunk to create a gap; the driver should resume.
                                    *gaps -= 1;
                                    injected = true;
                                    off += n;
                                    continue;
                                }
                                let mut fr = vec![0x02];
                                fr.extend_from_slice(&rec.id.to_le_bytes());
                                fr.extend_from_slice(&(off as u32).to_le_bytes());
                                fr.push(n as u8);
                                fr.extend_from_slice(&raw[off..off + n]);
                                self.outbox.push_back(session.seal(&fr));
                                off += n;
                            }
                            // End marker.
                            let mut end = vec![0x02];
                            end.extend_from_slice(&rec.id.to_le_bytes());
                            end.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
                            end.push(1);
                            end.push(1);
                            self.outbox.push_back(session.seal(&end));
                        }
                    }
                    Frame::Control { opcode: OP_TAIL, .. } if self.logged_in => {
                        if let Some((rec, raw, _)) = self.file.as_ref() {
                            let crc = crc::crc16_ccitt_false(raw);
                            let mut fr = vec![0x01, 0x1D, 0x00];
                            fr.extend_from_slice(&rec.id.to_le_bytes());
                            fr.extend_from_slice(&crc.to_le_bytes());
                            let out = session.seal(&fr);
                            self.outbox.push_back(out);
                        }
                    }
                    // The real device stays silent until login.
                    Frame::Control { opcode: OP_GET_STATE, .. } if self.logged_in => {
                        let mut reply = self.state.0.to_le_bytes().to_vec();
                        reply.extend_from_slice(&[0, self.state.1]);
                        self.outbox.push_back(session.seal(&frame::control(OP_GET_STATE, &reply)));
                    }
                    Frame::Control { opcode: OP_SET_ACTIVE, payload } if self.logged_in => {
                        self.active.push(payload.first() == Some(&1));
                        self.outbox.push_back(session.seal(&frame::control(OP_SET_ACTIVE, &[0])));
                    }
                    Frame::Control { opcode: OP_BATTERY, .. } if self.logged_in => {
                        let noise = session.seal(&frame::control(0x03, &[0]));
                        let reply = session.seal(&frame::control(OP_BATTERY, &[1, 87]));
                        self.outbox.extend([noise, reply]);
                    }
                    _ => {}
                }
                return Ok(());
            }
            let chunk = frame::parse_chunk(f)?;
            match chunk.opcode {
                handshake::OP_SN_SIGNATURE => {
                    if self.signature.push(&chunk).is_some() {
                        if self.wants_key {
                            self.outbox.push_back(vec![0x11, 0xFE, 1, 0]);
                        } else {
                            self.send_session_blob();
                        }
                    }
                }
                OP_USER_KEY => {
                    if let Some(pem) = self.user_key.push(&chunk) {
                        self.received_pem = Some(String::from_utf8(pem)?);
                        self.send_session_blob();
                    }
                }
                other => bail!("unexpected opcode {other:#06x}"),
            }
            Ok(())
        }

        async fn next(&mut self) -> Result<Vec<u8>> {
            self.outbox.pop_front().context("fake device has nothing to send")
        }
    }

    const OP_BATTERY: u16 = 0x09;
    const USER_ID: &str = "0123456789abcdef0123456789abcdef";

    fn pem() -> String {
        test_key().to_public_key().to_public_key_pem(LineEnding::LF).unwrap()
    }

    #[tokio::test]
    async fn bound_device_replies_fe12_directly() {
        let mut dev = FakeDevice::new(false);
        let got = handshake(&mut dev, &[0xAB; 256], test_key()).await.unwrap();
        assert_eq!(got.key, keys().key);
        assert_eq!(dev.received_pem, None);

        let mut session = Session::phone(got);
        assert_eq!(login(&mut dev, &mut session, USER_ID).await.unwrap(), 0x14);
    }

    #[tokio::test]
    async fn wrong_user_id_is_rejected_clearly() {
        let mut dev = FakeDevice::new(false);
        let got = handshake(&mut dev, &[0xAB; 256], test_key()).await.unwrap();
        let mut session = Session::phone(got);
        let err = login(&mut dev, &mut session, "ffffffffffffffffffffffffffffffff").await.unwrap_err();
        assert!(err.to_string().contains("rejected the login"), "{err}");
    }

    use plaud_protocol::file;
    use chacha20::cipher::{KeyIvInit, StreamCipher};
    use chacha20::ChaCha20;

    /// Builds a valid encrypted recording (512-byte header + ChaCha20 body)
    /// wrapped to `test_key`, like the real device format.
    fn make_recording(audio: &[u8]) -> Vec<u8> {
        let (akey, nonce) = ([7u8; 32], [8u8; 12]);
        let mut h = vec![0u8; file::HEADER_SIZE];
        h[..8].copy_from_slice(plaud_protocol::handshake::MAGIC);
        h[132..144].copy_from_slice(&nonce);
        // segment = 0 (continuous), matching the captured recordings.
        let wrapped = test_key()
            .to_public_key()
            .encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, &akey)
            .unwrap();
        h[256..512].copy_from_slice(&wrapped);
        let mut body = audio.to_vec();
        ChaCha20::new(&akey.into(), &nonce.into()).apply_keystream(&mut body);
        h.extend_from_slice(&body);
        h
    }

    async fn ready_device(file: Option<(Recording, Vec<u8>, u32)>) -> (FakeDevice, Session) {
        let mut dev = match file {
            Some((r, raw, gaps)) => FakeDevice::new(false).with_file(r, raw, gaps),
            None => FakeDevice::new(false),
        };
        let keys = handshake(&mut dev, &[0xAB; 256], test_key()).await.unwrap();
        let mut session = Session::phone(keys);
        login(&mut dev, &mut session, USER_ID).await.unwrap();
        // consume the unsolicited battery push
        let _ = session.open(&dev.next().await.unwrap());
        (dev, session)
    }

    #[tokio::test]
    async fn lists_recordings() {
        let audio = b"OggS fake".to_vec();
        let raw = make_recording(&audio);
        let rec = Recording { id: 0x6acd16b8, size: raw.len() as u32, scene: 1 };
        let (mut dev, mut session) = ready_device(Some((rec.clone(), raw, 0))).await;
        let list = list(&mut dev, &mut session, 0x14).await.unwrap();
        assert_eq!(list, vec![rec]);
    }

    #[tokio::test]
    async fn pulls_and_decrypts_a_recording_with_a_gap() {
        let audio: Vec<u8> = (0..900u32).map(|i| (i * 7) as u8).collect();
        let raw = make_recording(&audio);
        let rec = Recording { id: 0x6acd16b8, size: raw.len() as u32, scene: 1 };
        // one injected gap forces a resume
        let (mut dev, mut session) = ready_device(Some((rec.clone(), raw, 1))).await;
        let ogg = pull(&mut dev, &mut session, &rec, test_key()).await.unwrap();
        assert_eq!(ogg, audio, "decrypted audio matches, across the resume");
    }

    #[test]
    fn login_frame_matches_the_official_app() {
        // Decrypted capture-1 frame 3683 with the user id replaced: 010100 010100 <uid>.
        let f = login_frame(USER_ID).unwrap();
        assert_eq!(hex::encode(&f[..6]), "010100010100");
        assert_eq!(&f[6..], USER_ID.as_bytes());
        assert!(login_frame("short").is_err());
    }

    #[tokio::test]
    async fn an_unlinked_recorder_is_not_bound_from_the_phone() {
        let mut dev = FakeDevice::new(true);
        let err = handshake(&mut dev, &[0xAB; 256], test_key()).await.unwrap_err();
        assert!(err.to_string().contains("not linked"), "{err}");
        assert_eq!(dev.received_pem, None);
    }

    async fn logged_in(dev: &mut FakeDevice) -> Session {
        let keys = handshake(dev, &[0xAB; 256], test_key()).await.unwrap();
        let mut session = Session::phone(keys);
        login(dev, &mut session, USER_ID).await.unwrap();
        session
    }

    #[tokio::test]
    async fn an_idle_recorder_gets_the_active_flag_on_and_off() {
        let mut dev = FakeDevice::new(false);
        let mut session = logged_in(&mut dev).await;
        assert!(is_idle(&mut dev, &mut session).await.unwrap());
        set_active(&mut dev, &mut session, true).await.unwrap();
        set_active(&mut dev, &mut session, false).await.unwrap();
        assert_eq!(dev.active, vec![true, false]);
    }

    #[tokio::test]
    async fn a_recording_or_unclear_state_is_not_idle() {
        for state in [(0, 1), (STATUS_RECORDING, 0), (0, 2), (0, 3)] {
            let mut dev = FakeDevice::new(false);
            dev.state = state;
            let mut session = logged_in(&mut dev).await;
            assert!(!is_idle(&mut dev, &mut session).await.unwrap(), "{state:?}");
        }
    }
}
