//! Local Wi-Fi companion, the phone capture link, optional remote owner
//! follow-up relay, and ETA e-Receipt sandbox payload builder
//! (`ADR-037`, `ADR-042`, `ADR-038`, `docs/PLAN.md` §15, §16, §18, §19).
//!
//! The desktop PC is the single source of truth (`ADR-016` #1, #2). The phone is
//! the capture device: it holds the camera, shows no pairing QR, and pushes a
//! draft of what it recorded to the desktop over the shop Wi-Fi (`0.0.0.0:8787`).
//! The phone keeps its own copy until the desktop acknowledges the push, which is
//! what lets the two machines be used one after the other rather than at the
//! same time (`ADR-042`). In Phase 4 the desktop also offers an optional
//! read-only remote follow-up relay for the owner outside the shop.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::identity::DomainError;
use crate::domain::shift::PaidFrom;

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
    /// True only while the responder really holds the port. A companion screen
    /// that claims the server is up without asking it is the bug `ADR-042` fixes.
    pub running: bool,
    pub paired_devices: Vec<PairedDevice>,
    pub pending_scans: Vec<CompanionScanItem>,
    /// Captures the phone pushed that the desktop has not applied yet (`ADR-042`).
    pub pending_intakes: Vec<CompanionIntakeDraft>,
    /// This device's own capture queue: on the phone it is what is waiting to be
    /// sent, on the desktop it stays empty (`ADR-042`).
    pub outbox: Vec<CompanionIntakeDraft>,
    /// Pushes the responder turned away because the pair code did not match.
    pub rejected_pushes: usize,
    pub remote_enabled: bool,
    pub remote_code: String,
    pub remote_payload: String,
    /// The computer this handset sends to, as it stored it (`ip:port`).
    ///
    /// Empty on a machine that has never been told to dial one. Without it the phone
    /// forgets its own address every time the screen is reopened, which is how a
    /// working link ends up described as «مش بقدر» (`ADR-043`).
    pub remote_host: String,
    /// Last moment data actually moved in either direction. The shell used to
    /// report "synced just now" from a checkbox; that field is gone (`ADR-042`).
    pub last_link_at: Option<i64>,
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

// ---------------------------------------------------------------------------
// The phone capture link (`ADR-042`)
// ---------------------------------------------------------------------------

/// How long a phone may be silent before the desktop stops calling it connected.
pub const ONLINE_WINDOW_MS: i64 = 30_000;
/// Photos one draft may carry. The desktop stores one cover image per product, so
/// a second photo is kept on the phone rather than thrown away silently.
pub const MAX_INTAKE_PHOTOS: usize = 3;
/// IMEIs one draft may carry.
pub const MAX_INTAKE_IMEIS: usize = 40;
/// Characters of product name the desktop accepts from a draft.
pub const MAX_INTAKE_NAME_CHARS: usize = 120;
/// Characters of barcode the desktop accepts from a draft.
pub const MAX_INTAKE_BARCODE_CHARS: usize = 64;
/// Largest `POST /api/companion/intake` body the responder will read.
pub const MAX_INTAKE_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Drafts the desktop holds before it asks the phone to wait.
pub const MAX_INTAKE_QUEUE: usize = 40;
/// Characters of expense category a phone may send (`ADR-043` uses the same 80 the
/// `expenses` table allows).
pub const MAX_EXPENSE_CATEGORY_CHARS: usize = 80;
/// Characters of expense note a phone may send.
pub const MAX_EXPENSE_NOTE_CHARS: usize = 300;
/// How long one HTTP hop to the shop computer may take before the phone gives up.
pub const LAN_REQUEST_TIMEOUT_MS: u64 = 2_500;

/// The desktop inbox, the phone outbox, the host the phone dials, and the names
/// the shop revoked. `ADR-037` put companion state in `app_settings` so this
/// slice needs no schema change either.
pub const COMPANION_INTAKES_KEY: &str = "companion.intakes_json";
pub const COMPANION_OUTBOX_KEY: &str = "companion.outbox_json";
pub const COMPANION_HOST_KEY: &str = "companion.host";
pub const COMPANION_HOST_CODE_KEY: &str = "companion.host_pair_code";
pub const COMPANION_BLOCKED_KEY: &str = "companion.blocked_json";
pub const COMPANION_LAST_LINK_KEY: &str = "companion.last_link_at";

