//! Local Wi-Fi companion service & the shop-LAN HTTP responder
//! (`ADR-037`, `ADR-042`, Plan item 3.2).
//!
//! No SQL queries live here; persistence goes through
//! `data::repositories::settings::app_settings`.
//!
//! The responder runs on a plain thread and holds no database handle on purpose:
//! a phone must be able to reach the shop computer without ever touching a session,
//! a token, or a write path. It therefore only *stages* what arrives, and the
//! desktop moves the stage into `app_settings` the next time somebody reads the
//! companion screen (`flush_lan_state`). That is also why a phone keeps its own
//! copy of a capture until the desktop acknowledges it: nothing is durable until
//! the machine that owns the data says so (`ADR-016` #2).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::data::repositories::settings::app_settings as repo;
use crate::domain::catalog::Disposition;
use crate::domain::catalog::ProductId;
use crate::domain::identity::{DomainError, Permission, Sensitivity, Session, Timestamp};
use crate::domain::unit::ReceiptKind;
use crate::services::catalog::images as image_use_cases;
use crate::services::catalog::product::{self as catalog_product, NewProduct};
use crate::services::catalog::CatalogContext;
use crate::services::inventory::stock as inventory_stock;
use crate::domain::companion::{
    format_pair_payload, format_remote_payload, is_online, validate_intake_draft,
    CompanionIntakeDraft, CompanionLinkError, CompanionProbe, CompanionScanItem,
    CompanionStatus, PairedDevice, COMPANION_BLOCKED_KEY, COMPANION_DEVICES_KEY,
    COMPANION_HOST_CODE_KEY, COMPANION_HOST_KEY, COMPANION_INTAKES_KEY,
    COMPANION_LAST_LINK_KEY, COMPANION_OUTBOX_KEY, COMPANION_PAIR_CODE_KEY,
    COMPANION_REMOTE_CODE_KEY, COMPANION_REMOTE_ENABLED_KEY, COMPANION_SCANS_KEY,
    DEFAULT_COMPANION_PORT, LAN_REQUEST_TIMEOUT_MS, MAX_INTAKE_QUEUE,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Port the responder actually holds, or `0` while it holds nothing (`ADR-042`).
static LAN_BOUND_PORT: AtomicU16 = AtomicU16::new(0);
/// Pushes the responder turned away because the pair code did not match.
static LAN_REJECTED_PUSHES: AtomicUsize = AtomicUsize::new(0);
/// `(shop name, pair code)` the desktop publishes for the responder to read.
static LAN_CREDENTIALS: OnceLock<Mutex<(String, String)>> = OnceLock::new();
/// Names the shop revoked: they may not register themselves again.
static LAN_BLOCKED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
/// `(device name, model, first heard)` since the last drain.
static LAN_HELLOS: OnceLock<Mutex<Vec<(String, String, i64)>>> = OnceLock::new();
/// Drafts accepted off the wire and not persisted yet.
static LAN_STAGED: OnceLock<Mutex<Vec<CompanionIntakeDraft>>> = OnceLock::new();

/// Take a companion static without ever panicking on a poisoned mutex: a lost
/// phone connection must not be able to take the desktop's UI down with it.
fn lan<T: Default>(slot: &OnceLock<Mutex<T>>) -> MutexGuard<'_, T> {
    slot.get_or_init(|| Mutex::new(T::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// True only while the responder really holds the port (`ADR-042`).
pub fn lan_server_running() -> bool {
    LAN_BOUND_PORT.load(Ordering::SeqCst) != 0
}

/// Publish what the responder needs in order to recognise this shop (`ADR-042`).
///
/// Reading the status is what refreshes this, so the responder never validates a
/// pair code the shop has already rotated.
pub fn set_lan_credentials(shop_name: &str, pair_code: &str) {
    let mut guard = lan(&LAN_CREDENTIALS);
    *guard = (shop_name.to_string(), pair_code.to_string());
}

/// The `(shop name, pair code)` the responder is accepting right now.
pub fn lan_credentials() -> (String, String) {
    lan(&LAN_CREDENTIALS).clone()
}

/// Snapshot of what the responder may use, read from the process globals.
fn lan_state() -> LanState {
    let (shop, pair_code) = lan(&LAN_CREDENTIALS).clone();
    LanState {
        shop,
        pair_code,
        blocked: lan(&LAN_BLOCKED).clone(),
        port: LAN_BOUND_PORT.load(Ordering::SeqCst),
        staged: lan(&LAN_STAGED).len(),
    }
}

/// Hand the desktop what the wire produced (`ADR-042`).
///
/// The responder's thread calls this; so does any caller that drives the routing
/// without opening a socket.
pub fn stage_lan_effect(effect: LanEffect) {
    match effect {
        LanEffect::Hello { name, model } => {
            let now_ms = Timestamp::now().as_millis();
            lan(&LAN_HELLOS).push((name, model, now_ms));
        }
        LanEffect::Intake(draft) => lan(&LAN_STAGED).push(draft),
    }
}

/// Pushes the responder refused for a wrong pair code since the process started.
pub fn lan_rejected_pushes() -> usize {
    LAN_REJECTED_PUSHES.load(Ordering::Relaxed)
}

fn note_blocked_device(name: &str) {
    let clean = name.trim();
    if clean.is_empty() {
        return;
    }
    let mut guard = lan(&LAN_BLOCKED);
    if !guard.iter().any(|n| n == clean) {
        guard.push(clean.to_string());
    }
}

fn is_blocked_device(name: &str) -> bool {
    let clean = name.trim();
    !clean.is_empty() && lan(&LAN_BLOCKED).iter().any(|n| n.trim() == clean)
}

fn set_blocked_devices(names: Vec<String>) {
    *lan(&LAN_BLOCKED) = names;
}

/// Detect the computer's local Wi-Fi / LAN IPv4 address without sending any packets.
pub fn detect_local_lan_ip() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("192.168.1.1:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip().to_string();
                if !ip.is_empty() && ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

/// Everything the responder is allowed to know: no database handle, no session,
/// no token (`ADR-042`).
///
/// It is passed in rather than read from globals so that the routing below is a
/// plain function: a test can hold a shop of its own, and two tests cannot reach
/// into each other's queue.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LanState {
    pub shop: String,
    pub pair_code: String,
    /// Names the shop revoked; they may not register themselves again.
    pub blocked: Vec<String>,
    pub port: u16,
    /// Drafts already waiting to be taken by the desktop.
    pub staged: usize,
}

impl LanState {
    fn accepts(&self, pair_code: &str) -> bool {
        !self.pair_code.is_empty() && pair_code == self.pair_code
    }

    fn is_blocked(&self, name: &str) -> bool {
        let clean = name.trim();
        !clean.is_empty() && self.blocked.iter().any(|n| n.trim() == clean)
    }
}

/// What a request asked the desktop to remember (`ADR-042`).
///
/// Returned rather than stored: the routing decision and the process-global queue
/// are two different jobs, and only the second one may block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanEffect {
    /// A handset introduced itself, so the shop's list of phones is built from
    /// this exchange and from nothing else.
    Hello { name: String, model: String },
    /// A capture arrived and has to be persisted by the desktop.
    Intake(CompanionIntakeDraft),
}

/// One request handed to the responder, with the headers already read off it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LanRequest {
    pub method: String,
    pub path: String,
    pub body: String,
    /// Set when the caller sent more bytes than `MAX_INTAKE_BODY_BYTES`.
    pub oversized: bool,
}

/// The responder's whole answer: a status, a content type, and a bounded body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl LanResponse {
    fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: body.into(),
        }
    }

    /// The wire form. CORS belongs here: a phone dials this server from a WebView
    /// origin, and without these headers its own browser refuses the POST.
    pub fn to_http(&self) -> String {
        format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.status,
            lan_reason(self.status),
            self.content_type,
            self.body.len(),
            self.body
        )
    }
}

