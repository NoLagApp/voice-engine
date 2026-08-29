import { describe, it, expect } from "vitest";
import {
  mulawDecode,
  mulawEncode,
  pcm16ToWav,
  resamplePcm16,
  StreamingDownsampler,
} from "../src/audio.js";

function tone(samples: number, amplitude = 8000, period = 30): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(Math.sin(i / period) * amplitude);
  return out;
}

describe("mu-law", () => {
  it("survives a round trip within its quantisation error", () => {
    const original = tone(2000);
    const restored = mulawDecode(mulawEncode(original));
    let error = 0;
    for (let i = 0; i < original.length; i++) error += Math.abs(original[i]! - restored[i]!);
    // mu-law is lossy by design; this bound catches encoding mistakes without
    // pretending the codec is transparent.
    expect(error / original.length).toBeLessThan(300);
  });
});

describe("pcm16ToWav", () => {
  it("writes a header the decoders agree on", () => {
    const wav = pcm16ToWav(tone(800), 8000);
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...wav.subarray(from, to));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 12)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(1600);
    expect(wav.length).toBe(44 + 1600);
  });
});

describe("resamplePcm16", () => {
  it("converts 24k to 8k with the expected length", () => {
    expect(resamplePcm16(tone(24000), 24000, 8000).length).toBe(8000);
  });
});

describe("StreamingDownsampler", () => {
  it("is unaffected by where the chunk boundaries fall", () => {
    const source = tone(24000);
    const bytes = new Uint8Array(source.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < source.length; i++) view.setInt16(i * 2, source[i]!, true);

    // Deliberately awkward sizes: odd byte counts split a sample in half, and
    // small ones split a group of three that becomes one output sample.
    const sizes = [1, 7, 333, 2, 4096, 5, 999, 8192];
    const downsampler = new StreamingDownsampler(24000, 8000);
    const parts: Int16Array[] = [];
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
      const size = Math.min(sizes[index++ % sizes.length]!, bytes.length - offset);
      parts.push(downsampler.push(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    parts.push(downsampler.flush());

    const streamed = Int16Array.from(parts.flatMap((part) => Array.from(part)));
    const reference = new Int16Array(source.length / 3);
    for (let i = 0; i < reference.length; i++) {
      reference[i] = Math.round((source[i * 3]! + source[i * 3 + 1]! + source[i * 3 + 2]!) / 3);
    }

    expect(streamed.length).toBe(reference.length);
    expect(Array.from(streamed)).toEqual(Array.from(reference));
  });
});
