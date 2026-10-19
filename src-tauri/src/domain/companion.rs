//! Local Wi-Fi companion, optional remote owner follow-up relay, and ETA e-Receipt
//! sandbox payload builder (`ADR-037`, `ADR-038`, `docs/PLAN.md` §15, §16, §18, §19).
//!
//! The desktop PC is the single source of truth (`ADR-016` #1, #2). The mobile
//! phone is a stateless companion connected over the shop Wi-Fi (`0.0.0.0:8787`)
//! with no database of its own, and in Phase 4 supports optional encrypted
//! read-only remote follow-up for the owner outside the shop.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Prefix for companion state stored in `app_settings`.
pub const COMPANION_PREFIX: &str = "companion.";
pub const COMPANION_DEVICES_KEY: &str = "companion.devices_json";
pub const COMPANION_SCANS_KEY: &str = "companion.scans_json";
pub const COMPANION_PAIR_CODE_KEY: &str = "companion.pair_code";
pub const COMPANION_REMOTE_ENABLED_KEY: &str = "companion.remote_enabled";
pub const COMPANION_REMOTE_CODE_KEY: &str = "companion.remote_code";

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

/// Snapshot of the LAN companion server, pairing QR payload, paired phones,
/// pending scans, and optional Phase 4 remote owner follow-up relay.
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
    pub remote_enabled: bool,
    pub remote_code: String,
    pub remote_payload: String,
    pub last_remote_sync_at: Option<i64>,
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

/// Format the Phase 4 read-only remote follow-up QR payload (`ADR-038`).
pub fn format_remote_payload(shop_name: &str, remote_code: &str) -> String {
    let clean_name = shop_name.trim().replace('|', "-");
    let name = if clean_name.is_empty() {
        "موبايل ستور"
    } else {
        clean_name.as_str()
    };
    format!("MSHOP-REMOTE|v1|{name}|{}", remote_code.trim())
}

/// Parse a `MSHOP-REMOTE|v1|{shop_name}|{remote_code}` payload.
pub fn parse_remote_payload(payload: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = payload.trim().split('|').collect();
    if parts.len() != 4 || parts[0] != "MSHOP-REMOTE" || parts[1] != "v1" {
        return None;
    }
    let shop_name = parts[2].trim().to_string();
    let remote_code = parts[3].trim().to_string();
    if remote_code.is_empty() {
        return None;
    }
    Some((shop_name, remote_code))
}

/// Line item inside a canonical ETA e-Receipt v1.2 sandbox document (`ADR-038`, `docs/PLAN.md` §18, §19).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaEReceiptLine {
    pub item_code: String,
    pub description: String,
    pub quantity: i64,
    pub unit_price_minor: i64,
    pub discount_minor: i64,
    pub net_total_minor: i64,
}

/// Canonical ETA e-Receipt v1.2 sandbox payload (`docs/PLAN.md` §18, §19).
///
/// Tax settings remain in the data model with default values and hidden from the
/// daily UI (`docs/PLAN.md` §18); this builder produces a deterministic SHA-256
/// receipt UUID and canonical summary ready for the ETA sandbox when mandated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaEReceiptDraft {
    pub receipt_type: String,
    pub type_version: String,
    pub receipt_number: String,
    pub issued_at_ms: i64,
    pub currency: String,
    pub subtotal_minor: i64,
    pub discount_minor: i64,
    pub tax_rate_bp: u32,
    pub tax_minor: i64,
    pub total_minor: i64,
    pub payment_method_code: String,
    pub uuid_hex: String,
    pub lines: Vec<EtaEReceiptLine>,
}

/// Build a canonical ETA e-Receipt v1.2 sandbox draft with a deterministic SHA-256 UUID (`ADR-038`).
pub fn build_eta_ereceipt_draft(
    receipt_number: &str,
    issued_at_ms: i64,
    lines: Vec<EtaEReceiptLine>,
    invoice_discount_minor: i64,
    vat_enabled: bool,
    vat_rate_bp: u32,
    vat_inclusive: bool,
    payment_method_code: &str,
) -> EtaEReceiptDraft {
    let lines_subtotal: i64 = lines.iter().map(|l| l.net_total_minor).sum();
    let net_before_tax = (lines_subtotal - invoice_discount_minor.max(0)).max(0);
    let effective_bp = if vat_enabled { vat_rate_bp } else { 0 };
    let (tax_minor, total_minor) = if effective_bp == 0 {
        (0, net_before_tax)
    } else if vat_inclusive {
        let bp = i64::from(effective_bp);
        let tax = (net_before_tax * bp) / (10_000 + bp);
        (tax, net_before_tax)
    } else {
        let bp = i64::from(effective_bp);
        let tax = (net_before_tax * bp + 5_000) / 10_000;
        (tax, net_before_tax + tax)
    };

    let mut hasher = Sha256::new();
    hasher.update(b"ETA-ERECEIPT-V1.2|");
    hasher.update(receipt_number.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(issued_at_ms.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(total_minor.to_string().as_bytes());
    for line in &lines {
        hasher.update(b"|");
        hasher.update(line.item_code.as_bytes());
        hasher.update(b":");
        hasher.update(line.quantity.to_string().as_bytes());
        hasher.update(b":");
        hasher.update(line.net_total_minor.to_string().as_bytes());
    }
    let digest = hasher.finalize();
    let mut uuid_hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut uuid_hex, "{b:02x}");
    }

    EtaEReceiptDraft {
        receipt_type: "S".to_string(),
        type_version: "1.2".to_string(),
        receipt_number: receipt_number.trim().to_string(),
        issued_at_ms,
        currency: "EGP".to_string(),
        subtotal_minor: lines_subtotal,
        discount_minor: invoice_discount_minor.max(0),
        tax_rate_bp: effective_bp,
        tax_minor,
        total_minor,
        payment_method_code: if payment_method_code.trim().is_empty() {
            "C".to_string()
        } else {
            payment_method_code.trim().to_string()
        },
        uuid_hex,
        lines,
    }
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

    #[test]
    fn remote_payload_round_trips() {
        let payload = format_remote_payload("سنتر بيتر", "RMT-9042");
        assert_eq!(payload, "MSHOP-REMOTE|v1|سنتر بيتر|RMT-9042");
        let parsed = parse_remote_payload(&payload).expect("valid remote payload");
        assert_eq!(parsed.0, "سنتر بيتر");
        assert_eq!(parsed.1, "RMT-9042");
        assert!(parse_remote_payload("MSHOP-REMOTE|v1|Shop|").is_none());
    }

    #[test]
    fn eta_ereceipt_draft_computes_deterministic_sha256_uuid_and_default_zero_vat() {
        let lines = vec![EtaEReceiptLine {
            item_code: "EG-2000000000015".to_string(),
            description: "شاحن سامسونج 25 وات".to_string(),
            quantity: 2,
            unit_price_minor: 45_000,
            discount_minor: 0,
            net_total_minor: 90_000,
        }];
        let d1 = build_eta_ereceipt_draft(
            "INV-20261019-0001",
            1_760_875_200_000,
            lines.clone(),
            5_000,
            false,
            1400,
            true,
            "C",
        );
        let d2 = build_eta_ereceipt_draft(
            "INV-20261019-0001",
            1_760_875_200_000,
            lines,
            5_000,
            false,
            1400,
            true,
            "C",
        );
        assert_eq!(d1.total_minor, 85_000);
        assert_eq!(d1.tax_minor, 0);
        assert_eq!(d1.uuid_hex.len(), 64);
        assert_eq!(d1.uuid_hex, d2.uuid_hex);
    }
}