fn lan_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        413 => "Content Too Large",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn json_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// The page a person sees when they open the address in a browser by hand.
const LAN_STUB_HTML: &str = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><title>مساعد المحل</title></head><body style=\"font-family:system-ui;padding:24px;line-height:1.7\"><h1>ده كمبيوتر المتجر على شبكة Wi-Fi</h1><p>الخدمة مستنية على البورت {port}. مفيش قاعدة بيانات هنا، ومفيش صفحة ربط — الكمبيوتر بيعرض باركود الربط جوه التطبيق، والموبايل هو اللي بيفتح الكاميرا.</p><p>لو بتفتح العنوان ده بالمتصفح فده تشخيص بس: الربط بيتم من جوه التطبيق.</p></body></html>";

/// Answer one LAN request and say what it should remember (`ADR-042`).
///
/// Four routes and nothing else: `ping` to prove the wire, `hello` to register a
/// phone, `intake` to hand a capture over, and `OPTIONS` because a WebView asks
/// first. No route reads or writes the shop's data, so there is no session and no
/// permission to check here — the pair code is the only thing a stranger on the
/// Wi-Fi would need, and the desktop is the one that decides what to apply.
pub fn handle_lan_request(req: &LanRequest, state: &LanState) -> (LanResponse, Option<LanEffect>) {
    let path = req.path.split('?').next().unwrap_or("/").to_string();
    let shop_json = serde_json::to_string(&state.shop).unwrap_or_else(|_| "\"\"".to_string());
    let port = state.port;
    if req.oversized {
        return (
            LanResponse::json(413, "{\"ok\":false,\"error\":\"body too large\"}"),
            None,
        );
    }
    let answer = |status: u16, body: &str| -> (LanResponse, Option<LanEffect>) {
        (LanResponse::json(status, body.to_string()), None)
    };
    match (req.method.as_str(), path.as_str()) {
        ("OPTIONS", _) => (LanResponse::json(204, String::new()), None),
        ("GET", "/api/companion/ping") => (
            LanResponse::json(
                200,
                format!(
                    "{{\"ok\":true,\"service\":\"mobile-shop-companion\",\"shop\":{shop_json},\"port\":{port},\"stateless\":true}}",
                ),
            ),
            None,
        ),
        ("POST", "/api/companion/hello") => {
            #[derive(serde::Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct Hello {
                pair_code: String,
                name: String,
                model: String,
            }
            let Ok(hello) = serde_json::from_str::<Hello>(&req.body) else {
                return answer(400, "{\"ok\":false,\"error\":\"bad json\"}");
            };
            if !state.accepts(&hello.pair_code) {
                return answer(401, "{\"ok\":false,\"error\":\"bad pair code\"}");
            }
            let name = hello.name.trim().to_string();
            if name.is_empty() {
                return answer(400, "{\"ok\":false,\"error\":\"no device name\"}");
            }
            if state.is_blocked(&name) {
                return answer(403, "{\"ok\":false,\"error\":\"this phone was unpaired\"}");
            }
            (
                LanResponse::json(200, format!("{{\"ok\":true,\"shop\":{shop_json}}}")),
                Some(LanEffect::Hello {
                    name,
                    model: hello.model.trim().to_string(),
                }),
            )
        }
        ("POST", "/api/companion/intake") => {
            let Ok(draft) = serde_json::from_str::<CompanionIntakeDraft>(&req.body) else {
                return answer(400, "{\"ok\":false,\"error\":\"bad json\"}");
            };
            if !state.accepts(&draft.pair_code) {
                return answer(401, "{\"ok\":false,\"error\":\"bad pair code\"}");
            }
            if let Err(reason) = validate_intake_draft(&draft) {
                return (
                    LanResponse::json(
                        400,
                        format!("{{\"ok\":false,\"error\":{}}}", json_str(reason)),
                    ),
                    None,
                );
            }
            if state.is_blocked(&draft.device_name) {
                return answer(403, "{\"ok\":false,\"error\":\"this phone was unpaired\"}");
            }
            if state.staged >= MAX_INTAKE_QUEUE {
                return answer(503, "{\"ok\":false,\"error\":\"inbox full\"}");
            }
            (
                LanResponse::json(
                    202,
                    format!("{{\"ok\":true,\"queued\":{}}}", state.staged + 1),
                ),
                Some(LanEffect::Intake(draft)),
            )
        }
        _ => (
            LanResponse {
                status: 200,
                content_type: "text/html; charset=utf-8",
                body: LAN_STUB_HTML.replace("{port}", &port.to_string()),
            },
            None,
        ),
    }
}