/// True while a phone has been heard from inside `ONLINE_WINDOW_MS`.
///
/// `PairedDevice::online` is derived from this and never stored: a device that has
/// not spoken on the wire is not connected, whatever the pairing record claims.
pub fn is_online(last_seen_at: i64, now_ms: i64) -> bool {
    last_seen_at > 0 && now_ms >= last_seen_at && now_ms - last_seen_at <= ONLINE_WINDOW_MS
}

/// One capture made on the phone: an item, how many, what they cost, the IMEIs,
/// and a photo or two (`ADR-042`).
///
/// The same shape travels three ways: it is the body of `POST /api/companion/intake`,
/// the row of the desktop inbox, and the phone's own outbox entry until the desktop
/// acknowledges it. `product_id`/`receipt_id` are filled by the desktop when it
/// applies the draft; `pushed_at`/`push_error` by the phone when it sends it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompanionIntakeDraft {
    pub id: String,
    /// `"product"` or `"expense"`. Empty is a product: every draft written before
    /// expenses existed was one, and a stored queue must still read back (`ADR-043`).
    pub kind: String,
    /// The code the phone scanned. Checked by the responder against the shop's own.
    pub pair_code: String,
    pub device_name: String,
    pub created_at: i64,
    /// `"quantity"` or `"serialized"`, as `Disposition::as_str` writes it.
    pub disposition: String,
    pub product_name: String,
    pub barcode: String,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub imeis: Vec<String>,
    /// `data:` URLs, shrunk on the phone before they are sent.
    pub photos: Vec<String>,
    pub product_id: Option<String>,
    pub receipt_id: Option<String>,
    pub pushed_at: Option<i64>,
    pub push_error: Option<String>,
    /// Expense drafts only: the category as the shopkeeper typed it (`ADR-043`).
    /// `product_name` is left empty on those, so a reader can never confuse the two.
    pub expense_category: String,
    /// Expense drafts only: money in piastres, always positive.
    pub expense_amount_minor: i64,
    /// Expense drafts only: `"drawer"` or `"outside"`. Stated by the person who paid,
    /// checked here, and never defaulted.
    pub expense_paid_from: String,
    /// Expense drafts only: a free line explaining what the money bought.
    pub expense_note: String,
    /// What the desktop decided on its own: "only the first photo can be stored",
    /// or the reason a step was skipped. Shown verbatim so neither side pretends
    /// a partial apply was a complete one (`ADR-042`).
    pub note: Option<String>,
}

/// Why the responder refuses a draft before it queues anything.
///
/// The phone enforces the same rules in `src/screens/mobile/companion.ts` so the
/// form refuses locally; this is the wire guard behind it.
pub fn validate_intake_draft(draft: &CompanionIntakeDraft) -> Result<(), &'static str> {
    match draft_kind(draft) {
        Some(DraftKind::Expense) => validate_expense_draft(draft),
        Some(DraftKind::Product) => validate_product_draft(draft),
        None => Err("a draft is either a product capture or an expense"),
    }
}

/// What a draft is (`ADR-043`). Two kinds share one queue, one push and one inbox,
/// because to the shopkeeper there is one button: «ابعت».
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftKind {
    Product,
    Expense,
}

/// Read the kind. An empty field is a product (drafts stored before expenses
/// existed carry no `kind`); an unknown word is `None` rather than a guess — a typo
/// must not become stock, and a product must not become money that left the shop.
pub fn draft_kind(draft: &CompanionIntakeDraft) -> Option<DraftKind> {
    match draft.kind.trim() {
        "" | "product" => Some(DraftKind::Product),
        "expense" => Some(DraftKind::Expense),
        _ => None,
    }
}

/// Why an expense draft is refused before it queues anything (`ADR-043`).
fn validate_expense_draft(draft: &CompanionIntakeDraft) -> Result<(), &'static str> {
    if draft.device_name.trim().is_empty() {
        return Err("draft carries no device name");
    }
    if draft.expense_category.trim().is_empty() {
        return Err("draft carries no expense category");
    }
    if draft.expense_category.chars().count() > MAX_EXPENSE_CATEGORY_CHARS {
        return Err("expense category too long for a draft");
    }
    if draft.expense_amount_minor <= 0 {
        return Err("an expense draft must carry a positive amount");
    }
    if draft.expense_note.chars().count() > MAX_EXPENSE_NOTE_CHARS {
        return Err("expense note too long for a draft");
    }
    if PaidFrom::parse(draft.expense_paid_from.trim()).is_none() {
        return Err("an expense draft must say where its money came from");
    }
    if draft.photos.len() > MAX_INTAKE_PHOTOS {
        return Err("too many photos in one draft");
    }
    Ok(())
}

