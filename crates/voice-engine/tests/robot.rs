//! Robot and comic layer: vocoder, chords, sung notes, semitone quantisation,
//! rhythm grid, lo-fi, formant shift, vibrato and glide, plus language rules.

mod common;

use common::*;

fn level_db(samples: &[f32]) -> f32 {
    20.0 * rms(samples).log10()
}

#[test]
fn vocoder_keeps_level_pitch_and_sibilants() {
    for text in ["AA1", "S"] {
        let dry = render_with(text, |voice| voice.set_intonation(0.0));
        let wet = render_with(text, |voice| {
            voice.set_intonation(0.0);
            voice.set_vocoder(1.0);
        });
        let difference = level_db(centre(&wet, 2048)) - level_db(centre(&dry, 2048));
        assert!(
            difference.abs() < 3.0,
            "{text}: vocoder changes level by {difference:.1} dB"
        );
    }
    let vowel = render_with("AA1", |voice| {
        voice.set_intonation(0.0);
        voice.set_vocoder(1.0);
    });
    assert!((pitch(centre(&vowel, 2400)) - 110.0).abs() < 6.0);
    let hiss = render_with("S", |voice| voice.set_vocoder(1.0));
    assert!(Spectrum::of(centre(&hiss, 2048)).fraction(4_000.0, 12_000.0) > 0.5);
}

#[test]
fn vocoded_vowels_stay_distinct() {
    let vocoded = |text: &str| {
        Spectrum::of(centre(
            &render_with(text, |voice| {
                voice.set_intonation(0.0);
                voice.set_vocoder(1.0);
            }),
            2048,
        ))
    };
    let (iy, aa) = (vocoded("IY1"), vocoded("AA1"));
    // F1: low for IY, high for AA.
    let low_centroid = |spectrum: &Spectrum| {
        let bands = [
            (200.0, 400.0),
            (400.0, 600.0),
            (600.0, 800.0),
            (800.0, 1_200.0),
        ];
        let total: f32 = bands
            .iter()
            .map(|&(low, high)| spectrum.band(low, high))
            .sum();
        bands
            .iter()
            .map(|&(low, high)| 0.5 * (low + high) * spectrum.band(low, high))
            .sum::<f32>()
            / total
    };
    assert!(low_centroid(&aa) > low_centroid(&iy) + 200.0);
    // F2: IY keeps a peak above its F1–F2 valley, AA does not.
    assert!(iy.band(1_800.0, 2_600.0) > iy.band(1_000.0, 1_500.0));
    assert!(aa.band(1_800.0, 2_600.0) < aa.band(1_000.0, 1_500.0));
}

#[test]
fn chords_add_carrier_pitches() {
    let fifth_harmonic = |chord: u32| {
        let output = render_with("AA1", |voice| {
            voice.set_intonation(0.0);
            voice.set_vocoder(1.0);
            voice.set_chord(chord);
        });
        let spectrum = Spectrum::of(centre(&output, 4096));
        spectrum.band(158.0, 172.0) / spectrum.band(100.0, 120.0)
    };
    assert!(fifth_harmonic(2) > 5.0 * fifth_harmonic(0));
}

#[test]
fn melody_sings_one_note_per_vowel() {
    let output = render_with("AA1 | AA1 | AA1", |voice| {
        assert_eq!(voice.set_melody("A2 mi2 A3"), 0);
    });
    let length = output.len();
    let window = seconds(0.04);
    let notes = [
        pitch(&output[length / 6..length / 6 + window]),
        pitch(&output[length / 2 - window / 2..length / 2 + window / 2]),
        pitch(&output[5 * length / 6 - window..5 * length / 6]),
    ];
    for (measured, expected) in notes.iter().zip([110.0, 164.8, 220.0]) {
        assert!(
            (measured / expected - 1.0).abs() < 0.04,
            "{measured} Hz instead of {expected}"
        );
    }
}

#[test]
fn quantisation_snaps_to_the_nearest_semitone() {
    let measured = |quantize: bool| {
        let output = render_with("AA1", |voice| {
            voice.set_intonation(0.0);
            voice.set_frequency(114.0);
            voice.set_quantize(quantize);
        });
        pitch(centre(&output, 2400))
    };
    // 114 Hz lies between A2 (110) and A#2 (116.5).
    assert!((measured(true) / 116.54 - 1.0).abs() < 0.025);
    assert!((measured(false) / 114.0 - 1.0).abs() < 0.025);
}

#[test]
fn tempo_puts_syllables_on_the_grid_and_chops_words() {
    let text = "M AA1 | M AA1 | M AA1";
    let natural = render(text);
    assert!(
        longest_quiet_run(&natural, 1e-3) < 0.02,
        "natural speech is connected"
    );
    let beat = 0.3;
    let robot = voice(text, |voice| voice.set_tempo(100.0));
    let pickup = voice("M", |_| {}).duration_seconds() - TAIL;
    let beats = (robot.duration_seconds() - TAIL - pickup) / beat;
    assert!((beats - beats.round()).abs() < 0.02, "{beats} beats");
    let chopped = render_with(text, |voice| voice.set_tempo(100.0));
    // The inserted silence is 30 % of the beat; amplitude ramps take the rest.
    assert!(
        longest_quiet_run(&chopped, 1e-3) >= 0.2 * beat,
        "words should be cut short"
    );
}

