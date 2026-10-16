//! Reader contract for the legacy export.
//!
//! The legacy system stores each collection under one key (`LOCAL_COLLECTION_MAP`)
//! and each day's transactions under `mshop_d_YYYY-MM-DD` with seven fixed
//! sections (`acc used sw cash exp phones repairs`). dependency: two shapes of
//! the same record coexist because repository writes use `toDatabase()` while
//! older rows were written by hand in local shape. The reader therefore detects
//! shape per record using marker fields, exactly as the legacy read path does
//! (`PARTITION_DB_SHAPE_MARKERS`):
//!
//! ```text
//! acc: snapshotName | used: snapshotName | sw: snapshotName
//! cash: walletName | exp: snapshotCategory | phones: snapshotModelName
//! ```
//!
//! Repairs are the exception the legacy code documents: no repository ever
//! writes them, so they are always local shape. Anything carrying none of the
//! expected fields for its section is `Shape::Unknown`, and unknown is a hard
//! failure, never a guess.

use serde_json::Value;
use std::collections::BTreeMap;

/// The seven daily sections. Fixed by the legacy `loadData()` default.
pub const SECTIONS: [&str; 7] = ["acc", "used", "sw", "cash", "exp", "phones", "repairs"];

/// Collection keys the reader understands. Anything else in the export is
/// reported as unrecognized rather than silently dropped, so a new key in a
/// real backup cannot vanish without anyone noticing.
pub const COLLECTIONS: [&str; 5] = [
    "mshop_inventory",
    "mshop_ca",
    "mshop_cu",
    "mshop_repair_parts",
    "mshop_wallets",
];

/// Reference lists migrated as seeds, never as business rows. Scalars land
/// here too when a whole key is one value: mshop_stagnant_days is a single
/// threshold string, and the importer reads it directly rather than shaping it
/// into records.
pub const REFERENCE_LISTS: [&str; 5] = [
    "mshop_cats",
    "mshop_ce",
    "mshop_fault_types",
    "mshop_brands",
    "mshop_stagnant_days",
];

/// Keys that must never enter the product. `mshop_cfg` holds passwords;
/// the rest is trash, notes, or operational state, each excluded by decision.
pub const EXCLUDED: [&str; 9] = [
    "mshop_cfg",
    "mshop_notes",
    "mshop_notifs",
    "mshop_trash",
    "mshop_jard",
    "mshop_rep_log",
    "mshop_calc_hist",
    "mshop_tab_order",
    "mshop_device_id",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Written through a repository (`toDatabase()`): snapshot*/walletName/id.
    Db,
    /// Written by hand before repositories: name/buy/sell/price/time.
    Local,
    /// Repairs only: the legacy code proves no repository writes them.
    LocalOnly,
    /// Carries none of the expected fields. A hard failure downstream.
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Record {
    /// e.g. `mshop_d_2026-09-20.acc` or `mshop_inventory`.
    pub source: String,
    /// Index inside its array, for error messages that point at the record.
    pub index: usize,
    pub shape: Shape,
    pub value: Value,
}

/// Everything the reader understood, plus everything it did not.
///
/// `unrecognized` keys and `excluded` keys are both reported so the caller can
/// tell "we chose to skip this" apart from "we never saw this before".
#[derive(Debug, Default)]
pub struct Export {
    pub days: BTreeMap<String, BTreeMap<String, Vec<Record>>>,
    pub collections: BTreeMap<String, Vec<Record>>,
    pub reference_lists: BTreeMap<String, Value>,
    pub excluded_present: Vec<String>,
    pub unrecognized: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReaderError {
    NotAnObject,
    InvalidJson(String),
    /// `.mshop` is a backup envelope whose real format is unknown. The reader
    /// refuses it outright rather than misreading bytes as JSON.
    UnsupportedFormat { hint: String },
    DayKeyWithoutSections { key: String },
}

impl std::fmt::Display for ReaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReaderError::NotAnObject => write!(f, "the export must be a JSON object"),
            ReaderError::InvalidJson(e) => write!(f, "invalid JSON: {e}"),
            ReaderError::UnsupportedFormat { hint } => write!(
                f,
                "unsupported export format ({hint}): only plain JSON is accepted until the .mshop envelope is specified"
            ),
            ReaderError::DayKeyWithoutSections { key } => {
                write!(f, "{key} is not a day object with sections")
            }
        }
    }
}

impl std::error::Error for ReaderError {}

/// Reads a plain-JSON legacy export. Anything else is refused by [`read_bytes`].
pub fn read_str(text: &str) -> Result<Export, ReaderError> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| ReaderError::InvalidJson(e.to_string()))?;
    read_value(&value)
}

/// Sniffs the envelope before parsing: JSON objects start with `{`, and a
/// `.mshop` backup does not. The hint names what was seen so the failure
/// explains itself.
pub fn read_bytes(bytes: &[u8]) -> Result<Export, ReaderError> {
    let start = bytes.iter().find(|b| !b.is_ascii_whitespace());
    match start {
        Some(b'{') => read_str(std::str::from_utf8(bytes).map_err(|e| {
            ReaderError::InvalidJson(format!("not UTF-8 JSON: {e}"))
        })?),
        Some(_) => Err(ReaderError::UnsupportedFormat {
            hint: "not a JSON object; .mshop envelopes are not accepted".to_string(),
        }),
        None => Err(ReaderError::InvalidJson("empty input".to_string())),
    }
}

