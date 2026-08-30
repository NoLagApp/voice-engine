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
  /**
   * How many unprompted lines may wait for the floor at once. Beyond this the
   * oldest is dropped: a backlog of things to say is a queue of increasingly
   * stale remarks, and a caller who pauses should not be buried under all of
   * them at once.
   */
  maxDeferred?: number;
  /**
   * Override how a transcript is judged before the model sees it. The defaults
   * are tuned for English phone calls, which is a specific enough thing to be
   * wrong for someone.
   */
  policy?: SessionPolicy;
}

/** Something to say that no caller turn asked for. */
export interface UnpromptedSpeech {
  text: string;
  /** Reported to the observer as the kind of speech this is. */
  kind?: string;
  /** Add to the conversation the model sees. Defaults to true. */
  remember?: boolean;
  /**
   * Drop it unspoken if the floor has not freed by then. Worth setting for
   * anything whose relevance decays, which is most things: talking over
   * someone is worse than staying quiet, and the next ordinary turn can
   * usually still carry the point.
   */
  expiresInMs?: number;
  /**
   * Cut in rather than wait. For a supervisor stopping a call going wrong, not
   * for an answer arriving late, which should never talk over anyone.
   */
  interrupt?: boolean;
}

export type UnpromptedOutcome =
  /** Said in full. */
  | "spoken"
  /** Started, then the caller talked over it. */
  | "interrupted"
  /** Withdrawn before it was said. */
  | "cancelled"
  /** The floor never freed in time. */
  | "expired"
  /** Pushed out of the queue by newer lines. */
  | "superseded"
  /** The call ended first. */
  | "closed";

export interface UnpromptedHandle {
  /** Settles exactly once, and never rejects. */
  readonly done: Promise<UnpromptedOutcome>;
  /** True once the line has begun being spoken. */
  readonly started: boolean;
  /** Withdraw it. False if it is already being spoken. */
  cancel(): boolean;
}

/**
 * Keeping the caller company while something slow happens.
 *
 * Distinct from a filler, which is one short phrase covering the ordinary gap
 * before a reply starts. A stall covers a wait long enough that silence starts
 * to read as a dropped call, and it escalates: the second thing you say to
 * someone who has been waiting cannot be the first thing again.
 */
export interface StallOptions {
  /** What to say, in order, as the wait goes on. */
  lines: string[];
  /** Delay before the first line, and between the rest. */
  everyMs?: number;
  /** Add these to the conversation the model sees. Defaults to false. */
  remember?: boolean;
  /** Reported to the observer as the kind of speech. Defaults to "stall". */
  kind?: string;
}

export interface StallHandle {
  /** Stop stalling, and withdraw any line that has not been said yet. */
  stop(): void;
  /** How many lines have been reached so far. */
  readonly stage: number;
}

/** The four judgements made about a transcript before the model sees it. */
export interface SessionPolicy {
  isLikelyNoise?(text: string, level: number, threshold: number): boolean;
  classifyScreening?(text: string): ScreeningKind | null;
  isFarewell?(text: string): boolean;
  stripMarkdown?(text: string): string;
}

interface DeferredLine {
  text: string;
  kind: string;
  remember: boolean;
  started: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settle(outcome: UnpromptedOutcome): void;
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
  private readonly policy: Required<SessionPolicy>;

  info: CallInfo | null = null;
  private history: ChatMessage[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private abort: AbortController | null = null;

  private agentSpeaking = false;
  private callerSpeaking = false;
  private markCounter = 0;
  private pendingMarks = 0;
  private epoch = 0;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIntro: string | null = null;
  private screenTurns = 0;
  private hangUpWhenDone = false;
  private closed = false;
  private deferred: DeferredLine[] = [];
  private stalls = new Set<StallHandle>();
  private stallAborts = new Set<AbortController>();
  private outbound: Promise<unknown> = Promise.resolve();
  private inflight = 0;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.providers = options.providers;
    this.observer = options.observer ?? {};
    this.detector = new UtteranceDetector(options.detector);
    this.policy = {
      isLikelyNoise: options.policy?.isLikelyNoise ?? isLikelyNoise,
      classifyScreening: options.policy?.classifyScreening ?? classifyScreening,
      isFarewell: options.policy?.isFarewell ?? isFarewell,
      stripMarkdown: options.policy?.stripMarkdown ?? stripMarkdown,
    };

    this.transport.onStart((info) => this.onStart(info));
    this.transport.onAudio((frame) => this.onAudio(frame));
    this.transport.onPlaybackComplete((markId) => this.onMark(markId));
    this.transport.onStop(() => this.close("the other end hung up"));
  }