/// Read exactly one request off the socket: the header block, then the body the
/// caller announced. A phone pushing two photos is a bigger frame than the first
/// kilobyte, which is what this replaced (`ADR-042`).
///
/// Public so the framing can be driven over a real socket by a test rather than
/// trusted: this is the one place where a half-written request becomes a draft.
pub fn read_lan_request(stream: &mut TcpStream) -> Option<LanRequest> {
    stream
        .set_read_timeout(Some(Duration::from_millis(3_000)))
        .ok()?;
    let mut head: Vec<u8> = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    let mut finished = false;
    while head.len() < 16 * 1024 {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                head.push(byte[0]);
                if head.len() >= 4 && head[head.len() - 4..] == *b"\r\n\r\n" {
                    finished = true;
                    break;
                }
            }
        }
    }
    if !finished {
        return None;
    }
    let text = String::from_utf8_lossy(&head[..head.len() - 4]).to_string();
    let mut lines = text.lines();
    let mut words = lines.next().unwrap_or("").split_whitespace();
    let method = words.next()?.to_string();
    let path = words.next().unwrap_or("/").to_string();
    let mut announced = 0usize;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                announced = value.trim().parse().unwrap_or(usize::MAX);
            }
        }
    }
    if announced > crate::domain::companion::MAX_INTAKE_BODY_BYTES {
        return Some(LanRequest {
            method,
            path,
            body: String::new(),
            oversized: true,
        });
    }
    let mut body: Vec<u8> = Vec::new();
    while body.len() < announced {
        let mut chunk = [0u8; 16 * 1024];
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    Some(LanRequest {
        method,
        path,
        body: String::from_utf8_lossy(&body).to_string(),
        oversized: false,
    })
}

/// Start the shop-LAN responder on `0.0.0.0:port` (`ADR-037`, `ADR-042`).
///
/// Called from the desktop's setup hook only: a phone does not host a link, it
/// dials one. `lan_server_running` reports the bind, so a port already taken by
/// another program shows up as a stopped server instead of a working one.
/// What the socket loop does with one answer, kept out of the loop on purpose.
///
/// A refusal is counted where the wire saw it — the router stays a pure function of
/// its request and state — and the effect that has to be persisted is staged for the
/// desktop to drain on its next read. A test drives the same two lines without
/// opening a socket or starting a second process, which is how "a knocked door is
/// reported" is provable at all (`ADR-042`).
pub fn note_lan_response(response: &LanResponse, effect: Option<LanEffect>) {
    if response.status == 401 {
        LAN_REJECTED_PUSHES.fetch_add(1, Ordering::Relaxed);
    }
    if let Some(effect) = effect {
        stage_lan_effect(effect);
    }
}

pub fn spawn_lan_companion_listener(port: u16) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) else {
            return;
        };
        LAN_BOUND_PORT.store(port, Ordering::SeqCst);
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let Some(req) = read_lan_request(&mut stream) else {
                continue;
            };
            let state = lan_state();
            let (response, effect) = handle_lan_request(&req, &state);
            note_lan_response(&response, effect);
            let _ = stream.write_all(response.to_http().as_bytes());
            let _ = stream.flush();
        }
    });
}

