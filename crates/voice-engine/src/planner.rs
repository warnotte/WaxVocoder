//! Turns parsed phonemes into time-varying synthesis parameters: durations,
//! stop structure (closure, burst, aspiration), formant transitions, source
//! amplitudes, the pitch contour and, in robot mode, a rhythm grid and a melody.

use crate::phonemes::{
    Boundary, FRICATION_BANDS, FricationShape, Manner, PhoneDef, Place, Stress, Token,
};

/// Nasal pole frequency; the nasal zero sits here (cancelling it) outside nasals.
pub const NASAL_POLE_HZ: f32 = 270.0;
const NASAL_ZERO_HZ: f32 = 450.0;
/// Lighter nasal coupling for nasal vowels, which keep their oral formants.
const NASAL_VOWEL_ZERO_HZ: f32 = 340.0;
const SCHWA: [f32; 3] = [500.0, 1450.0, 2450.0];
const SCHWA_BANDWIDTHS: [f32; 3] = [80.0, 90.0, 150.0];
const PITCH_STEP: f32 = 0.01;

/// Piecewise-linear parameter track, evaluated with a forward-moving cursor.
#[derive(Clone, Debug, Default)]
pub struct Track {
    points: Vec<(f32, f32)>,
}

impl Track {
    fn push(&mut self, time: f32, value: f32) {
        let time = match self.points.last() {
            Some(&(last, _)) => time.max(last),
            None => time,
        };
        self.points.push((time, value));
    }

    pub fn value_at(&self, time: f32, cursor: &mut usize) -> f32 {
        let points = &self.points;
        let Some(&(_, first)) = points.first() else {
            return 0.0;
        };
        if *cursor >= points.len() {
            *cursor = points.len() - 1;
        }
        while *cursor > 0 && points[*cursor].0 > time {
            *cursor -= 1;
        }
        while *cursor + 1 < points.len() && points[*cursor + 1].0 <= time {
            *cursor += 1;
        }
        let (t0, v0) = points[*cursor];
        if *cursor == 0 && time < t0 {
            return first;
        }
        match points.get(*cursor + 1) {
            Some(&(t1, v1)) if t1 > t0 => {
                v0 + (v1 - v0) * ((time - t0) / (t1 - t0)).clamp(0.0, 1.0)
            }
            Some(&(_, v1)) => v1,
            None => v0,
        }
    }
}

/// Options that change timing or pitch, so that the plan must be rebuilt.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanOptions {
    /// Speaking rate multiplier (0.5–2).
    pub rate: f32,
    /// Aspirate voiceless stops before vowels (English, German), not in French.
    pub aspiration: bool,
    /// Robot rhythm: vowel onsets fall on an eighth-note grid at this tempo.
    pub tempo: Option<f32>,
    /// Notes in Hz sung on successive vowels (cycled); empty for speech.
    pub melody: Vec<f32>,
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions {
            rate: 1.0,
            aspiration: true,
            tempo: None,
            melody: Vec::new(),
        }
    }
}

/// All parameter tracks of a phrase.
#[derive(Clone, Debug, Default)]
pub struct Plan {
    /// Speech duration in seconds, pauses included.
    pub duration: f32,
    pub phone_count: usize,
    /// Pitch deviation at full intonation: f0 = base × (1 + intonation × value).
    pub pitch: Track,
    pub voicing: Track,
    pub aspiration: Track,
    pub frication: Track,
    pub nasal_zero: Track,
    pub formants: [Track; 3],
    pub bandwidths: [Track; 3],
    pub frication_shape: [Track; FRICATION_BANDS],
    /// Sung pitch in Hz when a melody is set.
    pub notes: Option<Track>,
}

#[derive(Clone, Copy)]
struct Phone {
    def: &'static PhoneDef,
    stress: Stress,
    phrase_final: bool,
    word_final: bool,
    /// Duration given by the protocol, which replaces the rules.
    explicit: Option<f32>,
    start: f32,
    duration: f32,
    closure: f32,
    burst: f32,
    aspiration: f32,
    voice_bar: bool,
    released: bool,
    target: [f32; 6],
    glide: Option<[f32; 6]>,
}

