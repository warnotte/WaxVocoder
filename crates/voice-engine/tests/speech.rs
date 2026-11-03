//! Acoustic checks of the cues that carry intelligibility: place-specific
//! frication and burst spectra, stop closures and aspiration, vowel formant
//! patterns, diphthong glides, nasal murmurs, prosody and timing.

mod common;

use common::*;
use voice_engine::Voice;
use voice_engine::phonemes::{lookup, supported_symbols};

#[test]
fn every_phoneme_is_audible_finite_and_bounded() {
    for symbol in supported_symbols() {
        let output = render(symbol);
        assert!(
            output
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() < 1.0)
        );
        let sounding: Vec<f32> = output
            .iter()
            .copied()
            .filter(|sample| sample.abs() > 1e-4)
            .collect();
        let level = 20.0 * rms(&sounding).log10();
        assert!(level > -45.0, "{symbol} is too quiet: {level:.1} dBFS");
        assert!(level < -6.0, "{symbol} is too loud: {level:.1} dBFS");
    }
}

#[test]
fn fricatives_have_place_specific_spectra() {
    let spectrum = |symbol: &str| Spectrum::of(centre(&render(symbol), 2048));
    let s = spectrum("S");
    let sh = spectrum("SH");
    assert!(
        s.fraction(4_000.0, 12_000.0) > 0.7,
        "S should hiss above 4 kHz"
    );
    assert!(
        sh.fraction(1_800.0, 4_500.0) > 0.7,
        "SH should be centred at 2–4 kHz"
    );
    assert!(s.centroid() > sh.centroid() + 1_000.0);
    let level = |symbol: &str| rms(centre(&render(symbol), 2048));
    for weak in ["F", "TH"] {
        assert!(
            level(weak) < 0.5 * level("S"),
            "{weak} should be much weaker than S"
        );
    }
}

#[test]
fn stop_bursts_have_place_specific_spectra() {
    let burst = |symbol: &str| {
        let output = render(&format!("{symbol} AA1"));
        let onset = output
            .iter()
            .position(|sample| sample.abs() > 1e-3)
            .unwrap();
        Spectrum::of(&output[onset..onset + seconds(0.01)])
    };
    let (p, t, k) = (burst("P"), burst("T"), burst("K"));
    assert!(
        t.fraction(4_000.0, 12_000.0) > 0.7,
        "alveolar burst should be high"
    );
    assert!(
        k.fraction(1_200.0, 3_500.0) > 0.7,
        "velar burst should be compact"
    );
    assert!(
        p.fraction(1_200.0, 3_500.0) < 0.4,
        "labial burst should be diffuse"
    );
    assert!(p.centroid() < t.centroid() - 1_500.0);
}

#[test]
fn stops_close_the_tract_and_sonorants_do_not() {
    assert!(longest_quiet_run(&render("AA1 P AA1"), 0.002) >= 0.04);
    assert!(longest_quiet_run(&render("AA1 M AA1"), 0.002) < 0.01);
}

#[test]
fn voiceless_stops_are_aspirated_except_after_s() {
    let duration = |text: &str| voice(text, |_| {}).duration_seconds();
    assert!(duration("P AA1") - duration("B AA1") > 0.03);
    assert!(duration("S P AA1") - duration("S B AA1") < 0.02);
}

#[test]
fn vowels_have_distinct_formant_patterns() {
    let spectrum = |symbol: &str| Spectrum::of(centre(&render(symbol), 2048));
    let (iy, aa, uw) = (spectrum("IY1"), spectrum("AA1"), spectrum("UW1"));
    let front = |s: &Spectrum| s.band(1_800.0, 2_600.0) / s.band(500.0, 1_000.0);
    let open = |s: &Spectrum| s.band(600.0, 800.0) / s.band(250.0, 400.0);
    let back = |s: &Spectrum| s.band(700.0, 1_100.0) / s.band(1_800.0, 2_600.0);
    assert!(front(&iy) > 20.0 * front(&aa), "IY needs a high F2");
    assert!(open(&aa) > 100.0 * open(&iy), "AA needs a high F1");
    assert!(back(&uw) > 100.0 * back(&iy), "UW needs a low F2");
}

#[test]
fn diphthongs_glide_between_targets() {
    let output = render("AY1");
    let length = 1536;
    let start = Spectrum::of(&output[seconds(0.02)..seconds(0.02) + length]);
    let end_offset = output.len() - length - seconds(TAIL + 0.01);
    let end = Spectrum::of(&output[end_offset..end_offset + length]);
    let ratio = |s: &Spectrum| s.band(1_700.0, 2_100.0) / s.band(1_000.0, 1_400.0);
    assert!(
        ratio(&end) > 50.0 * ratio(&start),
        "AY should glide towards IY"
    );
}

#[test]
fn nasals_are_weaker_low_frequency_murmurs() {
    let nasal = render("M");
    let spectrum = Spectrum::of(centre(&nasal, 2048));
    assert!(spectrum.fraction(0.0, 500.0) > 0.9);
    let relative = 20.0 * (rms(centre(&nasal, 2048)) / rms(centre(&render("AA1"), 2048))).log10();
    assert!(
        (-15.0..-4.0).contains(&relative),
        "nasal level {relative:.1} dB"
    );
}

