//! How the screens look and how the shop/receipt profile is configured
//! (DESIGN.md; plan items 1.6, 1.7, and 1.13; ADR-022).
//!
//! Display, POS, shop, and receipt choices, stored as `app_settings` rows
//! under the `ui.` prefix. They are not secret, so they can be read before
//! anyone signs in — the sign-in screen is drawn in the shop's own look.
//!
//! Kept apart from [`super::SettingsSnapshot`] on purpose: that snapshot is
//! read inside every sale, and a display choice must never be able to fail a
//! sale. The snapshot loader skips this prefix by name.

use super::SettingsError;

/// The `app_settings` key prefix that belongs to this slice.
pub const APPEARANCE_PREFIX: &str = "ui.";

/// One display, POS, shop, or receipt choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppearanceKey {
    Look,
    Theme,
    Accent,
    Font,
    Scale,
    Digits,
    MoneyUnit,
    Images,
    ImeiMode,
    PayMethods,
    DiscountLimitPct,
    ShopName,
    ShopPhone,
    ShopAddress,
    ReceiptFooter,
    WaTemplate,
    ReceiptMode,
    PrinterEnabled,
    ReceiptPaper,
    WarrantyNew,
    WarrantyUsed,
    WarrantyItem,
    SellerCanCloseShift,
    ServiceFeeMode,
    ServiceFeePct,
    ServiceFeeMin,
    BillFee,
    BackupOnShift,
    BackupEvery2h,
    BackupUsbAuto,
    BackupVerify,
}

