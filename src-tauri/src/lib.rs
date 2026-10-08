//! Application wiring.
//!
//! Only this file knows about Tauri and about the platform credential store
//! together. Everything below it is ordinary Rust.

pub mod commands;
pub mod data;
pub mod domain;
pub mod services;

use std::sync::Arc;

use tauri::Manager;

use services::catalog::CatalogContext;
use services::identity::secure_store::{KeyringTokenStore, SecureTokenStore};
use services::identity::IdentityContext;

/// Filename of the device's local database.
///
/// Each device owns exactly one of these. There is no shared database and no
/// synchronisation in V1 (`ADR-008:12`).
const DB_FILENAME: &str = "shop.db";

// Tauri's mobile entry point.
//
// `#[cfg_attr(mobile, ...)]` applies the attribute only when tauri-build sets
// the `mobile` cfg, so desktop keeps an ordinary `main` and mobile gains the
// `start_app` C symbol that the generated Gradle project links against.
//
// Without it the desktop build is perfectly happy while the Android build fails
// at packaging time with:
//
//     failed to validate library: ... does not include required runtime symbols.
//     This means you are likely missing the tauri::mobile_entry_point macro usage
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::identity::bootstrap_status,
            commands::identity::create_first_manager,
            commands::identity::list_users_for_picker,
            commands::identity::login,
            commands::identity::logout,
            commands::identity::whoami,
            commands::identity::reauthenticate,
            commands::catalog::create_product,
            commands::catalog::get_product,
            commands::catalog::list_products,
            commands::catalog::update_product,
            commands::catalog::set_product_archived,
            commands::catalog::find_product_by_barcode,
            commands::identity_lifecycle::change_own_password,
            commands::identity_lifecycle::list_users_for_management,
            commands::identity_lifecycle::create_user,
            commands::identity_lifecycle::reset_user_password,
            commands::identity_lifecycle::change_user_role,
            commands::identity_lifecycle::disable_user,
            commands::identity_lifecycle::enable_user,
            commands::identity_lifecycle::set_username,
            commands::identity_lifecycle::password_change_required,
            commands::departments::create_department,
            commands::departments::get_department,
            commands::departments::list_departments,
            commands::departments::update_department,
            commands::departments::set_department_archived,
            commands::departments::reorder_departments,
            commands::settings::read_settings,
            commands::settings::update_setting,
            commands::pattern::get_pattern_status,
            commands::pattern::verify_pattern,
            commands::pattern::set_pattern,
            commands::pattern::reset_pattern,
            commands::pattern::disable_pattern,
        ])
        .setup(move |app| {
            // Fail closed, and loudly. If the OS credential store cannot be
            // reached there is no safe way to hold a session token, and
            // continuing would mean inventing a weaker fallback (ADR-009).
            let tokens: Arc<dyn SecureTokenStore> = Arc::new(
                KeyringTokenStore::new()
                    .map_err(|e| format!("secure session storage is unavailable: {e}"))?,
            );

            let data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("could not resolve the application data directory: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("could not create the application data directory: {e}"))?;

            let pool = tauri::async_runtime::block_on(data::db::open(&data_dir.join(DB_FILENAME)))
                .map_err(|e| format!("could not open the local database: {e}"))?;

            // Clear sessions that expired while the device was off. Housekeeping
            // only: no decision depends on it.
            let _ = tauri::async_runtime::block_on(services::identity::session::purge_expired(&pool));

            app.manage(IdentityContext::new(pool.clone(), tokens.clone()));
            // The catalogue shares the same pool and the same credential store.
            // Sharing the store is what lets every catalogue command resolve the
            // operator without any command accepting a session parameter.
            app.manage(CatalogContext::new(pool, tokens));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}