//! WebAssembly binding of [`Voice`], used by the browser AudioWorklet.

use crate::phonemes::supported_symbols;
use crate::{AudioVocoder, Voice};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct VoiceEngine {
    voice: Voice,
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[wasm_bindgen]
impl VoiceEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> VoiceEngine {
        VoiceEngine {
            voice: Voice::new(sample_rate),
        }
    }

    /// Space-separated phoneme symbols understood by the engine.
    pub fn supported_phonemes() -> String {
        supported_symbols().collect::<Vec<_>>().join(" ")
    }

    /// Loads a phrase; returns the number of unrecognised symbols.
    pub fn set_phonemes(&mut self, text: &str) -> u32 {
        count(self.voice.set_phonemes(text))
    }

    pub fn set_frequency(&mut self, frequency: f32) {
        self.voice.set_frequency(frequency);
    }

    pub fn set_rate(&mut self, rate: f32) {
        self.voice.set_rate(rate);
    }

    pub fn set_intonation(&mut self, amount: f32) {
        self.voice.set_intonation(amount);
    }

    pub fn set_language(&mut self, code: &str) {
        self.voice.set_language(code);
    }

    pub fn set_tempo(&mut self, bpm: f32) {
        self.voice.set_tempo(bpm);
    }

    /// Sets the sung melody; returns the number of invalid notes.
    pub fn set_melody(&mut self, notes: &str) -> u32 {
        count(self.voice.set_melody(notes))
    }

    pub fn set_quantize(&mut self, quantize: bool) {
        self.voice.set_quantize(quantize);
    }

    pub fn set_vocoder(&mut self, mix: f32) {
        self.voice.set_vocoder(mix);
    }

    pub fn set_chord(&mut self, chord: u32) {
        self.voice.set_chord(chord);
    }

    pub fn set_lofi(&mut self, amount: f32) {
        self.voice.set_lofi(amount);
    }

    pub fn set_formant_shift(&mut self, factor: f32) {
        self.voice.set_formant_shift(factor);
    }

    pub fn set_vibrato(&mut self, semitones: f32) {
        self.voice.set_vibrato(semitones);
    }

    pub fn set_glide(&mut self, seconds: f32) {
        self.voice.set_glide(seconds);
    }

    pub fn set_presence(&mut self, amount: f32) {
        self.voice.set_presence(amount);
    }

    pub fn set_active(&mut self, active: bool) {
        self.voice.set_active(active);
    }

    pub fn is_active(&self) -> bool {
        self.voice.is_active()
    }

    pub fn phone_count(&self) -> u32 {
        count(self.voice.phone_count())
    }

    pub fn duration_seconds(&self) -> f32 {
        self.voice.duration_seconds()
    }

    pub fn render(&mut self, output: &mut [f32]) {
        self.voice.render(output);
    }
}

/// Vocoder for external audio (recorded voice, a whole track).
#[wasm_bindgen]
pub struct AudioVocoderEngine {
    vocoder: AudioVocoder,
}

#[wasm_bindgen]
impl AudioVocoderEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> AudioVocoderEngine {
        AudioVocoderEngine {
            vocoder: AudioVocoder::new(sample_rate),
        }
    }

    pub fn set_frequency(&mut self, frequency: f32) {
        self.vocoder.set_frequency(frequency);
    }

    pub fn set_chord(&mut self, chord: u32) {
        self.vocoder.set_chord(chord);
    }

    pub fn set_mix(&mut self, mix: f32) {
        self.vocoder.set_mix(mix);
    }

    pub fn set_split(&mut self, low: f32, high: f32) {
        self.vocoder.set_split(low, high);
    }

    pub fn reset(&mut self) {
        self.vocoder.reset();
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        self.vocoder.process(input, output);
    }
}
