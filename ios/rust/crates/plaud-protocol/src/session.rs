//! Session cipher used after the handshake on port version >= 20.
//!
//! Every frame, in both directions, is
//! `ChaCha20-Poly1305(key, nonce, aad).seal(seq_u32_LE ‖ plain_frame)`.
//! The nonce is fixed for the whole session (a weakness in the firmware's
//! design, not ours to fix); only the sequence number changes. Inbound frames
//! whose seq does not increase are rejected as replays.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

use crate::{Error, Result};

#[derive(Clone)]
pub struct SessionKeys {
    pub key: [u8; 32],
    pub nonce: [u8; 12],
    pub aad: [u8; 12],
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKeys(<redacted>)")
    }
}

pub struct Session {
    keys: SessionKeys,
    cipher: ChaCha20Poly1305,
    send_seq: u32,
    recv_seq: u32,
}

impl Session {
    pub fn new(keys: SessionKeys) -> Self {
        Self::with_last_seqs(keys, 0, 0)
    }

    /// The phone side as the official app runs it: the handshake counts as
    /// sequence 1, so the first sealed frame is seq 2 (seen in the decrypted
    /// capture), while the device's frames start at 1.
    pub fn phone(keys: SessionKeys) -> Self {
        Self::with_last_seqs(keys, 1, 0)
    }

    pub fn with_last_seqs(keys: SessionKeys, last_sent: u32, last_received: u32) -> Self {
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&keys.key));
        Self { keys, cipher, send_seq: last_sent, recv_seq: last_received }
    }

    /// Encrypts one outbound plaintext frame. Sequence numbers start at 1.
    pub fn seal(&mut self, frame: &[u8]) -> Vec<u8> {
        self.send_seq += 1;
        let mut msg = Vec::with_capacity(4 + frame.len());
        msg.extend_from_slice(&self.send_seq.to_le_bytes());
        msg.extend_from_slice(frame);
        self.cipher
            .encrypt(Nonce::from_slice(&self.keys.nonce), Payload { msg: &msg, aad: &self.keys.aad })
            .expect("ChaCha20-Poly1305 encryption cannot fail for in-memory buffers")
    }

    /// Decrypts one inbound frame and enforces increasing sequence numbers.
    pub fn open(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(&self.keys.nonce), Payload { msg: data, aad: &self.keys.aad })
            .map_err(|_| Error::Auth)?;
        if plain.len() < 4 {
            return Err(Error::Short { need: 4, got: plain.len() });
        }
        let seq = u32::from_le_bytes(plain[..4].try_into().unwrap());
        if seq <= self.recv_seq {
            return Err(Error::Replay { seq, last: self.recv_seq });
        }
        self.recv_seq = seq;
        Ok(plain[4..].to_vec())
    }
}

/// Opens a ChaCha20-Poly1305 blob without the seq prefix (used for the
/// handshake proof).
pub(crate) fn open_raw(keys: &SessionKeys, data: &[u8]) -> Result<Vec<u8>> {
    ChaCha20Poly1305::new(Key::from_slice(&keys.key))
        .decrypt(Nonce::from_slice(&keys.nonce), Payload { msg: data, aad: &keys.aad })
        .map_err(|_| Error::Auth)
}

#[cfg(test)]
pub(crate) fn seal_raw(keys: &SessionKeys, data: &[u8]) -> Vec<u8> {
    ChaCha20Poly1305::new(Key::from_slice(&keys.key))
        .encrypt(Nonce::from_slice(&keys.nonce), Payload { msg: data, aad: &keys.aad })
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> SessionKeys {
        SessionKeys { key: [1; 32], nonce: [2; 12], aad: [3; 12] }
    }

    #[test]
    fn roundtrip_between_two_ends() {
        let (mut phone, mut device) = (Session::new(keys()), Session::new(keys()));
        let sealed = phone.seal(&[0x01, 0x1A, 0x00]);
        assert_eq!(sealed.len(), 4 + 3 + 16);
        assert_eq!(device.open(&sealed).unwrap(), [0x01, 0x1A, 0x00]);
    }

    #[test]
    fn rejects_replay_and_tamper() {
        let (mut phone, mut device) = (Session::new(keys()), Session::new(keys()));
        let first = phone.seal(b"\x01\x09\x00");
        device.open(&first).unwrap();
        assert_eq!(device.open(&first), Err(Error::Replay { seq: 1, last: 1 }));

        let mut bad = phone.seal(b"\x01\x09\x00");
        bad[0] ^= 1;
        assert_eq!(device.open(&bad), Err(Error::Auth));
    }

    #[test]
    fn phone_session_starts_at_seq_2() {
        let mut phone = Session::phone(keys());
        // A device that counts the handshake as seq 1 accepts the phone's first frame.
        let mut device = Session::with_last_seqs(keys(), 0, 1);
        assert_eq!(device.open(&phone.seal(b"\x01\x01\x00")).unwrap(), b"\x01\x01\x00");
        // ...and would have rejected a frame at seq 1.
        let mut early = Session::new(keys());
        assert_eq!(Session::with_last_seqs(keys(), 0, 1).open(&early.seal(b"x")), Err(Error::Replay { seq: 1, last: 1 }));
    }

    #[test]
    fn debug_does_not_leak_keys() {
        assert_eq!(format!("{:?}", keys()), "SessionKeys(<redacted>)");
    }
}
