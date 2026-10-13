//! Bluetooth LE transport via btleplug (CoreBluetooth on macOS).
//!
//! GATT layout from `docs/protocol/02-sdk-ble-commands.md` §1: vendor service
//! `0x1910`, phone→device writes on `0x2BB1`, device→phone notifications on
//! `0x2BB0`.

use std::pin::Pin;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{
    CharPropFlags, Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, ValueNotification,
    WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::{Stream, StreamExt};

use crate::link::Link;

pub fn service_uuid() -> uuid::Uuid {
    uuid_from_u16(0x1910)
}
/// What the Note Pro actually advertises ("PL" in ASCII), seen 2026-10-12.
fn advertised_service_uuid() -> uuid::Uuid {
    uuid_from_u16(0x504C)
}
/// Realtek, whose advertising data on the Note Pro carries the serial.
const REALTEK: u16 = 0x005D;
const NORDIC: u16 = 0x0059;
fn write_uuid() -> uuid::Uuid {
    uuid_from_u16(0x2BB1)
}
fn notify_uuid() -> uuid::Uuid {
    uuid_from_u16(0x2BB0)
}

pub struct Found {
    pub peripheral: Peripheral,
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
    /// Advertised service UUIDs and manufacturer ids, for `scan --all`.
    pub services: Vec<uuid::Uuid>,
    pub manufacturers: Vec<(u16, Vec<u8>)>,
}

impl Found {
    /// Matches the device's data advertisement, not its Apple Find My beacon,
    /// which reuses the "Plaud Note Pro" name but cannot be talked to.
    pub fn is_plaud(&self) -> bool {
        let named = self.name.as_deref().is_some_and(|n| n.to_ascii_lowercase().contains("plaud"));
        self.services.iter().any(|u| *u == service_uuid() || *u == advertised_service_uuid())
            || (named && self.manufacturers.iter().any(|(id, _)| *id == REALTEK || *id == NORDIC))
    }
    }

async fn adapter() -> Result<Adapter> {
    Manager::new()
        .await?
        .adapters()
        .await?
        .into_iter()
        .next()
        .context("no Bluetooth adapter found (is Bluetooth on, and does the terminal have Bluetooth permission?)")
}

/// Scans for `secs` seconds. Returns Plaud devices, or every device when `all`.
pub async fn scan(secs: u64, all: bool) -> Result<Vec<Found>> {
    let central = adapter().await?;
    // Unfiltered: a service filter would hide a Note Pro that advertises only its name.
    central.start_scan(ScanFilter::default()).await?;
    tokio::time::sleep(Duration::from_secs(secs)).await;
    central.stop_scan().await?;

    let mut found = Vec::new();
    for p in central.peripherals().await? {
        let Some(props) = p.properties().await? else { continue };
        let f = Found {
            id: p.id().to_string(),
            name: props.local_name,
            rssi: props.rssi,
            services: props.services,
            manufacturers: props.manufacturer_data.into_iter().collect(),
            peripheral: p,
        };
        if all || f.is_plaud() {
            found.push(f);
        }
    }
    Ok(found)
}

pub struct BleLink {
    peripheral: Peripheral,
    write: Characteristic,
    write_type: WriteType,
    notifications: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
    timeout: Duration,
}

impl BleLink {
    /// Connects to `device` (an id from `scan`), or the only Plaud device in range.
    pub async fn connect(device: Option<&str>, timeout: Duration) -> Result<Self> {
        let mut found = scan(10, false).await?;
        let found = match device {
            Some(id) => found
                .into_iter()
                .find(|f| f.id == id)
                .with_context(|| format!("Recorder {id} was not found nearby"))?,
            None => match found.len() {
                0 => bail!("no Plaud device found; wake it and keep it close"),
                1 => found.remove(0),
                n => bail!("{n} Plaud recorders are in range; choose one"),
            },
        };

        let p = found.peripheral;
        p.connect().await.context("connect failed")?;
        p.discover_services().await?;
        let chars = p.characteristics();
        if !chars.iter().any(|c| c.uuid == write_uuid()) {
            let table: Vec<_> = chars.iter().map(|c| format!("{} in {} {:?}", c.uuid, c.service_uuid, c.properties)).collect();
            let _ = p.disconnect().await;
            bail!("expected characteristic 0x2BB1 not found; the device exposes:\n  {}", table.join("\n  "));
        }
        let write = chars
            .iter()
            .find(|c| c.uuid == write_uuid())
            .cloned()
            .context("write characteristic 0x2BB1 not found")?;
        let notify = chars
            .iter()
            .find(|c| c.uuid == notify_uuid())
            .cloned()
            .context("notify characteristic 0x2BB0 not found")?;

        // The official app uses ATT Write Command (no response), per the capture.
        let write_type = if write.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
            WriteType::WithoutResponse
        } else {
            WriteType::WithResponse
        };

        let notifications = p.notifications().await?;
        p.subscribe(&notify).await.context("subscribe to 0x2BB0 failed")?;
        let notify_uuid = notify.uuid;
        let notifications = Box::pin(notifications.filter(move |n| std::future::ready(n.uuid == notify_uuid)));

        Ok(Self { peripheral: p, write, write_type, notifications, timeout })
    }

    pub async fn disconnect(self) -> Result<()> {
        Ok(self.peripheral.disconnect().await?)
    }
}

impl Link for BleLink {
    async fn write(&mut self, frame: &[u8]) -> Result<()> {
        Ok(self.peripheral.write(&self.write, frame, self.write_type).await?)
    }

    async fn next(&mut self) -> Result<Vec<u8>> {
        match tokio::time::timeout(self.timeout, self.notifications.next()).await {
            Ok(Some(n)) => Ok(n.value),
            Ok(None) => bail!("device disconnected"),
            Err(_) => bail!("no reply from device within {:?}", self.timeout),
        }
    }
}

