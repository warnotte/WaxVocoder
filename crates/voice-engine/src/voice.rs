//! Host-independent voice API: phoneme text in, audio samples out.

use crate::effects::{CHORDS, LoFi, Vocoder};
use crate::melody::parse_melody;
use crate::phonemes::{Token, parse};
use crate::planner::{Plan, PlanOptions};
use crate::synth::{Controls, Synth};

/// Silence rendered after the last phone so that resonators ring out.
const TAIL_SECONDS: f32 = 0.06;
pub const DEFAULT_FREQUENCY: f32 = 110.0;
pub const DEFAULT_RATE: f32 = 1.0;
pub const DEFAULT_INTONATION: f32 = 0.6;
/// Languages whose voiceless stops are aspirated before vowels.
const ASPIRATING_LANGUAGES: [&str; 8] = ["en", "de", "nl", "da", "sv", "nb", "no", "is"];

pub struct Voice {
    sample_rate: f32,
    controls: Controls,
    options: PlanOptions,
    vocoder_mix: f64,
    chord: usize,
    lofi_amount: f64,
    tokens: Vec<Token>,
    plan: Plan,
    synth: Synth,
    vocoder: Vocoder,
    lofi: LoFi,
    active: bool,
    position: u64,
    end_position: u64,
}

impl Voice {
    pub fn new(sample_rate: f32) -> Voice {
        let sample_rate = if sample_rate.is_finite() {
            sample_rate.clamp(8_000.0, 384_000.0)
        } else {
            48_000.0
        };
        Voice {
            sample_rate,
            controls: Controls {
                base_frequency: f64::from(DEFAULT_FREQUENCY),
                intonation: f64::from(DEFAULT_INTONATION),
                ..Controls::default()
            },
            options: PlanOptions::default(),
            vocoder_mix: 0.0,
            chord: 0,
            lofi_amount: 0.0,
            tokens: Vec::new(),
            plan: Plan::default(),
            synth: Synth::new(sample_rate),
            vocoder: Vocoder::new(sample_rate),
            lofi: LoFi::new(),
            active: false,
            position: 0,
            end_position: 0,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Loads a phrase in the protocol described in [`crate::phonemes`] and
    /// returns the number of unrecognised symbols. Playback continues from the
    /// same position if the voice is active.
    pub fn set_phonemes(&mut self, text: &str) -> usize {
        let parsed = parse(text);
        self.tokens = parsed.tokens;
        self.replan();
        parsed.unknown.len()
    }

    /// Base pitch in Hz (45–400), applied immediately.
    pub fn set_frequency(&mut self, frequency: f32) {
        if frequency.is_finite() {
            self.controls.base_frequency = f64::from(frequency.clamp(45.0, 400.0));
        }
    }

    /// Speaking rate multiplier (0.5–2).
    pub fn set_rate(&mut self, rate: f32) {
        if rate.is_finite() {
            self.update_options(|options| options.rate = rate.clamp(0.5, 2.0));
        }
    }

    /// Amount of pitch movement: 0 is a monotone robot, 1 a lively contour.
    pub fn set_intonation(&mut self, amount: f32) {
        if amount.is_finite() {
            self.controls.intonation = f64::from(amount.clamp(0.0, 1.0));
        }
    }

    /// Language rules by ISO code (`en`, `fr`, `de`…): French and most other
    /// languages do not aspirate voiceless stops.
    pub fn set_language(&mut self, code: &str) {
        let language = code
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let aspiration = ASPIRATING_LANGUAGES.contains(&language.as_str());
        self.update_options(|options| options.aspiration = aspiration);
    }

    /// Robot rhythm in beats per minute (one syllable per eighth note); 0 turns
    /// it off.
    pub fn set_tempo(&mut self, bpm: f32) {
        let tempo = (bpm.is_finite() && bpm > 0.0).then(|| bpm.clamp(30.0, 300.0));
        self.update_options(|options| options.tempo = tempo);
    }

    /// Sung melody, one note per vowel (see [`crate::melody`]); an empty text
    /// returns to speech intonation. Returns the number of invalid notes.
    pub fn set_melody(&mut self, text: &str) -> usize {
        let melody = parse_melody(text);
        self.update_options(|options| options.melody = melody.notes);
        melody.invalid.len()
    }

    /// Snap the pitch to the nearest semitone.
    pub fn set_quantize(&mut self, quantize: bool) {
        self.controls.quantize = quantize;
    }

    /// Vocoder mix: 0 dry voice, 1 voice fully imprinted on a sawtooth carrier.
    pub fn set_vocoder(&mut self, mix: f32) {
        if mix.is_finite() {
            self.vocoder_mix = f64::from(mix.clamp(0.0, 1.0));
        }
    }

    /// Carrier chord: 0 unison, 1 octave, 2 fifth + octave, 3 minor, 4 major,
    /// 5 low octave.
    pub fn set_chord(&mut self, chord: u32) {
        self.chord = (chord as usize).min(CHORDS.len() - 1);
    }

    /// Talking-toy sound: buzzing source, sample-rate and bit-depth reduction.
    pub fn set_lofi(&mut self, amount: f32) {
        if amount.is_finite() {
            self.lofi_amount = f64::from(amount.clamp(0.0, 1.0));
            self.controls.buzz = self.lofi_amount;
        }
    }

    /// Resonance scale: above 1 a small robot, below 1 a giant (0.6–1.6).
    pub fn set_formant_shift(&mut self, factor: f32) {
        if factor.is_finite() {
            self.controls.formant_shift = f64::from(factor.clamp(0.6, 1.6));
        }
    }

    /// Vibrato depth in semitones (0–3).
    pub fn set_vibrato(&mut self, semitones: f32) {
        if semitones.is_finite() {
            self.controls.vibrato = f64::from(semitones.clamp(0.0, 3.0));
        }
    }

    /// Intelligibility in a mix (0–1): sharper glottal closure, louder
    /// consonants and brighter highs. 0 keeps the neutral voice.
    pub fn set_presence(&mut self, amount: f32) {
        if amount.is_finite() {
            self.controls.presence = f64::from(amount.clamp(0.0, 1.0));
        }
    }

    /// Pitch glide (portamento) time in seconds (0–0.5).
    pub fn set_glide(&mut self, seconds: f32) {
        if seconds.is_finite() {
            self.controls.glide = f64::from(seconds.clamp(0.0, 0.5));
        }
    }

    /// Starting playback always restarts the phrase from its beginning.
    pub fn set_active(&mut self, active: bool) {
        self.active = active && self.plan.phone_count > 0;
        if active {
            self.position = 0;
            self.synth.reset();
            self.vocoder.reset();
            self.lofi.reset();
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn phone_count(&self) -> usize {
        self.plan.phone_count
    }

    /// Length of the rendered phrase, release tail included.
    pub fn duration_seconds(&self) -> f32 {
        if self.plan.phone_count == 0 {
            0.0
        } else {
            self.plan.duration + TAIL_SECONDS
        }
    }

    pub fn render(&mut self, output: &mut [f32]) {
        let sample_rate = f64::from(self.sample_rate);
        let chord = CHORDS[self.chord];
        for sample in output.iter_mut() {
            if !self.active || self.position >= self.end_position {
                self.active = false;
                *sample = 0.0;
                continue;
            }
            let voice = f64::from(self.synth.sample(&self.plan, self.position, &self.controls));
            let mixed = if self.vocoder_mix > 0.0 {
                let wet = self.vocoder.process(voice, self.synth.frequency(), chord);
                voice * (1.0 - self.vocoder_mix) + wet * self.vocoder_mix
            } else {
                voice
            };
            let crushed = self.lofi.process(mixed, self.lofi_amount, sample_rate);
            *sample = crushed.clamp(-1.0, 1.0) as f32;
            self.position += 1;
            if self.position >= self.end_position {
                self.active = false;
            }
        }
    }

    fn update_options(&mut self, change: impl FnOnce(&mut PlanOptions)) {
        let mut options = self.options.clone();
        change(&mut options);
        if options != self.options {
            self.options = options;
            self.replan();
        }
    }

    fn replan(&mut self) {
        self.plan = Plan::build(&self.tokens, &self.options);
        self.end_position =
            (f64::from(self.duration_seconds()) * f64::from(self.sample_rate)).ceil() as u64;
        self.synth.rewind_tracks();
        if self.plan.phone_count == 0 {
            self.active = false;
        }
    }
}
