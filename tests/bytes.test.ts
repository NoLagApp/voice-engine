import { describe, it, expect, afterEach } from "vitest";
import { toBase64, fromBase64, concatBytes } from "../src/bytes.js";
import { mulawDecode, mulawEncode, pcm16ToWav, bytesToInt16, StreamingDownsampler } from "../src/audio.js";
import { TwilioMediaStreamTransport } from "../src/transports/twilio.js";
import type { SocketLike } from "../src/transport.js";

describe("base64", () => {
  it("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(fromBase64(toBase64(all)))).toEqual(Array.from(all));
  });

  it("handles each padding case", () => {
    // Lengths of 1, 2 and 3 mod 3 exercise the "==", "=" and no-padding forms.
    for (const length of [0, 1, 2, 3, 4, 5, 6]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("agrees with Node's own encoder", () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("survives payloads far larger than the conversion block size", () => {
    // A whole call's audio at once would blow the stack if spread as arguments.
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 256);
    expect(fromBase64(toBase64(bytes)).length).toBe(bytes.length);
  });
});

describe("concatBytes", () => {
  it("joins in order and copies", () => {
    const joined = concatBytes([Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3)]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});

/**
 * The core is meant to run on any modern runtime, not only Node. Removing
 * `Buffer` entirely is the only honest way to check that: a stray
 * `Buffer.from` would work perfectly in every test here and then fail on an
 * edge runtime where the global does not exist.
 */
describe("the core without a Buffer global", () => {
  const original = (globalThis as { Buffer?: unknown }).Buffer;
  afterEach(() => {
    (globalThis as { Buffer?: unknown }).Buffer = original;
  });

  it("encodes, decodes and frames audio with Buffer removed", () => {
    delete (globalThis as { Buffer?: unknown }).Buffer;

    const samples = new Int16Array(480);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 8) * 6000);

    const mulaw = mulawEncode(samples);
    expect(mulawDecode(mulaw).length).toBe(samples.length);

    const wav = pcm16ToWav(samples, 8000);
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(toBase64(wav).length).toBeGreaterThan(0);

    const pcmBytes = new Uint8Array(samples.length * 2);
    const view = new DataView(pcmBytes.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
    expect(bytesToInt16(pcmBytes).length).toBe(samples.length);

    const downsampler = new StreamingDownsampler(24000, 8000);
    downsampler.push(pcmBytes);
    expect(downsampler.flush()).toBeInstanceOf(Int16Array);
  });

  it("runs a whole transport exchange with Buffer removed", () => {
    delete (globalThis as { Buffer?: unknown }).Buffer;

    const sent: string[] = [];
    const handlers: Record<string, (arg: unknown) => void> = {};
    const socket: SocketLike = {
      readyState: 1,
      OPEN: 1,
      send: (data) => sent.push(data),
      close: () => {},
      on: (event, handler) => {
        handlers[event] = handler as (arg: unknown) => void;
      },
    };

    const transport = new TwilioMediaStreamTransport({ socket });
    const heard: Int16Array[] = [];
    transport.onAudio((frame) => heard.push(frame));

    const inbound = mulawEncode(Int16Array.from({ length: 160 }, (_, i) => i * 10));
    handlers.message?.(
      JSON.stringify({ event: "media", media: { payload: toBase64(inbound) } })
    );
    expect(heard[0]?.length).toBe(160);

    transport.sendAudio(new Int16Array(800));
    transport.mark("a0-1");
    expect(sent.some((line) => line.includes('"event":"media"'))).toBe(true);
    expect(sent.some((line) => line.includes('"event":"mark"'))).toBe(true);
  });
});