#[derive(Clone, Copy)]
enum Item {
    Phone(Phone),
    Pause {
        start: f32,
        duration: f32,
        boundary: Boundary,
    },
}

impl Item {
    fn end(&self) -> f32 {
        match self {
            Item::Phone(phone) => phone.start + phone.duration,
            Item::Pause {
                start, duration, ..
            } => start + duration,
        }
    }
}

/// Amplitude slice: constant source levels, joined to the previous slice by a ramp.
#[derive(Clone, Copy)]
struct Slice {
    duration: f32,
    ramp: f32,
    voicing: f32,
    aspiration: f32,
    frication: f32,
    nasal_zero: f32,
    shape: FricationShape,
}

impl Slice {
    fn silent(duration: f32, ramp: f32) -> Self {
        Slice {
            duration,
            ramp,
            voicing: 0.0,
            aspiration: 0.0,
            frication: 0.0,
            nasal_zero: NASAL_POLE_HZ,
            shape: [0.0; FRICATION_BANDS],
        }
    }
}

impl Plan {
    pub fn build(tokens: &[Token], options: &PlanOptions) -> Plan {
        let rate = options.rate.clamp(0.5, 2.0);
        let mut items = layout(tokens, rate, options.aspiration);
        if let Some(tempo) = options
            .tempo
            .filter(|tempo| tempo.is_finite() && *tempo > 0.0)
        {
            // One syllable per eighth note.
            items = apply_tempo(items, 30.0 / tempo.clamp(30.0, 300.0));
        }
        assign_start_times(&mut items);
        assign_targets(&mut items);
        let duration = items.last().map(Item::end).unwrap_or(0.0);
        let phone_count = items
            .iter()
            .filter(|item| matches!(item, Item::Phone(_)))
            .count();
        if phone_count == 0 {
            return Plan::default();
        }

        let slices = amplitude_slices(&items);
        let mut plan = Plan {
            duration,
            phone_count,
            pitch: pitch_track(&items, duration),
            voicing: steps(&slices, |slice| slice.voicing),
            aspiration: steps(&slices, |slice| slice.aspiration),
            frication: steps(&slices, |slice| slice.frication),
            nasal_zero: steps(&slices, |slice| slice.nasal_zero),
            ..Plan::default()
        };
        for band in 0..FRICATION_BANDS {
            plan.frication_shape[band] = steps(&slices, |slice| slice.shape[band]);
        }
        let [f1, f2, f3, b1, b2, b3] = formant_tracks(&items);
        plan.formants = [f1, f2, f3];
        plan.bandwidths = [b1, b2, b3];
        if !options.melody.is_empty() {
            plan.notes = Some(notes_track(&items, &options.melody));
        }
        plan
    }
}

fn pause_duration(boundary: Boundary) -> f32 {
    match boundary {
        Boundary::Word => 0.0,
        Boundary::Short => 0.09,
        Boundary::Comma => 0.2,
        Boundary::Period | Boundary::Question => 0.35,
    }
}

fn ends_phrase(boundary: Boundary) -> bool {
    matches!(
        boundary,
        Boundary::Comma | Boundary::Period | Boundary::Question
    )
}

