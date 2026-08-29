/**
 * How audio reaches the engine, as an interface.
 *
 * The engine deals only in PCM16 at 8 kHz and in "play this, tell me when it
 * finished". Everything telephony specific (mu-law, base64, JSON framing,
 * stream identifiers) belongs to a transport implementation.
 *
 * The playback mark is not decoration. Audio is pushed to the network far
 * faster than it is heard, so "have I finished speaking" cannot be answered
 * locally; only the far end knows, and it answers by echoing the mark back.
 */

/**
 * The parts of a WebSocket a transport actually uses.
 *
 * Structural rather than importing from `ws`, so the engine does not force a
 * socket library on its consumers, and so a transport can be driven by a test
 * double without opening a real connection.
 */
export interface SocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
}

export interface CallInfo {
  /** Provider's identifier for the call, used to name rooms and recordings. */
  callId: string;
  /** The number or label at the other end. */
  peer: string;
  /** True when we placed the call rather than received it. */
  outbound: boolean;
}

export interface AudioTransport {
  /** Fires once the call is up, with its identity. */
  onStart(handler: (info: CallInfo) => void): void;
  /** One frame of inbound audio, PCM16 at 8 kHz, typically 20 ms. */
  onAudio(handler: (frame: Int16Array) => void): void;
  /** The far end has finished playing everything up to this mark. */
  onPlaybackComplete(handler: (markId: string) => void): void;
  /** The call ended from the other side. */
  onStop(handler: () => void): void;

  /** Queue audio for playback, PCM16 at 8 kHz. */
  sendAudio(samples: Int16Array): void;
  /** Ask to be told when everything queued so far has been heard. */
  mark(markId: string): void;
  /** Discard anything queued but not yet played, for barge-in. */
  clear(): void;
  /** Hang up. */
  close(): void;
}
