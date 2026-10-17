//! The shop's own barcode (`PLAN` §6, «الكود الداخلي»): an EAN-13 that starts
//! with 2, made for the shop itself and printed on a label, so it is never
//! confused with a manufacturer's barcode.
//!
//! The mockup's rule (`docs/ui/mockup-v1/analytics.js`, `ean13`;
//! `views/catalog.js`, `nextCode`) is kept exactly: the first 12 digits are `2`
//! followed by the next number after the highest internal code already stored,
//! and the thirteenth is the standard EAN-13 check digit. A shop that has no
//! internal code starts at `2000000000015`.
//!
//! # Why a code with a wrong check digit still counts
//!
//! [`next_shop_code`] scans every 13-digit barcode that starts with 2, not only
//! the ones whose check digit is right. A barcode the shop typed by hand can be
//! 13 digits starting with 2 and still fail the check digit; skipping it would
//! make the next generated code repeat it, and the products table's UNIQUE
//! index would refuse the insert. Counting it reserves its number.
//!
//! No storage, no SQL, no Tauri (`spec:99`).

use std::fmt;

/// The first digit of every barcode the shop makes for itself.
const INTERNAL_PREFIX: char = '2';
/// Digits before the check digit.
const BODY_LEN: usize = 12;
/// Digits in the whole code.
const CODE_LEN: usize = 13;
/// The largest sequence that fits after the prefix (11 digits, all nines).
const MAX_SEQUENCE: u64 = 99_999_999_999;

/// Why no shop code can be made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShopCodeError {
    /// Every sequence in the range has been used (`2999999999991` is taken).
    Exhausted,
}

impl ShopCodeError {
    /// A stable, language-independent code for the transport.
    pub fn code(&self) -> &'static str {
        match self {
            ShopCodeError::Exhausted => "SHOP_CODE_EXHAUSTED",
        }
    }
}

impl fmt::Display for ShopCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShopCodeError::Exhausted => f.write_str("every internal shop code is in use"),
        }
    }
}

impl std::error::Error for ShopCodeError {}

/// The EAN-13 check digit of a 12-digit body, or `None` when the body is not
/// exactly 12 ASCII digits.
///
/// Weights alternate 1 and 3 from the left; the check digit is what makes their
/// total a multiple of ten. This is the mockup's `ean13`, including its
/// `(10 - sum % 10) % 10` so a total already divisible by ten yields 0.
pub fn ean13_check_digit(body: &str) -> Option<u8> {
    if body.len() != BODY_LEN || !body.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let sum: u32 = body
        .bytes()
        .enumerate()
        .map(|(index, digit)| u32::from(digit - b'0') * if index % 2 == 0 { 1 } else { 3 })
        .sum();
    Some(((10 - (sum % 10)) % 10) as u8)
}

/// The full 13-digit EAN-13 for a 12-digit body.
pub fn ean13(body: &str) -> Option<String> {
    let check = ean13_check_digit(body)?;
    Some(format!("{body}{check}"))
}

/// The sequence number of an internal code, if `code` has the shape of one:
/// 13 ASCII digits starting with 2. The check digit is deliberately not
/// validated here; see the module documentation.
fn internal_sequence(code: &str) -> Option<u64> {
    if code.len() != CODE_LEN || !code.starts_with(INTERNAL_PREFIX) {
        return None;
    }
    if !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Safe: every byte is ASCII, checked above.
    code[1..BODY_LEN].parse().ok()
}

/// The next free shop code: one past the highest sequence in `codes`.
///
/// Barcodes that are not 13 digits starting with 2 are ignored, so a
/// manufacturer's barcode never moves the shop's numbering.
pub fn next_shop_code<'a>(
    codes: impl IntoIterator<Item = &'a str>,
) -> Result<String, ShopCodeError> {
    let mut generated = next_shop_codes(codes, 1)?;
    generated.pop().ok_or(ShopCodeError::Exhausted)
}

/// The next `count` free shop codes, consecutive from the highest sequence in
/// `codes`.
///
/// Used by «اعمل أكواد للي من غير باركود» on a variant item (ADR-018 §4), so a
/// whole table of blank rows receives consecutive valid EAN-13 codes in one
/// step without colliding with codes already in the database or in the form.
pub fn next_shop_codes<'a>(
    codes: impl IntoIterator<Item = &'a str>,
    count: usize,
) -> Result<Vec<String>, ShopCodeError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut highest = 0u64;
    for code in codes {
        if let Some(sequence) = internal_sequence(code) {
            highest = highest.max(sequence);
        }
    }
    let count_u64 = u64::try_from(count).map_err(|_| ShopCodeError::Exhausted)?;
    if highest.saturating_add(count_u64) > MAX_SEQUENCE {
        return Err(ShopCodeError::Exhausted);
    }
    let mut out = Vec::with_capacity(count);
    for offset in 1..=count_u64 {
        let sequence = highest + offset;
        let body = format!("{}{sequence:011}", INTERNAL_PREFIX);
        let check = ean13_check_digit(&body).ok_or(ShopCodeError::Exhausted)?;
        out.push(format!("{body}{check}"));
    }
    Ok(out)
}

