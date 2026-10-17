//! Product images («صور الأصناف», ADR-018 §5, plan item 1.2 step 5).
//!
//! Each product may carry one optional 192×192 square JPEG thumbnail stored on
//! disk under `images/<product_id>.jpg` beside `shop.db`. In compliance with
//! XC-10 (`spec:220`), the database row stores only the relative path (`file`)
//! and the verified dimensions and byte length (`w`, `h`, `bytes`) — never the
//! image payload.
//!
//! Depends on no infrastructure (`spec:99`): JPEG header parsing and RFC 4648
//! Base64 encoding/decoding are pure Rust over slices.

use std::fmt;

use crate::domain::catalog::ProductId;

/// Required square side in pixels for every stored product thumbnail.
pub const IMAGE_SIDE: u16 = 192;

/// Maximum byte length accepted for a 192×192 JPEG thumbnail (64 KiB).
pub const MAX_IMAGE_BYTES: usize = 65_536;

/// Relative directory prefix inside the application data directory.
pub const IMAGES_DIR_PREFIX: &str = "images/";

/// Persisted metadata for a product's external 192×192 JPEG file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductImage {
    pub product_id: ProductId,
    pub file: String,
    pub w: u16,
    pub h: u16,
    pub bytes: usize,
}

impl ProductImage {
    /// Relative path inside the app data directory (`images/<product_id>.jpg`).
    #[must_use]
    pub fn relative_file_for(product_id: ProductId) -> String {
        format!("{IMAGES_DIR_PREFIX}{product_id}.jpg")
    }

    /// Validate a 192×192 JPEG byte buffer and build its persisted metadata row.
    pub fn from_jpeg_bytes(product_id: ProductId, bytes: &[u8]) -> Result<Self, ImageError> {
        let (w, h) = validate_jpeg_192(bytes)?;
        Ok(Self {
            product_id,
            file: Self::relative_file_for(product_id),
            w,
            h,
            bytes: bytes.len(),
        })
    }

    /// Decode a `data:image/jpeg;base64,...` (or bare Base64) string, validate
    /// the 192×192 JPEG header and byte bounds, and return `(metadata, bytes)`.
    pub fn from_data_url(
        product_id: ProductId,
        data_url: &str,
    ) -> Result<(Self, Vec<u8>), ImageError> {
        let raw = decode_jpeg_data_url(data_url)?;
        let image = Self::from_jpeg_bytes(product_id, &raw)?;
        Ok((image, raw))
    }

    /// Reconstruct from a stored SQLite row, checking the schema invariants.
    pub fn from_row(
        product_id: ProductId,
        file: String,
        w: i64,
        h: i64,
        bytes: i64,
    ) -> Result<Self, ImageError> {
        let expected_file = Self::relative_file_for(product_id);
        if file != expected_file {
            return Err(ImageError::NotJpeg);
        }
        let w_u16 = u16::try_from(w).map_err(|_| ImageError::DimensionsInvalid)?;
        let h_u16 = u16::try_from(h).map_err(|_| ImageError::DimensionsInvalid)?;
        if w_u16 != IMAGE_SIDE || h_u16 != IMAGE_SIDE {
            return Err(ImageError::DimensionsInvalid);
        }
        let len = usize::try_from(bytes).map_err(|_| ImageError::Empty)?;
        if len == 0 {
            return Err(ImageError::Empty);
        }
        if len > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge);
        }
        Ok(Self {
            product_id,
            file,
            w: w_u16,
            h: h_u16,
            bytes: len,
        })
    }
}

