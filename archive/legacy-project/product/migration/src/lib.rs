//! Step 2 of Task 1.4: the legacy reader contract, the mapping specification,
//! and the validation rules. No importer lives here and nothing writes to a
//! database: this crate answers "what does the source mean" so a later importer
//! can answer "what do we store".
//!
//! # The contract, in one paragraph
//!
//! The reader accepts a JSON object whose keys are legacy storage keys
//! (`mshop_inventory`, `mshop_ca`, `mshop_d_YYYY-MM-DD`, ...). Every record it
//! returns is tagged with its source key, its index, and its shape. A section
//! may mix two shapes record by record, which the legacy code proves
//! (`storage.js` read-path compatibility), so shape is detected per record,
//! never per section. Anything the reader cannot classify is a hard failure
//! naming the section, the index, and the keys it saw. The `.mshop` envelope is
//! explicitly unsupported until its real format is known: guessing a binary
//! format is how silent corruption starts.

pub mod mapping;
pub mod reader;
pub mod validation;
