//! Commands that act on the running application itself.
//!
//! Two commands, one reason each:
//!
//! * `restart_app` — a restore replaces `shop.db` on disk while the pool that
//!   read it is closed for good (`commands::backup::restore_backup`). The
//!   restored database is opened by the *next* process, so the operator has to
//!   restart — and the panel that ran the restore offers that as one button
//!   instead of asking them to hunt for the window's close box.
//! * `open_external_url` — a WhatsApp chat does not live inside the till. The
//!   receipt is sent by opening the shop's own WhatsApp, which is a browser
//!   (`wa.me`) or the WhatsApp Desktop app, never a page inside this window.
//!   `window.open` from a Tauri webview does not reach the operating system's
//!   browser by itself, so the click that used to do nothing now has a door.

use serde::Serialize;

/// Why a URL was not opened. Codes, not sentences: the screen writes the Arabic
/// (`src/api/errors.ts`, `describeError`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlError {
    pub code: &'static str,
}

/// The hosts a chat link may point at.
///
/// This is the whole security surface of the command: without it, a `String`
/// from the WebView would be handed to the operating system's shell, and
/// `shell:...` or a `file:` path would be a way out of the app. A chat link is
/// `https` on one of three WhatsApp hosts and nothing else.
const CHAT_HOSTS: [&str; 3] = ["wa.me", "api.whatsapp.com", "web.whatsapp.com"];

/// Is this a WhatsApp chat link, and only that?
///
/// Pure on purpose: it is the one rule standing between a WebView string and the
/// operating system, so it is proven by unit tests instead of by reading it.
pub fn is_chat_link(url: &str) -> bool {
    // A URL that is longer than a receipt message is not one this app built.
    if url.len() > 4096 {
        return false;
    }
    // A space or a control character is how a second command hides inside a
    // shell argument; both are refused before the string is looked at further.
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map(|(_, after_at)| after_at)
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    CHAT_HOSTS.contains(&host.as_str())
}

/// Open a WhatsApp chat in the machine's own browser (`ADR-022` §2.3).
///
/// No session and no permission: nothing here reads or writes the shop. The only
/// thing that makes it worth a command rather than a `window.open` is that the
/// operating system, not the webview, has the browser.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), OpenUrlError> {
    if !is_chat_link(&url) {
        return Err(OpenUrlError {
            code: "EXTERNAL_URL_NOT_ALLOWED",
        });
    }
    open_in_system_browser(&url).map_err(|_| OpenUrlError {
        code: "EXTERNAL_OPEN_FAILED",
    })
}

/// Hand the URL to the OS. Spawned, not waited on: the browser outlives the click.
fn open_in_system_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `start` is a `cmd` builtin, so it needs the shell. The empty argument is
        // the window title `start` would otherwise read the URL as — without it a
        // quoted URL becomes the title and nothing opens.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
    }
    // The Android app is the companion, not the till: it has no WhatsApp hand-off
    // to make, and the screen falls back to a link it can long-press.
    #[cfg(target_os = "android")]
    {
        let _ = url;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "opening a browser is a desktop action",
        ))
    }
}

/// Restart the application (the current process exits and a new one starts).
///
/// Deliberately takes no session and checks no permission. After a restore the
/// pool is closed, so any command that resolved a session would answer
/// `LOCAL_STORAGE_UNAVAILABLE` — the very failure this button exists to end.
/// Restarting changes no data: `shop.db` on disk is already whatever the last
/// committed operation made it, and a restart is the only way back to it.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    // `AppHandle::restart` never returns: it hands the process to a new instance.
    app.restart();
}
