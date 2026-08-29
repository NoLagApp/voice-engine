/**
 * Telephone audio primitives: G.711 mu-law, WAV, and resampling.
 *
 * Phone audio is 8 kHz mu-law; speech models work in 16-bit PCM at 16 kHz or
 * 24 kHz. Everything here exists to move between those two worlds. It is
 * deliberately dependency free and works in bytes rather than Node Buffers, so
 * it can be unit tested in isolation and run in any modern JavaScript runtime.
 */

import { concatBytes, viewOf, writeAscii } from "./bytes.js";

const MULAW_BIAS = 0x84;
const MULAW_MAX = 32635;

/** G.711 mu-law bytes to PCM16 samples. */
export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = ~bytes[i]!;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    out[i] = sign ? -sample : sample;
  }
  return out;
}

/** PCM16 samples to G.711 mu-law bytes. */
export function mulawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i]!;
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;

    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Wraps PCM16 samples in a WAV container, for sending to a speech model. */
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = viewOf(bytes);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

/** Raw little-endian PCM16 bytes to samples. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const view = viewOf(bytes);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function movingAverage(samples: Int16Array, window: number): Int16Array {
  if (window <= 1) return samples;
  const out = new Int16Array(samples.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(samples.length - 1, i + half); j++) {
      sum += samples[j]!;
      count++;
    }
    out[i] = Math.round(sum / count);
  }
  return out;
}

/**
 * Linear-interpolation resampler. Downsampling is low-pass filtered first,
 * without which the frequencies above the new Nyquist limit fold back into the
 * audible range and the result sounds gritty.
 */
export function resamplePcm16(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const source = ratio > 1 ? movingAverage(samples, Math.max(2, Math.round(ratio))) : samples;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = source[index] ?? 0;
    const b = source[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

/** Root mean square, the loudness measure the detector thresholds on. */
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Downsamples a PCM16 byte stream as it arrives, so speech can be forwarded to
 * the caller while the rest of it is still being synthesised.
 *
 * Chunks arrive at arbitrary boundaries: a chunk can end mid-sample, and a
 * group of input samples for one output sample can straddle two chunks, so
 * both are carried over. Whole-number rate ratios (the usual 24k to 8k) are
 * averaged in fixed groups, which is boundary-safe and anti-aliases for free.
 * Any other ratio falls back to buffering the lot and resampling at the end.
 */
export class StreamingDownsampler {
  private readonly factor: number;
  private readonly streaming: boolean;
  private byteCarry: Uint8Array | null = null;
  private samples: number[] = [];

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number
  ) {
    this.factor = fromRate / toRate;
    this.streaming = Number.isInteger(this.factor) && this.factor >= 1;
  }

  /** Returns the output samples available so far, possibly none. */
  push(chunk: Uint8Array): Int16Array {
    let bytes = chunk;
    if (this.byteCarry?.length) {
      bytes = concatBytes([this.byteCarry, bytes]);
      this.byteCarry = null;
    }
    const usable = bytes.length - (bytes.length % 2);
    if (usable < bytes.length) this.byteCarry = bytes.slice(usable);

    const view = viewOf(bytes);
    for (let i = 0; i < usable; i += 2) this.samples.push(view.getInt16(i, true));

    if (!this.streaming) return new Int16Array(0);

    const count = Math.floor(this.samples.length / this.factor);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let j = 0; j < this.factor; j++) sum += this.samples[i * this.factor + j]!;
      out[i] = Math.round(sum / this.factor);
    }
    this.samples = this.samples.slice(count * this.factor);
    return out;
  }

  /** Whatever is left once the stream ends. */
  flush(): Int16Array {
    const rest = Int16Array.from(this.samples);
    this.samples = [];
    this.byteCarry = null;
    if (!rest.length) return rest;
    return this.streaming ? rest : resamplePcm16(rest, this.fromRate, this.toRate);
  }
}