/// Inspect a byte slice and confirm it is a JPEG with 192×192 dimensions
/// within [`MAX_IMAGE_BYTES`].
pub fn validate_jpeg_192(bytes: &[u8]) -> Result<(u16, u16), ImageError> {
    if bytes.is_empty() {
        return Err(ImageError::Empty);
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    let (w, h) = parse_jpeg_dimensions(bytes)?;
    if w != IMAGE_SIDE || h != IMAGE_SIDE {
        return Err(ImageError::DimensionsInvalid);
    }
    Ok((w, h))
}

/// Parse the `(width, height)` from a JPEG byte stream's Start Of Frame (`SOF0`,
/// `SOF1`, or `SOF2`) segment.
pub fn parse_jpeg_dimensions(bytes: &[u8]) -> Result<(u16, u16), ImageError> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(ImageError::NotJpeg);
    }
    let mut i = 2usize;
    while i < bytes.len() {
        if bytes[i] != 0xFF {
            return Err(ImageError::NotJpeg);
        }
        while i < bytes.len() && bytes[i] == 0xFF {
            i += 1;
        }
        if i >= bytes.len() {
            return Err(ImageError::NotJpeg);
        }
        let marker = bytes[i];
        i += 1;

        // Standalone markers without a 2-byte length field.
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        // EOI or SOS reached before any SOF marker.
        if marker == 0xD9 || marker == 0xDA {
            return Err(ImageError::NotJpeg);
        }

        if i + 2 > bytes.len() {
            return Err(ImageError::NotJpeg);
        }
        let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > bytes.len() {
            return Err(ImageError::NotJpeg);
        }

        // Baseline (`SOF0`), extended sequential (`SOF1`), or progressive (`SOF2`).
        if matches!(marker, 0xC0 | 0xC1 | 0xC2) {
            if seg_len < 7 {
                return Err(ImageError::NotJpeg);
            }
            let payload = &bytes[i + 2..i + seg_len];
            let height = u16::from_be_bytes([payload[1], payload[2]]);
            let width = u16::from_be_bytes([payload[3], payload[4]]);
            if width == 0 || height == 0 {
                return Err(ImageError::DimensionsInvalid);
            }
            return Ok((width, height));
        }

        i += seg_len;
    }

    Err(ImageError::NotJpeg)
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode a validated JPEG slice as a `data:image/jpeg;base64,...` URL.
#[must_use]
pub fn encode_jpeg_data_url(bytes: &[u8]) -> String {
    let prefix = "data:image/jpeg;base64,";
    let encoded_len = bytes.len().div_ceil(3) * 4;
    let mut out = String::with_capacity(prefix.len() + encoded_len);
    out.push_str(prefix);

    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(char::from(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[((n >> 6) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[(n & 0x3F) as usize]));
    }

    let rem = chunks.remainder();
    if rem.len() == 1 {
        let n = u32::from(rem[0]) << 16;
        out.push(char::from(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]));
        out.push('=');
        out.push('=');
    } else if rem.len() == 2 {
        let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
        out.push(char::from(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize]));
        out.push(char::from(BASE64_ALPHABET[((n >> 6) & 0x3F) as usize]));
        out.push('=');
    }

    out
}

/// Decode a `data:image/jpeg;base64,...` URL (or bare Base64 string) into raw bytes.
pub fn decode_jpeg_data_url(input: &str) -> Result<Vec<u8>, ImageError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ImageError::Empty);
    }

    let body = if let Some((header, rest)) = trimmed.split_once(',') {
        let h = header.trim().to_ascii_lowercase();
        if h != "data:image/jpeg;base64" && h != "data:image/jpg;base64" {
            return Err(ImageError::NotJpeg);
        }
        rest
    } else {
        trimmed
    };

    let clean: Vec<u8> = body
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.is_empty() {
        return Err(ImageError::Empty);
    }
    if clean.len() % 4 != 0 {
        return Err(ImageError::NotJpeg);
    }

    let max_decoded_len = (clean.len() / 4) * 3;
    if max_decoded_len > MAX_IMAGE_BYTES + 3 {
        return Err(ImageError::TooLarge);
    }

    let mut out = Vec::with_capacity(max_decoded_len);
    for (idx, quad) in clean.chunks_exact(4).enumerate() {
        let is_last = idx + 1 == clean.len() / 4;
        let a = b64_val(quad[0]).ok_or(ImageError::NotJpeg)?;
        let b = b64_val(quad[1]).ok_or(ImageError::NotJpeg)?;

        match (quad[2], quad[3]) {
            (b'=', b'=') if is_last => {
                let n = (u32::from(a) << 18) | (u32::from(b) << 12);
                out.push(((n >> 16) & 0xFF) as u8);
            }
            (c_ch, b'=') if is_last => {
                let c = b64_val(c_ch).ok_or(ImageError::NotJpeg)?;
                let n = (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6);
                out.push(((n >> 16) & 0xFF) as u8);
                out.push(((n >> 8) & 0xFF) as u8);
            }
            (b'=', _) | (_, b'=') => return Err(ImageError::NotJpeg),
            (c_ch, d_ch) => {
                let c = b64_val(c_ch).ok_or(ImageError::NotJpeg)?;
                let d = b64_val(d_ch).ok_or(ImageError::NotJpeg)?;
                let n = (u32::from(a) << 18)
                    | (u32::from(b) << 12)
                    | (u32::from(c) << 6)
                    | u32::from(d);
                out.push(((n >> 16) & 0xFF) as u8);
                out.push(((n >> 8) & 0xFF) as u8);
                out.push((n & 0xFF) as u8);
            }
        }
    }

    if out.is_empty() {
        return Err(ImageError::Empty);
    }
    if out.len() > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    Ok(out)
}

const fn b64_val(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Errors produced when validating or managing a product's image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    Empty,
    TooLarge,
    NotJpeg,
    DimensionsInvalid,
    NotFound,
}

impl ImageError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Empty => "IMAGE_EMPTY",
            Self::TooLarge => "IMAGE_TOO_LARGE",
            Self::NotJpeg => "IMAGE_NOT_JPEG",
            Self::DimensionsInvalid => "IMAGE_DIMENSIONS_INVALID",
            Self::NotFound => "IMAGE_NOT_FOUND",
        }
    }
}


impl fmt::Display for ImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ImageError {}
