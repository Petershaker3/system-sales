//! The owner's recovery code (ADR-017 §4; the owner's choice, ADR-016 #32): a
//! one-time code written on paper that sets a new password when the old one is
//! forgotten.
//!
//! The shape is a domain rule: 20 symbols from an alphabet without the
//! characters that are misread on paper — no 0 or O, no 1, I or L — shown as
//! five groups of four. That alphabet has 31 symbols, so 20 of them carry
//! about 99 bits: nobody guesses it, and the shared lockout stops anyone who
//! tries. Drawing a code needs randomness, which is the service's
//! (`crypto::generate_recovery_code`); reading back what an operator typed is
//! here, so the rule has one home.

/// The symbols a recovery code is written in: digits 2–9 and the capital
/// letters without I, L and O.
pub const RECOVERY_CODE_ALPHABET: &str = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// Symbols in one recovery code.
pub const RECOVERY_CODE_LEN: usize = 20;

/// Symbols per group when a code is shown or written down.
pub const RECOVERY_CODE_GROUP: usize = 4;

/// A typed code in its stored form, or `None` when it cannot be a code.
///
/// Forgiven: lower case, spaces and dashes between groups, and digits typed on
/// an Arabic keyboard. Anything else outside the alphabet — a 0, an O, a 1, an
/// I or an L included — means it is not a code, and the caller treats it as a
/// wrong one.
pub fn normalize_recovery_code(typed: &str) -> Option<String> {
    let mut code = String::with_capacity(RECOVERY_CODE_LEN);
    for ch in typed.chars() {
        if ch.is_whitespace() || ch == '-' {
            continue;
        }
        let symbol = latin_digit(ch).to_ascii_uppercase();
        if !RECOVERY_CODE_ALPHABET.contains(symbol) {
            return None;
        }
        code.push(symbol);
        if code.len() > RECOVERY_CODE_LEN {
            return None;
        }
    }
    (code.len() == RECOVERY_CODE_LEN).then_some(code)
}

/// A code in groups of four joined by dashes, as it is shown and written down.
pub fn group_recovery_code(code: &str) -> String {
    code.chars()
        .collect::<Vec<_>>()
        .chunks(RECOVERY_CODE_GROUP)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// An Arabic-Indic or Eastern Arabic-Indic digit as its Latin digit; any other
/// character unchanged.
fn latin_digit(ch: char) -> char {
    let offset = match ch {
        '\u{0660}'..='\u{0669}' => u32::from(ch) - 0x0660,
        '\u{06F0}'..='\u{06F9}' => u32::from(ch) - 0x06F0,
        _ => return ch,
    };
    char::from_digit(offset, 10).unwrap_or(ch)
}
