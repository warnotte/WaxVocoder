//! Note names for sung melodies, separated by spaces: scientific pitch
//! (`A4` = 440 Hz, `C#3`, `Eb2`) or French solfège with the French octave
//! numbering (`la3` = 440 Hz, `ré#2`, `sib1`).

#[derive(Debug, Default, PartialEq)]
pub struct Melody {
    /// Note frequencies in Hz, in order.
    pub notes: Vec<f32>,
    /// Tokens that are not a note between 40 and 800 Hz.
    pub invalid: Vec<String>,
}

const SOLFEGE: [(&str, i32); 7] = [
    ("do", 0),
    ("re", 2),
    ("mi", 4),
    ("fa", 5),
    ("sol", 7),
    ("la", 9),
    ("si", 11),
];

pub fn parse_melody(text: &str) -> Melody {
    let mut melody = Melody::default();
    for token in text.split_whitespace() {
        match parse_note(token) {
            Some(frequency) => melody.notes.push(frequency),
            None => melody.invalid.push(token.to_string()),
        }
    }
    melody
}

fn parse_note(token: &str) -> Option<f32> {
    let lower = token
        .to_lowercase()
        .replace('é', "e")
        .replace('♯', "#")
        .replace('♭', "b");
    let (class, rest, octave_offset) =
        match SOLFEGE.iter().find(|(name, _)| lower.starts_with(name)) {
            Some(&(name, class)) => (class, &lower[name.len()..], 2),
            None => {
                let class = match lower.chars().next()? {
                    'c' => 0,
                    'd' => 2,
                    'e' => 4,
                    'f' => 5,
                    'g' => 7,
                    'a' => 9,
                    'b' => 11,
                    _ => return None,
                };
                (class, &lower[1..], 1)
            }
        };
    let (accidental, digits) = match rest.as_bytes().first() {
        Some(b'#') => (1, &rest[1..]),
        Some(b'b') if rest.len() > 1 => (-1, &rest[1..]),
        _ => (0, rest),
    };
    let octave: i32 = digits.parse().ok()?;
    let midi = 12 * (octave + octave_offset) + class + accidental;
    let frequency = 440.0 * 2f32.powf((midi - 69) as f32 / 12.0);
    (40.0..=800.0).contains(&frequency).then_some(frequency)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(actual: f32, expected: f32) -> bool {
        (actual - expected).abs() < 0.01
    }

    #[test]
    fn parses_scientific_and_french_names() {
        let melody = parse_melody("A2 la1 C#3 ré#2 Bb2 sib1 sol2");
        assert!(melody.invalid.is_empty());
        let expected = [110.0, 110.0, 138.59, 155.56, 116.54, 116.54, 196.0];
        for (actual, expected) in melody.notes.iter().zip(expected) {
            assert!(close(*actual, expected), "{actual} != {expected}");
        }
    }

    #[test]
    fn reports_invalid_and_out_of_range_tokens() {
        let melody = parse_melody("A2 H2 C9 do");
        assert_eq!(melody.notes.len(), 1);
        assert_eq!(melody.invalid, ["H2", "C9", "do"]);
    }
}
