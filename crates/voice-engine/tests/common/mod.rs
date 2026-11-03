//! Measurement helpers shared by the acoustic test suites.
#![allow(dead_code)]

use voice_engine::Voice;

pub const SR: f32 = 48_000.0;
pub const TAIL: f32 = 0.06;

pub fn voice(text: &str, setup: impl Fn(&mut Voice)) -> Voice {
    let mut voice = Voice::new(SR);
    setup(&mut voice);
    assert_eq!(voice.set_phonemes(text), 0, "unknown symbol in {text}");
    voice
}

pub fn render_with(text: &str, setup: impl Fn(&mut Voice)) -> Vec<f32> {
    let mut voice = voice(text, setup);
    voice.set_active(true);
    // Exactly the announced length: the voice must report the end on its last sample.
    let mut output =
        vec![0.0; (f64::from(voice.duration_seconds()) * f64::from(SR)).ceil() as usize];
    voice.render(&mut output);
    assert!(
        !voice.is_active(),
        "{text} did not finish within duration_seconds()"
    );
    output
}

pub fn render(text: &str) -> Vec<f32> {
    render_with(text, |_| {})
}

pub fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

pub fn centre(samples: &[f32], length: usize) -> &[f32] {
    let start = samples.len().saturating_sub(length) / 2;
    &samples[start..start + length]
}

/// Hann-windowed power spectrum up to 12 kHz.
pub struct Spectrum {
    power: Vec<f32>,
    resolution: f32,
}

impl Spectrum {
    pub fn of(samples: &[f32]) -> Spectrum {
        let n = samples.len();
        let resolution = SR / n as f32;
        let bins = (12_000.0 / resolution) as usize;
        let power = (0..bins)
            .map(|bin| {
                let (mut real, mut imaginary) = (0.0f64, 0.0f64);
                for (index, &sample) in samples.iter().enumerate() {
                    let phase = std::f64::consts::TAU * index as f64 / n as f64;
                    let weighted = f64::from(sample) * (0.5 - 0.5 * phase.cos());
                    let angle = phase * bin as f64;
                    real += weighted * angle.cos();
                    imaginary -= weighted * angle.sin();
                }
                (real * real + imaginary * imaginary) as f32
            })
            .collect();
        Spectrum { power, resolution }
    }

    pub fn band(&self, low: f32, high: f32) -> f32 {
        self.power
            .iter()
            .enumerate()
            .filter(|(bin, _)| (low..high).contains(&(*bin as f32 * self.resolution)))
            .map(|(_, power)| power)
            .sum()
    }

    pub fn fraction(&self, low: f32, high: f32) -> f32 {
        self.band(low, high) / self.band(0.0, 12_000.0)
    }

    pub fn centroid(&self) -> f32 {
        let weighted: f32 = self
            .power
            .iter()
            .enumerate()
            .map(|(bin, power)| bin as f32 * self.resolution * power)
            .sum();
        weighted / self.band(0.0, 12_000.0)
    }
}

/// Autocorrelation pitch: the shortest lag whose correlation is close to the best.
pub fn pitch(samples: &[f32]) -> f32 {
    let correlation = |lag: usize| -> f32 {
        samples
            .iter()
            .zip(&samples[lag..])
            .map(|(a, b)| a * b)
            .sum()
    };
    let lags: Vec<(usize, f32)> = ((SR / 400.0) as usize..(SR / 55.0) as usize)
        .map(|lag| (lag, correlation(lag)))
        .collect();
    let best = lags
        .iter()
        .map(|&(_, value)| value)
        .fold(f32::MIN, f32::max);
    let lag = lags
        .iter()
        .find(|&&(_, value)| value >= 0.9 * best)
        .map(|&(lag, _)| lag)
        .unwrap();
    SR / lag as f32
}

pub fn seconds(time: f32) -> usize {
    (time * SR) as usize
}

pub fn longest_quiet_run(samples: &[f32], threshold: f32) -> f32 {
    let chunk = seconds(0.005);
    let mut run = 0;
    let mut longest = 0;
    for block in samples.chunks(chunk) {
        if rms(block) < threshold {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest as f32 * 0.005
}
