import type {
  ChatRequest,
  LanguageModel,
  SpeakRequest,
  SpeechToText,
  TextToSpeech,
  TranscribeRequest,
} from "../../src/providers/types.js";
import { abortError, waitFor } from "./async.js";

/**
 * Every fake here yields between units of work (a sentence, an audio chunk),
 * because the behaviour under test lives in those gaps: a barge-in that lands
 * mid-clip, or an answer arriving while the caller still holds the floor. A
 * fake that resolves in one tick can never place anything there.
 *
 * `manual` mode holds each unit until the test releases it, which is what makes
 * "mid-clip" an addressable moment rather than a race.
 */
class Paced {
  /** Hold every unit of work until the test asks for it. */
  manual = false;
  private waiters: Array<() => void> = [];

  protected pace(): Promise<void> {
    if (!this.manual) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** True once work is parked waiting to be released. */
  get waiting(): boolean {
    return this.waiters.length > 0;
  }

  /** Wait for work to park, then release one unit of it. */
  async step(): Promise<void> {
    await waitFor(() => this.waiters.length > 0, "provider to reach a yield point");
    this.waiters.shift()?.();
    // Two rounds: one for the provider to emit, one for the session to act on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Release everything currently parked and anything that parks while draining. */
  async drain(limit = 50): Promise<void> {
    for (let i = 0; i < limit && this.waiters.length > 0; i++) {
      await this.step();
    }
  }
}

export class FakeSpeechToText extends Paced implements SpeechToText {
  /** Transcripts handed out in order; an exhausted script returns "". */
  script: string[] = [];
  readonly requests: TranscribeRequest[] = [];

  async transcribe(request: TranscribeRequest): Promise<string> {
    this.requests.push(request);
    await this.pace();
    if (request.signal?.aborted) throw abortError();
    return this.script.shift() ?? "";
  }
}

/** Matches the sentence splitting a streaming provider would do. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

export class FakeLanguageModel extends Paced implements LanguageModel {
  /** Full replies handed out in order; an exhausted script returns "". */
  script: string[] = [];
  readonly requests: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<string> {
    this.requests.push(request);
    const reply = this.script.shift() ?? "";
    for (const sentence of sentences(reply)) {
      await this.pace();
      if (request.signal?.aborted) throw abortError();
      request.onSentence?.(sentence);
    }
    return reply;
  }

  /** The messages of the most recent call, system prompt included. */
  get lastMessages(): ChatRequest["messages"] {
    return this.requests[this.requests.length - 1]?.messages ?? [];
  }
}

export class FakeTextToSpeech extends Paced implements TextToSpeech {
  /**
   * 8 kHz matches the transport, so the downsampler is a pass-through and a
   * test can count samples without accounting for resampling.
   */
  readonly sampleRate = 8000;
  chunksPerClip = 3;
  samplesPerChunk = 160;

  /** Text passed to synthesis, in order. */
  readonly spoken: string[] = [];
  /** Text whose synthesis was cancelled by an abort signal. */
  readonly aborted: string[] = [];
  /** Clips that ran to completion without a signal being passed at all. */
  readonly unsignalled: string[] = [];
  /**
   * Which clip each chunk of audio belonged to, in the order it went out. Two
   * clips streaming at once show up here as alternating entries, which is what
   * the far end would hear as two half-sentences spliced together.
   */
  readonly emissions: string[] = [];

  async speak(request: SpeakRequest): Promise<void> {
    this.spoken.push(request.text);
    if (!request.signal) this.unsignalled.push(request.text);

    for (let i = 0; i < this.chunksPerClip; i++) {
      await this.pace();
      if (request.signal?.aborted) {
        this.aborted.push(request.text);
        throw abortError();
      }
      this.emissions.push(request.text);
      request.onAudio(pcm16(this.samplesPerChunk, 1000 + i));
    }
  }

  /** Distinct clips, in the order their audio started going out. */
  get clipOrder(): string[] {
    return this.emissions.filter((text, at) => at === 0 || this.emissions[at - 1] !== text);
  }
}

/** PCM16 little-endian bytes, which is what a real provider streams. */
function pcm16(samples: number, amplitude: number): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin(i / 3) * amplitude), true);
  }
  return bytes;
}

export function fakeProviders(): {
  stt: FakeSpeechToText;
  llm: FakeLanguageModel;
  tts: FakeTextToSpeech;
} {
  return {
    stt: new FakeSpeechToText(),
    llm: new FakeLanguageModel(),
    tts: new FakeTextToSpeech(),
  };
}