/// Expands tokens into timed phones and pauses.
fn layout(tokens: &[Token], rate: f32, aspiration: bool) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    for token in tokens {
        match *token {
            Token::Phone(def, stress, explicit) => items.push(Item::Phone(Phone {
                def,
                stress,
                phrase_final: false,
                word_final: false,
                explicit,
                start: 0.0,
                duration: 0.0,
                closure: 0.0,
                burst: 0.0,
                aspiration: 0.0,
                voice_bar: false,
                released: true,
                target: [0.0; 6],
                glide: None,
            })),
            Token::Boundary(Boundary::Word) => {
                if let Some(Item::Phone(phone)) = items.last_mut() {
                    phone.word_final = true;
                }
            }
            Token::Boundary(boundary) if pause_duration(boundary) > 0.0 => {
                if let Some(Item::Phone(phone)) = items.last_mut() {
                    phone.word_final = true;
                }
                items.push(Item::Pause {
                    start: 0.0,
                    duration: pause_duration(boundary) / rate,
                    boundary,
                })
            }
            Token::Boundary(_) => {}
        }
    }

    mark_phrase_final(&mut items);

    let snapshot = items.clone();
    for (index, item) in items.iter_mut().enumerate() {
        let previous = adjacent_phone(&snapshot, index, -1);
        let next = adjacent_phone(&snapshot, index, 1);
        let followed_by_pause = matches!(snapshot.get(index + 1), None | Some(Item::Pause { .. }));
        let Item::Phone(phone) = item else {
            continue;
        };
        let manner = phone.def.manner;
        let mut duration = if let Some(explicit) = phone.explicit {
            explicit / rate
        } else {
            rule_duration(phone, previous, next) / rate
        };

        if matches!(manner, Manner::Stop | Manner::Affricate) {
            phone.burst = match phone.def.place {
                Place::Labial => 0.008,
                Place::Velar => 0.018,
                _ => 0.012,
            } / rate.sqrt();
            phone.released = !(followed_by_pause && manner == Manner::Stop);
            let next_is_sonorant = next.is_some_and(|other| {
                other.def.manner.is_vocalic() || other.def.manner == Manner::Approximant
            });
            let after_s = previous.is_some_and(|other| other.def.symbol == "S");
            if aspiration
                && manner == Manner::Stop
                && !phone.def.voiced
                && next_is_sonorant
                && !after_s
            {
                let stressed = next.is_some_and(|other| {
                    other.def.manner.is_vocalic() && other.stress != Stress::Unstressed
                });
                phone.aspiration = if stressed { 0.05 } else { 0.03 } / rate.sqrt();
            }
            phone.voice_bar = phone.def.voiced && previous.is_some_and(|other| other.def.voiced);
            let frication_part = if manner == Manner::Affricate {
                (0.55 * duration).max(0.045)
            } else {
                0.0
            };
            // An explicit duration already contains the burst and the aspiration.
            let budget = if phone.explicit.is_some() {
                phone.burst = phone.burst.min(0.4 * duration);
                phone.aspiration = phone
                    .aspiration
                    .min((duration - phone.burst - frication_part - 0.012).max(0.0));
                duration - phone.aspiration
            } else {
                duration
            };
            let mut closure = budget - phone.burst - frication_part;
            if previous.is_none() {
                closure = closure.min(0.03);
            }
            phone.closure = closure.max(if phone.explicit.is_some() {
                0.012
            } else {
                0.02
            });
            duration = phone.closure + phone.burst + frication_part + phone.aspiration;
        }
        phone.duration = duration;
    }
    items
}

fn assign_start_times(items: &mut [Item]) {
    let mut time = 0.0;
    for item in items {
        match item {
            Item::Phone(phone) => {
                phone.start = time;
                time += phone.duration;
            }
            Item::Pause {
                start, duration, ..
            } => {
                *start = time;
                time += *duration;
            }
        }
    }
}

fn scale_phone(phone: &mut Phone, factor: f32) {
    phone.duration *= factor;
    phone.closure *= factor;
    phone.burst *= factor;
    phone.aspiration *= factor;
}

fn item_duration(item: &Item) -> f32 {
    match item {
        Item::Phone(phone) => phone.duration,
        Item::Pause { duration, .. } => *duration,
    }
}

fn is_vowel(item: &Item) -> bool {
    matches!(item, Item::Phone(phone) if phone.def.manner.is_vocalic())
}

fn is_phrase_pause(item: &Item) -> bool {
    matches!(item, Item::Pause { boundary, .. } if ends_phrase(*boundary))
}

