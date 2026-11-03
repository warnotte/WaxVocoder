//! Phoneme inventory and the text protocol accepted by the engine.
//!
//! The first 39 symbols are ARPAbet, the CMUdict set. Extensions cover French
//! and German: `E` /e/, `A` /a/, `O` /o/, `U` /u/, `UE` /y/, `EU` /ø/, `OE` /œ/,
//! `AX` /ə/, nasal vowels `AN` /ɑ̃/, `ON` /ɔ̃/, `IN` /ɛ̃/, `UN` /œ̃/, `RX` /ʁ/,
//! `NY` /ɲ/, `UY` /ɥ/, `X` /x/ and `CC` /ç/.
//!
//! Protocol: whitespace-separated symbols, case-insensitive. Vowels may
//! carry a stress digit (`0` unstressed, `1` primary, `2` secondary; primary
//! when omitted). `|` marks a word boundary without silence, `_` a short pause,
//! `,` `;` `:` a phrase pause, `.` `!` a final pause with falling pitch and `?`
//! a final pause with rising pitch. A phone may carry an explicit duration in
//! milliseconds after a colon (`A1:93`, `K:42`), for instance measured from a
//! reference synthesizer; without it, the duration comes from the rules.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Manner {
    Vowel,
    Diphthong,
    Approximant,
    Nasal,
    Fricative,
    Stop,
    Affricate,
    Aspirate,
}

impl Manner {
    pub fn is_vocalic(self) -> bool {
        matches!(self, Manner::Vowel | Manner::Diphthong)
    }

    pub fn is_sonorant(self) -> bool {
        matches!(
            self,
            Manner::Vowel | Manner::Diphthong | Manner::Approximant | Manner::Nasal
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Labial,
    Labiodental,
    Dental,
    Alveolar,
    Postalveolar,
    Palatal,
    Velar,
    Uvular,
    Glottal,
    Vocalic,
}

/// Number of noise bands of the parallel (frication) branch.
pub const FRICATION_BANDS: usize = 6;

/// Gains of the frication bands: resonators following F2 and F3, fixed
/// resonators at 3.5 kHz, 4.5 kHz and 6 kHz, then the flat bypass path.
pub type FricationShape = [f32; FRICATION_BANDS];

#[derive(Clone, Copy, Debug)]
pub struct PhoneDef {
    pub symbol: &'static str,
    pub manner: Manner,
    pub place: Place,
    pub voiced: bool,
    /// F1–F3 targets in Hz (start targets for diphthongs, loci for stops).
    pub formants: [f32; 3],
    /// End targets of a diphthong glide.
    pub glide_to: Option<[f32; 3]>,
    pub bandwidths: [f32; 3],
    /// Inherent duration in seconds, before stress and rate rules.
    pub duration: f32,
    /// Spectrum of the frication noise or release burst.
    pub frication: FricationShape,
    /// Nasal vowel: the nasal pole/zero pair is coupled during the vowel.
    pub nasalized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stress {
    Unstressed,
    Primary,
    Secondary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    Word,
    Short,
    Comma,
    Period,
    Question,
}

#[derive(Clone, Copy, Debug)]
pub enum Token {
    /// A phone, its stress and an optional explicit duration in seconds.
    Phone(&'static PhoneDef, Stress, Option<f32>),
    Boundary(Boundary),
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub tokens: Vec<Token>,
    pub unknown: Vec<String>,
}

const NO_FRICATION: FricationShape = [0.0; FRICATION_BANDS];
const S_SHAPE: FricationShape = [0.0, 0.0, 0.05, 0.3, 1.0, 0.0];
const SH_SHAPE: FricationShape = [0.0, 1.5, 1.8, 0.8, 0.24, 0.0];
const F_SHAPE: FricationShape = [0.0, 0.0, 0.0, 0.035, 0.065, 0.1];
const TH_SHAPE: FricationShape = [0.0, 0.0, 0.0, 0.06, 0.12, 0.09];
const BURST_LABIAL: FricationShape = [1.0, 0.3, 0.0, 0.0, 0.0, 0.12];
const BURST_ALVEOLAR: FricationShape = [0.0, 0.0, 0.3, 0.6, 0.9, 0.0];
const BURST_VELAR: FricationShape = [0.9, 0.6, 0.15, 0.0, 0.0, 0.0];
const X_SHAPE: FricationShape = [0.7, 0.4, 0.1, 0.0, 0.0, 0.05];
const CC_SHAPE: FricationShape = [0.0, 0.5, 0.9, 0.4, 0.1, 0.0];
const RX_SHAPE: FricationShape = [0.3, 0.15, 0.0, 0.0, 0.0, 0.02];

/// Number of leading [`PHONES`] entries that form the CMUdict ARPAbet set.
pub const ARPABET_SYMBOLS: usize = 39;

const fn vowel(
    symbol: &'static str,
    formants: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Vowel,
        place: Place::Vocalic,
        voiced: true,
        formants,
        glide_to: None,
        bandwidths,
        duration: ms / 1000.0,
        frication: NO_FRICATION,
        nasalized: false,
    }
}

const fn diphthong(
    symbol: &'static str,
    formants: [f32; 3],
    glide_to: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Diphthong,
        place: Place::Vocalic,
        voiced: true,
        formants,
        glide_to: Some(glide_to),
        bandwidths,
        duration: ms / 1000.0,
        frication: NO_FRICATION,
        nasalized: false,
    }
}

const fn approximant(
    symbol: &'static str,
    place: Place,
    formants: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Approximant,
        place,
        voiced: true,
        formants,
        glide_to: None,
        bandwidths,
        duration: ms / 1000.0,
        frication: NO_FRICATION,
        nasalized: false,
    }
}

const fn nasal(
    symbol: &'static str,
    place: Place,
    formants: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Nasal,
        place,
        voiced: true,
        formants,
        glide_to: None,
        bandwidths,
        duration: ms / 1000.0,
        frication: NO_FRICATION,
        nasalized: false,
    }
}