fn read_value(value: &Value) -> Result<Export, ReaderError> {
    let map = value.as_object().ok_or(ReaderError::NotAnObject)?;
    let mut out = Export::default();

    for (key, content) in map {
        if key.starts_with("_") {
            continue;
        }
        if key.starts_with("mshop_d_") {
            read_day(&mut out, key, content)?;
        } else if *key == "mshop_wallets" {
            // Configuration object ({order, limits, opening}), not records.
            // A non-object here is malformed config, not an empty day.
            match content {
                Value::Object(_) => out.collections.insert(
                    key.clone(),
                    vec![Record {
                        source: key.clone(),
                        index: 0,
                        shape: Shape::Local,
                        value: content.clone(),
                    }],
                ),
                _ => {
                    return Err(ReaderError::DayKeyWithoutSections {
                        key: format!("{key} is not a wallets object"),
                    })
                }
            };
        } else if COLLECTIONS.contains(&key.as_str()) {
            out.collections.insert(
                key.clone(),
                read_array(&section_source(key), content, &|v, i| {
                    collection_shape(key, v, i)
                }),
            );
        } else if REFERENCE_LISTS.contains(&key.as_str()) || key == "mshop_brands2" {
            out.reference_lists.insert(key.clone(), content.clone());
        } else if EXCLUDED.contains(&key.as_str())
            || key == "mshop_catalog"
            || key == "mshop_backup_history_log"
            || key.starts_with("mshop_backup_reminder")
            || key == "mshop_last_backup"
            || key == "mshop_emergency_backup"
        {
            out.excluded_present.push(key.clone());
        } else {
            out.unrecognized.push(key.clone());
        }
    }
    out.excluded_present.sort();
    out.unrecognized.sort();
    Ok(out)
}

fn section_source(key: &str) -> String {
    key.to_string()
}

fn read_day(out: &mut Export, key: &str, content: &Value) -> Result<(), ReaderError> {
    let day = content
        .as_object()
        .ok_or_else(|| ReaderError::DayKeyWithoutSections { key: key.to_string() })?;
    let mut sections = BTreeMap::new();
    for section in SECTIONS {
        let records = match day.get(section) {
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(i, v)| Record {
                    source: format!("{key}.{section}"),
                    index: i,
                    shape: detect_shape(section, v),
                    value: v.clone(),
                })
                .collect(),
            Some(_) => {
                return Err(ReaderError::DayKeyWithoutSections {
                    key: format!("{key}.{section} is not an array"),
                })
            }
            None => Vec::new(),
        };
        sections.insert(section.to_string(), records);
    }
    out.days.insert(key.to_string(), sections);
    Ok(())
}

fn read_array(
    source: &str,
    content: &Value,
    shape_of: &dyn Fn(&Value, usize) -> (Shape, Value),
) -> Vec<Record> {
    match content {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let (shape, value) = shape_of(v, i);
                Record { source: source.to_string(), index: i, shape, value }
            })
            .collect(),
        other => vec![Record {
            source: source.to_string(),
            index: 0,
            shape: Shape::Unknown,
            value: other.clone(),
        }],
    }
}

fn collection_shape(_key: &str, value: &Value, _index: usize) -> (Shape, Value) {
    // Collections have a single hand-written shape each; the per-record Db/Local
    // split only exists inside daily sections. A non-object here is unknown.
    if value.is_object() {
        (Shape::Local, value.clone())
    } else {
        (Shape::Unknown, value.clone())
    }
}

/// Marker-based shape detection, mirroring `PARTITION_DB_SHAPE_MARKERS`.
/// `mshop_wallets` is configuration (`{order, limits, opening}`), not records,
/// so it is never shape-detected: the mapping reads its fields directly.
///
/// A record carrying the marker is Db. A record without it is Local ONLY if it
/// carries at least one field the local shape is known to use; otherwise it is
/// Unknown. The distinction matters: `{"mystery": 1}` in acc must stop the
/// import, not slide through as a local row with every field missing.
pub fn detect_shape(section: &str, value: &Value) -> Shape {
    if section == "repairs" {
        return if value.is_object() { Shape::LocalOnly } else { Shape::Unknown };
    }
    let marker: Option<&str> = match section {
        "acc" | "used" | "sw" => Some("snapshotName"),
        "cash" => Some("walletName"),
        "exp" => Some("snapshotCategory"),
        "phones" => Some("snapshotModelName"),
        _ => None,
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Shape::Unknown,
    };
    match marker {
        Some(m) if obj.contains_key(m) => Shape::Db,
        Some(_) if has_any(obj, local_fields(section)) => Shape::Local,
        Some(_) => Shape::Unknown,
        None => Shape::Unknown,
    }
}

/// Fields the hand-written local shape is evidenced to use, per section.
/// Sourced from the writer functions (addAcc/addUsed/addSw/addCash/exp writers
/// and the phone sale writer), not from any single example row.
fn local_fields(section: &str) -> &'static [&'static str] {
    match section {
        "acc" => &["name", "mainCat", "buy", "sell", "profit", "qty", "time"],
        "used" => &["name", "buy", "sell", "profit", "note", "time"],
        "sw" => &["name", "price", "note", "paid", "delivered", "time"],
        "cash" => &["cashType", "service", "amount", "time"],
        "exp" => &["category", "amount", "time"],
        "phones" => &["model", "name", "brand", "buyPrice", "sellPrice", "profit", "qty", "time"],
        _ => &[],
    }
}

fn has_any(obj: &serde_json::Map<String, Value>, fields: &[&str]) -> bool {
    fields.iter().any(|f| obj.contains_key(*f))
}
