//! Klatt-style formant synthesizer. A glottal source and aspiration noise feed
//! a cascade of formant resonators with a nasal pole/zero pair; frication
//! noise feeds a parallel bank of resonators whose gains set the spectrum of
//! fricatives and release bursts. Robot and comic controls act on the source
//! (sung notes, semitone quantisation, glide, vibrato, buzz) and on the tract
//! (formant shift).

use crate::phonemes::FRICATION_BANDS;
use crate::planner::{NASAL_POLE_HZ, Plan};
use std::f64::consts::PI;

/// Parameters are re-read every `BLOCK` samples; amplitudes are interpolated
/// per sample in between.
const BLOCK: u64 = 16;
const NASAL_BANDWIDTH: f64 = 100.0;
const FIXED_CASCADE: [(f64, f64); 2] = [(3500.0, 300.0), (4500.0, 400.0)];
const FIXED_PARALLEL: [(f64, f64); 3] = [(3500.0, 400.0), (4500.0, 600.0), (6000.0, 1600.0)];
const PARALLEL_BANDWIDTHS: [f64; 2] = [250.0, 320.0];
const PARALLEL_SIGNS: [f64; 5] = [-1.0, 1.0, -1.0, 1.0, -1.0];
const INITIAL_NOISE_STATE: u32 = 0x4d59_5df4;

const VOICE_GAIN: f64 = 1.0;
const ASPIRATION_GAIN: f64 = 0.2;
const FRICATION_GAIN: f64 = 1.0;
const OUTPUT_GAIN: f64 = 0.2;
const VIBRATO_HZ: f64 = 5.5;
const BUZZ_PULSE_WIDTH: f64 = 0.05;
/// Presence: shelf corner, maximum shelf gain, consonant boost and sharpest
/// glottal closing phase at full presence.
const PRESENCE_SHELF_HZ: f64 = 2_000.0;
const PRESENCE_SHELF_DB: f64 = 12.0;
const PRESENCE_CONSONANT_BOOST: f64 = 0.6;
const CLOSING_PHASE: f64 = 0.16;
const PRESENCE_CLOSING_PHASE: f64 = 0.09;

/// Live controls read at every parameter block.
#[derive(Clone, Copy, Debug)]
pub struct Controls {
    /// Base pitch in Hz for speech (ignored while a melody is sung).
    pub base_frequency: f64,
    /// 0 monotone, 1 full speech contour.
    pub intonation: f64,
    /// Scale of all resonances: above 1 a small robot, below 1 a giant.
    pub formant_shift: f64,
    /// Vibrato depth in semitones.
    pub vibrato: f64,
    /// Portamento time constant in seconds.
    pub glide: f64,
    /// Snap the pitch to the nearest semitone.
    pub quantize: bool,
    /// 0 smooth glottal pulse, 1 narrow buzzing pulse.
    pub buzz: f64,
    /// Intelligibility in a mix: sharper glottal closure, louder consonants
    /// and a high shelf above 2 kHz (0 neutral, 1 strongest).
    pub presence: f64,
}

impl Default for Controls {
    fn default() -> Self {
        Controls {
            base_frequency: 110.0,
            intonation: 0.6,
            formant_shift: 1.0,
            vibrato: 0.0,
            glide: 0.0,
            quantize: false,
            buzz: 0.0,
            presence: 0.0,
        }
    }
}

