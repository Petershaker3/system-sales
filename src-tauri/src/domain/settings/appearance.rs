//! How the screens look (DESIGN.md; plan items 1.6 and 1.13).
//!
//! Six display choices, stored as `app_settings` rows under the `ui.` prefix:
//! the look («لافتة الشارع» `plate` / «علبة الموبايل» `box`), the theme, the
//! shop colour, the font, the text size and the digit style. They are not
//! business data and not secret, so they can be read before anyone signs in —
//! the sign-in screen is drawn in the shop's own look.
//!
//! Kept apart from [`super::SettingsSnapshot`] on purpose: that snapshot is
//! read inside every sale, and a display choice must never be able to fail a
//! sale. The snapshot loader skips this prefix by name.

use super::SettingsError;

/// The `app_settings` key prefix that belongs to this slice.
pub const APPEARANCE_PREFIX: &str = "ui.";

/// One display choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppearanceKey {
    Look,
    Theme,
    Accent,
    Font,
    Scale,
    Digits,
}

impl AppearanceKey {
    pub const ALL: [AppearanceKey; 6] = [
        AppearanceKey::Look,
        AppearanceKey::Theme,
        AppearanceKey::Accent,
        AppearanceKey::Font,
        AppearanceKey::Scale,
        AppearanceKey::Digits,
    ];

    /// The stored key.
    pub fn as_str(self) -> &'static str {
        match self {
            AppearanceKey::Look => "ui.look",
            AppearanceKey::Theme => "ui.theme",
            AppearanceKey::Accent => "ui.accent",
            AppearanceKey::Font => "ui.font",
            AppearanceKey::Scale => "ui.scale",
            AppearanceKey::Digits => "ui.digits",
        }
    }

    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|candidate| candidate.as_str() == key)
    }

    /// Whether whoever works the counter may change it, or only the owner.
    ///
    /// Only the light/dark switch on the rail is for everyone; the look, the
    /// shop colour, the font, the size and the digits are the owner's choice
    /// from the settings screen.
    pub fn is_for_everyone(self) -> bool {
        matches!(self, AppearanceKey::Theme)
    }
}

/// The current display choices, defaults applied for anything never set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appearance {
    pub look: String,
    pub theme: String,
    pub accent: String,
    pub font: String,
    pub scale: String,
    pub digits: String,
}

impl Default for Appearance {
    /// The approved defaults: «لافتة الشارع», light, the navy shop colour, the
    /// look's own font, normal size, Latin digits (docs/ui/REDESIGN.md).
    fn default() -> Self {
        Self {
            look: "plate".to_owned(),
            theme: "light".to_owned(),
            accent: "#1d4f91".to_owned(),
            font: "auto".to_owned(),
            scale: "normal".to_owned(),
            digits: "latin".to_owned(),
        }
    }
}

fn is_hex_colour(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl Appearance {
    /// Apply one stored or requested value, refusing anything this build does
    /// not know. The same function validates a write and reads a row back, so
    /// the two can never disagree.
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), SettingsError> {
        let parsed = AppearanceKey::parse(key).ok_or_else(|| SettingsError::UnknownKey {
            key: key.to_owned(),
        })?;
        let allowed = match parsed {
            AppearanceKey::Look => matches!(value, "plate" | "box"),
            AppearanceKey::Theme => matches!(value, "light" | "dark" | "auto"),
            AppearanceKey::Accent => is_hex_colour(value),
            AppearanceKey::Font => matches!(value, "auto" | "plex" | "cairo" | "tajawal" | "readex"),
            AppearanceKey::Scale => matches!(value, "normal" | "large"),
            AppearanceKey::Digits => matches!(value, "latin" | "arabic"),
        };
        if !allowed {
            return Err(SettingsError::MalformedValue {
                key: parsed.as_str().to_owned(),
                reason: "not one of the allowed display choices",
            });
        }
        let value = value.to_ascii_lowercase();
        match parsed {
            AppearanceKey::Look => self.look = value,
            AppearanceKey::Theme => self.theme = value,
            AppearanceKey::Accent => self.accent = value,
            AppearanceKey::Font => self.font = value,
            AppearanceKey::Scale => self.scale = value,
            AppearanceKey::Digits => self.digits = value,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_approved_look() {
        let a = Appearance::default();
        assert_eq!((a.look.as_str(), a.theme.as_str(), a.accent.as_str()), ("plate", "light", "#1d4f91"));
    }

    #[test]
    fn every_key_round_trips_its_name() {
        for key in AppearanceKey::ALL {
            assert_eq!(AppearanceKey::parse(key.as_str()), Some(key));
            assert!(key.as_str().starts_with(APPEARANCE_PREFIX));
        }
        assert_eq!(AppearanceKey::parse("invoice_prefix"), None);
    }

    #[test]
    fn values_outside_the_choices_are_refused() {
        let mut a = Appearance::default();
        assert!(a.set("ui.look", "box").is_ok());
        assert_eq!(a.look, "box");
        assert_eq!(a.set("ui.look", "neon").map_err(|e| e.code()), Err("SETTING_VALUE_INVALID"));
        assert_eq!(a.set("ui.accent", "#12345").map_err(|e| e.code()), Err("SETTING_VALUE_INVALID"));
        assert!(a.set("ui.accent", "#ABCDEF").is_ok());
        assert_eq!(a.accent, "#abcdef", "stored lower case");
        assert_eq!(a.set("ui.nope", "x").map_err(|e| e.code()), Err("SETTING_UNKNOWN_KEY"));
    }

    #[test]
    fn only_the_theme_is_for_everyone() {
        let everyone: Vec<_> = AppearanceKey::ALL.into_iter().filter(|k| k.is_for_everyone()).collect();
        assert_eq!(everyone, vec![AppearanceKey::Theme]);
    }
}
