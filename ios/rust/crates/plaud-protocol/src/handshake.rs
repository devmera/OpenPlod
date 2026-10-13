//! The port-version-20 key exchange.
//!
//! 1. Phone sends the Plaud-issued serial-number signature as `0xFE10` chunks
//!    (`0xFE20` to force-clear a stale binding).
//! 2. The device answers `0xFE11` if it wants the user's RSA public key, which
//!    the phone then sends as `0xFE12` chunks.
//! 3. The device answers `0xFE12` chunks carrying an RSA-PKCS#1 v1.5 blob for
//!    the user key: `key[32] ‖ nonce[12] ‖ aad[12] ‖ proof`, where `proof` must
//!    open (ChaCha20-Poly1305, same key/nonce/aad, no seq) to `PLAUD.AI`.
//!
//! The signature is byte-identical across connections (see
//! `docs/protocol/03-capture-notepro-sync-1.md`), so it only has to be
//! obtained once.

use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};

use crate::frame;
use crate::session::{open_raw, SessionKeys};
use crate::{Error, Result};

pub const OP_SN_SIGNATURE: u16 = 0xFE10;
pub const OP_WANTS_USER_KEY: u16 = 0xFE11;
pub const OP_USER_KEY: u16 = 0xFE12;
pub const MAGIC: &[u8; 8] = b"PLAUD.AI";

pub fn signature_frames(signature: &[u8]) -> Result<Vec<Vec<u8>>> {
    let op = OP_SN_SIGNATURE;
    frame::chunk(op, signature)
}

/// The user public key goes over the air as the PEM text's bytes.
pub fn public_key_frames(public_key_pem: &str) -> Result<Vec<Vec<u8>>> {
    frame::chunk(OP_USER_KEY, public_key_pem.as_bytes())
}

/// Unwraps the device's reassembled `0xFE12` blob into session keys.
pub fn session_keys(private_key: &RsaPrivateKey, blob: &[u8]) -> Result<SessionKeys> {
    let plain = private_key.decrypt(Pkcs1v15Encrypt, blob).map_err(|_| Error::Rsa)?;
    if plain.len() < 56 {
        return Err(Error::Short { need: 56, got: plain.len() });
    }
    let keys = SessionKeys {
        key: plain[..32].try_into().unwrap(),
        nonce: plain[32..44].try_into().unwrap(),
        aad: plain[44..56].try_into().unwrap(),
    };
    if open_raw(&keys, &plain[56..])? != MAGIC {
        return Err(Error::BadMagic);
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::seal_raw;
    use rsa::RsaPublicKey;

    /// Plays the device's side: wraps fresh session keys plus proof to the user key.
    fn device_blob(public: &RsaPublicKey, keys: &SessionKeys) -> Vec<u8> {
        let mut plain = Vec::new();
        plain.extend_from_slice(&keys.key);
        plain.extend_from_slice(&keys.nonce);
        plain.extend_from_slice(&keys.aad);
        plain.extend_from_slice(&seal_raw(keys, MAGIC));
        public.encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, &plain).unwrap()
    }

    #[test]
    fn unwraps_device_blob() {
        let private = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let keys = SessionKeys { key: [9; 32], nonce: [8; 12], aad: [7; 12] };
        let blob = device_blob(&private.to_public_key(), &keys);
        // RSA-2048 output is 256 bytes, matching the 3-chunk 0xFE12 reply in the capture.
        assert_eq!(blob.len(), 256);
        let got = session_keys(&private, &blob).unwrap();
        assert_eq!((got.key, got.nonce, got.aad), (keys.key, keys.nonce, keys.aad));
    }

    #[test]
    fn wrong_key_is_rejected() {
        let mut rng = rand::thread_rng();
        let (ours, theirs) = (RsaPrivateKey::new(&mut rng, 2048).unwrap(), RsaPrivateKey::new(&mut rng, 2048).unwrap());
        let keys = SessionKeys { key: [1; 32], nonce: [1; 12], aad: [1; 12] };
        let blob = device_blob(&theirs.to_public_key(), &keys);
        assert!(session_keys(&ours, &blob).is_err());
    }

    #[test]
    fn signature_frames_match_capture_headers() {
        let frames = signature_frames(&[0u8; 256]).unwrap();
        let heads: Vec<_> = frames.iter().map(|f| f[..4].to_vec()).collect();
        assert_eq!(heads, [[0x10, 0xFE, 3, 0], [0x10, 0xFE, 3, 1], [0x10, 0xFE, 3, 2]]);
    }
}
