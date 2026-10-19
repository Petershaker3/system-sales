//! Local Wi-Fi companion domain (`ADR-037`, `docs/PLAN.md` §15, §16, §19 — Item 3.2).
//!
//! The desktop PC is the single source of truth (`ADR-016` #2). The mobile
//! phone is a stateless companion connected over the shop Wi-Fi (`0.0.0.0:8787`)
//! with no database of its own.

use serde::{Deserialize, Serialize};

/// Prefix for companion state stored in `app_settings`.
pub const COMPANION_PREFIX: &str = "companion.";
pub const COMPANION_DEVICES_KEY: &str = "companion.devices_json";
pub const COMPANION_SCANS_KEY: &str = "companion.scans_json";
pub const COMPANION_PAIR_CODE_KEY: &str = "companion.pair_code";

/// Default TCP port for the shop LAN companion HTTP server (`docs/ui/mockup-v1/views/settings.js`).
pub const DEFAULT_COMPANION_PORT: u16 = 8787;

/// One mobile phone paired with the shop computer over local Wi-Fi.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    pub paired_at: i64,
    pub last_seen_at: i64,
    pub online: bool,
}

/// A barcode or 15-digit IMEI scanned by a paired phone and forwarded to the desktop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionScanItem {
    pub id: String,
    /// `"pos"` (cashier invoice) or `"receive"` (stock receiving).
    pub target: String,
    pub code: String,
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    pub device_name: String,
    pub scanned_at: i64,
}

/// Snapshot of the LAN companion server, pairing QR payload, paired phones, and pending scans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub host_ip: String,
    pub port: u16,
    pub pair_code: String,
    pub pair_payload: String,
    pub running: bool,
    pub paired_devices: Vec<PairedDevice>,
    pub pending_scans: Vec<CompanionScanItem>,
}

/// Format the QR pairing payload scanned by the mobile companion app on shop Wi-Fi.
pub fn format_pair_payload(
    shop_name: &str,
    host_ip: &str,
    port: u16,
    pair_code: &str,
) -> String {
    let clean_name = shop_name.trim().replace('|', "-");
    let name = if clean_name.is_empty() {
        "موبايل ستور"
    } else {
        clean_name.as_str()
    };
    format!("MSHOP-PAIR|v1|{name}|{host_ip}:{port}|{}", pair_code.trim())
}

/// Parse a `MSHOP-PAIR|v1|{shop_name}|{host_ip}:{port}|{pair_code}` payload.
pub fn parse_pair_payload(payload: &str) -> Option<(String, String, u16, String)> {
    let parts: Vec<&str> = payload.trim().split('|').collect();
    if parts.len() != 5 || parts[0] != "MSHOP-PAIR" || parts[1] != "v1" {
        return None;
    }
    let shop_name = parts[2].trim().to_string();
    let (host_ip, port_str) = parts[3].trim().split_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    let pair_code = parts[4].trim().to_string();
    if host_ip.is_empty() || pair_code.is_empty() {
        return None;
    }
    Some((shop_name, host_ip.to_string(), port, pair_code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_payload_round_trips() {
        let payload = format_pair_payload("سنتر بيتر", "192.168.1.10", 8787, "PAIR-7741");
        assert_eq!(
            payload,
            "MSHOP-PAIR|v1|سنتر بيتر|192.168.1.10:8787|PAIR-7741"
        );
        let parsed = parse_pair_payload(&payload).expect("valid payload");
        assert_eq!(parsed.0, "سنتر بيتر");
        assert_eq!(parsed.1, "192.168.1.10");
        assert_eq!(parsed.2, 8787);
        assert_eq!(parsed.3, "PAIR-7741");
    }

    #[test]
    fn invalid_pair_payload_returns_none() {
        assert!(parse_pair_payload("INVALID").is_none());
        assert!(parse_pair_payload("MSHOP-PAIR|v1|Shop|192.168.1.10|1234").is_none());
    }
}
