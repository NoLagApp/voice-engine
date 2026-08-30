/**
 * One conversation: who is speaking, when to listen, and what gets said.
 *
 * This is the part that makes a voice agent feel like a phone call rather than
 * a chat box with a speaker attached. It owns turn taking, interruption, the
 * ordering of audio, and the policy that decides whether the language model is
 * consulted at all.
 *
 * Three ideas do most of the work:
 *
 *   Playback is tracked by mark, not by clock. Audio goes out faster than it
 *   is heard, so a turn is only over when the far end says the last mark
 *   played. A turn can contain several clips (a filler, then the answer), so
 *   marks are counted rather than treated as a single flag.
 *
 *   Interruption invalidates rather than cancels. Cleared audio may never
 *   report back, so each barge-in starts a new epoch and marks from an earlier
 *   one are ignored instead of waited for.
 *
 *   The model is the last resort, not the first. Noise, screeners and goodbyes
 *   are handled from a script before the model is asked for anything.
 */

import {
  StreamingDownsampler,
  bytesToInt16,
  concatInt16,
  pcm16ToWav,
} from "./audio.js";
import { UtteranceDetector, type UtteranceDetectorOptions } from "./vad.js";
import {
  classifyScreening,
  isFarewell,
  isLikelyNoise,
  stripMarkdown,
  type ScreeningKind,
} from "./policy.js";
import type { AudioTransport, CallInfo } from "./transport.js";
import type { ChatMessage, VoiceProviders } from "./providers/types.js";
import type { FillerBank } from "./fillers.js";

const TRANSPORT_RATE = 8000;
const MAX_HISTORY = 24;

export interface ScriptedLines {
  /** Said when we answer an inbound call. */
  greeting?: string;
  /** Said when we placed the call. Held back until they speak first. */
  outboundGreeting?: string;
  /** Said to a screener that asks who is calling. No customer details. */
  identify?: string;
  /** Left on voicemail, after which the call ends. */
  voicemail?: string;
  /** Said when the caller signals the call is over, before hanging up. */
  farewell?: string;
}

export interface VoiceSessionOptions {
  transport: AudioTransport;
  providers: VoiceProviders;
  systemPrompt: string;
  lines?: ScriptedLines;
  detector?: UtteranceDetectorOptions;
  fillers?: FillerBank | null;
  /** Wait this long for a real answer before playing a filler. */
  fillerDelayMs?: number;
  /** Language hint passed to transcription. */
  language?: string;
  /**
   * On an outbound call, hold the introduction until the other end speaks.
   * Talking over someone's "hello" is what makes a call feel automated.
   */
  waitForHello?: boolean;
  /** Optional observer, used for coordination and recording. */
  observer?: SessionObserver;
}

export interface TurnMetrics {
  sttMs: number;
  llmMs: number;
  firstAudioMs: number | null;
  clips: number;
  totalMs: number;
}

/** Everything worth telling the outside world about a call. */
export interface SessionObserver {
  onCallStarted?(info: CallInfo): void;
  onCallEnded?(reason: string): void;
  /** Audio heard from the other end, PCM16 at 8 kHz. */
  onCallerAudio?(frame: Int16Array): void;
  /** Audio we sent, PCM16 at 8 kHz. */
  onAgentAudio?(samples: Int16Array): void;
  onCallerSpeech?(text: string, meta: { sttMs: number }): void;
  onAgentSpeech?(text: string, meta: { kind: string; llmMs?: number }): void;
  onScreening?(kind: ScreeningKind, turn: number): void;
  onBargeIn?(): void;
  onTurnComplete?(metrics: TurnMetrics): void;
  onError?(error: Error): void;
}

export class VoiceSession {
  readonly transport: AudioTransport;
  private readonly providers: VoiceProviders;
  private readonly options: VoiceSessionOptions;
  private readonly detector: UtteranceDetector;
  private readonly observer: SessionObserver;

