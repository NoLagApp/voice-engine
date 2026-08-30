/**
 * @nolag/voice-engine
 *
 * The real-time half of a voice agent: turn taking, interruption, voice
 * activity detection, filler speech, screener handling and recording. It has
 * no opinion about telephony vendor, AI vendor, or whether anything is
 * coordinating the call from outside.
 *
 * Pair it with `@nolag/voice` to make each call a NoLag room that dashboards,
 * supervisors and other agents can join while it is happening.
 *
 * This entry point deliberately touches no filesystem, no HTTP server and no
 * socket library, so it can be bundled into a function without carrying a dev
 * tool along. The two things that do are separate:
 *
 *   import { createRecorder } from "@nolag/voice-engine/recorder";   // node:fs
 *   import { startSimulator } from "@nolag/voice-engine/simulator";  // http + ws
 */

export {
  mulawDecode,
  mulawEncode,
  pcm16ToWav,
  bytesToInt16,
  resamplePcm16,
  rms,
  concatInt16,
  StreamingDownsampler,
} from "./audio.js";

// Byte helpers, exported because a transport or provider written outside this
// package needs the same base64 and concatenation without reaching for Buffer.
export { concatBytes, toBase64, fromBase64 } from "./bytes.js";

export { UtteranceDetector } from "./vad.js";
export type { UtteranceDetectorOptions, DetectorResult } from "./vad.js";

export {
  classifyScreening,
  isFarewell,
  isLikelyNoise,
  stripMarkdown,
} from "./policy.js";
export type { ScreeningKind } from "./policy.js";

export { VoiceSession } from "./session.js";
export type {
  VoiceSessionOptions,
  ScriptedLines,
  SessionObserver,
  TurnMetrics,
  UnpromptedSpeech,
  UnpromptedHandle,
  UnpromptedOutcome,
  StallOptions,
  StallHandle,
  SessionPolicy,
} from "./session.js";

export { createFillerBank, DEFAULT_FILLERS } from "./fillers.js";
export type { FillerBank, FillerClip } from "./fillers.js";

export type { AudioTransport, CallInfo, SocketLike } from "./transport.js";
export { TwilioMediaStreamTransport } from "./transports/twilio.js";
export type { TwilioTransportOptions } from "./transports/twilio.js";

export {
  OpenRouterSpeechToText,
  OpenRouterLanguageModel,
  OpenRouterTextToSpeech,
  findSentenceEnd,
} from "./providers/openrouter.js";
export type { OpenRouterOptions, OpenRouterTtsOptions } from "./providers/openrouter.js";

export type {
  SpeechToText,
  LanguageModel,
  TextToSpeech,
  VoiceProviders,
  ChatMessage,
  ChatRequest,
  SpeakRequest,
  TranscribeRequest,
} from "./providers/types.js";
