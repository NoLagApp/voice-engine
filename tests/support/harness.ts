import {
  VoiceSession,
  type SessionObserver,
  type TurnMetrics,
  type VoiceSessionOptions,
} from "../../src/session.js";
import type { ScreeningKind } from "../../src/policy.js";
import { FakeTransport } from "./fake-transport.js";
import { fakeProviders } from "./fake-providers.js";
import { flush } from "./async.js";

const FRAME = 160; // 20 ms at 8 kHz

/** One 20 ms frame at a given loudness. */
export function frame(amplitude: number): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    out[i] = Math.round(Math.sin(i / 4) * amplitude);
  }
  return out;
}

export const QUIET = 40;
export const LOUD = 4000;

interface Observed {
  started: number;
  ended: string[];
  callerSpeech: string[];
  agentSpeech: Array<{ text: string; kind: string }>;
  screenings: Array<{ kind: ScreeningKind; turn: number }>;
  bargeIns: number;
  turns: TurnMetrics[];
  errors: Error[];
  /** Marks the point in the agent-audio stream each observation happened at. */
  agentAudioBlocks: number;
}

export interface Harness {
  session: VoiceSession;
  transport: FakeTransport;
  providers: ReturnType<typeof fakeProviders>;
  observed: Observed;
  /** Feed enough quiet frames for the detector to measure the room. */
  calibrate(): void;
  /** Feed n frames at a given loudness, synchronously. */
  feed(count: number, amplitude: number): void;
  /**
   * A complete caller turn: loud enough to open, long enough to count, then
   * silence long enough to close.
   */
  utterance(amplitude?: number): void;
  /** Drain the work queue and let all outstanding playback report back. */
  settle(): Promise<void>;
  /** The text of everything the agent said, in order. */
  said(): string[];
}

export function harness(
  overrides: Partial<VoiceSessionOptions> = {},
  observerOverrides: SessionObserver = {}
): Harness {
  const transport = new FakeTransport();
  const providers = fakeProviders();

  const observed: Observed = {
    started: 0,
    ended: [],
    callerSpeech: [],
    agentSpeech: [],
    screenings: [],
    bargeIns: 0,
    turns: [],
    errors: [],
    agentAudioBlocks: 0,
  };

  const observer: SessionObserver = {
    onCallStarted: () => {
      observed.started += 1;
    },
    onCallEnded: (reason) => observed.ended.push(reason),
    onCallerSpeech: (text) => observed.callerSpeech.push(text),
    onAgentSpeech: (text, meta) => observed.agentSpeech.push({ text, kind: meta.kind }),
    onScreening: (kind, turn) => observed.screenings.push({ kind, turn }),
    onBargeIn: () => {
      observed.bargeIns += 1;
    },
    onTurnComplete: (metrics) => observed.turns.push(metrics),
    onAgentAudio: () => {
      observed.agentAudioBlocks += 1;
    },
    onError: (error) => observed.errors.push(error),
    ...observerOverrides,
  };

  const session = new VoiceSession({
    transport,
    providers,
    systemPrompt: "You are a test agent.",
    fillers: null,
    ...overrides,
    observer,
  });

  const feed = (count: number, amplitude: number): void => {
    for (let i = 0; i < count; i++) transport.audio(frame(amplitude));
  };

  return {
    session,
    transport,
    providers,
    observed,
    feed,
    calibrate: () => feed(30, QUIET),
    utterance: (amplitude = LOUD) => {
      feed(25, amplitude);
      feed(40, QUIET);
    },
    async settle(): Promise<void> {
      // Three passes, because finishing playback can release queued work that
      // then speaks again and produces new marks.
      for (let i = 0; i < 3; i++) {
        await flush();
        await transport.finishPlayback();
      }
      await flush();
    },
    said: () => observed.agentSpeech.map((entry) => entry.text),
  };
}