  info: CallInfo | null = null;
  private history: ChatMessage[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private abort: AbortController | null = null;

  private speaking = false;
  private markCounter = 0;
  private pendingMarks = 0;
  private epoch = 0;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIntro: string | null = null;
  private screenTurns = 0;
  private hangUpWhenDone = false;
  private closed = false;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.providers = options.providers;
    this.observer = options.observer ?? {};
    this.detector = new UtteranceDetector(options.detector);

    this.transport.onStart((info) => this.onStart(info));
    this.transport.onAudio((frame) => this.onAudio(frame));
    this.transport.onPlaybackComplete((markId) => this.onMark(markId));
    this.transport.onStop(() => this.close("the other end hung up"));
  }

  private get lines(): ScriptedLines {
    return this.options.lines ?? {};
  }

  private onStart(info: CallInfo): void {
    this.info = info;
    this.observer.onCallStarted?.(info);

    const greeting = info.outbound ? this.lines.outboundGreeting : this.lines.greeting;
    if (!greeting) return;

    if (info.outbound && (this.options.waitForHello ?? true)) {
      this.pendingIntro = greeting;
      return;
    }
    this.history.push({ role: "assistant", content: greeting });
    this.observer.onAgentSpeech?.(greeting, { kind: "greeting" });
    this.enqueue(() => this.speak(greeting, this.beginTurn()));
  }

  /**
   * Starts a cancellable unit of work. Anything that speaks needs one of
   * these, because synthesis keeps producing audio long after the caller has
   * interrupted: without a signal to abort, the cleared buffer immediately
   * refills and the agent talks over the person who just cut in.
   *
   * The queue serialises jobs, so one slot is enough.
   */
  private beginTurn(): AbortSignal {
    this.abort = new AbortController();
    return this.abort.signal;
  }

  private onAudio(frame: Int16Array): void {
    this.observer.onCallerAudio?.(frame);
    const result = this.detector.push(frame);

    if (result.bargeIn) this.bargeIn();

    if (result.utterance) {
      const { utterance, level, threshold } = result;
      this.enqueue(() => this.handleUtterance(utterance, level ?? 0, threshold ?? 0));
    }
  }

  /** Utterances are processed one at a time, in order. */
  private enqueue(job: () => Promise<unknown>): void {
    this.queue = this.queue.then(job).catch((error: Error) => {
      if (error?.name === "AbortError") return; // barge-in cancelled it, expected
      this.observer.onError?.(error);
    });
  }

  private async handleUtterance(
    utterance: Int16Array,
    level: number,
    threshold: number
  ): Promise<void> {
    if (this.closed) return;
    const signal = this.beginTurn();
    const startedAt = Date.now();

    const text = await this.providers.stt.transcribe({
      audio: pcm16ToWav(utterance, TRANSPORT_RATE),
      language: this.options.language,
      signal,
    });
    const sttMs = Date.now() - startedAt;
    if (!text) return;

    if (isLikelyNoise(text, level, threshold)) return;

    this.observer.onCallerSpeech?.(text, { sttMs });
    this.history.push({ role: "user", content: text });
    this.trimHistory();

    // A screener or voicemail system is not the customer. Answer it from a
    // script: the model, left to itself, greets it by name and starts
    // confirming private details to whatever machine picked up.
    const screening = classifyScreening(text);
    if (screening) {
      await this.handleScreening(screening, signal);
      return;
    }
    this.screenTurns = 0;

    // The caller is winding up. Say goodbye and hang up, rather than answering
    // again and leaving them to hang up on an agent that will not stop talking.
    if (isFarewell(text)) {
      await this.speakScripted(this.lines.farewell, signal, { hangUp: true });
      return;
    }

    // They have answered the phone, so deliver the introduction we held back.
    // Scripted rather than generated: no model call, no wait, and the opening
    // of a call is the one place that cannot afford a surprise.
    if (this.pendingIntro) {
      const intro = this.pendingIntro;
      this.pendingIntro = null;
      this.history.push({ role: "assistant", content: intro });
      this.observer.onAgentSpeech?.(intro, { kind: "greeting" });
      await this.speak(intro, signal);
      return;
    }

    await this.respond(sttMs, startedAt, signal);
  }

