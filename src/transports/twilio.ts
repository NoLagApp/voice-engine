/**
 * Twilio Media Streams as an AudioTransport.
 *
 * Everything Twilio specific lives here: the JSON event framing, base64, mu-law
 * at 8 kHz, and the stream identifier that has to be echoed on everything sent
 * back. The session above deals only in PCM samples.
 *
 * The protocol, briefly. Twilio opens the socket and sends `connected` then
 * `start` (carrying the call identifiers and any parameters from the TwiML).
 * `media` events flow both ways. A `mark` sent downstream is echoed back once
 * the audio queued before it has finished playing, which is the only way to
 * know when the agent has stopped talking. `clear` discards audio queued but
 * not yet played, which is how an interruption takes effect.
 */

import { mulawDecode, mulawEncode } from "../audio.js";
import { concatBytes, fromBase64, toBase64 } from "../bytes.js";
import type { AudioTransport, CallInfo, SocketLike } from "../transport.js";

/** 100 ms of mu-law per outbound frame. */
const OUT_CHUNK_BYTES = 800;

export interface TwilioTransportOptions {
  socket: SocketLike;
  /**
   * Name of the TwiML <Parameter> holding who we are talking to. The webhook
   * sets this, since on an outbound call the customer is the To number and on
   * an inbound one it is the From number.
   */
  peerParameter?: string;
  /** TwiML <Parameter> that marks a call we placed. */
  outboundParameter?: string;
}

interface TwilioStartEvent {
  streamSid: string;
  callSid: string;
  customParameters?: Record<string, string>;
}

export class TwilioMediaStreamTransport implements AudioTransport {
  private readonly socket: SocketLike;
  private readonly options: TwilioTransportOptions;
  private streamSid: string | null = null;
  private outBuffer: Uint8Array = new Uint8Array(0);

  private startHandler?: (info: CallInfo) => void;
  private audioHandler?: (frame: Int16Array) => void;
  private markHandler?: (markId: string) => void;
  private stopHandler?: () => void;

  constructor(options: TwilioTransportOptions) {
    this.socket = options.socket;
    this.options = options;
    this.socket.on("message", (raw: unknown) => this.handleMessage(raw));
    this.socket.on("close", () => this.stopHandler?.());
  }

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

  private handleMessage(raw: unknown): void {
    let message: { event?: string; start?: TwilioStartEvent; media?: { payload: string }; mark?: { name: string } };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (message.event) {
      case "start": {
        const start = message.start;
        if (!start) return;
        this.streamSid = start.streamSid;
        const params = start.customParameters ?? {};
        this.startHandler?.({
          callId: start.callSid,
          peer: params[this.options.peerParameter ?? "peer"] ?? "unknown",
          outbound: params[this.options.outboundParameter ?? "outbound"] === "1",
        });
        break;
      }
      case "media": {
        if (!message.media) return;
        this.audioHandler?.(mulawDecode(fromBase64(message.media.payload)));
        break;
      }
      case "mark": {
        if (message.mark?.name) this.markHandler?.(message.mark.name);
        break;
      }
      case "stop": {
        this.stopHandler?.();
        break;
      }
    }
  }

  private send(payload: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  /** Buffered into fixed-size frames so Twilio receives an even flow. */
  sendAudio(samples: Int16Array): void {
    const mulaw = mulawEncode(samples);
    this.outBuffer = this.outBuffer.length ? concatBytes([this.outBuffer, mulaw]) : mulaw;
    while (this.outBuffer.length >= OUT_CHUNK_BYTES) {
      this.sendMedia(this.outBuffer.subarray(0, OUT_CHUNK_BYTES));
      this.outBuffer = this.outBuffer.subarray(OUT_CHUNK_BYTES);
    }
  }

  private sendMedia(mulaw: Uint8Array): void {
    this.send({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: toBase64(mulaw) },
    });
  }

  mark(markId: string): void {
    // Flush the partial frame first, so the mark really does come after all
    // of the audio it is supposed to follow.
    if (this.outBuffer.length) {
      this.sendMedia(this.outBuffer);
      this.outBuffer = new Uint8Array(0);
    }
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name: markId } });
  }

  clear(): void {
    this.outBuffer = new Uint8Array(0);
    this.send({ event: "clear", streamSid: this.streamSid });
  }

  close(): void {
    this.socket.close();
  }
}