  private get lines(): ScriptedLines {
    return this.options.lines ?? {};
  }

  /** True while audio the agent generated is still playing out. */
  get speaking(): boolean {
    return this.agentSpeaking;
  }

  /** True from the moment the caller starts an utterance until it closes. */
  get listening(): boolean {
    return this.callerSpeaking;
  }

  /**
   * True when neither side holds the channel, so something can be said without
   * talking over anyone. There is one audio buffer to the far end, so anything
   * spoken while it is busy is spliced into whatever is already playing.
   */
  get floorIsFree(): boolean {
    return !this.closed && !this.agentSpeaking && !this.callerSpeaking;
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

    // Who currently holds the channel. A barge-in opens an utterance too, so it
    // counts as the caller starting to speak even though no `speechStarted`
    // transition is reported for it.
    if (result.speechStarted || result.bargeIn) this.callerSpeaking = true;
    if (result.speechEnded) {
      this.callerSpeaking = false;
      // Deferred behind the reply to whatever they just said, rather than in
      // front of it: the utterance is enqueued further down this same handler,
      // and answering the question they just asked comes first.
      queueMicrotask(() => this.pump());
    }

    if (result.bargeIn) this.bargeIn();

    if (result.utterance) {
      const { utterance, level, threshold } = result;
      this.enqueue(() => this.handleUtterance(utterance, level ?? 0, threshold ?? 0));
    }
  }