impl AppearanceKey {
    pub const ALL: [AppearanceKey; 31] = [
        AppearanceKey::Look,
        AppearanceKey::Theme,
        AppearanceKey::Accent,
        AppearanceKey::Font,
        AppearanceKey::Scale,
        AppearanceKey::Digits,
        AppearanceKey::MoneyUnit,
        AppearanceKey::Images,
        AppearanceKey::ImeiMode,
        AppearanceKey::PayMethods,
        AppearanceKey::DiscountLimitPct,
        AppearanceKey::ShopName,
        AppearanceKey::ShopPhone,
        AppearanceKey::ShopAddress,
        AppearanceKey::ReceiptFooter,
        AppearanceKey::WaTemplate,
        AppearanceKey::ReceiptMode,
        AppearanceKey::PrinterEnabled,
        AppearanceKey::ReceiptPaper,
        AppearanceKey::WarrantyNew,
        AppearanceKey::WarrantyUsed,
        AppearanceKey::WarrantyItem,
        AppearanceKey::SellerCanCloseShift,
        AppearanceKey::ServiceFeeMode,
        AppearanceKey::ServiceFeePct,
        AppearanceKey::ServiceFeeMin,
        AppearanceKey::BillFee,
        AppearanceKey::BackupOnShift,
        AppearanceKey::BackupEvery2h,
        AppearanceKey::BackupUsbAuto,
        AppearanceKey::BackupVerify,
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
            // The unit on the glass, not a second way to store money (`ADR-044`).
            AppearanceKey::MoneyUnit => "ui.money_unit",
            AppearanceKey::Images => "ui.images",
            AppearanceKey::ImeiMode => "ui.imei_mode",
            AppearanceKey::PayMethods => "ui.pay_methods",
            AppearanceKey::DiscountLimitPct => "ui.discount_limit_pct",
            AppearanceKey::ShopName => "ui.shop_name",
            AppearanceKey::ShopPhone => "ui.shop_phone",
            AppearanceKey::ShopAddress => "ui.shop_address",
            AppearanceKey::ReceiptFooter => "ui.receipt_footer",
            AppearanceKey::WaTemplate => "ui.wa_template",
            AppearanceKey::ReceiptMode => "ui.receipt_mode",
            AppearanceKey::PrinterEnabled => "ui.printer_enabled",
            AppearanceKey::ReceiptPaper => "ui.receipt_paper",
            AppearanceKey::WarrantyNew => "ui.warranty_new",
            AppearanceKey::WarrantyUsed => "ui.warranty_used",
            AppearanceKey::WarrantyItem => "ui.warranty_item",
            AppearanceKey::SellerCanCloseShift => "ui.seller_can_close_shift",
            AppearanceKey::ServiceFeeMode => "ui.service_fee_mode",
            AppearanceKey::ServiceFeePct => "ui.service_fee_pct",
            AppearanceKey::ServiceFeeMin => "ui.service_fee_min",
            AppearanceKey::BillFee => "ui.bill_fee",
            AppearanceKey::BackupOnShift => "ui.backup_on_shift",
            AppearanceKey::BackupEvery2h => "ui.backup_every_2h",
            AppearanceKey::BackupUsbAuto => "ui.backup_usb_auto",
            AppearanceKey::BackupVerify => "ui.backup_verify",
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

    /// Whether the owner may toggle this choice under [`Permission::ManageCatalog`]
    /// alongside category, brand, payment, discount, shop, receipt, and warranty cards.
    pub fn is_catalog_choice(self) -> bool {
        matches!(
            self,
            AppearanceKey::MoneyUnit
                | AppearanceKey::Images
                | AppearanceKey::ImeiMode
                | AppearanceKey::PayMethods
                | AppearanceKey::DiscountLimitPct
                | AppearanceKey::ShopName
                | AppearanceKey::ShopPhone
                | AppearanceKey::ShopAddress
                | AppearanceKey::ReceiptFooter
                | AppearanceKey::WaTemplate
                | AppearanceKey::ReceiptMode
                | AppearanceKey::PrinterEnabled
                | AppearanceKey::ReceiptPaper
                | AppearanceKey::WarrantyNew
                | AppearanceKey::WarrantyUsed
                | AppearanceKey::WarrantyItem
                | AppearanceKey::SellerCanCloseShift
                | AppearanceKey::ServiceFeeMode
                | AppearanceKey::ServiceFeePct
                | AppearanceKey::ServiceFeeMin
                | AppearanceKey::BillFee
                | AppearanceKey::BackupOnShift
                | AppearanceKey::BackupEvery2h
                | AppearanceKey::BackupUsbAuto
                | AppearanceKey::BackupVerify
        )
    }
}

/// Canonical order of all supported invoice payment methods (`ADR-020`).
pub const CANONICAL_PAY_METHODS: [&str; 6] = [
    "cash", "vf", "instapay", "card", "install", "credit",
];

/// Default enabled payment methods (`ADR-020` §1: all enabled).
pub const DEFAULT_PAY_METHODS: &str = "cash,vf,instapay,card,install,credit";

/// Validate and canonicalize a comma-separated list of enabled payment methods.
///
/// `"cash"` is mandatory and cannot be disabled; every other token must be one
/// of [`CANONICAL_PAY_METHODS`] with no duplicates.
pub fn parse_pay_methods(raw: &str) -> Option<String> {
    let mut seen: Vec<&str> = Vec::new();
    for part in raw.split(',') {
        let token = part.trim();
        let canonical = CANONICAL_PAY_METHODS
            .iter()
            .copied()
            .find(|candidate| candidate.eq_ignore_ascii_case(token))?;
        if seen.contains(&canonical) {
            return None;
        }
        seen.push(canonical);
    }
    if !seen.contains(&"cash") {
        return None;
    }
    let ordered: Vec<&str> = CANONICAL_PAY_METHODS
        .iter()
        .copied()
        .filter(|m| seen.contains(m))
        .collect();
    Some(ordered.join(","))
}

/// Default seller discount limit percentage without owner PIN approval (`ADR-021`, `PLAN.md` §4).
pub const DEFAULT_DISCOUNT_LIMIT_PCT: &str = "5";

/// What the shop types and reads: pounds, the way a counter speaks. The stored
/// amount is always piastres (`ADR-010`); `piastre` is for shops that price in them.
pub const DEFAULT_MONEY_UNIT: &str = "egp";

/// Default shop and receipt settings (`ADR-022`, `PLAN.md` §10, §16).
pub const DEFAULT_SHOP_NAME: &str = "موبايل ستور";
pub const DEFAULT_SHOP_PHONE: &str = "01000000000";
pub const DEFAULT_SHOP_ADDRESS: &str = "12 شارع شبرا، القاهرة";
pub const DEFAULT_RECEIPT_FOOTER: &str =
    "شكرًا لزيارتكم. الاستبدال خلال 14 يوم بالفاتورة والعلبة.";
pub const DEFAULT_WA_TEMPLATE: &str =
    "أهلاً {الاسم}، دي فاتورتك رقم {رقم} من {المحل}. الضمان لحد {تاريخ_الضمان}.";
pub const DEFAULT_RECEIPT_MODE: &str = "wa";
pub const DEFAULT_PRINTER_ENABLED: &str = "off";
pub const DEFAULT_RECEIPT_PAPER: &str = "80";

/// Default warranty months (`ADR-023`, `PLAN.md` §16, §19).
pub const DEFAULT_WARRANTY_NEW: &str = "12";
pub const DEFAULT_WARRANTY_USED: &str = "1";
pub const DEFAULT_WARRANTY_ITEM: &str = "0";

/// Default seller shift-closing permission (`ADR-024`, `docs/ui/mockup-v1/pos.js`).
pub const DEFAULT_SELLER_CAN_CLOSE_SHIFT: &str = "off";

/// Default service commission settings (`ADR-025`, `PLAN.md` §9, §16).
pub const DEFAULT_SERVICE_FEE_MODE: &str = "manual";
pub const DEFAULT_SERVICE_FEE_PCT: &str = "1";
pub const DEFAULT_SERVICE_FEE_MIN: &str = "5";
pub const DEFAULT_BILL_FEE: &str = "5";

/// Default automatic backup policy settings (`ADR-027`, `PLAN.md` §17, §19).
pub const DEFAULT_BACKUP_ON_SHIFT: &str = "on";
pub const DEFAULT_BACKUP_EVERY_2H: &str = "on";
pub const DEFAULT_BACKUP_USB_AUTO: &str = "on";
pub const DEFAULT_BACKUP_VERIFY: &str = "on";

/// Parse and canonicalize a whole-EGP service fee (`0..=10000`).
pub fn parse_service_fee_egp(raw: &str) -> Option<(u16, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let egp: u16 = trimmed.parse().ok()?;
    if egp > 10_000 {
        return None;
    }
    Some((egp, egp.to_string()))
}

/// Parse and canonicalize a discount limit percentage (`0..=100`).
pub fn parse_discount_limit_pct(raw: &str) -> Option<(u8, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let pct: u8 = trimmed.parse().ok()?;
    if pct > 100 {
        return None;
    }
    Some((pct, pct.to_string()))
}

/// Parse and canonicalize default warranty months (`0..=60`).
pub fn parse_warranty_months(raw: &str) -> Option<(u8, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let months: u8 = trimmed.parse().ok()?;
    if months > 60 {
        return None;
    }
    Some((months, months.to_string()))
}

fn validate_single_line_text(
    raw: &str,
    allow_empty: bool,
    max_chars: usize,
) -> Option<String> {
    let trimmed = raw.trim();
    if !allow_empty && trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > max_chars || trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn validate_multiline_text(
    raw: &str,
    allow_empty: bool,
    max_chars: usize,
) -> Option<String> {
    let normalized = raw.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if !allow_empty && trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > max_chars
        || trimmed.chars().any(|c| c.is_control() && c != '\n')
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn validate_phone_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > 40 {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' ' | '(' | ')'))
    {
        return None;
    }
    Some(trimmed.to_owned())
}

/// The current display, POS, shop, and receipt choices, defaults applied for anything never set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appearance {
    pub look: String,
    pub theme: String,
    pub accent: String,
    pub font: String,
    pub scale: String,
    pub digits: String,
    pub money_unit: String,
    pub images: String,
    pub imei_mode: String,
    pub pay_methods: String,
    pub discount_limit_pct: String,
    pub shop_name: String,
    pub shop_phone: String,
    pub shop_address: String,
    pub receipt_footer: String,
    pub wa_template: String,
    pub receipt_mode: String,
    pub printer_enabled: String,
    pub receipt_paper: String,
    pub warranty_new: String,
    pub warranty_used: String,
    pub warranty_item: String,
    pub seller_can_close_shift: String,
    pub service_fee_mode: String,
    pub service_fee_pct: String,
    pub service_fee_min: String,
    pub bill_fee: String,
    pub backup_on_shift: String,
    pub backup_every_2h: String,
    pub backup_usb_auto: String,
    pub backup_verify: String,
}

