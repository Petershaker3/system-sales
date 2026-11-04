//! The one string that leaves the application (`commands/shell.rs`).
//!
//! A WhatsApp chat has to be opened by the operating system, because a webview
//! cannot leave its own window. That makes one URL the only thing this app hands
//! to the OS — so the rule that decides which URLs may be handed over is proven
//! here, in the same suite that proves the other boundaries.
//!
//! The failure this guards against is not exotic: `shell:…` or a `file:` path
//! reaching `std::process::Command` would be a way out of the app, and a
//! lookalike host (`wa.me.evil.com`) is how a link that looks right is not.

use mobile_shop_system_lib::commands::shell::is_chat_link;

#[test]
fn a_whatsapp_chat_link_is_allowed() {
    assert!(is_chat_link(
        "https://wa.me/201012345678?text=%D8%A3%D9%87%D9%84%D8%A7"
    ));
    assert!(is_chat_link(
        "https://api.whatsapp.com/send?phone=201012345678"
    ));
    assert!(is_chat_link("https://web.whatsapp.com/send?text=hi"));
    // A port on an allowed host is still that host.
    assert!(is_chat_link("https://wa.me:443/201012345678"));
}

#[test]
fn anything_else_is_refused() {
    // Another scheme is another program, and `file:` is the filesystem.
    assert!(!is_chat_link("http://wa.me/201012345678"));
    assert!(!is_chat_link("file:///C:/Windows/System32/cmd.exe"));
    assert!(!is_chat_link("shell:cmd"));
    assert!(!is_chat_link("ms-settings:"));
    // The host must be the whole host: `wa.me.evil.com` is not `wa.me`.
    assert!(!is_chat_link("https://wa.me.evil.com/201012345678"));
    assert!(!is_chat_link("https://evil.com/wa.me"));
    // Credentials in front of the host do not make it ours.
    assert!(!is_chat_link("https://wa.me@evil.com/2010"));
    // Nor does an empty or whitespace-bearing string: a space or a newline is how
    // a second command hides inside a shell argument.
    assert!(!is_chat_link(""));
    assert!(!is_chat_link("https://"));
    assert!(!is_chat_link("https://wa.me/201012345678 && calc"));
    assert!(!is_chat_link("https://wa.me/201012345678\ncalc"));
    assert!(!is_chat_link(&format!("https://wa.me/{}", "1".repeat(5000))));
}

#[test]
fn the_command_is_registered_and_named_for_what_it_does() {
    // An unregistered command compiles, tests, and silently does not exist for the
    // app — which is exactly how the WhatsApp button "did nothing" before.
    let lib = include_str!("../../src/lib.rs");
    assert!(
        lib.contains("commands::shell::open_external_url"),
        "open_external_url must stay registered in lib.rs"
    );
    assert!(
        lib.contains("commands::shell::restart_app"),
        "restart_app must stay registered in lib.rs"
    );
}
