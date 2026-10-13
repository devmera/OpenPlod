//! Plaintext frame layouts (before the session cipher is applied).
//!
//! - Handshake chunks: `[opcode u16 LE][total u8][index u8][payload]`, at most
//!   100 payload bytes each. Confirmed against the `0xFE10` frames in
//!   `notepro-sync-1.pklg`.
//! - Control frames: `[0x01][opcode u16 LE][payload]`.
//! - Bulk file data (port >= 7): `[0x02][session u32][offset u32][len u8][data]`,
//!   with offset `0xFFFF_FFFF` marking the end; the byte after `len` is then an
//!   end code (1 = normal).

use crate::{Error, Result};

pub const CHUNK_PAYLOAD: usize = 100;
pub const FAMILY_CONTROL: u8 = 0x01;
pub const FAMILY_BULK: u8 = 0x02;
pub const BULK_END_OFFSET: u32 = 0xFFFF_FFFF;

/// Splits `payload` into handshake chunks for `opcode`.
pub fn chunk(opcode: u16, payload: &[u8]) -> Result<Vec<Vec<u8>>> {
    let total = payload.len().div_ceil(CHUNK_PAYLOAD).max(1);
    let total = u8::try_from(total).map_err(|_| Error::TooManyChunks(payload.len()))?;
    let mut out = Vec::with_capacity(total as usize);
    for (index, part) in payload.chunks(CHUNK_PAYLOAD).enumerate() {
        let mut f = Vec::with_capacity(4 + part.len());
        f.extend_from_slice(&opcode.to_le_bytes());
        f.push(total);
        f.push(index as u8);
        f.extend_from_slice(part);
        out.push(f);
    }
    Ok(out)
}

/// One received handshake chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk<'a> {
    pub opcode: u16,
    pub total: u8,
    pub index: u8,
    pub payload: &'a [u8],
}

pub fn parse_chunk(frame: &[u8]) -> Result<Chunk<'_>> {
    if frame.len() < 4 {
        return Err(Error::Short { need: 4, got: frame.len() });
    }
    let (total, index) = (frame[2], frame[3]);
    if index >= total {
        return Err(Error::ChunkRange { index, total });
    }
    Ok(Chunk {
        opcode: u16::from_le_bytes([frame[0], frame[1]]),
        total,
        index,
        payload: &frame[4..],
    })
}

/// Reassembles chunks of one message, tolerating duplicates (the official app
/// re-sends the whole signature once, as seen in the capture).
#[derive(Debug, Default)]
pub struct Reassembler {
    parts: Vec<Option<Vec<u8>>>,
}

impl Reassembler {
    /// Feeds a chunk; returns the full payload once every index has arrived.
    pub fn push(&mut self, c: &Chunk<'_>) -> Option<Vec<u8>> {
        if self.parts.len() != c.total as usize {
            self.parts = vec![None; c.total as usize];
        }
        self.parts[c.index as usize] = Some(c.payload.to_vec());
        if self.parts.iter().all(Option::is_some) {
            let full = self.parts.iter().flatten().flatten().copied().collect();
            self.parts.clear();
            Some(full)
        } else {
            None
        }
    }
}

pub fn control(opcode: u16, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(3 + payload.len());
    f.push(FAMILY_CONTROL);
    f.extend_from_slice(&opcode.to_le_bytes());
    f.extend_from_slice(payload);
    f
}

/// A decoded inbound frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame<'a> {
    Control { opcode: u16, payload: &'a [u8] },
    Bulk(Bulk<'a>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bulk<'a> {
    Data { session: u32, offset: u32, data: &'a [u8] },
    End { session: u32, end_code: u8 },
}

pub fn parse(frame: &[u8]) -> Result<Frame<'_>> {
    let family = *frame.first().ok_or(Error::Short { need: 1, got: 0 })?;
    match family {
        FAMILY_CONTROL => {
            if frame.len() < 3 {
                return Err(Error::Short { need: 3, got: frame.len() });
            }
            Ok(Frame::Control {
                opcode: u16::from_le_bytes([frame[1], frame[2]]),
                payload: &frame[3..],
            })
        }
        FAMILY_BULK => {
            if frame.len() < 10 {
                return Err(Error::Short { need: 10, got: frame.len() });
            }
            let session = u32::from_le_bytes(frame[1..5].try_into().unwrap());
            let offset = u32::from_le_bytes(frame[5..9].try_into().unwrap());
            let len = frame[9] as usize;
            if offset == BULK_END_OFFSET {
                let end_code = *frame.get(10).unwrap_or(&0);
                return Ok(Frame::Bulk(Bulk::End { session, end_code }));
            }
            let need = 10 + len;
            if frame.len() < need {
                return Err(Error::Short { need, got: frame.len() });
            }
            Ok(Frame::Bulk(Bulk::Data { session, offset, data: &frame[10..need] }))
        }
        other => Err(Error::Family(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_roundtrip_256_bytes_matches_capture_shape() {
        let payload: Vec<u8> = (0..=255).collect();
        let chunks = chunk(0xFE10, &payload).unwrap();
        // Capture: three frames of 104, 104 and 60 bytes, headers 10fe0300/01/02.
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [104, 104, 60]);
        assert_eq!(&chunks[2][..4], &[0x10, 0xFE, 0x03, 0x02]);

        let mut r = Reassembler::default();
        let mut out = None;
        for c in &chunks {
            out = r.push(&parse_chunk(c).unwrap());
        }
        assert_eq!(out.unwrap(), payload);
    }

    #[test]
    fn reassembler_tolerates_full_resend() {
        let payload = vec![7u8; 150];
        let chunks = chunk(0xFE12, &payload).unwrap();
        let mut r = Reassembler::default();
        let mut results = Vec::new();
        for c in chunks.iter().chain(chunks.iter()) {
            if let Some(p) = r.push(&parse_chunk(c).unwrap()) {
                results.push(p);
            }
        }
        assert_eq!(results, vec![payload.clone(), payload]);
    }

    #[test]
    fn rejects_out_of_range_chunk() {
        assert_eq!(parse_chunk(&[0x10, 0xFE, 2, 2]), Err(Error::ChunkRange { index: 2, total: 2 }));
    }

    #[test]
    fn parses_bulk_data_and_end() {
        let mut f = vec![FAMILY_BULK];
        f.extend_from_slice(&9u32.to_le_bytes());
        f.extend_from_slice(&1000u32.to_le_bytes());
        f.push(3);
        f.extend_from_slice(b"abc");
        assert_eq!(
            parse(&f).unwrap(),
            Frame::Bulk(Bulk::Data { session: 9, offset: 1000, data: b"abc" })
        );

        let mut e = vec![FAMILY_BULK];
        e.extend_from_slice(&9u32.to_le_bytes());
        e.extend_from_slice(&BULK_END_OFFSET.to_le_bytes());
        e.extend_from_slice(&[0, 1]);
        assert_eq!(parse(&e).unwrap(), Frame::Bulk(Bulk::End { session: 9, end_code: 1 }));
    }

    #[test]
    fn control_roundtrip() {
        let f = control(0x1A, &[1, 2]);
        assert_eq!(f, [0x01, 0x1A, 0x00, 1, 2]);
        assert_eq!(parse(&f).unwrap(), Frame::Control { opcode: 0x1A, payload: &[1, 2] });
    }
}