impl Default for Appearance {
    /// The approved defaults: «لافتة الشارع», light, the navy shop colour, the
    /// look's own font, normal size, Latin digits, product images on, IMEI
    /// mode optional, all payment methods enabled, 5% seller discount limit,
    /// shop/receipt profile defaults, default warranty periods (12 months
    /// new phone, 1 month used phone, 0 months accessory), and manual service
    /// commission mode
    /// (docs/ui/REDESIGN.md, ADR-018 §5, ADR-019 §2, ADR-020 §1, ADR-021 §2, ADR-022 §2, ADR-023, ADR-024, ADR-025, ADR-027).
    fn default() -> Self {
        Self {
            look: "plate".to_owned(),
            theme: "light".to_owned(),
            accent: "#1d4f91".to_owned(),
            font: "auto".to_owned(),
            scale: "normal".to_owned(),
            digits: "latin".to_owned(),
            money_unit: DEFAULT_MONEY_UNIT.to_owned(),
            images: "on".to_owned(),
            imei_mode: "optional".to_owned(),
            pay_methods: DEFAULT_PAY_METHODS.to_owned(),
            discount_limit_pct: DEFAULT_DISCOUNT_LIMIT_PCT.to_owned(),
            shop_name: DEFAULT_SHOP_NAME.to_owned(),
            shop_phone: DEFAULT_SHOP_PHONE.to_owned(),
            shop_address: DEFAULT_SHOP_ADDRESS.to_owned(),
            receipt_footer: DEFAULT_RECEIPT_FOOTER.to_owned(),
            wa_template: DEFAULT_WA_TEMPLATE.to_owned(),
            receipt_mode: DEFAULT_RECEIPT_MODE.to_owned(),
            printer_enabled: DEFAULT_PRINTER_ENABLED.to_owned(),
            receipt_paper: DEFAULT_RECEIPT_PAPER.to_owned(),
            warranty_new: DEFAULT_WARRANTY_NEW.to_owned(),
            warranty_used: DEFAULT_WARRANTY_USED.to_owned(),
            warranty_item: DEFAULT_WARRANTY_ITEM.to_owned(),
            seller_can_close_shift: DEFAULT_SELLER_CAN_CLOSE_SHIFT.to_owned(),
            service_fee_mode: DEFAULT_SERVICE_FEE_MODE.to_owned(),
            service_fee_pct: DEFAULT_SERVICE_FEE_PCT.to_owned(),
            service_fee_min: DEFAULT_SERVICE_FEE_MIN.to_owned(),
            bill_fee: DEFAULT_BILL_FEE.to_owned(),
            backup_on_shift: DEFAULT_BACKUP_ON_SHIFT.to_owned(),
            backup_every_2h: DEFAULT_BACKUP_EVERY_2H.to_owned(),
            backup_usb_auto: DEFAULT_BACKUP_USB_AUTO.to_owned(),
            backup_verify: DEFAULT_BACKUP_VERIFY.to_owned(),
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
        match parsed {
            AppearanceKey::PayMethods => {
                let canonical =
                    parse_pay_methods(value).ok_or_else(|| SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "invalid enabled payment methods list (cash must stay enabled)",
                    })?;
                self.pay_methods = canonical;
                return Ok(());
            }
            AppearanceKey::DiscountLimitPct => {
                let (_pct, canonical) = parse_discount_limit_pct(value).ok_or_else(|| {
                    SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "discount limit percentage must be an integer between 0 and 100",
                    }
                })?;
                self.discount_limit_pct = canonical;
                return Ok(());
            }
            AppearanceKey::ShopName => {
                let clean =
                    validate_single_line_text(value, false, 120).ok_or_else(|| {
                        SettingsError::MalformedValue {
                            key: parsed.as_str().to_owned(),
                            reason: "shop name must be non-empty and at most 120 characters",
                        }
                    })?;
                self.shop_name = clean;
                return Ok(());
            }
            AppearanceKey::ShopPhone => {
                let clean = validate_phone_text(value).ok_or_else(|| {
                    SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "shop phone must be at most 40 phone characters",
                    }
                })?;
                self.shop_phone = clean;
                return Ok(());
            }
            AppearanceKey::ShopAddress => {
                let clean =
                    validate_single_line_text(value, true, 200).ok_or_else(|| {
                        SettingsError::MalformedValue {
                            key: parsed.as_str().to_owned(),
                            reason: "shop address must be at most 200 characters",
                        }
                    })?;
                self.shop_address = clean;
                return Ok(());
            }
            AppearanceKey::ReceiptFooter => {
                let clean =
                    validate_multiline_text(value, true, 500).ok_or_else(|| {
                        SettingsError::MalformedValue {
                            key: parsed.as_str().to_owned(),
                            reason: "receipt footer must be at most 500 characters",
                        }
                    })?;
                self.receipt_footer = clean;
                return Ok(());
            }
            AppearanceKey::WaTemplate => {
                let clean =
                    validate_multiline_text(value, false, 1000).ok_or_else(|| {
                        SettingsError::MalformedValue {
                            key: parsed.as_str().to_owned(),
                            reason: "WhatsApp template must be non-empty and at most 1000 characters",
                        }
                    })?;
                self.wa_template = clean;
                return Ok(());
            }
            AppearanceKey::WarrantyNew
            | AppearanceKey::WarrantyUsed
            | AppearanceKey::WarrantyItem => {
                let (_months, canonical) = parse_warranty_months(value).ok_or_else(|| {
                    SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "warranty months must be an integer between 0 and 60",
                    }
                })?;
                match parsed {
                    AppearanceKey::WarrantyNew => self.warranty_new = canonical,
                    AppearanceKey::WarrantyUsed => self.warranty_used = canonical,
                    AppearanceKey::WarrantyItem => self.warranty_item = canonical,
                    _ => unreachable!(),
                }
                return Ok(());
            }
            AppearanceKey::ServiceFeePct => {
                let (_pct, canonical) = parse_discount_limit_pct(value).ok_or_else(|| {
                    SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "service fee percentage must be an integer between 0 and 100",
                    }
                })?;
                self.service_fee_pct = canonical;
                return Ok(());
            }
            AppearanceKey::ServiceFeeMin | AppearanceKey::BillFee => {
                let (_egp, canonical) = parse_service_fee_egp(value).ok_or_else(|| {
                    SettingsError::MalformedValue {
                        key: parsed.as_str().to_owned(),
                        reason: "service fee must be an integer between 0 and 10000 EGP",
                    }
                })?;
                match parsed {
                    AppearanceKey::ServiceFeeMin => self.service_fee_min = canonical,
                    AppearanceKey::BillFee => self.bill_fee = canonical,
                    _ => unreachable!(),
                }
                return Ok(());
            }
            _ => {}
        }

        let allowed = match parsed {
            AppearanceKey::Look => matches!(value, "plate" | "box"),
            AppearanceKey::Theme => matches!(value, "light" | "dark" | "auto"),
            AppearanceKey::Accent => is_hex_colour(value),
            AppearanceKey::Font => matches!(value, "auto" | "plex" | "cairo" | "tajawal" | "readex"),
            AppearanceKey::Scale => matches!(value, "normal" | "large"),
            AppearanceKey::Digits => matches!(value, "latin" | "arabic"),
            AppearanceKey::MoneyUnit => matches!(value, "egp" | "piastre"),
            AppearanceKey::Images => matches!(value, "on" | "off"),
            AppearanceKey::ImeiMode => matches!(value, "optional" | "required"),
            AppearanceKey::ReceiptMode => matches!(value, "wa" | "none" | "print" | "both"),
            AppearanceKey::PrinterEnabled => matches!(value, "on" | "off"),
            AppearanceKey::ReceiptPaper => matches!(value, "80" | "58"),
            AppearanceKey::SellerCanCloseShift => matches!(value, "on" | "off"),
            AppearanceKey::ServiceFeeMode => matches!(value, "manual" | "auto"),
            AppearanceKey::BackupOnShift
            | AppearanceKey::BackupEvery2h
            | AppearanceKey::BackupUsbAuto
            | AppearanceKey::BackupVerify => matches!(value, "on" | "off"),
            AppearanceKey::PayMethods
            | AppearanceKey::DiscountLimitPct
            | AppearanceKey::ShopName
            | AppearanceKey::ShopPhone
            | AppearanceKey::ShopAddress
            | AppearanceKey::ReceiptFooter
            | AppearanceKey::WaTemplate
            | AppearanceKey::WarrantyNew
            | AppearanceKey::WarrantyUsed
            | AppearanceKey::WarrantyItem
            | AppearanceKey::ServiceFeePct
            | AppearanceKey::ServiceFeeMin
            | AppearanceKey::BillFee => unreachable!(),
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
            AppearanceKey::MoneyUnit => self.money_unit = value,
            AppearanceKey::Images => self.images = value,
            AppearanceKey::ImeiMode => self.imei_mode = value,
            AppearanceKey::ReceiptMode => self.receipt_mode = value,
            AppearanceKey::PrinterEnabled => self.printer_enabled = value,
            AppearanceKey::ReceiptPaper => self.receipt_paper = value,
            AppearanceKey::SellerCanCloseShift => self.seller_can_close_shift = value,
            AppearanceKey::ServiceFeeMode => self.service_fee_mode = value,
            AppearanceKey::BackupOnShift => self.backup_on_shift = value,
            AppearanceKey::BackupEvery2h => self.backup_every_2h = value,
            AppearanceKey::BackupUsbAuto => self.backup_usb_auto = value,
            AppearanceKey::BackupVerify => self.backup_verify = value,
            AppearanceKey::PayMethods
            | AppearanceKey::DiscountLimitPct
            | AppearanceKey::ShopName
            | AppearanceKey::ShopPhone
            | AppearanceKey::ShopAddress
            | AppearanceKey::ReceiptFooter
            | AppearanceKey::WaTemplate
            | AppearanceKey::WarrantyNew
            | AppearanceKey::WarrantyUsed
            | AppearanceKey::WarrantyItem
            | AppearanceKey::ServiceFeePct
            | AppearanceKey::ServiceFeeMin
            | AppearanceKey::BillFee => unreachable!(),
        }
        Ok(())
    }

    /// Whether a payment method code (`cash`, `vf`, `instapay`, `card`,
    /// `install`, `credit`) is currently enabled in settings (`ADR-020` §1).
    pub fn is_pay_method_enabled(&self, method_code: &str) -> bool {
        method_code == "cash" || self.pay_methods.split(',').any(|m| m == method_code)
    }

    /// Numeric seller discount limit percentage (`0..=100`, default `5`, `ADR-021`).
    pub fn discount_limit_pct_num(&self) -> u8 {
        parse_discount_limit_pct(&self.discount_limit_pct)
            .map(|(pct, _)| pct)
            .unwrap_or(5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_approved_look() {
        let a = Appearance::default();
        assert_eq!(
            (a.look.as_str(), a.theme.as_str(), a.accent.as_str()),
            ("plate", "light", "#1d4f91")
        );
        assert_eq!(a.shop_name, DEFAULT_SHOP_NAME);
        assert_eq!(a.receipt_mode, "wa");
        assert_eq!(a.printer_enabled, "off");
        assert_eq!(a.receipt_paper, "80");
        assert_eq!(a.warranty_new, "12");
        assert_eq!(a.warranty_used, "1");
        assert_eq!(a.warranty_item, "0");
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
        assert_eq!(
            a.set("ui.look", "neon").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert_eq!(
            a.set("ui.accent", "#12345").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert!(a.set("ui.accent", "#ABCDEF").is_ok());
        assert_eq!(a.accent, "#abcdef", "stored lower case");
        assert_eq!(
            a.set("ui.nope", "x").map_err(|e| e.code()),
            Err("SETTING_UNKNOWN_KEY")
        );
        assert_eq!(
            a.set("ui.shop_name", "   ").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert_eq!(
            a.set("ui.wa_template", "   ").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert_eq!(
            a.set("ui.receipt_mode", "sms").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert_eq!(
            a.set("ui.receipt_paper", "72").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
        assert!(a.set("ui.warranty_used", "3").is_ok());
        assert_eq!(a.warranty_used, "3");
        assert_eq!(
            a.set("ui.warranty_used", "61").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
    }

    #[test]
    fn money_is_shown_in_pounds_unless_the_owner_chooses_piastres() {
        // The stored amount never changes; only the unit on the glass (`ADR-044`).
        let mut a = Appearance::default();
        assert_eq!(a.money_unit, "egp");
        assert_eq!(
            AppearanceKey::parse("ui.money_unit"),
            Some(AppearanceKey::MoneyUnit)
        );
        assert!(a.set("ui.money_unit", "piastre").is_ok());
        assert_eq!(a.money_unit, "piastre");
        assert!(a.set("ui.money_unit", "EGP").is_ok(), "stored lower case");
        assert_eq!(a.money_unit, "egp");
        assert_eq!(
            a.set("ui.money_unit", "dollar").map_err(|e| e.code()),
            Err("SETTING_VALUE_INVALID")
        );
    }

    #[test]
    fn only_the_theme_is_for_everyone() {
        let everyone: Vec<_> = AppearanceKey::ALL
            .into_iter()
            .filter(|k| k.is_for_everyone())
            .collect();
        assert_eq!(everyone, vec![AppearanceKey::Theme]);
    }
}
