//! Opening one web address in the system's own browser.
//!
//! # Why this command exists
//!
//! The WebView cannot open a second window: `window.open` inside Tauri is
//! answered with nothing on both platforms, so every «واتساب» button in the app
//! used to *say* it sent the message while the link went nowhere — the owner's
//! word for it was «فيك». A WhatsApp receipt, the owner's daily summary and the
//! GSMArena page of a registered phone all live outside the shop's network, and
//! the only honest way to reach them is to hand the address to the OS, which
//! owns the browser and the WhatsApp app.
//!
//! # Why it is one narrow command
//!
//! `plan:157` keeps the WebView's IPC surface named, never generic: this opens
//! an `http(s)` address and nothing else. No paths, no programs, no `file:` and
//! no custom schemes — `validated_web_url` refuses everything that is not a
//! plain web address before any platform call is made, so a tampered frontend
//! still cannot turn this into "run anything".
//!
//! No new crate enters the tree for this (the deliberately-absent list in
//! `Cargo.toml` stays as it is): Windows gets `cmd /C start`, Android fires the
//! `ACTION_VIEW` intent over the JNI crates the Tauri runtime already resolves,
//! and a Linux desktop (CI and `tauri dev`) gets `xdg-open`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCommandError {
    pub code: &'static str,
}

/// The longest address the app ever builds: a `wa.me` link carries the whole
/// daily summary as percent-encoded UTF-8, so the bound is generous, but it is
/// a bound — an unbounded string handed to a command line is a way to smuggle.
const MAX_URL_LEN: usize = 8_000;

/// What one address must look like to be opened.
///
/// - `http` or `https`, nothing else (`wa.me` and GSMArena are both `https`);
/// - no whitespace, no quotes and no control characters: the Windows path is
///   assembled through `cmd`'s own quoting, and a character that could close
///   the quote or start a new command never reaches it;
/// - a hard length bound.
///
/// Percent-encoded text (Arabic message bodies) passes: `%` is not special to
/// any of the three platform calls once the address is quoted.
pub fn validated_web_url(url: &str) -> Result<String, SystemCommandError> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(SystemCommandError {
            code: "OPEN_URL_SCHEME_REFUSED",
        });
    }
    if trimmed.len() > MAX_URL_LEN {
        return Err(SystemCommandError {
            code: "OPEN_URL_TOO_LONG",
        });
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\'' || c == '`')
    {
        return Err(SystemCommandError {
            code: "OPEN_URL_INVALID_CHAR",
        });
    }
    Ok(trimmed.to_owned())
}

/// Open one validated address in the OS's own browser (or WhatsApp, for a
/// `wa.me` link — the OS decides what owns the address).
///
/// Fire-and-forget by design: the browser window is the receipt the operator
/// sees, and the frontend says honestly what happened («اتفتح واتساب — دوس
/// إرسال»), never «اتبعت».
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), SystemCommandError> {
    let validated = validated_web_url(&url)?;
    spawn_open(&validated).map_err(|_| SystemCommandError {
        code: "OPEN_URL_FAILED",
    })
}

#[cfg(target_os = "windows")]
fn spawn_open(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// `CREATE_NO_WINDOW`: the shop's counter must not flash a console every
    /// time a receipt goes out on WhatsApp.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // `start` takes an (empty) title then the quoted address; inside the quotes
    // `cmd` treats `?`, `%` and friends as literal characters, and the URL was
    // validated above to contain no quote, whitespace or control character that
    // could close them. `raw_arg` keeps `std` from re-quoting the pieces.
    Command::new("cmd")
        .creation_flags(CREATE_NO_WINDOW)
        .raw_arg("/C start \"\" \"")
        .raw_arg(url)
        .raw_arg("\"")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
fn spawn_open(url: &str) -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    // The handset has no browser to `start`: the address becomes an
    // `ACTION_VIEW` intent and Android hands it to WhatsApp or the browser,
    // whichever owns `wa.me`/`https`. The VM and the activity context are the
    // ones the Tauri runtime already holds (`ndk-context`), so no new crate
    // enters the tree — `jni` and `ndk-context` are the runtime's own.
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;

    // Each field/method answer is bound before it is read, and `JValue::Object`
    // borrows its `JObject` (`&JString` reaches `&JObject` through `Deref`):
    // chaining reads off temporaries would drop the value being pointed into.
    let action_field = env
        .get_static_field("android/content/Intent", "ACTION_VIEW", "Ljava/lang/String;")
        .map_err(|e| e.to_string())?;
    let action_view = action_field.l().map_err(|e| e.to_string())?;

    let url_string = env.new_string(url).map_err(|e| e.to_string())?;
    let uri_field = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&url_string)],
        )
        .map_err(|e| e.to_string())?;
    let uri = uri_field.l().map_err(|e| e.to_string())?;

    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action_view), JValue::Object(&uri)],
        )
        .map_err(|e| e.to_string())?;

    // The stored context may be the application's rather than an activity's,
    // and starting an activity from it is refused without the task flag.
    let flag_field = env
        .get_static_field("android/content/Intent", "FLAG_ACTIVITY_NEW_TASK", "I")
        .map_err(|e| e.to_string())?;
    let new_task = flag_field.i().map_err(|e| e.to_string())?;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(new_task)],
    )
    .map_err(|e| e.to_string())?;

    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    env.call_method(
        &activity,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(|e| e.to_string())?;
    // The context pointer is the runtime's own *global* reference: wrapping it
    // in a `JObject` only borrows it, and `forget` keeps the Drop from issuing
    // a `DeleteLocalRef` on a reference that is not ours to release.
    std::mem::forget(activity);
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_open(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// The development desktop and CI: a plain Linux session. Android is `unix` too,
// so it is named out — its path is the intent above.
#[cfg(all(unix, not(target_os = "android"), not(target_os = "macos")))]
fn spawn_open(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validated_web_url;

    #[test]
    fn a_whatsapp_link_passes_with_its_encoded_arabic() {
        let url = "https://wa.me/201001234567?text=%D9%85%D9%84%D8%AE%D8%B5%20%D8%A7%D9%84%D9%8A%D9%88%D9%85";
        assert_eq!(validated_web_url(url).unwrap(), url);
    }

    #[test]
    fn a_gsmarena_search_passes_with_its_ampersand() {
        // `&` separates query parameters; the Windows quoting keeps it literal.
        let url = "https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=Galaxy%20A54";
        assert_eq!(validated_web_url(url).unwrap(), url);
    }

    #[test]
    fn anything_that_is_not_a_web_address_is_refused() {
        for bad in [
            "file:///C:/Windows/system32",
            "ftp://example.com/x",
            "javascript:alert(1)",
            "MSHOP-PAIR|v1|x|1.2.3.4:8787|PAIR-1",
            "",
            "   ",
            "wa.me/201001234567",
        ] {
            assert!(validated_web_url(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn characters_that_could_escape_the_quoting_are_refused() {
        for bad in [
            "https://example.com/a b",
            "https://example.com/\"whoops\"",
            "https://example.com/it's",
            "https://example.com/`id`",
            "https://example.com/\nSet-Cookie:x",
        ] {
            assert!(validated_web_url(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_length_bound_is_enforced() {
        let long = format!("https://wa.me/201001234567?text={}", "a".repeat(9_000));
        assert!(validated_web_url(&long).is_err());
        let ok = format!("https://wa.me/201001234567?text={}", "a".repeat(4_000));
        assert!(validated_web_url(&ok).is_ok());
    }
}