#[test]
fn intonation_shapes_the_pitch_contour() {
    let contour = |text: &str, pause: f32, intonation: f32| {
        let output = render_with(text, |voice| voice.set_intonation(intonation));
        let window = seconds(0.04);
        let vowel_end = output.len() - seconds(TAIL + pause);
        (
            pitch(&output[seconds(0.03)..seconds(0.03) + window]),
            pitch(&output[vowel_end - seconds(0.07)..vowel_end - seconds(0.07) + window]),
        )
    };
    let (start, end) = contour("AA1", 0.0, 0.0);
    assert!(
        (start - 110.0).abs() < 5.0 && (end - 110.0).abs() < 5.0,
        "monotone {start}→{end}"
    );
    let (start, end) = contour("AA1", 0.0, 1.0);
    assert!(end < 0.9 * start, "statement should fall: {start}→{end}");
    let (start, end) = contour("AA1 ?", 0.35, 1.0);
    assert!(end > 1.1 * start, "question should rise: {start}→{end}");
}

#[test]
fn base_frequency_changes_apply_during_playback() {
    let mut voice = voice("AA1", |voice| voice.set_intonation(0.0));
    voice.set_active(true);
    let mut first = vec![0.0; seconds(0.08)];
    voice.render(&mut first);
    voice.set_frequency(220.0);
    let mut second = vec![0.0; seconds(0.08)];
    voice.render(&mut second);
    assert!((pitch(&first[seconds(0.02)..]) - 110.0).abs() < 5.0);
    assert!((pitch(&second[seconds(0.02)..]) - 220.0).abs() < 10.0);
}

#[test]
fn pauses_and_rate_control_timing() {
    assert!(longest_quiet_run(&render("AA1 , AA1"), 1e-4) >= 0.15);
    let gap = |text: &str| longest_quiet_run(&render(text), 1e-4);
    assert!(gap("AA1 . AA1") > gap("AA1 _ AA1") + 0.15);
    let duration = |rate: f32| {
        voice("HH AH0 L OW1 , W ER1 L D .", |voice| voice.set_rate(rate)).duration_seconds()
    };
    let ratio = duration(2.0) / duration(1.0);
    assert!((0.45..0.65).contains(&ratio), "rate 2 gave ratio {ratio}");
}

#[test]
fn rendering_does_not_depend_on_the_sample_rate() {
    let text = "HH AH0 L OW1 , W ER1 L D .";
    let render_at = |sample_rate: f32| {
        let mut voice = Voice::new(sample_rate);
        voice.set_phonemes(text);
        voice.set_active(true);
        let mut output = vec![0.0; (voice.duration_seconds() * sample_rate).ceil() as usize];
        voice.render(&mut output);
        (voice.duration_seconds(), rms(&output))
    };
    let (duration_44, level_44) = render_at(44_100.0);
    let (duration_48, level_48) = render_at(48_000.0);
    assert!((duration_44 - duration_48).abs() < 1e-6);
    assert!((20.0 * (level_44 / level_48).log10()).abs() < 1.0);
}

#[test]
fn replaying_a_phrase_is_sample_identical() {
    let mut voice = voice("S P IY1 CH , M AH0 SH IY1 N .", |_| {});
    let mut first = vec![0.0; seconds(1.5)];
    let mut second = vec![0.0; seconds(1.5)];
    voice.set_active(true);
    voice.render(&mut first);
    voice.set_active(false);
    voice.set_active(true);
    voice.render(&mut second);
    assert_eq!(first, second);
}

#[test]
fn stop_mutes_the_next_block() {
    let mut voice = voice("AA1", |_| {});
    voice.set_active(true);
    let mut output = [0.0; 512];
    voice.render(&mut output);
    assert!(output.iter().any(|sample| *sample != 0.0));
    voice.set_active(false);
    output.fill(1.0);
    voice.render(&mut output);
    assert!(!voice.is_active());
    assert!(output.iter().all(|sample| *sample == 0.0));
}

#[test]
fn empty_unknown_and_pause_only_input_stay_silent() {
    for (text, unknown) in [("", 0), ("XX QQ", 2), ("_ , . ?", 0)] {
        let mut voice = Voice::new(SR);
        assert_eq!(voice.set_phonemes(text), unknown);
        voice.set_active(true);
        let mut output = [1.0; 128];
        voice.render(&mut output);
        assert!(!voice.is_active());
        assert_eq!(voice.duration_seconds(), 0.0);
        assert!(output.iter().all(|sample| *sample == 0.0));
    }
}

#[test]
fn every_symbol_in_one_phrase_stays_bounded() {
    let phrase = supported_symbols().collect::<Vec<_>>().join(" ");
    let output = render(&phrase);
    let peak = output
        .iter()
        .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
    assert!(peak < 0.95, "peak {peak}");
    assert!(lookup("AA1").is_some());
}

#[test]
fn editing_phonemes_during_playback_keeps_playing() {
    let mut voice = voice("HH AH0 L OW1 .", |_| {});
    voice.set_active(true);
    let mut output = vec![0.0; seconds(0.1)];
    voice.render(&mut output);
    assert_eq!(voice.set_phonemes("HH AH0 L OW1 , W ER1 L D ."), 0);
    assert!(voice.is_active());
    voice.render(&mut output);
    assert!(rms(&output) > 0.01);
}
