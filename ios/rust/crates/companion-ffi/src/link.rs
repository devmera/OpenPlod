//! The device-facing seam: anything that can write a frame and yield the next
//! notification. The BLE implementation lives in `ble.rs`; tests use a fake
//! device instead.

use anyhow::Result;

#[allow(async_fn_in_trait)]
pub trait Link {
    async fn write(&mut self, frame: &[u8]) -> Result<()>;
    /// Waits for the next notification from the device.
    async fn next(&mut self) -> Result<Vec<u8>>;
}