/// High-shelf biquad (RBJ cookbook, shelf slope 1).
#[derive(Clone, Copy, Default)]
struct Shelf {
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

impl Shelf {
    fn tune(&mut self, frequency: f64, gain_db: f64, sample_rate: f64) {
        let amplitude = 10f64.powf(gain_db / 40.0);
        let omega = 2.0 * PI * frequency.min(0.45 * sample_rate) / sample_rate;
        let (sine, cosine) = omega.sin_cos();
        let alpha = sine * std::f64::consts::FRAC_1_SQRT_2;
        let root = 2.0 * amplitude.sqrt() * alpha;
        let a0 = (amplitude + 1.0) - (amplitude - 1.0) * cosine + root;
        self.b0 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine + root) / a0;
        self.b1 = -2.0 * amplitude * ((amplitude - 1.0) + (amplitude + 1.0) * cosine) / a0;
        self.b2 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine - root) / a0;
        self.a1 = 2.0 * ((amplitude - 1.0) - (amplitude + 1.0) * cosine) / a0;
        self.a2 = ((amplitude + 1.0) - (amplitude - 1.0) * cosine - root) / a0;
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

#[derive(Clone, Copy, Default)]
struct Resonator {
    a: f64,
    b: f64,
    c: f64,
    y1: f64,
    y2: f64,
}

impl Resonator {
    fn coefficients(frequency: f64, bandwidth: f64, sample_rate: f64) -> (f64, f64, f64) {
        let period = 1.0 / sample_rate;
        let c = -(-2.0 * PI * bandwidth * period).exp();
        let b = 2.0 * (-PI * bandwidth * period).exp() * (2.0 * PI * frequency * period).cos();
        (1.0 - b - c, b, c)
    }

    /// Unity gain at DC, as in Klatt's cascade branch.
    fn tune(&mut self, frequency: f64, bandwidth: f64, sample_rate: f64) {
        (self.a, self.b, self.c) = Self::coefficients(frequency, bandwidth, sample_rate);
    }