const fn fricative(
    symbol: &'static str,
    place: Place,
    voiced: bool,
    formants: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
    frication: FricationShape,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Fricative,
        place,
        voiced,
        formants,
        glide_to: None,
        bandwidths,
        duration: ms / 1000.0,
        frication,
        nasalized: false,
    }
}

const fn stop(
    symbol: &'static str,
    place: Place,
    voiced: bool,
    formants: [f32; 3],
    ms: f32,
    burst: FricationShape,
) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Stop,
        place,
        voiced,
        formants,
        glide_to: None,
        bandwidths: [80.0, 120.0, 180.0],
        duration: ms / 1000.0,
        frication: burst,
        nasalized: false,
    }
}

const fn affricate(symbol: &'static str, voiced: bool, ms: f32) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Affricate,
        place: Place::Postalveolar,
        voiced,
        formants: [250.0, 1840.0, 2750.0],
        glide_to: None,
        bandwidths: [100.0, 120.0, 250.0],
        duration: ms / 1000.0,
        frication: SH_SHAPE,
        nasalized: false,
    }
}

const fn nasal_vowel(
    symbol: &'static str,
    formants: [f32; 3],
    bandwidths: [f32; 3],
    ms: f32,
) -> PhoneDef {
    PhoneDef {
        nasalized: true,
        ..vowel(symbol, formants, bandwidths, ms)
    }
}

const fn aspirate(symbol: &'static str, ms: f32) -> PhoneDef {
    PhoneDef {
        symbol,
        manner: Manner::Aspirate,
        place: Place::Glottal,
        voiced: false,
        formants: [500.0, 1450.0, 2450.0],
        glide_to: None,
        bandwidths: [300.0, 200.0, 300.0],
        duration: ms / 1000.0,
        frication: NO_FRICATION,
        nasalized: false,
    }
}