/// Robot rhythm: every span from a vowel onset to the next one lasts a whole
/// number of beats. Inside a word the vowel absorbs the difference; across a
/// word boundary the word is cut short and a silence ends the beat (staccato).
fn apply_tempo(items: Vec<Item>, beat: f32) -> Vec<Item> {
    let mut output = Vec::with_capacity(items.len() + 8);
    let mut index = 0;
    while index < items.len() {
        if is_phrase_pause(&items[index]) {
            let mut pause = items[index];
            if let Item::Pause { duration, .. } = &mut pause {
                *duration = (*duration / beat).ceil().max(1.0) * beat;
            }
            output.push(pause);
            index += 1;
            continue;
        }
        if !is_vowel(&items[index]) {
            output.push(items[index]);
            index += 1;
            continue;
        }
        let end = (index + 1..items.len())
            .find(|&next| is_vowel(&items[next]) || is_phrase_pause(&items[next]))
            .unwrap_or(items.len());
        let mut span: Vec<Item> = items[index..end].to_vec();
        let natural: f32 = span.iter().map(item_duration).sum();
        let target = (natural / beat).round().max(1.0) * beat;
        let cut = span
            .iter()
            .position(|item| matches!(item, Item::Phone(phone) if phone.word_final));
        // Robot diction: every word ends with a silence of 30 % of its beat.
        let speech = if cut.is_some() { 0.7 * target } else { target };
        if natural > speech {
            let factor = speech / natural;
            for item in &mut span {
                match item {
                    Item::Phone(phone) => scale_phone(phone, factor),
                    Item::Pause { duration, .. } => *duration *= factor,
                }
            }
        } else if let Item::Phone(vowel) = &mut span[0] {
            vowel.duration += speech - natural;
        }
        if let Some(position) = cut {
            span.insert(
                position + 1,
                Item::Pause {
                    start: 0.0,
                    duration: target - speech,
                    boundary: Boundary::Short,
                },
            );
        }
        output.extend(span);
        index = end;
    }
    output
}

/// Sung pitch: each vowel takes the next note, with a short portamento.
fn notes_track(items: &[Item], melody: &[f32]) -> Track {
    let mut track = Track::default();
    let mut current = melody[0];
    track.push(0.0, current);
    for (note_index, phone) in items
        .iter()
        .filter_map(|item| match item {
            Item::Phone(phone) if phone.def.manner.is_vocalic() => Some(phone),
            _ => None,
        })
        .enumerate()
    {
        let note = melody[note_index % melody.len()];
        track.push(phone.start - 0.005, current);
        track.push(phone.start + 0.015, note);
        current = note;
    }
    track
}

/// Duration from the rules: inherent duration, stress, clusters, phrase-final lengthening.
fn rule_duration(phone: &Phone, previous: Option<Phone>, next: Option<Phone>) -> f32 {
    let manner = phone.def.manner;
    let mut duration = match manner {
        Manner::Vowel | Manner::Diphthong => {
            if phone.def.symbol == "AH" && phone.stress == Stress::Unstressed {
                0.065
            } else {
                phone.def.duration
                    * match phone.stress {
                        Stress::Primary => 0.85,
                        Stress::Secondary => 0.72,
                        Stress::Unstressed => 0.55,
                    }
            }
        }
        _ => phone.def.duration * 0.9,
    };
    let in_cluster = !manner.is_vocalic()
        && [previous, next]
            .iter()
            .flatten()
            .any(|other| !other.def.manner.is_vocalic());
    if in_cluster {
        duration *= 0.8;
    }
    if phone.phrase_final {
        duration *= 1.35;
    }
    duration
}

/// Marks the last vowel of every phrase and the consonants after it.
fn mark_phrase_final(items: &mut [Item]) {
    let mut phrase_start = 0;
    for index in 0..=items.len() {
        let at_boundary = match items.get(index) {
            None => true,
            Some(Item::Pause { boundary, .. }) => ends_phrase(*boundary),
            Some(Item::Phone(_)) => false,
        };
        if !at_boundary {
            continue;
        }
        let last_vowel = (phrase_start..index).rev().find(|&candidate| {
            matches!(items[candidate], Item::Phone(phone) if phone.def.manner.is_vocalic())
        });
        if let Some(vowel) = last_vowel {
            for item in &mut items[vowel..index] {
                if let Item::Phone(phone) = item {
                    phone.phrase_final = true;
                }
            }
        }
        phrase_start = index + 1;
    }
}

