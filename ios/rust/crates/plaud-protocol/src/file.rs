//! Encrypted recording files as stored on the device.
//!
//! A 512-byte little-endian header (`PlaudEncryptHeader` in the SDK) followed by
//! the audio encrypted with raw ChaCha20 (RFC 7539, counter 0). The 32-byte
//! audio key is RSA-PKCS#1 v1.5 wrapped to the user public key.
//!
//! | Offset | Size | Field |
//! |---|---|---|
//! | 0 | 8 | magic `PLAUD.AI` |
//! | 8 | 2 | version |
//! | 10 | 2 | header size |
//! | 12 | 4 | crc |
//! | 16 | 32 | user id (ASCII hex) |
//! | 48 | 2 | file type |
//! | 50 | 2 | channel |
//! | 52 | 2 | encrypt type |
//! | 54 | 4 | duration |
//! | 58 | 70 | reserved |
//! | 128 | 4 | counter |
//! | 132 | 12 | nonce |
//! | 144 | 4 | segment |
//! | 148 | 108 | algorithm params |
//! | 256 | 256 | RSA-wrapped audio key |

use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20::ChaCha20;
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};

use crate::handshake::MAGIC;
use crate::{Error, Result};

pub const HEADER_SIZE: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub version: u16,
    pub user_id: [u8; 32],
    pub file_type: u16,
    pub channel: u16,
    pub encrypt_type: u16,
    pub duration: u32,
    pub nonce: [u8; 12],
    pub segment: u32,
    pub key_cipher: [u8; 256],
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

impl Header {
    /// Parses the header, or returns `NotEncrypted` for plain files.
    pub fn parse(file: &[u8]) -> Result<Self> {
        if file.len() < HEADER_SIZE {
            return Err(Error::Short { need: HEADER_SIZE, got: file.len() });
        }
        if &file[..8] != MAGIC {
            return Err(Error::NotEncrypted);
        }
        Ok(Self {
            version: u16_at(file, 8),
            user_id: file[16..48].try_into().unwrap(),
            file_type: u16_at(file, 48),
            channel: u16_at(file, 50),
            encrypt_type: u16_at(file, 52),
            duration: u32_at(file, 54),
            nonce: file[132..144].try_into().unwrap(),
            segment: u32_at(file, 144),
            key_cipher: file[256..512].try_into().unwrap(),
        })
    }
}

/// Decrypts a whole recording, mirroring the SDK's `AudioDecryptor`.
/// Plain (unencrypted) files are returned as-is.
pub fn decrypt(private_key: &RsaPrivateKey, file: &[u8]) -> Result<Vec<u8>> {
    let header = match Header::parse(file) {
        Ok(h) => h,
        Err(Error::NotEncrypted) => return Ok(file.to_vec()),
        Err(e) => return Err(e),
    };
    let audio_key = private_key.decrypt(Pkcs1v15Encrypt, &header.key_cipher).map_err(|_| Error::Rsa)?;
    if audio_key.len() < 32 {
        return Err(Error::Short { need: 32, got: audio_key.len() });
    }
    let key: [u8; 32] = audio_key[..32].try_into().unwrap();
    let body = &file[HEADER_SIZE..];
    let mut out = Vec::with_capacity(body.len());
    // segment == 0: one continuous ChaCha20 keystream over the whole body.
    // segment  > 0: each `segment` bytes are a fresh stream (keystream restarts at 0),
    //               reusing the same key and nonce. Verified against the SDK's AudioDecryptor.
    let step = if header.segment == 0 { body.len().max(1) } else { header.segment as usize };
    for chunk in body.chunks(step) {
        let mut piece = chunk.to_vec();
        ChaCha20::new(&key.into(), &header.nonce.into()).apply_keystream(&mut piece);
        out.extend_from_slice(&piece);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypted_file(private: &RsaPrivateKey, audio: &[u8]) -> Vec<u8> {
        let (audio_key, nonce) = ([5u8; 32], [6u8; 12]);
        let mut h = vec![0u8; HEADER_SIZE];
        h[..8].copy_from_slice(MAGIC);
        h[8..10].copy_from_slice(&1u16.to_le_bytes());
        h[16..48].copy_from_slice(b"0123456789abcdef0123456789abcdef");
        h[54..58].copy_from_slice(&42u32.to_le_bytes());
        h[132..144].copy_from_slice(&nonce);
        let wrapped = private
            .to_public_key()
            .encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, &audio_key)
            .unwrap();
        h[256..512].copy_from_slice(&wrapped);
        let mut body = audio.to_vec();
        ChaCha20::new(&audio_key.into(), &nonce.into()).apply_keystream(&mut body);
        h.extend_from_slice(&body);
        h
    }

    #[test]
    fn decrypts_synthetic_recording() {
        let private = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let audio = b"OggS\0\x02 fake opus page";
        let file = encrypted_file(&private, audio);
        let header = Header::parse(&file).unwrap();
        assert_eq!((header.version, header.duration), (1, 42));
        assert_eq!(&header.user_id, b"0123456789abcdef0123456789abcdef");
        assert_eq!(decrypt(&private, &file).unwrap(), audio);
    }

    #[test]
    fn decrypts_segmented_recording() {
        let private = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let (audio_key, nonce, seg) = ([9u8; 32], [3u8; 12], 100usize);
        let audio: Vec<u8> = (0..250u32).map(|i| i as u8).collect();
        let mut h = vec![0u8; HEADER_SIZE];
        h[..8].copy_from_slice(MAGIC);
        h[132..144].copy_from_slice(&nonce);
        h[144..148].copy_from_slice(&(seg as u32).to_le_bytes());
        let wrapped = private.to_public_key().encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, &audio_key).unwrap();
        h[256..512].copy_from_slice(&wrapped);
        // Encrypt each segment with the keystream restarted at 0.
        let mut body = Vec::new();
        for seg_bytes in audio.chunks(seg) {
            let mut p = seg_bytes.to_vec();
            ChaCha20::new(&audio_key.into(), &nonce.into()).apply_keystream(&mut p);
            body.extend_from_slice(&p);
        }
        h.extend_from_slice(&body);
        assert_eq!(decrypt(&private, &h).unwrap(), audio);
    }

    #[test]
    fn passes_plain_files_through() {
        let private = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let plain = vec![0u8; 600];
        assert_eq!(decrypt(&private, &plain).unwrap(), plain);
    }
}
