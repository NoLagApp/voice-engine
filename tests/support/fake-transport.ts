import type { AudioTransport, CallInfo } from "../../src/transport.js";

/**
 * A transport driven entirely from test code.
 *
 * Two details are load-bearing and easy to get wrong, both of which produce a
 * test that passes while asserting the wrong thing:
 *
 *   Marks are echoed asynchronously. `speakScripted` sets `hangUpWhenDone`
 *   AFTER `await speak()` resolves, and `speak()` emits the mark before it
 *   resolves. Echoing synchronously from `mark()` therefore runs `onMark`
 *   while the latch is still false, so a voicemail or farewell never hangs up
 *   and the test happily reports success.
 *
 *   The exact mark id is echoed back. `onMark` parses the `a<epoch>-` prefix
 *   and ignores foreign epochs, so a synthetic id silently never decrements
 *   `pendingMarks` and the session stays "speaking" forever.
 */
export class FakeTransport implements AudioTransport {
  /** Every sample block handed to the transport, in order. */
  readonly sent: Int16Array[] = [];
  /** Mark ids in the order they were emitted. */
  readonly marks: string[] = [];
  /** How many times playback was flushed for a barge-in. */
  clears = 0;
  closed = false;

  /**
   * Marks emitted but not yet echoed. Tests drive playback by calling
   * `finishPlayback()`, which is the moment the far end says "you have
   * stopped talking".
   */
  private outstanding: string[] = [];

  private startHandler?: (info: CallInfo) => void;
  private audioHandler?: (frame: Int16Array) => void;
  private markHandler?: (markId: string) => void;
  private stopHandler?: () => void;

  onStart(handler: (info: CallInfo) => void): void {
    this.startHandler = handler;
  }
  onAudio(handler: (frame: Int16Array) => void): void {
    this.audioHandler = handler;
  }
  onPlaybackComplete(handler: (markId: string) => void): void {
    this.markHandler = handler;
  }
  onStop(handler: () => void): void {
    this.stopHandler = handler;
  }

  sendAudio(samples: Int16Array): void {
    this.sent.push(samples);
  }
  mark(markId: string): void {
    this.marks.push(markId);
    this.outstanding.push(markId);
  }
  clear(): void {
    this.clears += 1;
    // A real carrier discards queued audio, so those marks may never come
    // back. Dropping them here is what makes the epoch mechanism meaningful.
    this.outstanding = [];
  }
  close(): void {
    this.closed = true;
  }

  // --- driving the call from a test -------------------------------------

  start(info: Partial<CallInfo> = {}): void {
    this.startHandler?.({ callId: "TEST", peer: "+61400000000", outbound: false, ...info });
  }

  /** One 20 ms frame of caller audio. */
  audio(frame: Int16Array): void {
    this.audioHandler?.(frame);
  }

  hangUp(): void {
    this.stopHandler?.();
  }

  /**
   * Echo one specific mark, including one already discarded by `clear()`.
   * A carrier can genuinely do this, so the session has to survive it.
   */
  echo(markId: string): void {
    this.markHandler?.(markId);
  }

  /** Echo every outstanding mark, as a phone would once the audio played. */
  async finishPlayback(): Promise<void> {
    const pending = this.outstanding;
    this.outstanding = [];
    for (const markId of pending) {
      await Promise.resolve();
      this.markHandler?.(markId);
    }
    await Promise.resolve();
  }

  /** Total samples sent, a proxy for "how much was actually spoken". */
  get sampleCount(): number {
    return this.sent.reduce((total, block) => total + block.length, 0);
  }

  get isSpeakingPending(): boolean {
    return this.outstanding.length > 0;
  }
}