/// Male-voice targets adapted from Klatt (1980) and Peterson & Barney (1952);
/// French vowels after Gendrot & Adda-Decker (2005).
pub static PHONES: [PhoneDef; 56] = [
    vowel("AA", [700.0, 1220.0, 2600.0], [130.0, 70.0, 160.0], 240.0),
    vowel("AE", [620.0, 1660.0, 2430.0], [70.0, 130.0, 300.0], 230.0),
    vowel("AH", [620.0, 1220.0, 2550.0], [80.0, 50.0, 140.0], 140.0),
    vowel("AO", [600.0, 990.0, 2570.0], [90.0, 100.0, 80.0], 240.0),
    diphthong(
        "AW",
        [640.0, 1230.0, 2550.0],
        [420.0, 940.0, 2350.0],
        [80.0, 70.0, 140.0],
        240.0,
    ),
    diphthong(
        "AY",
        [660.0, 1200.0, 2550.0],
        [400.0, 1880.0, 2500.0],
        [100.0, 70.0, 200.0],
        250.0,
    ),
    stop(
        "B",
        Place::Labial,
        true,
        [200.0, 900.0, 2100.0],
        75.0,
        BURST_LABIAL,
    ),
    affricate("CH", false, 120.0),
    stop(
        "D",
        Place::Alveolar,
        true,
        [200.0, 1700.0, 2600.0],
        65.0,
        BURST_ALVEOLAR,
    ),
    fricative(
        "DH",
        Place::Dental,
        true,
        [270.0, 1290.0, 2540.0],
        [60.0, 80.0, 170.0],
        50.0,
        TH_SHAPE,
    ),
    vowel("EH", [530.0, 1680.0, 2500.0], [60.0, 90.0, 200.0], 160.0),
    vowel("ER", [470.0, 1270.0, 1540.0], [100.0, 60.0, 110.0], 180.0),
    diphthong(
        "EY",
        [480.0, 1720.0, 2520.0],
        [330.0, 2020.0, 2600.0],
        [70.0, 100.0, 200.0],
        210.0,
    ),
    fricative(
        "F",
        Place::Labiodental,
        false,
        [340.0, 1100.0, 2080.0],
        [200.0, 120.0, 150.0],
        100.0,
        F_SHAPE,
    ),
    stop(
        "G",
        Place::Velar,
        true,
        [200.0, 1900.0, 2400.0],
        75.0,
        BURST_VELAR,
    ),
    aspirate("HH", 65.0),
    vowel("IH", [400.0, 1800.0, 2570.0], [50.0, 100.0, 140.0], 135.0),
    vowel("IY", [310.0, 2020.0, 2960.0], [45.0, 200.0, 400.0], 190.0),
    affricate("JH", true, 100.0),
    stop(
        "K",
        Place::Velar,
        false,
        [200.0, 1900.0, 2400.0],
        85.0,
        BURST_VELAR,
    ),
    approximant(
        "L",
        Place::Alveolar,
        [310.0, 1050.0, 2880.0],
        [50.0, 100.0, 280.0],
        80.0,
    ),
    nasal(
        "M",
        Place::Labial,
        [480.0, 1270.0, 2130.0],
        [40.0, 200.0, 200.0],
        70.0,
    ),
    nasal(
        "N",
        Place::Alveolar,
        [480.0, 1340.0, 2470.0],
        [40.0, 300.0, 300.0],
        60.0,
    ),
    nasal(
        "NG",
        Place::Velar,
        [480.0, 2000.0, 2900.0],
        [40.0, 300.0, 300.0],
        95.0,
    ),
    diphthong(
        "OW",
        [540.0, 1100.0, 2300.0],
        [450.0, 900.0, 2300.0],
        [80.0, 70.0, 70.0],
        220.0,
    ),
    diphthong(
        "OY",
        [550.0, 960.0, 2400.0],
        [360.0, 1820.0, 2450.0],
        [80.0, 50.0, 130.0],
        280.0,
    ),
    stop(
        "P",
        Place::Labial,
        false,
        [200.0, 900.0, 2100.0],
        90.0,
        BURST_LABIAL,
    ),
    approximant(
        "R",
        Place::Alveolar,
        [310.0, 1060.0, 1380.0],
        [70.0, 100.0, 120.0],
        80.0,
    ),
    fricative(
        "S",
        Place::Alveolar,
        false,
        [320.0, 1390.0, 2530.0],
        [200.0, 80.0, 200.0],
        105.0,
        S_SHAPE,
    ),
    fricative(
        "SH",
        Place::Postalveolar,
        false,
        [300.0, 1840.0, 2750.0],
        [200.0, 100.0, 300.0],
        115.0,
        SH_SHAPE,
    ),
    stop(
        "T",
        Place::Alveolar,
        false,
        [200.0, 1700.0, 2600.0],
        75.0,
        BURST_ALVEOLAR,
    ),
    fricative(
        "TH",
        Place::Dental,
        false,
        [320.0, 1290.0, 2540.0],
        [200.0, 90.0, 200.0],
        90.0,
        TH_SHAPE,
    ),
    vowel("UH", [450.0, 1100.0, 2350.0], [80.0, 100.0, 80.0], 160.0),
    diphthong(
        "UW",
        [350.0, 1100.0, 2250.0],
        [320.0, 900.0, 2200.0],
        [65.0, 110.0, 140.0],
        210.0,
    ),
    fricative(
        "V",
        Place::Labiodental,
        true,
        [220.0, 1100.0, 2080.0],
        [60.0, 90.0, 120.0],
        60.0,
        F_SHAPE,
    ),
    approximant(
        "W",
        Place::Labial,
        [290.0, 610.0, 2150.0],
        [50.0, 80.0, 60.0],
        80.0,
    ),
    approximant(
        "Y",
        Place::Palatal,
        [260.0, 2070.0, 3020.0],
        [40.0, 250.0, 500.0],
        80.0,
    ),
    fricative(
        "Z",
        Place::Alveolar,
        true,
        [240.0, 1390.0, 2530.0],
        [70.0, 60.0, 180.0],
        75.0,
        S_SHAPE,
    ),
    fricative(
        "ZH",
        Place::Postalveolar,
        true,
        [300.0, 1840.0, 2750.0],
        [80.0, 100.0, 200.0],
        70.0,
        SH_SHAPE,
    ),
    // French and German extensions.
    vowel("E", [400.0, 2050.0, 2650.0], [50.0, 120.0, 200.0], 150.0),
    vowel("A", [740.0, 1450.0, 2550.0], [90.0, 100.0, 160.0], 170.0),
    vowel("O", [410.0, 840.0, 2400.0], [60.0, 80.0, 120.0], 160.0),
    vowel("U", [310.0, 760.0, 2300.0], [60.0, 80.0, 120.0], 150.0),
    vowel("UE", [290.0, 1750.0, 2100.0], [50.0, 120.0, 150.0], 150.0),
    vowel("EU", [390.0, 1550.0, 2250.0], [60.0, 100.0, 150.0], 160.0),
    vowel("OE", [540.0, 1450.0, 2400.0], [70.0, 100.0, 150.0], 160.0),
    vowel("AX", [480.0, 1450.0, 2450.0], [80.0, 90.0, 150.0], 90.0),
    nasal_vowel("AN", [640.0, 1050.0, 2500.0], [100.0, 100.0, 150.0], 190.0),
    nasal_vowel("ON", [470.0, 850.0, 2450.0], [90.0, 90.0, 140.0], 190.0),
    nasal_vowel("IN", [610.0, 1550.0, 2550.0], [100.0, 110.0, 160.0], 190.0),
    nasal_vowel("UN", [560.0, 1450.0, 2450.0], [100.0, 110.0, 160.0], 190.0),
    fricative(
        "RX",
        Place::Uvular,
        true,
        [550.0, 1250.0, 2550.0],
        [120.0, 150.0, 250.0],
        75.0,
        RX_SHAPE,
    ),
    nasal(
        "NY",
        Place::Palatal,
        [400.0, 2100.0, 2800.0],
        [40.0, 250.0, 300.0],
        80.0,
    ),
    approximant(
        "UY",
        Place::Palatal,
        [270.0, 1800.0, 2150.0],
        [50.0, 150.0, 200.0],
        70.0,
    ),
    fricative(
        "X",
        Place::Velar,
        false,
        [400.0, 1500.0, 2500.0],
        [200.0, 150.0, 250.0],
        95.0,
        X_SHAPE,
    ),
    fricative(
        "CC",
        Place::Palatal,
        false,
        [300.0, 2200.0, 2900.0],
        [200.0, 150.0, 250.0],
        100.0,
        CC_SHAPE,
    ),
];