async fn build_status(
    conn: &mut sqlx::SqliteConnection,
    now_ms: i64,
) -> Result<CompanionStatus, DomainError> {
    let appearance = repo::load_appearance(conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let pair_code = repo::get(conn, COMPANION_PAIR_CODE_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .unwrap_or_else(|| "PAIR-8787".to_string());
    let devices: Vec<PairedDevice> = match repo::get(conn, COMPANION_DEVICES_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        // A shop that has never paired a phone shows an empty list and the
        // instructions, not a pair of invented handsets (`ADR-042`).
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };
    let devices: Vec<PairedDevice> = devices
        .into_iter()
        .map(|mut device| {
            device.online = is_online(device.last_seen_at, now_ms);
            device
        })
        .collect();
    if let Ok(raw) = repo::get(conn, COMPANION_BLOCKED_KEY).await {
        set_blocked_devices(
            raw.and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
                .unwrap_or_default(),
        );
    }
    let pending_intakes: Vec<CompanionIntakeDraft> =
        match repo::get(conn, COMPANION_INTAKES_KEY)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
        {
            Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            None => Vec::new(),
        };
    let outbox: Vec<CompanionIntakeDraft> = match repo::get(conn, COMPANION_OUTBOX_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };
    let scans: Vec<CompanionScanItem> = match repo::get(conn, COMPANION_SCANS_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };
    let host_ip = detect_local_lan_ip();
    let port = DEFAULT_COMPANION_PORT;
    let pair_payload = format_pair_payload(&appearance.shop_name, &host_ip, port, &pair_code);
    let remote_enabled = repo::get(conn, COMPANION_REMOTE_ENABLED_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .map(|v| v == "on")
        .unwrap_or(false);
    let remote_code = repo::get(conn, COMPANION_REMOTE_CODE_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .unwrap_or_else(|| "RMT-9042".to_string());
    let remote_payload = format_remote_payload(&appearance.shop_name, &remote_code);
    // What the responder accepts is what this shop's own code is, so reading the
    // status is also what keeps the wire guard honest (`ADR-042`).
    set_lan_credentials(&appearance.shop_name, &pair_code);
    let last_link_at = repo::get(conn, COMPANION_LAST_LINK_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .and_then(|raw| raw.parse::<i64>().ok());
    Ok(CompanionStatus {
        host_ip,
        port,
        pair_code,
        pair_payload,
        running: lan_server_running(),
        paired_devices: devices,
        pending_scans: scans,
        pending_intakes,
        outbox,
        rejected_pushes: lan_rejected_pushes(),
        remote_enabled,
        remote_code,
        remote_payload,
        last_link_at,
    })
}

/// Read the LAN companion overview (paired devices, QR payload, pending scans).
pub async fn overview(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    flush_lan_state(&mut conn, &session.user_id().as_str(), now_ms).await?;
    build_status(&mut conn, now_ms).await
}

/// Pair a new mobile phone with the shop computer (`Permission::ManageCatalog` — owner).
pub async fn pair_device(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    name: &str,
    model: &str,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let current = build_status(&mut conn, now_ms).await?;
    let mut devices = current.paired_devices;
    let clean_name = name.trim();
    let clean_model = model.trim();
    devices.push(PairedDevice {
        id: Uuid::now_v7().to_string(),
        name: if clean_name.is_empty() {
            "موبايل المحل".to_string()
        } else {
            clean_name.to_string()
        },
        model: if clean_model.is_empty() {
            "مضاف يدويًا".to_string()
        } else {
            clean_model.to_string()
        },
        paired_at: now_ms,
        // Nothing has arrived from this handset on the wire yet, so the honest
        // answer is "not connected" until it says hello (`ADR-042`).
        last_seen_at: 0,
        online: false,
    });
    let json = serde_json::to_string(&devices).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_DEVICES_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms).await
}

/// Unpair a connected mobile phone (`Permission::ManageCatalog` — owner).
pub async fn unpair_device(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    device_id: &str,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let current = build_status(&mut conn, now_ms).await?;
    let removed: Vec<String> = current
        .paired_devices
        .iter()
        .filter(|d| d.id == device_id)
        .map(|d| d.name.clone())
        .collect();
    let devices: Vec<PairedDevice> = current
        .paired_devices
        .into_iter()
        .filter(|d| d.id != device_id)
        .collect();
    let json = serde_json::to_string(&devices).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_DEVICES_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    // Forgetting the record alone would be a decoration: the same handset says
    // hello again and reappears. Its name goes on the block list as well, so
    // "unpaired" means it has to be paired again by hand (`ADR-042`).
    if !removed.is_empty() {
        for name in &removed {
            note_blocked_device(name);
        }
        let blocked: Vec<String> = lan(&LAN_BLOCKED).clone();
        let blocked_json =
            serde_json::to_string(&blocked).map_err(|_| DomainError::StorageUnavailable)?;
        repo::set(
            &mut conn,
            COMPANION_BLOCKED_KEY,
            &blocked_json,
            &session.user_id().as_str(),
            now_ms,
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }
    build_status(&mut conn, now_ms).await
}

/// Push a barcode or 15-digit IMEI scanned on the companion phone to the desktop queue.
pub async fn push_scan(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    target: &str,
    code: &str,
    product_id: Option<String>,
    product_name: Option<String>,
    device_name: &str,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let current = build_status(&mut conn, now_ms).await?;
    let mut scans = current.pending_scans;
    scans.push(CompanionScanItem {
        id: Uuid::now_v7().to_string(),
        target: if target.trim() == "receive" {
            "receive".to_string()
        } else {
            "pos".to_string()
        },
        code: code.trim().to_string(),
        product_id,
        product_name,
        device_name: if device_name.trim().is_empty() {
            "موبايل المحل".to_string()
        } else {
            device_name.trim().to_string()
        },
        scanned_at: now_ms,
    });
    let json = serde_json::to_string(&scans).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_SCANS_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms).await
}

/// Consume and clear queued companion scans for a given target (`"pos"` or `"receive"`).
pub async fn consume_scans(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    target: &str,
) -> Result<Vec<CompanionScanItem>, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let current = build_status(&mut conn, now_ms).await?;
    let mut matched = Vec::new();
    let mut remaining = Vec::new();
    for item in current.pending_scans {
        if item.target == target.trim() {
            matched.push(item);
        } else {
            remaining.push(item);
        }
    }
    let json = serde_json::to_string(&remaining).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_SCANS_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(matched)
}

/// Enable or disable the optional read-only remote follow-up relay for the owner (`ADR-038`).
pub async fn set_remote_follow_up(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    enabled: bool,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let val = if enabled { "on" } else { "off" };
    repo::set(
        &mut conn,
        COMPANION_REMOTE_ENABLED_KEY,
        val,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms).await
}

/// Move what the responder accepted off the wire into the shop's own settings.
///
/// The responder thread holds no database handle, so this is the moment a phone's
/// capture becomes durable. A draft the inbox already carries is answered as a
/// duplicate instead of queued twice, which is what lets the phone retry safely
/// after the Wi-Fi dropped mid-push (`ADR-042`).
async fn flush_lan_state(
    conn: &mut sqlx::SqliteConnection,
    actor: &str,
    now_ms: i64,
) -> Result<usize, DomainError> {
    let hellos: Vec<(String, String, i64)> = {
        let mut guard = lan(&LAN_HELLOS);
        std::mem::take(&mut *guard)
    };
    let staged: Vec<CompanionIntakeDraft> = {
        let mut guard = lan(&LAN_STAGED);
        if guard.is_empty() && hellos.is_empty() {
            return Ok(0);
        }
        std::mem::take(&mut *guard)
    };
    let mut touched = false;
    let mut accepted = 0usize;

    if !hellos.is_empty() {
        let raw = repo::get(conn, COMPANION_DEVICES_KEY)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        let mut devices: Vec<PairedDevice> = raw
            .and_then(|value| serde_json::from_str::<Vec<PairedDevice>>(&value).ok())
            .unwrap_or_default();
        for (name, model, heard_at) in &hellos {
            if is_blocked_device(name) {
                continue;
            }
            match devices.iter_mut().find(|device| &device.name == name) {
                Some(known) => {
                    if *heard_at > known.last_seen_at {
                        known.last_seen_at = *heard_at;
                    }
                    if !model.is_empty() && model != &known.model {
                        known.model = model.clone();
                    }
                }
                None => devices.push(PairedDevice {
                    id: Uuid::now_v7().to_string(),
                    name: name.clone(),
                    model: if model.is_empty() {
                        "موبايل على Wi-Fi المتجر".to_string()
                    } else {
                        model.clone()
                    },
                    paired_at: *heard_at,
                    last_seen_at: *heard_at,
                    online: true,
                }),
            }
            touched = true;
        }
        let json = serde_json::to_string(&devices).map_err(|_| DomainError::StorageUnavailable)?;
        repo::set(conn, COMPANION_DEVICES_KEY, &json, actor, now_ms)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    if !staged.is_empty() {
        let raw = repo::get(conn, COMPANION_INTAKES_KEY)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        let mut queue: Vec<CompanionIntakeDraft> = raw
            .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
            .unwrap_or_default();
        let mut overflow: Vec<CompanionIntakeDraft> = Vec::new();
        for draft in staged {
            if queue.iter().any(|queued| queued.id == draft.id) {
                continue;
            }
            if queue.len() >= MAX_INTAKE_QUEUE {
                overflow.push(draft);
                continue;
            }
            queue.push(draft);
            accepted += 1;
        }
        if accepted > 0 {
            touched = true;
            let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
            repo::set(conn, COMPANION_INTAKES_KEY, &json, actor, now_ms)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
        }
        if !overflow.is_empty() {
            lan(&LAN_STAGED).extend(overflow);
        }
    }

    if touched {
        repo::set(
            conn,
            COMPANION_LAST_LINK_KEY,
            &now_ms.to_string(),
            actor,
            now_ms,
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }
    Ok(accepted)
}

/// Give the shop a fresh pair code (`ADR-042`).
///
/// A phone that leaves the building keeps a saved address, and the only thing that
/// stops it pushing to the shop afterwards is the code inside the QR. Rotating it
/// means every handset currently configured has to scan the new one: that is the
/// point, and the panel says so before it does it.
pub async fn rotate_pair_code(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<CompanionStatus, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let suffix: String = Uuid::now_v7()
        .simple()
        .to_string()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .collect();
    let code = format!("PAIR-{}", suffix.to_uppercase());
    repo::set(
        &mut conn,
        COMPANION_PAIR_CODE_KEY,
        &code,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    let appearance = repo::load_appearance(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    set_lan_credentials(&appearance.shop_name, &code);
    build_status(&mut conn, now_ms).await
}

// ---------------------------------------------------------------------------
// The phone side of the link (`ADR-042`)
//
// Everything below this line is symmetric with the responder above: the desktop
// stages what it receives, the phone keeps what it has not managed to send. The
// HTTP client is hand-rolled for the same reason the server is — the shop LAN is
// the only network either machine needs, and a dependency bought for it would be
// a second way to be wrong.
// ---------------------------------------------------------------------------

/// One HTTP hop to the shop computer. Blocking by design: the caller runs it on a
/// blocking thread so a silent laptop never occupies the async executor.
fn lan_http(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    use std::net::ToSocketAddrs;

    let unreachable = "الكمبيوتر ما ردّش — اتأكد إنه مفتوح، وأن الموبايل على نفس Wi-Fi المتجر";
    let mut addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "عنوان الكمبيوتر مش معروف".to_string())?;
    let address = addresses
        .next()
        .ok_or_else(|| "عنوان الكمبيوتر ناقص بورت".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(LAN_REQUEST_TIMEOUT_MS))
        .map_err(|_| unreachable.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(LAN_REQUEST_TIMEOUT_MS)))
        .ok();
    let request = match body {
        Some(payload) => format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://{host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        ),
        None => format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://{host}:{port}\r\nConnection: close\r\n\r\n"
        ),
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|_| unreachable.to_string())?;
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8 * 1024];
    while raw.len() < 256 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => raw.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    if raw.is_empty() {
        return Err(unreachable.to_string());
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, response_body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "الكمبيوتر رد بحاجة مش مفهومة".to_string())?;
    Ok((status, response_body.to_string()))
}

/// Pull the one field the responder explains itself with.
fn lan_error_text(response: &str) -> String {
    serde_json::from_str::<serde_json::Value>(response)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|field| field.as_str())
                .map(str::to_string)
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "الكمبيوتر رفض من غير سبب".to_string())
}

/// `ip:port` exactly as the pairing payload carries it.
pub fn split_host_address(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.trim().rsplit_once(':')?;
    let port = port.trim().parse::<u16>().ok()?;
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

/// Ask the shop computer whether *this program* is answering (`ADR-042`).
///
/// Latency is reported because a slow answer and no answer are different problems
/// for the person standing in the shop with a phone in their hand.
pub fn lan_probe(host: &str, port: u16) -> CompanionProbe {
    let started = std::time::Instant::now();
    let outcome = lan_http(host, port, "GET", "/api/companion/ping", None);
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok((200, body)) if body.contains("mobile-shop-companion") => CompanionProbe {
            ok: true,
            latency_ms,
            detail: "كمبيوتر المتجر رد".to_string(),
        },
        Ok((200, _)) => CompanionProbe {
            ok: false,
            latency_ms,
            detail: "في خدمة تانية على البورت ده — الرد مش من برنامج المتجر".to_string(),
        },
        Ok((_status, _)) => CompanionProbe {
            ok: false,
            latency_ms,
            detail: "الكمبيوتر رد بردّ مش مفهوم — البرنامج اللي على البورت ده مش برنامج المتجر.".to_string(),
        },
        Err(detail) => CompanionProbe {
            ok: false,
            latency_ms,
            detail,
        },
    }
}

/// The one call a phone makes when it is told which computer it belongs to: prove
/// the wire works, then introduce itself (`ADR-042`).
///
/// The address is saved on the phone whether or not the computer answers, because
/// a shop owner pairs the handset in the morning with the PC still in a drawer, and
/// the push is what has to wait. What the panel reports is the handshake, not hope.
pub fn lan_introduce(
    address: &str,
    pair_code: &str,
    device_name: &str,
    device_model: &str,
) -> CompanionProbe {
    let Some((host, port)) = split_host_address(address) else {
        return CompanionProbe {
            ok: false,
            latency_ms: 0,
            detail: "عنوان الكمبيوتر مكتوبش صح".to_string(),
        };
    };
    let probe = lan_probe(&host, port);
    if !probe.ok {
        return probe;
    }
    match lan_hello(&host, port, pair_code, device_name, device_model) {
        Ok(()) => CompanionProbe {
            ok: true,
            latency_ms: probe.latency_ms,
            detail: format!("{} — والموبايل اتسجّل عنده", probe.detail),
        },
        Err(reason) => CompanionProbe {
            ok: false,
            latency_ms: probe.latency_ms,
            detail: reason,
        },
    }
}

/// Register this handset with the shop computer (`ADR-042`).
///
/// This is what puts a name on the desktop's connected list: a phone is paired
/// because it spoke with the right code, not because somebody typed it in.
pub fn lan_hello(host: &str, port: u16, pair_code: &str, name: &str, model: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "pairCode": pair_code,
        "name": name,
        "model": model,
    })
    .to_string();
    let (status, response) = lan_http(host, port, "POST", "/api/companion/hello", Some(&body))?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(lan_error_text(&response))
}

