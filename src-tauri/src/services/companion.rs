//! Local Wi-Fi companion service & lightweight LAN HTTP responder (`ADR-037`, Plan item 3.2).
//!
//! No SQL queries live here; persistence goes through `data::repositories::settings::app_settings`.

use std::io::{Read, Write};
use std::net::{TcpListener, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::data::repositories::settings::app_settings as repo;
use crate::domain::companion::{
    format_pair_payload, format_remote_payload, CompanionScanItem, CompanionStatus, PairedDevice,
    COMPANION_DEVICES_KEY, COMPANION_PAIR_CODE_KEY, COMPANION_REMOTE_CODE_KEY,
    COMPANION_REMOTE_ENABLED_KEY, COMPANION_SCANS_KEY, DEFAULT_COMPANION_PORT,
};
use crate::domain::identity::{DomainError, Permission, Timestamp};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

static LAN_SERVER_RUNNING: AtomicBool = AtomicBool::new(false);

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
    "192.168.1.10".to_string()
}

/// Start the lightweight stateless LAN HTTP responder on `0.0.0.0:port` (best effort).
///
/// The mobile companion connects over the shop Wi-Fi without internet and holds no
/// database of its own (`ADR-016` #2, `ADR-037`).
pub fn spawn_lan_companion_listener(port: u16) {
    if LAN_SERVER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) else {
            return;
        };
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = [0u8; 1024];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");
            let is_ping = first_line.contains("/api/companion/ping");
            let (content_type, body) = if is_ping {
                (
                    "application/json; charset=utf-8",
                    format!(
                        "{{\"ok\":true,\"service\":\"mobile-shop-companion\",\"port\":{port},\"stateless\":true}}"
                    ),
                )
            } else {
                (
                    "text/html; charset=utf-8",
                    "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><title>مساعد المحل</title></head><body><h1>مساعد المحل متصل على شبكة Wi-Fi المحلية</h1><p>مفيش قاعدة بيانات على الموبايل — كل القراءة والحفظ من الكمبيوتر مباشرة.</p></body></html>".to_string(),
                )
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
}

fn default_devices(now_ms: i64) -> Vec<PairedDevice> {
    vec![
        PairedDevice {
            id: "dev-owner-1".to_string(),
            name: "موبايل بيتر".to_string(),
            model: "iPhone 15 Pro".to_string(),
            paired_at: now_ms - 7 * 86_400_000,
            last_seen_at: now_ms,
            online: true,
        },
        PairedDevice {
            id: "dev-seller-1".to_string(),
            name: "موبايل يوسف".to_string(),
            model: "Redmi Note 13".to_string(),
            paired_at: now_ms - 3 * 86_400_000,
            last_seen_at: now_ms - 300_000,
            online: true,
        },
    ]
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
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| default_devices(now_ms)),
        None => default_devices(now_ms),
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
    let last_remote_sync_at = if remote_enabled { Some(now_ms) } else { None };
    Ok(CompanionStatus {
        host_ip,
        port,
        pair_code,
        pair_payload,
        running: true,
        paired_devices: devices,
        pending_scans: scans,
        remote_enabled,
        remote_code,
        remote_payload,
        last_remote_sync_at,
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
            "Android Wi-Fi".to_string()
        } else {
            clean_model.to_string()
        },
        paired_at: now_ms,
        last_seen_at: now_ms,
        online: true,
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