/// Finds a phoneme by its ARPAbet symbol, ignoring case and stress digits.
pub fn lookup(symbol: &str) -> Option<&'static PhoneDef> {
    let name = symbol.trim_end_matches(['0', '1', '2']);
    PHONES
        .iter()
        .find(|phone| phone.symbol.eq_ignore_ascii_case(name))
}

/// Supported symbols: the ARPAbet set first, then the extensions.
pub fn supported_symbols() -> impl Iterator<Item = &'static str> {
    PHONES.iter().map(|phone| phone.symbol)
}

/// Parses the phoneme protocol. Unknown symbols are skipped and reported.
pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut symbol = String::new();
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        // `A1:93`: a colon between a symbol and digits introduces a duration.
        if character == ':'
            && !symbol.is_empty()
            && characters.peek().is_some_and(char::is_ascii_digit)
        {
            symbol.push(character);
            continue;
        }
        let boundary = match character {
            '|' => Some(Boundary::Word),
            '_' => Some(Boundary::Short),
            ',' | ';' | ':' => Some(Boundary::Comma),
            '.' | '!' => Some(Boundary::Period),
            '?' => Some(Boundary::Question),
            _ => None,
        };
        if character.is_whitespace() || boundary.is_some() {
            flush_symbol(&mut symbol, &mut parsed);
            if let Some(boundary) = boundary {
                parsed.tokens.push(Token::Boundary(boundary));
            }
        } else {
            symbol.push(character);
        }
    }
    flush_symbol(&mut symbol, &mut parsed);
    parsed
}