/// Hand one captured draft to the shop computer (`ADR-042`).
fn lan_push_draft(host: &str, port: u16, draft: &CompanionIntakeDraft) -> Result<(), String> {
    let body = serde_json::to_string(draft)
        .map_err(|_| "المسودة ما اتكتبش بشكل سليم".to_string())?;
    let (status, response) = lan_http(host, port, "POST", "/api/companion/intake", Some(&body))?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(lan_error_text(&response))
}

/// What this phone is about to send: where to send it, and what is waiting.
pub struct PendingPush {
    pub host: String,
    pub port: u16,
    pub pair_code: String,
    pub drafts: Vec<CompanionIntakeDraft>,
}

/// The code and address this phone was pointed at, or `None` when it never scanned
/// a pairing QR (`ADR-042`).
async fn host_target(
    conn: &mut sqlx::SqliteConnection,
) -> Result<Option<(String, u16, String)>, DomainError> {
    let Some(raw_host) = repo::get(conn, COMPANION_HOST_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    else {
        return Ok(None);
    };
    let pair_code = repo::get(conn, COMPANION_HOST_CODE_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .unwrap_or_default();
    let Some((host, port)) = split_host_address(&raw_host) else {
        return Ok(None);
    };
    Ok(Some((host, port, pair_code)))
}

/// Remember which computer this phone sends its captures to (`ADR-042`).
///
/// `host` is the `ip:port` from the scanned payload, so the phone stores what it
/// read rather than what a person retyped from a screen.
pub async fn save_host(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    host: &str,
    pair_code: &str,
) -> Result<CompanionStatus, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if split_host_address(host).is_none() || pair_code.trim().is_empty() {
        return Err(CompanionLinkError::NoHostConfigured);
    }
    repo::set(
        &mut conn,
        COMPANION_HOST_KEY,
        host.trim(),
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_HOST_CODE_KEY,
        pair_code.trim(),
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)
}

/// Check the operator may dial the shop computer, before any socket is opened.
pub async fn authorize_probe(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<(), DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)
}

