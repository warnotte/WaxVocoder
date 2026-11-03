declare module '@echogarden/espeak-ng-emscripten' {
  interface EspeakNGWorker {
    set_voice(voice: string): number
    synthesize_ipa(text: string): { ipa: string }
    synthesize(
      text: string,
      callback: (audio: Int16Array, events: Array<{ type: string; id?: string | number; audio_position: number }>) => boolean,
    ): unknown
  }

  interface EspeakModule {
    eSpeakNGWorker: new () => EspeakNGWorker
  }

  /** Emscripten factory; espeak-ng.data is fetched next to espeak-ng.js. */
  const initialize: (options?: Record<string, unknown>) => Promise<EspeakModule>
  export default initialize
}