  /** The ordinary path: ask the model, speak the answer. */
  private async respond(sttMs: number, startedAt: number, signal: AbortSignal): Promise<void> {
    // The slow part (model, then synthesis) is still ahead, so cover the gap if
    // the answer does not start almost immediately. Scheduled only once a
    // transcript has survived the noise check, so noise never triggers one.
    this.scheduleFiller();

    const llmStartedAt = Date.now();
    let firstAudioMs: number | null = null;
    let clips = 0;
    let playback: Promise<void> = Promise.resolve();
    let firstSentence: string | null = null;
    const remainder: string[] = [];

    const queueSpeak = (text: string) => {
      clips += 1;
      playback = playback
        .then(async () => {
          if (this.closed || signal.aborted) return;
          const at = Date.now();
          const firstByteMs = await this.speak(text, signal);
          if (firstAudioMs === null) firstAudioMs = at - llmStartedAt + firstByteMs;
        })
        // This chain must never reject. A barge-in aborts the model stream
        // first, so the turn unwinds without ever awaiting playback, and a
        // rejection here would have no handler and would take the process down.
        .catch((error: Error) => {
          if (error?.name === "AbortError") return;
          this.observer.onError?.(error);
        });
    };

    const reply = await this.providers.llm.chat({
      messages: [{ role: "system", content: this.options.systemPrompt }, ...this.history],
      signal,
      // Speaking starts on the first finished sentence, so synthesis overlaps
      // the model still writing. The remainder is then sent as ONE more
      // request rather than one per sentence: synthesis latency is mostly
      // fixed per-request overhead, so more requests would cost more than they
      // save.
      onSentence: (sentence) => {
        if (firstSentence === null) {
          firstSentence = sentence;
          queueSpeak(sentence);
        } else {
          remainder.push(sentence);
        }
      },
    });
    const llmMs = Date.now() - llmStartedAt;
    if (!reply) {
      // Nothing to say, so nothing left to cover. A filler left armed here
      // fires into the silence after the exchange it belonged to is over.
      this.clearFiller();
      return;
    }
    if (remainder.length) queueSpeak(remainder.join(" "));

    const spoken = stripMarkdown(reply);
    this.history.push({ role: "assistant", content: spoken });
    this.observer.onAgentSpeech?.(spoken, { kind: "reply", llmMs });

    await playback;
    this.observer.onTurnComplete?.({
      sttMs,
      llmMs,
      firstAudioMs,
      clips,
      totalMs: Date.now() - startedAt,
    });
  }

  /**
   * Deals with a screener or voicemail without involving the model, so nothing
   * private is disclosed to a machine and the wording is predictable.
   */
  private async handleScreening(kind: ScreeningKind, signal: AbortSignal): Promise<void> {
    this.screenTurns += 1;
    this.observer.onScreening?.(kind, this.screenTurns);

    // A screener that keeps talking at us is a loop we cannot win.
    if (this.screenTurns > 4) {
      await this.speakScripted(this.lines.voicemail, signal, { hangUp: true });
      return;
    }
    // Talking over hold music or a transfer prompt achieves nothing.
    if (kind === "hold") return;
    if (kind === "voicemail") {
      await this.speakScripted(this.lines.voicemail, signal, { hangUp: true });
      return;
    }
    // "identify": say who is calling and why, and nothing more. The full
    // introduction is still held back for whoever actually comes on the line.
    await this.speakScripted(this.lines.identify, signal);
  }

  /** Speaks fixed text: no model call, no filler, optionally ends the call. */
  private async speakScripted(
    text: string | undefined,
    signal: AbortSignal,
    { hangUp = false }: { hangUp?: boolean } = {}
  ): Promise<void> {
    if (!text) return;
    this.clearFiller();
    this.history.push({ role: "assistant", content: text });
    this.observer.onAgentSpeech?.(text, { kind: "scripted" });
    await this.speak(text, signal);
    if (hangUp) this.hangUpWhenDone = true;
  }

