/**
 * The three AI legs of a voice turn, as interfaces.
 *
 * Keeping these abstract is what stops the engine being a wrapper around one
 * vendor. It also makes the thing that actually governs perceived latency
 * explicit in the type: `speak` streams. Time to the first audio byte matters
 * far more than total synthesis time, because the caller hears the first byte,
 * and the difference between providers is measured in seconds.
 */

export interface TranscribeRequest {
  /** WAV audio, mono, at whatever rate the transport captured. */
  audio: Uint8Array;
  /**
   * Language hint. Worth setting: handed a buffer of room noise, an
   * unconstrained model returns confident text in an unrelated language, and
   * the agent then answers in that language.
   */
  language?: string;
  signal?: AbortSignal;
}

export interface SpeechToText {
  transcribe(request: TranscribeRequest): Promise<string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  /**
   * Called with each complete sentence as it is generated, so synthesis of the
   * first sentence can start while the rest is still being written.
   */
  onSentence?: (sentence: string) => void;
}

export interface LanguageModel {
  /** Streams the reply and resolves with the full text. */
  chat(request: ChatRequest): Promise<string>;
}

export interface SpeakRequest {
  text: string;
  signal?: AbortSignal;
  /** Called with raw PCM16 little-endian chunks as they arrive. */
  onAudio: (chunk: Uint8Array) => void;
}

export interface TextToSpeech {
  /** Sample rate of the PCM this provider emits. */
  readonly sampleRate: number;
  speak(request: SpeakRequest): Promise<void>;
}

export interface VoiceProviders {
  stt: SpeechToText;
  llm: LanguageModel;
  tts: TextToSpeech;
}