    /// Unity gain at the centre frequency, for the parallel branch.
    fn tune_peak(&mut self, frequency: f64, bandwidth: f64, sample_rate: f64) {
        let (_, b, c) = Self::coefficients(frequency, bandwidth, sample_rate);
        let theta = 2.0 * PI * frequency / sample_rate;
        let real = 1.0 - b * theta.cos() - c * (2.0 * theta).cos();
        let imaginary = b * theta.sin() + c * (2.0 * theta).sin();
        self.a = real.hypot(imaginary);
        self.b = b;
        self.c = c;
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.a * input + self.b * self.y1 + self.c * self.y2;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

#[derive(Clone, Copy, Default)]
struct AntiResonator {
    a: f64,
    b: f64,
    c: f64,
    x1: f64,
    x2: f64,
}

impl AntiResonator {
    fn tune(&mut self, frequency: f64, bandwidth: f64, sample_rate: f64) {
        let (a, b, c) = Resonator::coefficients(frequency, bandwidth, sample_rate);
        self.a = 1.0 / a;
        self.b = -b / a;
        self.c = -c / a;
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.a * input + self.b * self.x1 + self.c * self.x2;
        self.x2 = self.x1;
        self.x1 = input;
        output
    }
}

#[derive(Clone, Copy, Default)]
struct Sources {
    voicing: f64,
    aspiration: f64,
    frication: f64,
    shape: [f64; FRICATION_BANDS],
}

#[derive(Clone, Copy, Default)]
struct Cursors {
    pitch: usize,
    notes: usize,
    voicing: usize,
    aspiration: usize,
    frication: usize,
    nasal_zero: usize,
    formants: [usize; 3],
    bandwidths: [usize; 3],
    shape: [usize; FRICATION_BANDS],
}

pub struct Synth {
    sample_rate: f64,
    phase: f64,
    frequency: f64,
    /// Glided pitch before vibrato; `None` until the first block of a phrase.
    pitch: Option<f64>,
    /// Formant shift applied to the fixed resonators.
    shift: f64,
    /// Presence the shelf is tuned for; NaN until the first block.
    presence: f64,
    shelf: Shelf,
    noise_state: u32,
    nasal_zero: AntiResonator,
    nasal_pole: Resonator,
    cascade: [Resonator; 5],
    parallel: [Resonator; 5],
    cursors: Cursors,
    from: Sources,
    to: Sources,
}

impl Synth {
    pub fn new(sample_rate: f32) -> Synth {
        let mut synth = Synth {
            sample_rate: f64::from(sample_rate),
            phase: 0.0,
            frequency: 110.0,
            pitch: None,
            shift: 1.0,
            presence: f64::NAN,
            shelf: Shelf::default(),
            noise_state: INITIAL_NOISE_STATE,
            nasal_zero: AntiResonator::default(),
            nasal_pole: Resonator::default(),
            cascade: [Resonator::default(); 5],
            parallel: [Resonator::default(); 5],
            cursors: Cursors::default(),
            from: Sources::default(),
            to: Sources::default(),
        };
        synth.reset();
        synth
    }

    /// Clears all filter memories and restarts the noise sequence, so that a
    /// replayed phrase is sample-identical.
    pub fn reset(&mut self) {
        self.phase = 0.0;
        self.pitch = None;
        self.noise_state = INITIAL_NOISE_STATE;
        self.nasal_zero = AntiResonator::default();
        self.nasal_pole = Resonator::default();
        self.cascade = [Resonator::default(); 5];
        self.parallel = [Resonator::default(); 5];
        self.shelf = Shelf::default();
        self.presence = f64::NAN;
        self.tune_fixed(1.0);
        self.rewind_tracks();
    }

    /// Tunes the resonators that do not follow the plan, for a formant shift.
    fn tune_fixed(&mut self, shift: f64) {
        let sample_rate = self.sample_rate;
        let limit = 0.45 * sample_rate;
        self.shift = shift;
        self.nasal_pole.tune(
            f64::from(NASAL_POLE_HZ) * shift,
            NASAL_BANDWIDTH * shift,
            sample_rate,
        );
        for (resonator, &(frequency, bandwidth)) in self.cascade[3..].iter_mut().zip(&FIXED_CASCADE)
        {
            resonator.tune(
                (frequency * shift).min(limit),
                bandwidth * shift,
                sample_rate,
            );
        }
        for (resonator, &(frequency, bandwidth)) in
            self.parallel[2..].iter_mut().zip(&FIXED_PARALLEL)
        {
            resonator.tune_peak(
                (frequency * shift).min(limit),
                bandwidth * shift,
                sample_rate,
            );
        }
    }

    /// Current fundamental frequency, vibrato included.
    pub fn frequency(&self) -> f64 {
        self.frequency
    }

    /// Restarts track evaluation, e.g. after the plan was rebuilt.
    pub fn rewind_tracks(&mut self) {
        self.cursors = Cursors::default();
    }

    fn sources_at(plan: &Plan, time: f32, cursors: &mut Cursors) -> Sources {
        let mut sources = Sources {
            voicing: f64::from(plan.voicing.value_at(time, &mut cursors.voicing)),
            aspiration: f64::from(plan.aspiration.value_at(time, &mut cursors.aspiration)),
            frication: f64::from(plan.frication.value_at(time, &mut cursors.frication)),
            shape: [0.0; FRICATION_BANDS],
        };
        for (band, value) in sources.shape.iter_mut().enumerate() {
            *value = f64::from(plan.frication_shape[band].value_at(time, &mut cursors.shape[band]));
        }
        sources
    }

    fn update(&mut self, plan: &Plan, position: u64, controls: &Controls) {
        let sample_rate = self.sample_rate;
        let shift = controls.formant_shift.clamp(0.5, 2.0);
        if (shift - self.shift).abs() > 1e-9 {
            self.tune_fixed(shift);
        }
        let presence = controls.presence.clamp(0.0, 1.0);
        if presence != self.presence {
            self.presence = presence;
            self.shelf
                .tune(PRESENCE_SHELF_HZ, PRESENCE_SHELF_DB * presence, sample_rate);
        }
        let start = (position as f64 / sample_rate) as f32;
        let end = ((position + BLOCK) as f64 / sample_rate) as f32;
        let middle = 0.5 * (start + end);
        let cursors = &mut self.cursors;
        self.from = Self::sources_at(plan, start, cursors);
        self.to = Self::sources_at(plan, end, cursors);

        let mut target = match &plan.notes {
            Some(notes) => f64::from(notes.value_at(middle, &mut cursors.notes)),
            None => {
                let deviation = f64::from(plan.pitch.value_at(middle, &mut cursors.pitch));
                controls.base_frequency * (1.0 + controls.intonation * deviation)
            }
        };
        target = target.clamp(40.0, 800.0);
        if controls.quantize {
            target = 440.0 * 2f64.powf((12.0 * (target / 440.0).log2()).round() / 12.0);
        }
        let pitch = match self.pitch {
            Some(current) if controls.glide > 0.0 => {
                let step = 1.0 - (-(BLOCK as f64) / (controls.glide * sample_rate)).exp();
                (current.ln() + (target.ln() - current.ln()) * step).exp()
            }
            _ => target,
        };
        self.pitch = Some(pitch);
        let vibrato =
            controls.vibrato.clamp(0.0, 3.0) * (2.0 * PI * VIBRATO_HZ * f64::from(middle)).sin();
        self.frequency = (pitch * 2f64.powf(vibrato / 12.0)).clamp(30.0, 1_000.0);

        let nasal_zero = f64::from(plan.nasal_zero.value_at(middle, &mut cursors.nasal_zero));
        self.nasal_zero
            .tune(nasal_zero * shift, NASAL_BANDWIDTH * shift, sample_rate);

        let limit = 0.45 * sample_rate;
        let mut formants = [0.0; 3];
        for (index, formant) in formants.iter_mut().enumerate() {
            *formant =
                (f64::from(plan.formants[index].value_at(middle, &mut cursors.formants[index]))
                    * shift)
                    .min(limit);
            let bandwidth =
                f64::from(plan.bandwidths[index].value_at(middle, &mut cursors.bandwidths[index]))
                    * shift;
            self.cascade[index].tune(*formant, bandwidth.max(20.0), sample_rate);
        }
        for (index, &bandwidth) in PARALLEL_BANDWIDTHS.iter().enumerate() {
            self.parallel[index].tune_peak(formants[index + 1], bandwidth * shift, sample_rate);
        }
    }

    fn noise(&mut self) -> f64 {
        self.noise_state ^= self.noise_state << 13;
        self.noise_state ^= self.noise_state >> 17;
        self.noise_state ^= self.noise_state << 5;
        f64::from(self.noise_state) / f64::from(u32::MAX) * 2.0 - 1.0
    }

    /// Synthesizes the sample at `position` (in samples since phrase start).
    pub fn sample(&mut self, plan: &Plan, position: u64, controls: &Controls) -> f32 {
        let offset = position % BLOCK;
        if offset == 0 {
            self.update(plan, position, controls);
        }
        let blend = offset as f64 / BLOCK as f64;
        let lerp = |from: f64, to: f64| from + (to - from) * blend;
        let voicing = lerp(self.from.voicing, self.to.voicing);
        let aspiration = lerp(self.from.aspiration, self.to.aspiration);
        let frication = lerp(self.from.frication, self.to.frication);

        self.phase += self.frequency / self.sample_rate;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        let aspiration_noise = self.noise();
        let frication_noise = self.noise();

        let buzz = controls.buzz.clamp(0.0, 1.0);
        let presence = self.presence;
        let closing = CLOSING_PHASE + (PRESENCE_CLOSING_PHASE - CLOSING_PHASE) * presence;
        let consonants = 1.0 + PRESENCE_CONSONANT_BOOST * presence;
        let source =
            (1.0 - buzz) * glottal_pulse(self.phase, closing) + buzz * buzz_pulse(self.phase);
        let mut cascade = source * voicing * VOICE_GAIN
            + aspiration_noise * aspiration * ASPIRATION_GAIN * consonants;
        cascade = self.nasal_zero.process(cascade);
        cascade = self.nasal_pole.process(cascade);
        for resonator in &mut self.cascade {
            cascade = resonator.process(cascade);
        }

        let modulation = if voicing > 0.05 && self.phase >= 0.5 {
            0.4
        } else {
            1.0
        };
        let excitation = frication_noise * frication * modulation * FRICATION_GAIN * consonants;
        let mut parallel = excitation * lerp(self.from.shape[5], self.to.shape[5]);
        for (band, resonator) in self.parallel.iter_mut().enumerate() {
            let gain = lerp(self.from.shape[band], self.to.shape[band]);
            parallel += PARALLEL_SIGNS[band] * gain * resonator.process(excitation);
        }

        let bright = self.shelf.process(cascade + parallel);
        (bright * OUTPUT_GAIN).tanh() as f32
    }
}

/// Narrow zero-mean pulse train: the bright, buzzy source of 1980s speech chips.
fn buzz_pulse(phase: f64) -> f64 {
    if phase < BUZZ_PULSE_WIDTH {
        -1.0
    } else {
        BUZZ_PULSE_WIDTH / (1.0 - BUZZ_PULSE_WIDTH)
    }
}

/// Derivative of a Rosenberg glottal flow pulse (radiation included),
/// normalised so that the closing peak is -1. A shorter closing phase gives a
/// sharper closure and a brighter voice.
fn glottal_pulse(phase: f64, closing: f64) -> f64 {
    const OPENING: f64 = 0.4;
    let value = if phase < OPENING {
        (PI / (2.0 * OPENING)) * (PI * phase / OPENING).sin()
    } else if phase < OPENING + closing {
        -(PI / (2.0 * closing)) * (PI * (phase - OPENING) / (2.0 * closing)).sin()
    } else {
        0.0
    };
    value * (2.0 * closing / PI)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gain_at(resonator: &Resonator, frequency: f64, sample_rate: f64) -> f64 {
        let theta = 2.0 * PI * frequency / sample_rate;
        let real = 1.0 - resonator.b * theta.cos() - resonator.c * (2.0 * theta).cos();
        let imaginary = resonator.b * theta.sin() + resonator.c * (2.0 * theta).sin();
        resonator.a / real.hypot(imaginary)
    }

    #[test]
    fn resonator_normalisations() {
        let mut resonator = Resonator::default();
        resonator.tune(500.0, 60.0, 48_000.0);
        assert!((gain_at(&resonator, 0.0, 48_000.0) - 1.0).abs() < 1e-9);
        assert!(gain_at(&resonator, 500.0, 48_000.0) > 5.0);
        resonator.tune_peak(6_000.0, 1_600.0, 48_000.0);
        assert!((gain_at(&resonator, 6_000.0, 48_000.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn nasal_zero_cancels_the_pole_when_tuned_together() {
        let mut pole = Resonator::default();
        let mut zero = AntiResonator::default();
        pole.tune(270.0, 100.0, 48_000.0);
        zero.tune(270.0, 100.0, 48_000.0);
        let mut noise = 1u32;
        for _ in 0..10_000 {
            noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let input = f64::from(noise) / f64::from(u32::MAX) - 0.5;
            assert!((zero.process(pole.process(input)) - input).abs() < 1e-6);
        }
    }

    #[test]
    fn glottal_pulse_has_no_dc_and_a_sharp_closure() {
        let steps = 10_000;
        let mean: f64 = (0..steps)
            .map(|step| glottal_pulse(step as f64 / steps as f64, CLOSING_PHASE))
            .sum::<f64>()
            / steps as f64;
        assert!(mean.abs() < 1e-3);
        assert!((glottal_pulse(0.5599, CLOSING_PHASE) + 1.0).abs() < 1e-3);
        assert_eq!(glottal_pulse(0.57, CLOSING_PHASE), 0.0);
        assert!((glottal_pulse(0.4899, PRESENCE_CLOSING_PHASE) + 1.0).abs() < 1e-3);
    }
}