fn adjacent_phone(items: &[Item], index: usize, direction: isize) -> Option<Phone> {
    let neighbour = index.checked_add_signed(direction)?;
    match items.get(neighbour)? {
        Item::Phone(phone) => Some(*phone),
        Item::Pause { .. } => None,
    }
}

fn with_bandwidths(formants: [f32; 3], bandwidths: [f32; 3]) -> [f32; 6] {
    [
        formants[0],
        formants[1],
        formants[2],
        bandwidths[0],
        bandwidths[1],
        bandwidths[2],
    ]
}

/// Context-dependent formant targets: schwa, velar loci and /h/ colouring.
fn assign_targets(items: &mut [Item]) {
    let snapshot = items.to_vec();
    for (index, item) in items.iter_mut().enumerate() {
        let previous = adjacent_phone(&snapshot, index, -1);
        let next = adjacent_phone(&snapshot, index, 1);
        let Item::Phone(phone) = item else {
            continue;
        };
        let def = phone.def;
        let mut formants = def.formants;
        let mut bandwidths = def.bandwidths;
        if def.symbol == "AH" && phone.stress == Stress::Unstressed {
            formants = SCHWA;
            bandwidths = SCHWA_BANDWIDTHS;
        }
        let vocalic_neighbour = next
            .filter(|other| other.def.manner.is_sonorant())
            .or(previous.filter(|other| other.def.manner.is_vocalic()));
        if def.manner == Manner::Aspirate {
            if let Some(other) = next.filter(|other| other.def.manner.is_sonorant()) {
                formants = other.def.formants;
                bandwidths = other.def.bandwidths.map(|bandwidth| bandwidth * 2.0 + 80.0);
            }
        } else if def.place == Place::Velar
            && let Some(other) = vocalic_neighbour
        {
            let second = (other.def.formants[1] + 150.0).clamp(1300.0, 2300.0);
            formants[1] = second;
            formants[2] = (second + 350.0).max(2300.0);
        }
        phone.target = with_bandwidths(formants, bandwidths);
        phone.glide = def.glide_to.map(|end| with_bandwidths(end, bandwidths));
    }
}

/// How strongly a phone holds its formant targets at a boundary, and how long
/// its own portion of the transition lasts.
fn transition_profile(phone: &Phone, left: bool) -> (f32, f32) {
    let duration = phone.duration;
    match phone.def.manner {
        Manner::Vowel | Manner::Diphthong => (1.0, 0.045f32.min(0.3 * duration)),
        Manner::Approximant => (1.0, 0.4 * duration),
        Manner::Nasal => (1.5, 0.015f32.min(0.2 * duration)),
        Manner::Fricative => (2.0, 0.02f32.min(0.3 * duration)),
        Manner::Aspirate => (0.3, 0.3 * duration),
        Manner::Stop if left => (2.0, 0.0),
        Manner::Stop if phone.aspiration > 0.0 => (0.5, phone.aspiration + phone.burst),
        Manner::Stop => (2.0, phone.burst),
        Manner::Affricate if left => (2.0, 0.0),
        Manner::Affricate => (2.0, 0.02f32.min(0.3 * duration)),
    }
}

fn mix(a: [f32; 6], b: [f32; 6], weight_a: f32, weight_b: f32) -> [f32; 6] {
    let share = weight_a / (weight_a + weight_b);
    std::array::from_fn(|index| a[index] * share + b[index] * (1.0 - share))
}