/// Every capture this phone made that the desktop has not taken yet.
pub async fn outbox_pending(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Option<PendingPush>, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let Some((host, port, pair_code)) = host_target(&mut conn).await? else {
        return Err(CompanionLinkError::NoHostConfigured);
    };
    let raw = repo::get(&mut conn, COMPANION_OUTBOX_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let drafts: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|draft| draft.pushed_at.is_none())
        .map(|mut draft| {
            // The stamp is the code the shop uses today, so rotating it and
            // rescanning the QR fixes a whole waiting queue at once (`ADR-042`).
            draft.pair_code = pair_code.clone();
            draft
        })
        .collect();
    if drafts.is_empty() {
        return Ok(None);
    }
    Ok(Some(PendingPush {
        host,
        port,
        pair_code,
        drafts,
    }))
}

/// Send the queue. Kept free of the pool so it can run on a blocking thread.
pub fn push_pending(pending: PendingPush) -> Vec<(String, Result<(), String>)> {
    let PendingPush {
        host,
        port,
        pair_code: _pair_code,
        drafts,
    } = pending;
    let mut results = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let outcome = lan_push_draft(&host, port, &draft);
        results.push((draft.id, outcome));
    }
    results
}

/// Write back what the wire said (`ADR-042`).
///
/// A delivered draft is marked with the time it left, not with a claim that it is
/// in the ledger: the desktop decides that, and the phone has no business saying
/// otherwise.
pub async fn record_push_results(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    results: Vec<(String, Result<(), String>)>,
) -> Result<CompanionStatus, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let raw = repo::get(&mut conn, COMPANION_OUTBOX_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let mut queue: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default();
    let mut delivered = 0usize;
    for draft in &mut queue {
        let Some((_, outcome)) = results.iter().find(|(id, _)| id == &draft.id) else {
            continue;
        };
        match outcome {
            Ok(()) => {
                if draft.pushed_at.is_none() {
                    delivered += 1;
                }
                draft.pushed_at = Some(now_ms);
                draft.push_error = None;
            }
            Err(detail) => {
                draft.push_error = Some(detail.clone());
            }
        }
    }
    let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_OUTBOX_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    if delivered > 0 {
        repo::set(
            &mut conn,
            COMPANION_LAST_LINK_KEY,
            &now_ms.to_string(),
            &session.user_id().as_str(),
            now_ms,
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }
    build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)
}

