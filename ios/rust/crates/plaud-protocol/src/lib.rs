//! Transport-agnostic protocol core for the Plaud Note Pro.
//!
//! Nothing here touches Bluetooth or the network: callers feed in bytes they
//! received and send the bytes this crate produces. That keeps the protocol
//! unit-testable and lets the same code back the Mac CLI and the mobile apps.
//!
//! Protocol notes live in `docs/protocol/`.

pub mod crc;
pub mod file;
pub mod frame;
pub mod handshake;
pub mod session;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("frame too short: need {need} bytes, got {got}")]
    Short { need: usize, got: usize },
    #[error("unexpected frame family 0x{0:02x}")]
    Family(u8),
    #[error("chunk {index} out of range for a {total}-chunk message")]
    ChunkRange { index: u8, total: u8 },
    #[error("payload of {0} bytes needs more than 255 chunks")]
    TooManyChunks(usize),
    #[error("session frame failed authentication")]
    Auth,
    #[error("replayed or out-of-order session frame (seq {seq}, last {last})")]
    Replay { seq: u32, last: u32 },
    #[error("RSA operation failed")]
    Rsa,
    #[error("handshake proof did not decrypt to the PLAUD.AI magic")]
    BadMagic,
    #[error("not a Plaud encrypted file header")]
    NotEncrypted,
}

pub type Result<T> = std::result::Result<T, Error>;
