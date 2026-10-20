//! Integration tests for the LAN companion server & mobile helper (`ADR-037`, Plan item 3.2).

use std::io::{Read, Write};
use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::companion::{
    parse_pair_payload, parse_remote_payload, DEFAULT_COMPANION_PORT,
};
use mobile_shop_system_lib::domain::identity::Role;
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::companion::{self, LanEffect, LanRequest, LanState};
use mobile_shop_system_lib::services::inventory;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::settings;
use sqlx::SqlitePool;

async fn signed_in_manager() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    (pool, tokens)
}

#[tokio::test]
async fn companion_overview_pairing_and_scan_queue_respect_roles_and_settings_snapshot() {
    let (pool, tokens) = signed_in_manager().await;

    let initial = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("overview");
    assert_eq!(initial.port, DEFAULT_COMPANION_PORT);
    // The status is read from the world, not asserted by the code: no responder is
    // listening inside an in-memory test, and a shop that has never paired a phone
    // has an empty list rather than two invented handsets (`ADR-042`).
    assert!(!initial.running);
    assert!(initial.paired_devices.is_empty());
    assert!(initial.pending_intakes.is_empty());
    assert!(initial.outbox.is_empty());
    assert_eq!(initial.last_link_at, None);
    let parsed = parse_pair_payload(&initial.pair_payload).expect("valid QR payload");
    assert_eq!(parsed.2, DEFAULT_COMPANION_PORT);
    assert!(!initial.remote_enabled);
    let parsed_remote = parse_remote_payload(&initial.remote_payload).expect("valid remote QR");
    assert_eq!(parsed_remote.1, initial.remote_code);

    // Owner pairs a third phone.
    let paired = companion::pair_device(&pool, tokens.as_ref(), "موبايل مينا", "Galaxy A55")
        .await
        .expect("owner pairs device");
    assert_eq!(paired.paired_devices.len(), 1);
    assert!(
        !paired.paired_devices[0].online,
        "typing a phone in records it; only the wire can connect it"
    );
    let added_id = paired
        .paired_devices
        .iter()
        .find(|d| d.name == "موبايل مينا")
        .expect("added device")
        .id
        .clone();

    // Create and sign in as a seller: seller can read overview and push/consume scans,
    // but cannot pair or unpair devices (`Permission::ManageCatalog`).
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let manager = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("manager");
    let seller = users::create_user(&pool, &manager, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("create seller");
    auth::login(&pool, tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("seller login");

    let refused_pair =
        companion::pair_device(&pool, tokens.as_ref(), "موبايل خارجي", "Pixel").await;
    assert_eq!(
        refused_pair.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    let refused_unpair = companion::unpair_device(&pool, tokens.as_ref(), &added_id).await;
    assert_eq!(
        refused_unpair.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    let refused_remote = companion::set_remote_follow_up(&pool, tokens.as_ref(), true).await;
    assert_eq!(
        refused_remote.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );

    // Seller pushes one scan to POS and one scan to Receive.
    let after_pos_scan = companion::push_scan(
        &pool,
        tokens.as_ref(),
        "pos",
        "356789104210348",
        Some("prod-1".to_string()),
        Some("Samsung Galaxy A55".to_string()),
        "موبايل يوسف",
    )
    .await
    .expect("seller pushes POS scan");
    assert_eq!(after_pos_scan.pending_scans.len(), 1);

    let after_recv_scan = companion::push_scan(
        &pool,
        tokens.as_ref(),
        "receive",
        "6221234560012",
        Some("prod-2".to_string()),
        Some("شاحن Anker 20W".to_string()),
        "موبايل يوسف",
    )
    .await
    .expect("seller pushes receive scan");
    assert_eq!(after_recv_scan.pending_scans.len(), 2);

    // Consuming POS scans leaves the receive scan intact.
    let pos_scans = companion::consume_scans(&pool, tokens.as_ref(), "pos")
        .await
        .expect("consume pos scans");
    assert_eq!(pos_scans.len(), 1);
    assert_eq!(pos_scans[0].code, "356789104210348");

    let recv_scans = companion::consume_scans(&pool, tokens.as_ref(), "receive")
        .await
        .expect("consume receive scans");
    assert_eq!(recv_scans.len(), 1);
    assert_eq!(recv_scans[0].code, "6221234560012");

    // Sign back in as manager to unpair the added phone and verify `settings::read_snapshot`.
    let manager_id = manager.user_id();
    auth::login(&pool, tokens.as_ref(), manager_id, PASSWORD)
        .await
        .expect("manager login");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate manager");

    let after_unpair = companion::unpair_device(&pool, tokens.as_ref(), &added_id)
        .await
        .expect("owner unpairs device");
    assert!(after_unpair.paired_devices.is_empty());

    let after_remote = companion::set_remote_follow_up(&pool, tokens.as_ref(), true)
        .await
        .expect("owner enables remote follow-up");
    assert!(after_remote.remote_enabled);
    // `ADR-038`'s relay is a switch, not a sync. Flipping it used to report "last
    // synced just now"; nothing has moved, so nothing may be timed (`ADR-042`).
    assert_eq!(after_remote.last_link_at, None);

    // --- the phone capture link (`ADR-042`) -----------------------------------
    //
    // Reading the status is what publishes this shop's credentials to the
    // responder, so the routes below are driven as the wire would drive them —
    // with no socket, no second process, and no invented state in between.
    let shop = LanState {
        shop: "متجر الاختبار".to_string(),
        pair_code: after_remote.pair_code.clone(),
        blocked: vec!["موبايل مينا".to_string()],
        port: DEFAULT_COMPANION_PORT,
        staged: 0,
    };
    let hello = |body: String| {
        companion::handle_lan_request(
            &LanRequest {
                method: "POST".to_string(),
                path: "/api/companion/hello".to_string(),
                body,
                oversized: false,
            },
            &shop,
        )
    };

    // A name the shop revoked stays revoked even with the right code.
    let (refused, _) = hello(format!(
        r#"{{"pairCode":"{}","name":"موبايل مينا","model":"Galaxy A55"}}"#,
        shop.pair_code
    ));
    assert_eq!(refused.status, 403, "unpairing must mean something");

    // A stranger guessing a code is refused, and the shop is told it was tried.
    let (knock, _) = hello(r#"{"pairCode":"PAIR-GUESS","name":"موبايل غريب"}"#.to_string());
    assert_eq!(knock.status, 401);
    let counted = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("status after a wrong code");
    assert!(
        counted.rejected_pushes >= 1,
        "a knocked door is reported, not swallowed"
    );

    // The owner's own handset arrives: that is the only reason it appears.
    let (greeted, effect) = hello(format!(
        r#"{{"pairCode":"{}","name":"موبايل بيتر","model":"Pixel 8"}}"#,
        shop.pair_code
    ));
    assert_eq!(greeted.status, 200);
    companion::stage_lan_effect(effect.expect("the hello is remembered"));
    let seen = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("status after a hello");
    assert_eq!(seen.paired_devices.len(), 1);
    assert_eq!(seen.paired_devices[0].name, "موبايل بيتر");
    assert_eq!(seen.paired_devices[0].model, "Pixel 8");
    assert!(seen.paired_devices[0].online, "it spoke a moment ago");
    assert!(seen.last_link_at.is_some(), "data moved, so the link has a time");

    // A capture pushed from the phone: named by barcode, serialized, one IMEI.
    let barcode_body = "6221234560011".to_string();
    let draft_json = serde_json::json!({
        "id": "intake-lifecycle",
        "pairCode": shop.pair_code,
        "deviceName": "موبايل بيتر",
        "createdAt": 1,
        "disposition": "serialized",
        "productName": "آيفون ١٤ برو ماكس",
        "barcode": barcode_body,
        "quantity": 1,
        "unitCostMinor": 780_000,
        "imeis": ["356938035643809"],
        "photos": [],
    })
    .to_string();
    let intake = |body: String, staged: usize| {
        companion::handle_lan_request(
            &LanRequest {
                method: "POST".to_string(),
                path: "/api/companion/intake".to_string(),
                body,
                oversized: false,
            },
            &LanState { staged, ..shop.clone() },
        )
    };
    let (taken, effect) = intake(draft_json.clone(), 0);
    assert_eq!(taken.status, 202, "the desktop took the capture");
    companion::stage_lan_effect(effect.expect("the draft is queued for the desktop"));
    let inbox = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("inbox after a push");
    assert_eq!(inbox.pending_intakes.len(), 1);
    assert_eq!(inbox.pending_intakes[0].product_name, "آيفون ١٤ برو ماكس");
    assert!(inbox.pending_intakes[0].pushed_at.is_none());

    // Applying it is ordinary, audited receiving work (`ADR-019`): the item, the
    // receipt, and the IMEI, none of it written by a companion-only path.
    let data_dir = std::env::temp().join(format!("mshop-intake-{}", std::process::id()));
    std::fs::create_dir_all(&data_dir).expect("temporary data directory");
    let catalog = CatalogContext::new(pool.clone(), tokens.clone());
    let (after_apply, applied) =
        companion::accept_intake(&pool, tokens.as_ref(), &catalog, &data_dir, "intake-lifecycle")
            .await
            .expect("the draft became a receipt");
    assert!(
        after_apply.pending_intakes.is_empty(),
        "the inbox emptied when the receipt was written"
    );
    let product_id = applied.product_id.clone().expect("the draft names its product");
    let units = inventory::list_units_in_stock(&pool, tokens.as_ref(), &product_id)
        .await
        .expect("units in stock");
    assert_eq!(units.len(), 1, "the IMEI the phone typed is on the shelf");
    assert_eq!(units[0].imei, "356938035643809");
    assert_eq!(units[0].unit_cost_minor, 780_000);

    // Rotating the code is the lock-out: every handset configured until now has
    // to read the new QR before it can push again.
    let rotated = companion::rotate_pair_code(&pool, tokens.as_ref())
        .await
        .expect("rotated pair code");
    assert_ne!(rotated.pair_code, shop.pair_code);
    let (stale, none) = intake(draft_json, 0);
    assert_eq!(stale.status, 401, "an old QR stops working at once");
    assert!(none.is_none(), "a refused draft queues nothing");
    let after_rotate = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("status after rotation");
    assert!(
        after_rotate.pending_intakes.is_empty(),
        "the refused draft did not sneak into the inbox"
    );

    // A draft may be refused without touching the ledger, and the phone is not
    // told a lie: it learned the computer received the draft, which is all its
    // own queue can honestly record.
    let (second, effect) = {
        let body = serde_json::json!({
            "id": "intake-refused",
            "pairCode": rotated.pair_code,
            "deviceName": "موبايل بيتر",
            "createdAt": 2,
            "disposition": "quantity",
            "productName": "كفر سيليكون",
            "barcode": "",
            "quantity": 6,
            "unitCostMinor": 9_000,
            "imeis": [],
            "photos": [],
        })
        .to_string();
        intake(body, 0)
    };
    assert_eq!(second.status, 202);
    companion::stage_lan_effect(effect.expect("queued"));
    let with_two = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("inbox with one draft");
    assert_eq!(with_two.pending_intakes.len(), 1);
    let rejected = companion::reject_intake(&pool, tokens.as_ref(), "intake-refused")
        .await
        .expect("rejected");
    assert!(rejected.pending_intakes.is_empty());

    settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("companion.* rows in app_settings do not disturb settings snapshot");
}

/// The framing is what a phone hits first: a body split across packets used to be
/// truncated by a single fixed read, which is how a capture could disappear without
/// either machine saying so (`ADR-042`).
#[tokio::test]
async fn lan_framing_reads_a_body_that_arrives_in_pieces() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("ephemeral listener");
    let port = listener.local_addr().expect("local address").port();
    let server = std::thread::spawn(move || {
        let mut stream = listener
            .incoming()
            .next()
            .expect("one connection")
            .expect("accepted socket");
        let request = companion::read_lan_request(&mut stream).expect("a whole request");
        let state = LanState {
            shop: "متجر الاختبار".to_string(),
            pair_code: "PAIR-FRAMING".to_string(),
            blocked: Vec::new(),
            port,
            staged: 0,
        };
        let (response, effect) = companion::handle_lan_request(&request, &state);
        let draft = match effect {
            Some(LanEffect::Intake(draft)) => draft,
            other => panic!("expected a staged intake, got {other:?}"),
        };
        stream
            .write_all(response.to_http().as_bytes())
            .expect("write the answer");
        (draft.product_name, draft.photos.len(), draft.photos[0].len())
    });

    let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let photo = "A".repeat(200_000);
    let body = serde_json::json!({
        "id": "framing-1",
        "pairCode": "PAIR-FRAMING",
        "deviceName": "موبايل الاختبار",
        "createdAt": 1,
        "disposition": "quantity",
        "productName": "شاحن سريع 65 واط",
        "barcode": "",
        "quantity": 4,
        "unitCostMinor": 25_000,
        "imeis": [],
        "photos": [format!("data:image/jpeg;base64,{photo}")],
    })
    .to_string();
    let head = format!(
        "POST /api/companion/intake HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes()).expect("write headers");
    client.write_all(body.as_bytes()).expect("write body");
    let mut answer = String::new();
    client.read_to_string(&mut answer).expect("read answer");
    assert!(
        answer.starts_with("HTTP/1.1 202"),
        "the framed body must be accepted, got: {answer}"
    );
    let (name, photos, photo_len) = server.join().expect("server thread");
    assert_eq!(name, "شاحن سريع 65 واط");
    assert_eq!(photos, 1);
    assert_eq!(photo_len, 200_000 + "data:image/jpeg;base64,".len());
}

/// A request larger than the companion will hold is answered rather than hung on,
/// and an unread body must never be mistaken for an empty one (`ADR-042`).
#[tokio::test]
async fn an_oversized_push_is_answered_with_413() {
    let state = LanState {
        shop: "متجر".to_string(),
        pair_code: "PAIR-1".to_string(),
        blocked: Vec::new(),
        port: 8787,
        staged: 0,
    };
    let (response, effect) = companion::handle_lan_request(
        &LanRequest {
            method: "POST".to_string(),
            path: "/api/companion/intake".to_string(),
            body: String::new(),
            oversized: true,
        },
        &state,
    );
    assert_eq!(response.status, 413);
    assert!(effect.is_none());
    assert!(response
        .to_http()
        .starts_with("HTTP/1.1 413 Content Too Large\r\n"));
}