/// Put one capture into this device's outbox (`ADR-042`).
///
/// The phone never edits its own catalogue with a capture: the item only becomes
/// real on the computer that owns the ledger. So this writes a queue row and
/// nothing else, which is also why the helper needs no schema of its own.
pub async fn save_capture(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    draft: &CompanionIntakeDraft,
) -> Result<CompanionStatus, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    validate_intake_draft(draft).map_err(|_| CompanionLinkError::DraftRefused)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let mut stored = draft.clone();
    if stored.id.trim().is_empty() {
        stored.id = Uuid::now_v7().to_string();
    }
    stored.created_at = now_ms;
    stored.pushed_at = None;
    stored.push_error = None;
    stored.product_id = None;
    stored.receipt_id = None;
    stored.note = None;
    let raw = repo::get(&mut conn, COMPANION_OUTBOX_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let mut queue: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default();
    queue.retain(|existing| existing.id != stored.id);
    queue.insert(0, stored);
    // Captures the computer already took are history rather than a backlog: the
    // newest ten stay so the list can be read after a push, while a queue whose
    // *waiting* rows have grown past the limit is refused instead of trimmed —
    // dropping an unsent capture would be the worse outcome (`ADR-042`).
    if queue
        .iter()
        .filter(|draft| draft.pushed_at.is_none())
        .count()
        > MAX_INTAKE_QUEUE
    {
        return Err(CompanionLinkError::DraftRefused);
    }
    let mut delivered = 0usize;
    queue.retain(|draft| {
        if draft.pushed_at.is_some() {
            delivered += 1;
            delivered <= 10
        } else {
            true
        }
    });
    let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_OUTBOX_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)
}