fn flush_symbol(symbol: &mut String, parsed: &mut Parsed) {
    if symbol.is_empty() {
        return;
    }
    match parse_symbol(symbol) {
        Some(token) => parsed.tokens.push(token),
        None => parsed.unknown.push(symbol.clone()),
    }
    symbol.clear();
}

/// Longest explicit duration accepted, in milliseconds.
const MAX_EXPLICIT_MS: f32 = 5_000.0;

fn parse_symbol(raw: &str) -> Option<Token> {
    let (raw, duration) = match raw.split_once(':') {
        Some((body, milliseconds)) => {
            let value: f32 = milliseconds.parse().ok()?;
            if !(value > 0.0 && value <= MAX_EXPLICIT_MS) {
                return None;
            }
            (body, Some(value / 1000.0))
        }
        None => (raw, None),
    };
    let (name, stress) = match raw.as_bytes().last() {
        Some(b'0') => (&raw[..raw.len() - 1], Some(Stress::Unstressed)),
        Some(b'1') => (&raw[..raw.len() - 1], Some(Stress::Primary)),
        Some(b'2') => (&raw[..raw.len() - 1], Some(Stress::Secondary)),
        _ => (raw, None),
    };
    let phone = PHONES
        .iter()
        .find(|phone| phone.symbol.eq_ignore_ascii_case(name))?;
    if stress.is_some() && !phone.manner.is_vocalic() {
        return None;
    }
    Some(Token::Phone(
        phone,
        stress.unwrap_or(Stress::Primary),
        duration,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbols(parsed: &Parsed) -> Vec<String> {
        parsed
            .tokens
            .iter()
            .map(|token| match token {
                Token::Phone(phone, stress, None) => format!("{}{stress:?}", phone.symbol),
                Token::Phone(phone, stress, Some(seconds)) => {
                    format!("{}{stress:?}@{}", phone.symbol, (seconds * 1000.0).round())
                }
                Token::Boundary(boundary) => format!("{boundary:?}"),
            })
            .collect()
    }

    #[test]
    fn inventory_starts_with_the_cmudict_set_and_has_no_duplicates() {
        let mut symbols: Vec<_> = supported_symbols().collect();
        assert_eq!(symbols.len(), PHONES.len());
        assert!(symbols[..ARPABET_SYMBOLS].is_sorted());
        assert_eq!(symbols[ARPABET_SYMBOLS - 1], "ZH");
        symbols.sort_unstable();
        symbols.dedup();
        assert_eq!(symbols.len(), PHONES.len());
        for phone in &PHONES {
            assert!(phone.duration > 0.0, "{} has no duration", phone.symbol);
            assert!(phone.formants.iter().all(|f| (150.0..3500.0).contains(f)));
        }
    }

    #[test]
    fn parses_stress_case_and_boundaries() {
        let parsed = parse("w iy1 | AA1 r, dh ah0 r ow1 b aa2 t s.?_");
        assert!(parsed.unknown.is_empty());
        assert_eq!(
            symbols(&parsed),
            [
                "WPrimary",
                "IYPrimary",
                "Word",
                "AAPrimary",
                "RPrimary",
                "Comma",
                "DHPrimary",
                "AHUnstressed",
                "RPrimary",
                "OWPrimary",
                "BPrimary",
                "AASecondary",
                "TPrimary",
                "SPrimary",
                "Period",
                "Question",
                "Short",
            ]
        );
    }

    #[test]
    fn reports_unknown_symbols_and_stress_on_consonants() {
        let parsed = parse("K XX AE1 T1 Q");
        assert_eq!(parsed.unknown, ["XX", "T1", "Q"]);
        assert_eq!(parsed.tokens.len(), 2);
    }

    #[test]
    fn parses_explicit_durations_and_keeps_colon_pauses() {
        let parsed = parse("K:42 A2:93 O1:99 : L AX2:60, B:0 T:99999 S:x");
        assert_eq!(
            symbols(&parsed),
            [
                "KPrimary@42",
                "ASecondary@93",
                "OPrimary@99",
                "Comma",
                "LPrimary",
                "AXSecondary@60",
                "Comma",
                "SPrimary",
                "Comma",
                "XPrimary",
            ]
        );
        assert_eq!(parsed.unknown, ["B:0", "T:99999"]);
    }

    #[test]
    fn lookup_ignores_stress_digits() {
        assert_eq!(lookup("ah0").unwrap().symbol, "AH");
        assert!(lookup("QQ").is_none());
    }
}