  /** Utterances are processed one at a time, in order. */
  private enqueue(job: () => Promise<unknown>): void {
    this.inflight += 1;
    this.queue = this.queue
      .then(job)
      .catch((error: Error) => {
        if (error?.name === "AbortError") return; // barge-in cancelled it, expected
        this.observer.onError?.(error);
      })
      .then(() => {
        this.inflight -= 1;
        // The queue going idle is one of the moments something waiting for the
        // floor might now be able to speak.
        if (this.inflight === 0) this.pump();
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

    if (this.policy.isLikelyNoise(text, level, threshold)) return;

    this.observer.onCallerSpeech?.(text, { sttMs });
    this.history.push({ role: "user", content: text });
    this.trimHistory();

    // A screener or voicemail system is not the customer. Answer it from a
    // script: the model, left to itself, greets it by name and starts
    // confirming private details to whatever machine picked up.
    const screening = this.policy.classifyScreening(text);
    if (screening) {
      await this.handleScreening(screening, signal);
      return;
    }
    this.screenTurns = 0;

    // The caller is winding up. Say goodbye and hang up, rather than answering
    // again and leaving them to hang up on an agent that will not stop talking.
    if (this.policy.isFarewell(text)) {
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

    const spoken = this.policy.stripMarkdown(reply);
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
    return this.serialiseAudio(() => this.synthesise(rawText, signal));
  }

  /**
   * One clip at a time, whoever asked for it.
   *
   * Separate from the work queue on purpose. The queue serialises turns, and a
   * turn waiting on a slow model holds it for the entire wait, which is exactly
   * when something else needs to be able to speak. Audio is the thing that
   * genuinely cannot overlap: there is one buffer to the far end, so two clips
   * streaming at once are spliced into a single stream of alternating
   * fragments of two sentences.
   */
  private serialiseAudio<T>(job: () => Promise<T>): Promise<T> {
    const run = this.outbound.then(job, job);
    this.outbound = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async synthesise(rawText: string, signal?: AbortSignal): Promise<number> {
    if (this.closed) return 0;
    const text = this.policy.stripMarkdown(rawText);
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
      return;
    }
    this.pump();
  }

  /** Keeps the detector's interrupt threshold in step with playback. */
  private setSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
    this.detector.setAgentSpeaking(speaking);
  }

  /** Stops the agent mid-sentence and gives up the channel. */
  private stopSpeaking(): void {
    this.abort?.abort();
    // A stall speaks outside the turn, so it has its own signal. Without this
    // the caller interrupts, the turn stops, and the stall keeps going. Being
    // talked to is also the end of needing to fill the silence, so the ladder
    // stops rather than merely going quiet.
    for (const controller of this.stallAborts) controller.abort();
    for (const stall of [...this.stalls]) stall.stop();
    this.clearFiller();
    this.transport.clear();
    // Discarded audio never plays, so its marks may never come back. Move to a
    // new epoch and drop the old counts rather than waiting on them forever.
    this.epoch += 1;
    this.pendingMarks = 0;
    this.setSpeaking(false);
  }

  private bargeIn(): void {
    this.stopSpeaking();
    this.observer.onBargeIn?.();
  }

  private scheduleFiller(): void {
    const bank = this.options.fillers;
    if (!bank || this.fillerTimer) return;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (this.closed || this.agentSpeaking) return;
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

  /**
   * Says something no caller turn asked for, once there is room to say it.
   *
   * This is the primitive behind anything arriving from outside the
   * conversation: a supervisor steering the call, or an answer that took longer
   * to find than a turn could wait for. It is not a second audio path. There is
   * one buffer to the far end, so it goes through the same queue as everything
   * else and waits for the floor, which is what stops two voices being spliced
   * into one stream.
   *
   * Deliberately not cancelled by a barge-in. Cleared audio is stale, but the
   * intention behind a line is not: someone asked a question, interrupted the
   * stalling, and the answer still arrives afterwards. Use `expiresInMs` for
   * things that genuinely stop being worth saying.
   */
  speakUnprompted(speech: string | UnpromptedSpeech): UnpromptedHandle {
    const request: UnpromptedSpeech = typeof speech === "string" ? { text: speech } : speech;

    let resolve!: (outcome: UnpromptedOutcome) => void;
    const done = new Promise<UnpromptedOutcome>((res) => {
      resolve = res;
    });

    const line: DeferredLine = {
      text: request.text,
      kind: request.kind ?? "unprompted",
      remember: request.remember ?? true,
      started: false,
      settled: false,
      timer: null,
      settle(outcome) {
        if (this.settled) return;
        this.settled = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        resolve(outcome);
      },
    };

    const handle: UnpromptedHandle = {
      done,
      get started() {
        return line.started;
      },
      cancel: () => {
        if (line.started || line.settled) return false;
        this.drop(line, "cancelled");
        return true;
      },
    };

    if (this.closed || !request.text.trim()) {
      line.settle("closed");
      return handle;
    }

    if (request.expiresInMs !== undefined) {
      line.timer = setTimeout(() => {
        if (line.started) return; // too late to withdraw, let it finish
        this.drop(line, "expired");
      }, request.expiresInMs);
    }

    // Cutting in is a separate path on purpose: it skips the queue of things
    // politely waiting, because the reason to cut in is that waiting is wrong.
    if (request.interrupt) {
      this.stopSpeaking();
      this.enqueue(() => this.deliver(line));
      return handle;
    }

    this.deferred.push(line);
    const cap = Math.max(1, this.options.maxDeferred ?? 2);
    while (this.deferred.length > cap) {
      this.deferred.shift()?.settle("superseded");
    }
    this.pump();
    return handle;
  }

  /**
   * Keeps the caller company while something slow happens, escalating as the
   * wait goes on.
   *
   * Deliberately not built on the filler timer. A filler is single-shot and
   * suppresses itself the moment the agent starts speaking, which is right for
   * covering the gap before a reply but would swallow every rung after the
   * first here: speaking rung one would cancel rung two. The two mechanisms
   * share no state at all, so neither can cancel the other by accident.
   *
   * Each rung goes out through `speakUnprompted`, so a stall never talks over
   * the caller, and expires at the next rung's due time: a stall line that
   * missed its gap is worse than no stall, because it lands after the thing it
   * was covering for has already been said.
   */
  beginStall(options: StallOptions): StallHandle {
    const lines = options.lines.map((line) => line.trim()).filter(Boolean);
    const everyMs = Math.max(1, options.everyMs ?? 4000);
    const controller = new AbortController();
    let stage = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      this.stallAborts.delete(controller);
      this.stalls.delete(handle);
    };

    const tick = (): void => {
      timer = null;
      if (this.closed || stage >= lines.length) {
        stop();
        return;
      }
      const text = lines[stage];
      stage += 1;

      // Skipped rather than queued when someone is talking. A rung that waits
      // for a gap arrives after the thing it was covering for, which is worse
      // than never having said it.
      if (this.floorIsFree) {
        if (options.remember ?? false) {
          this.history.push({ role: "assistant", content: text });
          this.trimHistory();
        }
        this.observer.onAgentSpeech?.(text, { kind: options.kind ?? "stall" });
        void this.speak(text, controller.signal).catch((error: Error) => {
          if (error?.name === "AbortError") return;
          this.observer.onError?.(error);
        });
      }

      if (stage < lines.length) timer = setTimeout(tick, everyMs);
    };

    const handle: StallHandle = {
      stop,
      get stage() {
        return stage;
      },
    };

    if (lines.length) {
      this.stallAborts.add(controller);
      timer = setTimeout(tick, everyMs);
    }
    this.stalls.add(handle);
    return handle;
  }

  /** Removes a line that will never be spoken. */
  private drop(line: DeferredLine, outcome: UnpromptedOutcome): void {
    const at = this.deferred.indexOf(line);
    if (at >= 0) this.deferred.splice(at, 1);
    line.settle(outcome);
  }

  /**
   * Speaks the next waiting line, if this is a moment when it can be said.
   *
   * Called from every edge that could free the floor: a new line arriving, the
   * queue going idle, playback finishing, and the caller stopping. There is no
   * polling, so a line waits exactly as long as the conversation makes it wait.
   */
  private pump(): void {
    if (this.closed || this.inflight > 0 || !this.deferred.length) return;
    if (!this.floorIsFree) return;

    this.enqueue(async () => {
      const line = this.deferred[0];
      if (!line) return;
      // The caller can start talking between deciding to speak and getting
      // here, because audio arrives synchronously from the transport. Leave the
      // line queued; the next edge will try again.
      if (this.callerSpeaking || this.closed) return;
      this.deferred.shift();
      await this.deliver(line);
    });
  }

  private async deliver(line: DeferredLine): Promise<void> {
    if (this.closed) {
      line.settle("closed");
      return;
    }
    line.started = true;
    if (line.remember) {
      this.history.push({ role: "assistant", content: line.text });
      this.trimHistory();
    }
    this.observer.onAgentSpeech?.(line.text, { kind: line.kind });

    const signal = this.beginTurn();
    try {
      await this.speak(line.text, signal);
      line.settle(signal.aborted ? "interrupted" : "spoken");
    } catch (error) {
      line.settle((error as Error)?.name === "AbortError" ? "interrupted" : "spoken");
      throw error;
    }
  }

  /**
   * Injects a line to say now, for a supervisor steering the call.
   *
   * Waits for a gap rather than talking over whoever is speaking. Pass
   * `interrupt` when stopping the call matters more than being polite.
   */
  say(text: string, options: { interrupt?: boolean } = {}): UnpromptedHandle {
    return this.speakUnprompted({
      text,
      kind: "injected",
      interrupt: options.interrupt,
    });
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
    // Anything still waiting for a gap will never get one. Settling rather than
    // abandoning matters because callers await these: an orchestrator holding a
    // promise that never resolves leaks for the lifetime of the process.
    for (const stall of [...this.stalls]) stall.stop();
    const waiting = this.deferred;
    this.deferred = [];
    for (const line of waiting) line.settle("closed");
    this.observer.onCallEnded?.(reason);
  }
}
