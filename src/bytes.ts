/**
 * Byte helpers, so the core needs no Node `Buffer`.
 *
 * `Buffer` is comfortable but it is a Node type. Keeping it out of the hot path
 * means the engine runs unchanged on Deno, Bun and edge runtimes, and it costs
 * almost nothing: `Uint8Array` and `DataView` do all of this already.
 *
 * `btoa` and `atob` are used for base64 rather than a hand-rolled table.
 * They are present in every runtime this package supports (Node 18+, Deno, Bun,
 * Workers, browsers) and getting base64 padding subtly wrong is a real risk
 * that a well-tested global removes.
 */

/** Joins byte arrays, the Uint8Array equivalent of Buffer.concat. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Writes ASCII at an offset, for the fixed tags in a WAV header. */
export function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i) & 0xff;
}

// Converted in blocks: String.fromCharCode(...bytes) on a whole call's audio
// would spread hundreds of thousands of arguments and blow the stack.
const BLOCK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BLOCK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A DataView over exactly the bytes given, respecting any offset. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
