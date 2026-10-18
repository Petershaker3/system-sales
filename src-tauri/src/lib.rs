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
            commands::identity::login_with_pin,
            commands::identity::approve_with_owner_pin,
            commands::identity::recover_password_with_code,
            commands::identity::logout,
            commands::identity::whoami,
            commands::identity::reauthenticate,
            commands::catalog::create_product,
            commands::catalog::get_product,
            commands::catalog::list_products,
            commands::catalog::update_product,
            commands::catalog::set_product_archived,
            commands::catalog::find_product_by_barcode,
            commands::catalog::set_product_category,
            commands::catalog::next_shop_code,
            commands::catalog::next_shop_codes,
            commands::catalog::create_variants,
            commands::catalog::list_product_images,
            commands::catalog::set_product_image,
            commands::catalog::remove_product_image,
            commands::catalog::get_shop_logo,
            commands::catalog::set_shop_logo,
            commands::catalog::remove_shop_logo,


            commands::identity_lifecycle::change_own_password,
            commands::identity_lifecycle::list_users_for_management,
            commands::identity_lifecycle::create_user,
            commands::identity_lifecycle::reset_user_password,
            commands::identity_lifecycle::set_my_pin,
            commands::identity_lifecycle::set_user_pin,
            commands::identity_lifecycle::create_recovery_code,
            commands::identity_lifecycle::recovery_code_status,
            commands::identity_lifecycle::change_user_role,
            commands::identity_lifecycle::disable_user,
            commands::identity_lifecycle::enable_user,
            commands::identity_lifecycle::set_username,
            commands::identity_lifecycle::password_change_required,
            commands::categories::list_categories,
            commands::categories::create_category,
            commands::categories::rename_category,
            commands::categories::set_category_hidden,
            commands::categories::move_category,
            commands::categories::delete_category,
            commands::brands::list_brands,
            commands::brands::create_brand,
            commands::brands::rename_brand,
            commands::brands::set_brand_type,
            commands::brands::set_brand_hidden,
            commands::brands::move_brand,
            commands::brands::delete_brand,
            commands::brands::create_phone,
            commands::settings::read_settings,
            commands::settings::update_setting,
            commands::settings::read_appearance,
            commands::settings::update_appearance,
            commands::inventory::receive_stock,
            commands::inventory::receive_opening_stock,
            commands::inventory::list_product_units,
            commands::inventory::remove_stock,
            commands::inventory::get_position,
            commands::pos::pos_catalog,
            commands::sales::record_sale,
            commands::sales::cancel_sale,
            commands::sales::link_sale_customer,
            commands::sales::set_sale_customer_name,
            commands::customer::create_customer,
            commands::customer::list_customers,
            commands::customer::get_customer,
            commands::customer::archive_customer,
            commands::customer::record_customer_payment,
            commands::customer::list_customer_ledger,
            commands::shift::current_shift_summary,
            commands::shift::open_shift,
            commands::shift::record_expense,
            commands::shift::record_cash_movement,
            commands::shift::close_shift,
            commands::backup::create_backup,
            commands::backup::restore_backup,
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

            // Crash recovery for an interrupted restore (P2a-Rust). This runs
            // BEFORE the database is opened: an interrupted restore leaves a
            // half-replaced device, and opening it would be acting on suspect
            // state. A clean or reverted device proceeds; a device that cannot
            // be recovered refuses to start (fail closed).
            match services::backup::recover_interrupted(&data_dir) {
                Ok(services::backup::RecoveryOutcome::NothingToDo) => {}
                Ok(recovered) => {
                    eprintln!("backup recovery at startup: {recovered:?}");
                }
                Err(error) => {
                    Err(format!(
                        "an interrupted backup restore could not be completed: {error}"
                    ))?;
                }
            }

            let pool = tauri::async_runtime::block_on(data::db::open(&data_dir.join(DB_FILENAME)))
                .map_err(|e| format!("could not open the local database: {e}"))?;

            // Clear sessions that expired while the device was off. Housekeeping
            // only: no decision depends on it.
            let _ = tauri::async_runtime::block_on(services::identity::session::purge_expired(&pool));

            // The default categories, for a database made before the tree
            // (ADR-018 §1). Added once, by fixed id; on a device with no manager
            // yet nothing happens, and setup adds them. Best effort: a shop
            // whose defaults could not be added still opens and sells.
            let _ = tauri::async_runtime::block_on(
                services::organisation::categories::add_default_categories(&pool),
            );
            // The default phone companies (ADR-018 §2), the same way.
            let _ = tauri::async_runtime::block_on(
                services::catalog::brands::add_default_brands(&pool),
            );

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