fn formant_tracks(items: &[Item]) -> [Track; 6] {
    let mut tracks: [Track; 6] = Default::default();
    let mut push = |time: f32, values: [f32; 6]| {
        for (track, value) in tracks.iter_mut().zip(values) {
            track.push(time, value);
        }
    };
    for index in 0..items.len() {
        let Item::Phone(phone) = items[index] else {
            continue;
        };
        let start_values = phone.target;
        let end_values = phone.glide.unwrap_or(phone.target);
        let previous = adjacent_phone(items, index, -1);
        let next = adjacent_phone(items, index, 1);
        let end = phone.start + phone.duration;

        let (weight_in, mut transition_in) = transition_profile(&phone, true);
        let (_, mut transition_out) = transition_profile(&phone, false);
        if previous.is_none() {
            transition_in = 0.0;
        }
        if next.is_none() {
            transition_out = 0.0;
        }
        let total = transition_in + transition_out;
        if total > 0.9 * phone.duration {
            let scale = 0.9 * phone.duration / total;
            transition_in *= scale;
            transition_out *= scale;
        }

        match previous {
            Some(other) => {
                let (weight_other, _) = transition_profile(&other, false);
                let other_end = other.glide.unwrap_or(other.target);
                push(
                    phone.start,
                    mix(other_end, start_values, weight_other, weight_in),
                );
            }
            None => push(phone.start, start_values),
        }
        push(phone.start + transition_in, start_values);
        if phone.glide.is_some() {
            let hold = phone.start + transition_in.max(0.3 * phone.duration);
            push(hold.min(end - transition_out), start_values);
        }
        push(end - transition_out, end_values);
        if next.is_none() {
            push(end, end_values);
        }
    }
    tracks
}

fn amplitude_slices(items: &[Item]) -> Vec<Slice> {
    let mut slices = Vec::new();
    for item in items {
        let phone = match *item {
            Item::Pause { duration, .. } => {
                slices.push(Slice::silent(duration, 0.012));
                continue;
            }
            Item::Phone(phone) => phone,
        };
        let def = phone.def;
        let voicing = match def.manner {
            Manner::Vowel | Manner::Diphthong => match phone.stress {
                Stress::Primary => 1.0,
                Stress::Secondary => 0.9,
                Stress::Unstressed => 0.75,
            },
            Manner::Approximant => {
                if def.symbol == "L" || def.symbol == "W" {
                    0.75
                } else {
                    0.8
                }
            }
            Manner::Nasal => 0.5,
            Manner::Fricative if def.voiced => 0.5,
            _ => 0.0,
        };
        match def.manner {
            Manner::Vowel | Manner::Diphthong | Manner::Approximant | Manner::Nasal => {
                slices.push(Slice {
                    voicing,
                    nasal_zero: if def.manner == Manner::Nasal {
                        NASAL_ZERO_HZ
                    } else if def.nasalized {
                        NASAL_VOWEL_ZERO_HZ
                    } else {
                        NASAL_POLE_HZ
                    },
                    ..Slice::silent(
                        phone.duration,
                        if def.manner == Manner::Approximant {
                            0.015
                        } else {
                            0.01
                        },
                    )
                });
            }
            Manner::Fricative => slices.push(Slice {
                voicing,
                frication: if def.voiced { 0.5 } else { 1.0 },
                shape: def.frication,
                ..Slice::silent(phone.duration, 0.012)
            }),
            Manner::Aspirate => slices.push(Slice {
                aspiration: 1.0,
                ..Slice::silent(phone.duration, 0.01)
            }),
            Manner::Stop | Manner::Affricate => {
                slices.push(Slice {
                    voicing: if phone.voice_bar { 0.3 } else { 0.0 },
                    ..Slice::silent(phone.closure, 0.008)
                });
                // Final stops keep a lighter release: it still cues place.
                let burst_level = match (def.voiced, phone.released) {
                    (true, false) => 0.45,
                    (false, false) => 0.6,
                    (true, true) => 0.6,
                    (false, true) => 1.0,
                };
                slices.push(Slice {
                    frication: burst_level,
                    shape: def.frication,
                    ..Slice::silent(phone.burst, 0.001)
                });
                if def.manner == Manner::Affricate {
                    let rest = phone.duration - phone.closure - phone.burst;
                    slices.push(Slice {
                        voicing: if def.voiced { 0.5 } else { 0.0 },
                        frication: if def.voiced { 0.5 } else { 0.9 },
                        shape: def.frication,
                        ..Slice::silent(rest, 0.003)
                    });
                } else if phone.aspiration > 0.0 {
                    slices.push(Slice {
                        aspiration: 0.8,
                        ..Slice::silent(phone.aspiration, 0.003)
                    });
                }
            }
        }
    }
    slices
}