/// The product half of the same rules, unchanged from `ADR-042`.
fn validate_product_draft(draft: &CompanionIntakeDraft) -> Result<(), &'static str> {
    if draft.device_name.trim().is_empty() {
        return Err("draft carries no device name");
    }
    if draft.product_name.trim().is_empty() {
        return Err("draft carries no product name");
    }
    if draft.product_name.chars().count() > MAX_INTAKE_NAME_CHARS {
        return Err("product name too long for a draft");
    }
    if draft.barcode.chars().count() > MAX_INTAKE_BARCODE_CHARS {
        return Err("barcode too long for a draft");
    }
    if draft.quantity <= 0 || draft.quantity > 9_999 {
        return Err("quantity must be between 1 and 9999");
    }
    if draft.unit_cost_minor < 0 {
        return Err("a draft cannot carry a negative cost");
    }
    if draft.imeis.len() > MAX_INTAKE_IMEIS {
        return Err("too many IMEIs in one draft");
    }
    if draft.photos.len() > MAX_INTAKE_PHOTOS {
        return Err("too many photos in one draft");
    }
    if !matches!(draft.disposition.as_str(), "quantity" | "serialized") {
        return Err("a draft is either quantity-tracked or serialized");
    }
    if draft.disposition == "serialized" && draft.imeis.is_empty() {
        return Err("a serialized draft must carry at least one IMEI");
    }
    Ok(())
}

/// What the phone learns from `GET /api/companion/ping` (`ADR-042`).
///
/// The connection line on either screen is built from this, so it reports a round
/// trip that happened rather than a checkbox that was ticked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionProbe {
    pub ok: bool,
    pub latency_ms: u64,
    pub detail: String,
}

/// What stopped a capture reaching the ledger, or the ledger reaching the phone
/// (`ADR-042`).
///
/// `Domain` keeps the identity/storage code intact rather than flattening a dead
/// database into "your draft was refused". `Carried` does the same for the receive
/// and catalogue steps: an IMEI that already exists must arrive as the code that
/// says so, because the remedy is different.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionLinkError {
    /// The identity or storage layer answered; its code is what the shop sees.
    Domain(DomainError),
    /// A code from the receive or catalogue path this draft ended up on.
    Carried(&'static str),
    /// The phone has never scanned a pairing QR, so it has no computer to dial.
    NoHostConfigured,
    /// The desktop refused the draft's shape or its code.
    DraftRefused,
    /// The inbox no longer holds that draft: it was applied or rejected already.
    IntakeGone,
    /// Nothing in the draft can become a stock receipt.
    IntakeNotReceivable,
}

impl CompanionLinkError {
    /// The code that crosses the IPC boundary (`ADR-002`'s rule: codes travel,
    /// Arabic wording lives in the frontend).
    pub fn code(&self) -> &'static str {
        match self {
            CompanionLinkError::Domain(error) => error.code(),
            CompanionLinkError::Carried(code) => code,
            CompanionLinkError::NoHostConfigured => "COMPANION_NO_HOST",
            CompanionLinkError::DraftRefused => "COMPANION_INTAKE_REFUSED",
            CompanionLinkError::IntakeGone => "COMPANION_INTAKE_GONE",
            CompanionLinkError::IntakeNotReceivable => "COMPANION_INTAKE_NOT_RECEIVABLE",
        }
    }
}

impl From<DomainError> for CompanionLinkError {
    fn from(error: DomainError) -> Self {
        Self::Domain(error)
    }
}

impl std::fmt::Display for CompanionLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompanionLinkError::Domain(error) => write!(f, "{error}"),
            CompanionLinkError::Carried(code) => write!(f, "companion intake refused [{code}]"),
            CompanionLinkError::NoHostConfigured => {
                write!(f, "no shop computer configured on this phone")
            }
            CompanionLinkError::DraftRefused => write!(f, "capture draft refused [COMPANION_INTAKE_REFUSED]"),
            CompanionLinkError::IntakeGone => write!(f, "capture draft is no longer in the inbox"),
            CompanionLinkError::IntakeNotReceivable => {
                write!(f, "capture draft cannot become a stock receipt")
            }
        }
    }
}
