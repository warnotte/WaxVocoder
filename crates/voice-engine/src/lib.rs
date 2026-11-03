//! WaxVocoder voice engine: a platform-independent speech synthesizer driven
//! by a phoneme protocol (see [`phonemes`]), with robot effects: sung notes,
//! rhythm grid, vocoder, lo-fi and formant shift.
//!
//! [`Voice`] is the native Rust API and does not depend on the browser. The
//! default `wasm` feature adds the `VoiceEngine` WebAssembly binding; hosts
//! that embed the engine natively can disable default features.

mod effects;
pub mod melody;
pub mod phonemes;
mod planner;
mod synth;
mod voice;
#[cfg(feature = "wasm")]
mod wasm;

pub use effects::AudioVocoder;
pub use voice::{DEFAULT_FREQUENCY, DEFAULT_INTONATION, DEFAULT_RATE, Voice};
#[cfg(feature = "wasm")]
pub use wasm::{AudioVocoderEngine, VoiceEngine};
