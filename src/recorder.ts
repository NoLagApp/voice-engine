/**
 * Per-call recording: two audio tracks plus a transcript.
 *
 *   <callId>-caller.wav  what the other end said
 *   <callId>-agent.wav   what we said
 *   <callId>.jsonl       every event, machine readable
 *   <callId>.txt         the same conversation, readable
 *
 * The two tracks are kept time-aligned. Caller audio arrives in real time, one
 * 20 ms frame at a time, so it doubles as the call clock; before any agent
 * audio is written the agent track is padded with silence up to that clock.
 * Without the padding the agent track collapses into one continuous monologue
 * and the files cannot be listened to side by side.
 *
 * Audio is streamed to disk rather than buffered, so a long call costs no more
 * memory than a short one. WAV needs its length in the header, which is not
 * known until the end, so the header is written with zeros and patched on
 * close.
 *
 * Recordings contain personal data and, in many places, need the consent of
 * everyone on the call. They are written in the clear; treat the directory
 * accordingly.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionObserver, TurnMetrics } from "./session.js";
import type { CallInfo } from "./transport.js";
import type { ScreeningKind } from "./policy.js";

const HEADER_BYTES = 44;

function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

class WavTrack {
  private fd: number | null;
  private samples = 0;

  constructor(
    file: string,
    private readonly sampleRate: number
  ) {
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, wavHeader(sampleRate, 0));
  }

  get position(): number {
    return this.samples;
  }

  write(samples: Int16Array): void {
    if (!samples.length || this.fd === null) return;
    fs.writeSync(
      this.fd,
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    );
    this.samples += samples.length;
  }

  /** Silence up to an absolute sample position, so tracks stay aligned. */
  padTo(position: number): void {
    const missing = position - this.samples;
    if (missing > 0) this.write(new Int16Array(missing));
  }

  close(): void {
    if (this.fd === null) return;
    fs.writeSync(this.fd, wavHeader(this.sampleRate, this.samples * 2), 0, HEADER_BYTES, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

export interface CallRecorder extends SessionObserver {
  /** Path prefix the files share. */
  readonly base: string;
}

export function createRecorder({
  dir,
  callId,
  sampleRate = 8000,
}: {
  dir: string;
  callId: string;
  sampleRate?: number;
}): CallRecorder {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, callId);
  const caller = new WavTrack(`${base}-caller.wav`, sampleRate);
  const agent = new WavTrack(`${base}-agent.wav`, sampleRate);
  const events = fs.openSync(`${base}.jsonl`, "a");
  const text = fs.openSync(`${base}.txt`, "a");
  const startedAt = Date.now();
  let closed = false;

  const log = (row: Record<string, unknown>) => {
    if (closed) return;
    fs.writeSync(events, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  };

  const line = (role: string, content: string, meta: Record<string, unknown> = {}) => {
    log({ type: "transcript", role, text: content, ...meta });
    const at = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
    const tag = role === "caller" ? "CALLER" : role === "filler" ? "FILLER" : "AGENT ";
    fs.writeSync(text, `[${at}s] ${tag} | ${content}\n`);
  };

  return {
    base,

    onCallStarted(info: CallInfo) {
      log({ type: "event", event: "call-started", ...info });
    },
    onCallerAudio(frame: Int16Array) {
      caller.write(frame);
    },
    onAgentAudio(samples: Int16Array) {
      agent.padTo(caller.position);
      agent.write(samples);
    },
    onCallerSpeech(content: string, meta: { sttMs: number }) {
      line("caller", content, meta);
    },
    onAgentSpeech(content: string, meta: { kind: string; llmMs?: number }) {
      line(meta.kind === "filler" ? "filler" : "agent", content, meta);
    },
    onScreening(kind: ScreeningKind, turn: number) {
      log({ type: "event", event: "screening-detected", kind, turn });
    },
    onBargeIn() {
      log({ type: "event", event: "barge-in" });
    },
    onTurnComplete(metrics: TurnMetrics) {
      log({ type: "event", event: "turn-complete", ...metrics });
    },
    onError(error: Error) {
      log({ type: "event", event: "error", message: error.message });
    },
    onCallEnded(reason: string) {
      if (closed) return;
      log({ type: "event", event: "call-ended", reason, durationMs: Date.now() - startedAt });
      closed = true;
      caller.close();
      agent.close();
      fs.closeSync(events);
      fs.closeSync(text);
    },
  };
}
