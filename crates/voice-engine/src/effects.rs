//! Robot effects applied after the voice: a channel vocoder with a sawtooth
//! carrier (the "Robots" sound) and a sample-rate/bit-depth reducer (the
//! 1980s talking-toy sound). [`AudioVocoder`] applies the vocoder to external
//! audio: a recorded voice or the voice band of a whole track.

use std::f64::consts::PI;

const BANDS: usize = 22;
const LOWEST_BAND_HZ: f64 = 120.0;
const HIGHEST_BAND_HZ: f64 = 7_500.0;
const BAND_Q: f64 = 4.0;
/// Bands from here up use noise as carrier, which keeps S, SH and bursts.
const NOISE_CARRIER_HZ: f64 = 3_800.0;
const ATTACK_SECONDS: f64 = 0.002;
const RELEASE_SECONDS: f64 = 0.02;
const SAW_GAIN: f64 = 5.5;
const NOISE_GAIN: f64 = 12.5;
/// Reference pitch of the carrier level equalisation.
const REFERENCE_HZ: f64 = 110.0;
const MAX_CHORD_VOICES: usize = 4;
const INITIAL_NOISE_STATE: u32 = 0x2545_f491;

/// Carrier chords, in semitones relative to the voice pitch.
pub const CHORDS: [&[f64]; 6] = [
    &[0.0],
    &[0.0, 12.0],
    &[0.0, 7.0, 12.0],
    &[0.0, 3.0, 7.0],
    &[0.0, 4.0, 7.0],
    &[-12.0, 0.0],
];

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    /// Band-pass with unity gain at the centre frequency (RBJ cookbook).
    fn band_pass(frequency: f64, q: f64, sample_rate: f64) -> Biquad {
        let omega = 2.0 * PI * frequency / sample_rate;
        let alpha = omega.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: alpha / a0,
            b2: -alpha / a0,
            a1: -2.0 * omega.cos() / a0,
            a2: (1.0 - alpha) / a0,
            ..Biquad::default()
        }
    }

    /// Butterworth low-pass (RBJ cookbook, Q = 1/√2).
    fn low_pass(frequency: f64, sample_rate: f64) -> Biquad {
        let omega = 2.0 * PI * frequency / sample_rate;
        let alpha = omega.sin() * std::f64::consts::FRAC_1_SQRT_2;
        let a0 = 1.0 + alpha;
        let cosine = omega.cos();
        Biquad {
            b0: (1.0 - cosine) / 2.0 / a0,
            b1: (1.0 - cosine) / a0,
            b2: (1.0 - cosine) / 2.0 / a0,
            a1: -2.0 * cosine / a0,
            a2: (1.0 - alpha) / a0,
            ..Biquad::default()
        }
    }

    /// Butterworth high-pass (RBJ cookbook, Q = 1/√2).
    fn high_pass(frequency: f64, sample_rate: f64) -> Biquad {
        let omega = 2.0 * PI * frequency / sample_rate;
        let alpha = omega.sin() * std::f64::consts::FRAC_1_SQRT_2;
        let a0 = 1.0 + alpha;
        let cosine = omega.cos();
        Biquad {
            b0: (1.0 + cosine) / 2.0 / a0,
            b1: -(1.0 + cosine) / a0,
            b2: (1.0 + cosine) / 2.0 / a0,
            a1: -2.0 * cosine / a0,
            a2: (1.0 - alpha) / a0,
            ..Biquad::default()
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

#[derive(Clone, Copy)]
struct Band {
    analysis: [Biquad; 2],
    synthesis: [Biquad; 2],
    envelope: f64,
    noise_carrier: bool,
    /// Equalises the carrier so that every band receives the same level: a
    /// sawtooth loses 6 dB per octave, band-passed white noise gains 3 dB.
    tilt: f64,
}

pub struct Vocoder {
    sample_rate: f64,
    bands: Vec<Band>,
    phases: [f64; MAX_CHORD_VOICES],
    noise_state: u32,
    attack: f64,
    release: f64,
}

impl Vocoder {
    pub fn new(sample_rate: f32) -> Vocoder {
        let sample_rate = f64::from(sample_rate);
        let mut vocoder = Vocoder {
            sample_rate,
            bands: Vec::with_capacity(BANDS),
            phases: [0.0; MAX_CHORD_VOICES],
            noise_state: INITIAL_NOISE_STATE,
            attack: 1.0 - (-1.0 / (ATTACK_SECONDS * sample_rate)).exp(),
            release: 1.0 - (-1.0 / (RELEASE_SECONDS * sample_rate)).exp(),
        };
        vocoder.reset();
        vocoder
    }

    pub fn reset(&mut self) {
        let ratio = (HIGHEST_BAND_HZ / LOWEST_BAND_HZ).powf(1.0 / (BANDS - 1) as f64);
        let sample_rate = self.sample_rate;
        self.bands = (0..BANDS)
            .map(|index| LOWEST_BAND_HZ * ratio.powi(index as i32))
            .filter(|&centre| centre < 0.45 * sample_rate)
            .map(|centre| {
                let filter = Biquad::band_pass(centre, BAND_Q, sample_rate);
                let noise_carrier = centre >= NOISE_CARRIER_HZ;
                Band {
                    analysis: [filter; 2],
                    synthesis: [filter; 2],
                    envelope: 0.0,
                    noise_carrier,
                    tilt: if noise_carrier {
                        NOISE_GAIN * (NOISE_CARRIER_HZ / centre).sqrt()
                    } else {
                        SAW_GAIN * (centre / REFERENCE_HZ).sqrt()
                    },
                }
            })
            .collect();
        self.phases = [0.0; MAX_CHORD_VOICES];
        self.noise_state = INITIAL_NOISE_STATE;
    }

    fn noise(&mut self) -> f64 {
        self.noise_state ^= self.noise_state << 13;
        self.noise_state ^= self.noise_state >> 17;
        self.noise_state ^= self.noise_state << 5;
        f64::from(self.noise_state) / f64::from(u32::MAX) * 2.0 - 1.0
    }

    /// Imprints the band envelopes of `input` (the voice) on a sawtooth chord
    /// at `frequency`.
    pub fn process(&mut self, input: f64, frequency: f64, chord: &[f64]) -> f64 {
        let voices = chord.len().clamp(1, MAX_CHORD_VOICES);
        let mut saw = 0.0;
        for (phase, interval) in self.phases.iter_mut().zip(chord).take(voices) {
            let step = (frequency * 2f64.powf(interval / 12.0) / self.sample_rate).min(0.45);
            *phase += step;
            if *phase >= 1.0 {
                *phase -= 1.0;
            }
            saw += 2.0 * *phase - 1.0 - poly_blep(*phase, step);
        }
        // Fewer, stronger harmonics fall in each band as the pitch rises.
        saw *= (REFERENCE_HZ / frequency.max(30.0)).sqrt() / (voices as f64).sqrt();
        let noise = self.noise();

        let (attack, release) = (self.attack, self.release);
        let mut output = 0.0;
        for band in &mut self.bands {
            let mut analysed = input;
            for filter in &mut band.analysis {
                analysed = filter.process(analysed);
            }
            let level = analysed.abs();
            let speed = if level > band.envelope {
                attack
            } else {
                release
            };
            band.envelope += (level - band.envelope) * speed;
            let mut carrier = if band.noise_carrier { noise } else { saw };
            for filter in &mut band.synthesis {
                carrier = filter.process(carrier);
            }
            output += carrier * band.tilt * band.envelope;
        }
        output
    }
}

/// Time constant of the automatic level matching between band and vocoder.
const LEVEL_SECONDS: f64 = 0.4;
const MAX_LEVEL_GAIN: f64 = 8.0;

/// Vocoder for external audio. Only the voice band (between the two split
/// frequencies) is vocoded; the lows (kick, bass) and highs (hi-hats) pass
/// through unchanged, and an automatic gain keeps the vocoded band at the
/// level of the original band.
pub struct AudioVocoder {
    sample_rate: f64,
    vocoder: Vocoder,
    low: [Biquad; 2],
    high: [Biquad; 2],
    frequency: f64,
    chord: usize,
    mix: f64,
    split: (f64, f64),
    band_power: f64,
    wet_power: f64,
    level: f64,
}

impl AudioVocoder {
    pub fn new(sample_rate: f32) -> AudioVocoder {
        let mut vocoder = AudioVocoder {
            sample_rate: f64::from(sample_rate.clamp(8_000.0, 384_000.0)),
            vocoder: Vocoder::new(sample_rate),
            low: [Biquad::default(); 2],
            high: [Biquad::default(); 2],
            frequency: 110.0,
            chord: 0,
            mix: 1.0,
            split: (150.0, 6_000.0),
            band_power: 0.0,
            wet_power: 0.0,
            level: 1.0,
        };
        vocoder.reset();
        vocoder
    }

    pub fn reset(&mut self) {
        let (low, high) = self.split;
        let high = high.min(0.45 * self.sample_rate);
        self.low = [Biquad::low_pass(low, self.sample_rate); 2];
        self.high = [Biquad::high_pass(high, self.sample_rate); 2];
        self.vocoder.reset();
        self.band_power = 0.0;
        self.wet_power = 0.0;
        self.level = 1.0;
    }

    /// Carrier pitch in Hz (30–1000).
    pub fn set_frequency(&mut self, frequency: f32) {
        if frequency.is_finite() {
            self.frequency = f64::from(frequency.clamp(30.0, 1_000.0));
        }
    }

    /// Carrier chord, as for [`crate::Voice::set_chord`].
    pub fn set_chord(&mut self, chord: u32) {
        self.chord = (chord as usize).min(CHORDS.len() - 1);
    }

    /// 0 keeps the original band, 1 replaces it with the vocoded band.
    pub fn set_mix(&mut self, mix: f32) {
        if mix.is_finite() {
            self.mix = f64::from(mix.clamp(0.0, 1.0));
        }
    }

    /// Frequencies outside `low..high` pass through unchanged; 0 and the
    /// Nyquist frequency vocode everything. Resets the filters.
    pub fn set_split(&mut self, low: f32, high: f32) {
        if low.is_finite() && high.is_finite() && high > low {
            self.split = (f64::from(low.max(1.0)), f64::from(high));
            self.reset();
        }
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let chord = CHORDS[self.chord];
        let speed = 1.0 - (-1.0 / (LEVEL_SECONDS * self.sample_rate)).exp();
        for (sample, out) in input.iter().zip(output.iter_mut()) {
            let dry = f64::from(*sample);
            let mut low = dry;
            for filter in &mut self.low {
                low = filter.process(low);
            }
            let mut high = dry;
            for filter in &mut self.high {
                high = filter.process(high);
            }
            let band = dry - low - high;
            let wet = self.vocoder.process(band, self.frequency, chord);
            self.band_power += (band * band - self.band_power) * speed;
            self.wet_power += (wet * wet - self.wet_power) * speed;
            if self.wet_power > 1e-12 {
                let target = (self.band_power / self.wet_power)
                    .sqrt()
                    .min(MAX_LEVEL_GAIN);
                self.level += (target - self.level) * speed;
            }
            let mixed = low + high + band * (1.0 - self.mix) + wet * self.level * self.mix;
            *out = mixed.clamp(-1.0, 1.0) as f32;
        }
    }
}

/// Polynomial band-limited step correction for the sawtooth discontinuity.
fn poly_blep(phase: f64, step: f64) -> f64 {
    if phase < step {
        let t = phase / step;
        t + t - t * t - 1.0
    } else if phase > 1.0 - step {
        let t = (phase - 1.0) / step;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

/// Sample-and-hold decimation plus bit reduction.
pub struct LoFi {
    phase: f64,
    held: f64,
}

impl LoFi {
    pub fn new() -> LoFi {
        LoFi {
            phase: 1.0,
            held: 0.0,
        }
    }

    pub fn reset(&mut self) {
        *self = LoFi::new();
    }

    /// `amount` 0 leaves the signal untouched; 1 gives about 6 kHz and 5 bits.
    pub fn process(&mut self, input: f64, amount: f64, sample_rate: f64) -> f64 {
        if amount <= 0.0 {
            return input;
        }
        let amount = amount.min(1.0);
        let rate = sample_rate * (6_000.0 / sample_rate).powf(amount);
        let levels = 2f64.powf(15.0 - 11.0 * amount);
        self.phase += rate / sample_rate;
        if self.phase >= 1.0 {
            self.phase -= self.phase.floor();
            self.held = (input * levels).round() / levels;
        }
        self.held
    }
}

impl Default for LoFi {
    fn default() -> Self {
        LoFi::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_in_gives_silence_out() {
        let mut vocoder = Vocoder::new(48_000.0);
        for _ in 0..4_800 {
            assert_eq!(vocoder.process(0.0, 110.0, CHORDS[2]), 0.0);
        }
    }

    #[test]
    fn band_pass_has_unity_gain_at_its_centre() {
        let mut filter = Biquad::band_pass(1_000.0, BAND_Q, 48_000.0);
        let mut peak: f64 = 0.0;
        for index in 0..48_000 {
            let output = filter.process((2.0 * PI * 1_000.0 * index as f64 / 48_000.0).sin());
            if index > 24_000 {
                peak = peak.max(output.abs());
            }
        }
        assert!((peak - 1.0).abs() < 0.01, "peak {peak}");
    }

    #[test]
    fn audio_vocoder_passes_audio_through_at_zero_mix() {
        let mut vocoder = AudioVocoder::new(48_000.0);
        vocoder.set_mix(0.0);
        let input: Vec<f32> = (0..9_600)
            .map(|index| (index as f32 * 0.05).sin() * 0.3 + (index as f32 * 0.9).sin() * 0.2)
            .collect();
        let mut output = vec![0.0; input.len()];
        vocoder.process(&input, &mut output);
        for (dry, out) in input.iter().zip(&output) {
            assert!((dry - out).abs() < 1e-5);
        }
    }

    #[test]
    fn audio_vocoder_keeps_the_low_end_and_retunes_the_voice_band() {
        let sample_rate = 48_000.0;
        // 50 Hz "kick" below the split, 400 Hz tone inside the voice band.
        let input: Vec<f32> = (0..48_000)
            .map(|index| {
                let time = index as f64 / sample_rate;
                (0.4 * (2.0 * PI * 50.0 * time).sin() + 0.3 * (2.0 * PI * 400.0 * time).sin())
                    as f32
            })
            .collect();
        let mut vocoder = AudioVocoder::new(48_000.0);
        vocoder.set_frequency(100.0);
        let mut output = vec![0.0; input.len()];
        vocoder.process(&input, &mut output);
        let tail = &output[24_000..];
        let power_at = |frequency: f64| {
            let (mut real, mut imaginary) = (0.0, 0.0);
            for (index, &sample) in tail.iter().enumerate() {
                let angle = 2.0 * PI * frequency * index as f64 / sample_rate;
                real += f64::from(sample) * angle.cos();
                imaginary += f64::from(sample) * angle.sin();
            }
            (real * real + imaginary * imaginary).sqrt() / tail.len() as f64
        };
        assert!(power_at(50.0) > 0.15, "kick lost: {}", power_at(50.0));
        // The 400 Hz band now carries harmonics of the 100 Hz carrier.
        assert!(power_at(400.0) > 0.01);
        assert!(
            power_at(300.0) > 0.003,
            "no carrier harmonic: {}",
            power_at(300.0)
        );
        assert!(
            output
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
        );
    }

    #[test]
    fn lofi_holds_samples_and_quantises() {
        let mut lofi = LoFi::new();
        let output: Vec<f64> = (0..480)
            .map(|index| lofi.process((index as f64 * 0.01).sin() * 0.5, 1.0, 48_000.0))
            .collect();
        let changes = output.windows(2).filter(|pair| pair[0] != pair[1]).count();
        assert!(changes <= 61, "{changes} changes for a 6 kHz hold");
        assert!(
            output
                .iter()
                .all(|value| (value * 16.0).fract().abs() < 1e-9)
        );
        assert_eq!(LoFi::new().process(0.3, 0.0, 48_000.0), 0.3);
    }
}