/// Drop the delivered part of this phone's queue (`ADR-042`).
pub async fn clear_outbox(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<CompanionStatus, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let raw = repo::get(&mut conn, COMPANION_OUTBOX_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let queue: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|draft| draft.pushed_at.is_none())
        .collect();
    let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_OUTBOX_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)
}

/// The item a draft belongs to: the one it names, the one its barcode matches, or
/// a new one — created with `Disposition` from the draft and no price, because a
/// capture is not a price list (`ADR-042`).
async fn product_for_draft(
    catalog: &CatalogContext,
    session: &Session,
    draft: &CompanionIntakeDraft,
) -> Result<String, CompanionLinkError> {
    if let Some(existing) = draft
        .product_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(existing.to_string());
    }
    let barcode = draft.barcode.trim();
    if !barcode.is_empty() {
        if let Ok(found) = catalog_product::find_by_barcode(catalog, session, barcode).await {
            return Ok(found.id.as_str());
        }
    }
    let disposition = Disposition::parse(&draft.disposition)
        .ok_or(CompanionLinkError::IntakeNotReceivable)?;
    let created = catalog_product::create(
        catalog,
        session,
        NewProduct {
            name: draft.product_name.trim().to_string(),
            disposition,
            barcode: (!barcode.is_empty()).then(|| barcode.to_string()),
            sale_price_minor: None,
            category: None,
        },
    )
    .await
    .map_err(|error| CompanionLinkError::Carried(error.code()))?;
    Ok(created.id.as_str())
}

/// Apply one inbox draft: the item, the receipt, the IMEIs, the cover photo.
///
/// The receive goes through `ADR-019`'s audited path rather than a companion one,
/// so a phone capture cannot smuggle stock into the ledger without the ordinary
/// checks. When the receipt fails the draft keeps the product it created, so a
/// second attempt does not invent the item twice (`ADR-042`).
pub async fn accept_intake(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    catalog: &CatalogContext,
    data_dir: &Path,
    intake_id: &str,
) -> Result<(CompanionStatus, CompanionIntakeDraft), CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let raw = repo::get(&mut conn, COMPANION_INTAKES_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let mut queue: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default();
    let Some(position) = queue.iter().position(|draft| draft.id == intake_id) else {
        return Err(CompanionLinkError::IntakeGone);
    };
    let draft = queue[position].clone();
    if !matches!(draft.disposition.as_str(), "quantity" | "serialized") {
        return Err(CompanionLinkError::IntakeNotReceivable);
    }

    let product_id = product_for_draft(catalog, &session, &draft).await?;
    queue[position].product_id = Some(product_id.clone());

    let mut note: Option<String> = None;
    if let Some(uuid) = Uuid::parse_str(&product_id).ok() {
        let photo_count = draft.photos.len();
        if let Some(first) = draft.photos.first() {
            if let Err(error) = image_use_cases::set_image(
                pool,
                tokens,
                data_dir,
                ProductId::from_uuid(uuid),
                first,
            )
            .await
            {
                // A photo is a bonus on a receipt. Failing the stock over it would
                // be the worse lie, so the reason is written down instead.
                note = Some(format!(
                    "الصورة ما اتخزنتش على الصنف — كود الخطأ: {}",
                    error.code()
                ));
            }
        }
        if photo_count > 1 {
            // The number of leftovers is the phone's business; the shop only needs
            // to know the cover took the first one and the rest stayed where they were.
            let extra =
                "أول صورة بس هي اللي بتتخزن كغلاف على الكمبيوتر — الباقي فاضل على الموبايل".to_string();
            note = Some(match note {
                Some(existing) => format!("{existing} — والصور التانية فاضلة على الموبايل"),
                None => extra,
            });
        }
    }

    inventory_stock::receive_with_units(
        pool,
        tokens,
        &product_id,
        draft.quantity,
        draft.unit_cost_minor,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &draft.imeis,
    )
    .await
    .map_err(|error| CompanionLinkError::Carried(error.code()))?;

    queue.remove(position);
    let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_INTAKES_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_LAST_LINK_KEY,
        &now_ms.to_string(),
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let mut applied = draft;
    applied.product_id = Some(product_id);
    applied.note = note;
    applied.pushed_at = Some(now_ms);
    let status = build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)?;
    Ok((status, applied))
}

/// Refuse one inbox draft without applying it (`ADR-042`).
///
/// The phone is not told: it already learned that the computer received the draft,
/// which is the only thing its own queue can honestly record.
pub async fn reject_intake(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    intake_id: &str,
) -> Result<CompanionStatus, CompanionLinkError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now_ms = Timestamp::now().as_millis();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let raw = repo::get(&mut conn, COMPANION_INTAKES_KEY)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let queue: Vec<CompanionIntakeDraft> = raw
        .and_then(|value| serde_json::from_str::<Vec<CompanionIntakeDraft>>(&value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|draft| draft.id != intake_id)
        .collect();
    let json = serde_json::to_string(&queue).map_err(|_| DomainError::StorageUnavailable)?;
    repo::set(
        &mut conn,
        COMPANION_INTAKES_KEY,
        &json,
        &session.user_id().as_str(),
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    build_status(&mut conn, now_ms)
        .await
        .map_err(CompanionLinkError::from)
}