#[test]
fn formant_shift_scales_the_resonances() {
    let brightness = |factor: f32| {
        let output = render_with("AA1", |voice| voice.set_formant_shift(factor));
        let spectrum = Spectrum::of(centre(&output, 2048));
        spectrum.band(850.0, 1_100.0) / spectrum.band(550.0, 750.0)
    };
    let (giant, normal, small) = (brightness(0.75), brightness(1.0), brightness(1.35));
    assert!(small > 5.0 * normal, "small robot {small} vs {normal}");
    assert!(giant > normal && giant < small, "giant {giant}");
}

#[test]
fn vibrato_and_glide_move_the_pitch() {
    let output = render_with("AA1", |voice| {
        voice.set_intonation(0.0);
        voice.set_vibrato(2.0);
    });
    let window = seconds(0.025);
    let pitches: Vec<f32> = (0..8)
        .map(|index| pitch(&output[2_000 + index * window..2_000 + (index + 1) * window]))
        .collect();
    let (low, high) = pitches
        .iter()
        .fold((f32::MAX, f32::MIN), |(low, high), &value| {
            (low.min(value), high.max(value))
        });
    assert!(high / low > 1.15, "vibrato range {low}–{high}");

    // Second vowel starts at 0.204 s; 40 ms later a 0.3 s glide is still on its way.
    let second_vowel = |glide: f32| {
        let output = render_with("AA1 AA1", |voice| {
            voice.set_melody("A2 A3");
            voice.set_glide(glide);
        });
        pitch(&output[seconds(0.24)..seconds(0.28)])
    };
    assert!(second_vowel(0.0) > 200.0);
    assert!(second_vowel(0.3) < 190.0);
}

#[test]
fn presence_brightens_the_voice_and_its_consonants() {
    let brightness = |presence: f32| {
        let output = render_with("AA1", |voice| voice.set_presence(presence));
        let spectrum = Spectrum::of(centre(&output, 2048));
        spectrum.band(2_500.0, 6_000.0) / spectrum.band(200.0, 1_000.0)
    };
    assert!(
        brightness(1.0) > 4.0 * brightness(0.0),
        "presence should add 6 dB of highs"
    );
    let hiss = |presence: f32| {
        rms(centre(
            &render_with("S", |voice| voice.set_presence(presence)),
            2048,
        ))
    };
    assert!(hiss(1.0) > 1.4 * hiss(0.0), "consonants should be louder");
    let output = render_with("S P IY1 CH , M AH0 SH IY1 N .", |voice| {
        voice.set_presence(1.0)
    });
    assert!(
        output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() < 1.0)
    );
}

#[test]
fn lofi_holds_and_quantises_samples() {
    let output = render_with("AA1", |voice| voice.set_lofi(1.0));
    let middle = centre(&output, 4_800);
    assert!(middle.iter().all(|sample| (sample * 16.0).fract() == 0.0));
    let changes = middle.windows(2).filter(|pair| pair[0] != pair[1]).count();
    assert!(changes < 4_800 / 6, "{changes} changes: not decimated");
}

#[test]
fn language_rules_control_aspiration() {
    let duration = |code: &str| voice("P AA1", |voice| voice.set_language(code)).duration_seconds();
    assert!(duration("en-US") - duration("fr") > 0.03);
    assert!((duration("de") - duration("en")).abs() < 1e-6);
    assert!((duration("fr-FR") - duration("es")).abs() < 1e-6);
}

#[test]
fn nasal_vowels_are_nasalised_but_keep_their_vowel() {
    let low_fraction = |text: &str| Spectrum::of(centre(&render(text), 2048)).fraction(0.0, 350.0);
    for (oral, nasal) in [("AA1", "AN"), ("AO1", "ON"), ("EH1", "IN")] {
        let (oral, nasal) = (low_fraction(oral), low_fraction(nasal));
        assert!(nasal > oral + 0.15 && nasal < 0.8, "{oral} → {nasal}");
    }
}

#[test]
fn everything_at_once_stays_bounded_and_finishes() {
    let output = render_with("W IY1 | AA1 R | DH AH0 | R OW1 B AA2 T S .", |voice| {
        voice.set_vocoder(1.0);
        voice.set_chord(3);
        voice.set_melody("do2 do2 ré#2 sol2 fa2");
        voice.set_quantize(true);
        voice.set_tempo(132.0);
        voice.set_lofi(0.5);
        voice.set_formant_shift(1.4);
        voice.set_vibrato(3.0);
        voice.set_glide(0.1);
    });
    assert!(
        output
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
    );
    assert!(rms(&output) > 0.02);
}