  /**
   * Says something, forwarding audio as it is synthesised rather than waiting
   * for the whole clip. Returns ms until the first audio went out.
   */
  async speak(rawText: string, signal?: AbortSignal): Promise<number> {
    if (this.closed) return 0;
    const text = stripMarkdown(rawText);
    if (!text) return 0;

    const startedAt = Date.now();
    const down = new StreamingDownsampler(this.providers.tts.sampleRate, TRANSPORT_RATE);
    let firstByteMs: number | null = null;

    const emit = (samples: Int16Array) => {
      if (!samples.length || this.closed || signal?.aborted) return;
      if (firstByteMs === null) {
        firstByteMs = Date.now() - startedAt;
        this.beginClip();
      }
      this.observer.onAgentAudio?.(samples);
      this.transport.sendAudio(samples);
    };

    await this.providers.tts.speak({
      text,
      signal,
      onAudio: (chunk) => emit(down.push(chunk)),
    });
    emit(down.flush());

    if (firstByteMs !== null) this.endClip();
    return firstByteMs ?? Date.now() - startedAt;
  }

  /** Plays a pre-rendered clip immediately, bypassing synthesis. */
  private sendCached(samples: Int16Array): void {
    if (this.closed || !samples.length) return;
    this.beginClip();
    this.observer.onAgentAudio?.(samples);
    this.transport.sendAudio(samples);
    this.endClip();
  }

  private beginClip(): void {
    this.clearFiller();
    this.setSpeaking(true);
  }

  private endClip(): void {
    this.pendingMarks += 1;
    this.transport.mark(`a${this.epoch}-${++this.markCounter}`);
  }

  /**
   * A turn can have several clips in flight (a filler, then the answer), so
   * the agent is only done speaking once every outstanding mark comes back.
   * Marks from before a barge-in carry a stale epoch and are ignored.
   */
  private onMark(markId: string): void {
    const epoch = Number(/^a(\d+)-/.exec(markId)?.[1] ?? -1);
    if (epoch !== this.epoch) return;
    this.pendingMarks = Math.max(0, this.pendingMarks - 1);
    if (this.pendingMarks > 0) return;
    this.setSpeaking(false);
    // Ending the call only once the message has actually played out.
    if (this.hangUpWhenDone) {
      this.close("message left");
      this.transport.close();
    }
  }

  /** Keeps the detector's interrupt threshold in step with playback. */
  private setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    this.detector.setAgentSpeaking(speaking);
  }

  private bargeIn(): void {
    this.abort?.abort();
    this.clearFiller();
    this.transport.clear();
    // Discarded audio never plays, so its marks may never come back. Move to a
    // new epoch and drop the old counts rather than waiting on them forever.
    this.epoch += 1;
    this.pendingMarks = 0;
    this.setSpeaking(false);
    this.observer.onBargeIn?.();
  }

  private scheduleFiller(): void {
    const bank = this.options.fillers;
    if (!bank || this.fillerTimer) return;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (this.closed || this.speaking) return;
      const clip = bank.pick();
      if (!clip) return;
      this.observer.onAgentSpeech?.(clip.phrase, { kind: "filler" });
      this.sendCached(clip.samples);
    }, this.options.fillerDelayMs ?? 500);
  }

  private clearFiller(): void {
    if (!this.fillerTimer) return;
    clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  /** Injects a line to say now, for a supervisor steering the call. */
  say(text: string): void {
    this.history.push({ role: "assistant", content: text });
    this.observer.onAgentSpeech?.(text, { kind: "injected" });
    this.enqueue(() => this.speak(text, this.beginTurn()));
  }

  /** Adds guidance the model will see from the next turn on, silently. */
  instruct(text: string): void {
    this.history.push({ role: "system", content: text });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.clearFiller();
    this.observer.onCallEnded?.(reason);
  }
}