/// Builds a track from consecutive constant slices, ramping between values.
fn steps(slices: &[Slice], value: impl Fn(&Slice) -> f32) -> Track {
    let mut track = Track::default();
    let mut time = 0.0;
    let mut previous: Option<(f32, f32)> = None;
    for slice in slices.iter().filter(|slice| slice.duration > 0.0) {
        let current = value(slice);
        match previous {
            None => track.push(time, current),
            Some((last, last_duration)) if (current - last).abs() > 1e-6 => {
                let half = (0.5 * slice.ramp)
                    .min(0.5 * last_duration)
                    .min(0.5 * slice.duration);
                track.push(time - half, last);
                track.push(time + half, current);
            }
            Some(_) => {}
        }
        previous = Some((current, slice.duration));
        time += slice.duration;
    }
    if let Some((last, _)) = previous {
        track.push(time, last);
    }
    track
}

/// Hat-pattern intonation: declination, accents on primary-stressed vowels
/// and a boundary tone at the end of each phrase.
fn pitch_track(items: &[Item], duration: f32) -> Track {
    struct Phrase {
        start: f32,
        end: f32,
        boundary: Boundary,
        accents: Vec<(f32, f32)>,
    }

    let mut phrases = Vec::new();
    let mut current = Phrase {
        start: 0.0,
        end: 0.0,
        boundary: Boundary::Period,
        accents: Vec::new(),
    };
    let mut has_phone = false;
    for item in items {
        match *item {
            Item::Phone(phone) => {
                if !has_phone {
                    current.start = phone.start;
                }
                has_phone = true;
                current.end = phone.start + phone.duration;
                if phone.def.manner.is_vocalic() && phone.stress == Stress::Primary {
                    current.accents.push((
                        phone.start + 0.4 * phone.duration,
                        (0.6 * phone.duration).max(0.08),
                    ));
                }
            }
            Item::Pause { boundary, .. } if ends_phrase(boundary) && has_phone => {
                current.boundary = boundary;
                phrases.push(std::mem::replace(
                    &mut current,
                    Phrase {
                        start: 0.0,
                        end: 0.0,
                        boundary: Boundary::Period,
                        accents: Vec::new(),
                    },
                ));
                has_phone = false;
            }
            Item::Pause { .. } => {}
        }
    }
    if has_phone {
        phrases.push(current);
    }

    let deviation = |time: f32| -> f32 {
        let Some(phrase) = phrases
            .iter()
            .find(|phrase| time >= phrase.start - 0.05 && time <= phrase.end + 0.05)
        else {
            return 0.0;
        };
        let length = (phrase.end - phrase.start).max(1e-3);
        let progress = ((time - phrase.start) / length).clamp(0.0, 1.0);
        let declination = 0.06 - 0.14 * progress;
        let accent = phrase
            .accents
            .iter()
            .map(|&(centre, half_width)| {
                let distance = (time - centre).abs() / (2.0 * half_width);
                if distance < 1.0 {
                    0.14 * 0.5 * (1.0 + (std::f32::consts::PI * distance).cos())
                } else {
                    0.0
                }
            })
            .fold(0.0, f32::max);
        let tone_length = 0.3f32.min(length);
        let tone_progress = ((time - (phrase.end - tone_length)) / tone_length).clamp(0.0, 1.0);
        let tone = match phrase.boundary {
            Boundary::Question => 0.45 * tone_progress * tone_progress,
            Boundary::Comma => 0.08 * tone_progress,
            _ => -0.18 * tone_progress * tone_progress,
        };
        declination + accent + tone
    };

    let mut track = Track::default();
    let steps = (duration / PITCH_STEP).ceil() as usize;
    for step in 0..=steps {
        let time = step as f32 * PITCH_STEP;
        track.push(time, deviation(time));
    }
    track
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phonemes::parse;

    fn plan(text: &str) -> Plan {
        Plan::build(&parse(text).tokens, &PlanOptions::default())
    }

    fn plan_with(text: &str, options: PlanOptions) -> Plan {
        Plan::build(&parse(text).tokens, &options)
    }

    #[test]
    fn track_interpolates_and_tolerates_rewinds() {
        let mut track = Track::default();
        track.push(0.0, 0.0);
        track.push(1.0, 10.0);
        track.push(2.0, 10.0);
        let mut cursor = 0;
        assert_eq!(track.value_at(0.5, &mut cursor), 5.0);
        assert_eq!(track.value_at(1.5, &mut cursor), 10.0);
        assert_eq!(track.value_at(0.25, &mut cursor), 2.5);
        assert_eq!(track.value_at(9.0, &mut cursor), 10.0);
    }

    #[test]
    fn stressed_vowels_are_longer_and_pauses_add_time() {
        let stressed = plan("AE1").duration;
        let unstressed = plan("AE0").duration;
        assert!(stressed > unstressed * 1.3);
        let with_pause = plan("AE1 , AE1").duration;
        assert!(with_pause > 2.0 * plan("AE1 AE1").duration / 2.0 + 0.19);
    }

    #[test]
    fn voiceless_stop_before_stressed_vowel_is_aspirated() {
        let peak = |plan: &Plan| {
            let mut cursor = 0;
            (0..400)
                .map(|step| plan.aspiration.value_at(step as f32 * 0.001, &mut cursor))
                .fold(0.0, f32::max)
        };
        assert!(peak(&plan("P AA1")) > 0.5);
        assert_eq!(peak(&plan("S P AA1")), 0.0);
    }

    #[test]
    fn rate_scales_the_phrase() {
        let at_rate = |rate| {
            plan_with(
                "HH AH0 L OW1 .",
                PlanOptions {
                    rate,
                    ..PlanOptions::default()
                },
            )
            .duration
        };
        let normal = at_rate(1.0);
        let fast = at_rate(2.0);
        assert!(fast < 0.62 * normal && fast > 0.4 * normal);
    }

    #[test]
    fn french_rules_do_not_aspirate() {
        let options = PlanOptions {
            aspiration: false,
            ..PlanOptions::default()
        };
        let english = plan("P AA1").duration;
        let french = plan_with("P AA1", options).duration;
        assert!(english - french > 0.03);
    }

    #[test]
    fn tempo_puts_every_syllable_on_the_beat_grid() {
        let options = PlanOptions {
            tempo: Some(120.0),
            ..PlanOptions::default()
        };
        // Eighth notes at 120 BPM last 0.25 s; the leading B is a pickup.
        let plan = plan_with("B IY1 P | B IY1 P | B IY1 P", options);
        let pickup = plan_with("B", PlanOptions::default()).duration;
        let beats = (plan.duration - pickup) / 0.25;
        assert!((beats - beats.round()).abs() < 0.02, "{beats} beats");
        assert!(beats.round() >= 3.0);
    }

    #[test]
    fn melody_assigns_notes_to_vowels() {
        let options = PlanOptions {
            melody: vec![110.0, 220.0],
            ..PlanOptions::default()
        };
        let plan = plan_with("AA1 | AA1 | AA1", options);
        let notes = plan.notes.unwrap();
        let mut cursor = 0;
        let at =
            |fraction: f32, cursor: &mut usize| notes.value_at(plan.duration * fraction, cursor);
        assert_eq!(at(0.15, &mut cursor), 110.0);
        assert_eq!(at(0.5, &mut cursor), 220.0);
        assert_eq!(at(0.85, &mut cursor), 110.0);
    }

    #[test]
    fn explicit_durations_replace_the_rules() {
        let timed = plan("K:40 A1:150 M:70 . ");
        // 0.26 s of phones plus the final pause.
        assert!((timed.duration - (0.26 + pause_duration(Boundary::Period))).abs() < 1e-3);
        let half = plan_with(
            "K:40 A1:150 M:70",
            PlanOptions {
                rate: 2.0,
                ..PlanOptions::default()
            },
        );
        assert!((half.duration - 0.13).abs() < 1e-3);
    }

    #[test]
    fn pause_only_input_has_nothing_to_say() {
        assert_eq!(plan("_ , .").phone_count, 0);
    }
}
