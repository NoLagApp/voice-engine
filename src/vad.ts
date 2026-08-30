/**
 * Utterance detection over 20 ms frames of telephone audio.
 *
 * Not a neural voice activity detector, but it does adapt. A fixed energy
 * threshold cannot work across a quiet phone line and a noisy room: set it low
 * and every room noise becomes a turn, set it high and quiet speakers are never
 * heard. So the detector measures the background continuously and requires
 * speech to stand out from it by a multiple. `speechRms` is only the absolute
 * floor, for rooms so quiet that a multiple of the noise would trigger on
 * nothing at all.
 *
 * Frames are PCM16 at 8 kHz, already decoded from mu-law.
 */

import { rms, concatInt16 } from "./audio.js";

const FRAME_MS = 20;

export interface UtteranceDetectorOptions {
  /** Absolute minimum energy that can count as speech. */
  speechRms?: number;
  /** Speech must exceed the measured noise floor by this multiple. */
  noiseMultiplier?: number;
  /** Consecutive speech frames that open an utterance. */
  startFrames?: number;
  /** Sustained frames needed to interrupt the agent. */
  bargeInFrames?: number;
  /** How far above the threshold an interruption must be. */
  bargeInMultiplier?: number;
  /** Silence that closes an utterance. */
  silenceHangMs?: number;
  /** Utterances shorter than this are discarded as blips. */
  minUtteranceMs?: number;
  /** Force-close runaway utterances. */
  maxUtteranceMs?: number;
  /** Frames kept from before speech onset, so the first word is not clipped. */
  prerollFrames?: number;
  /** Frames spent measuring the room before any detection happens. */
  calibrationFrames?: number;
}

export interface DetectorResult {
  /** An utterance opened on this frame. */
  speechStarted?: boolean;
  /**
   * An utterance closed on this frame, whether or not it was long enough to
   * keep. Reported separately from `utterance` because a blip closes without
   * producing one, and anything tracking who holds the channel would otherwise
   * believe the caller is still talking for the rest of the call.
   */
  speechEnded?: boolean;
  /** The caller is talking over the agent and it should stop. */
  bargeIn?: boolean;
  /** A complete utterance, ready to transcribe. */
  utterance?: Int16Array;
  /** Loudness of that utterance, for judging how confident to be in it. */
  level?: number;
  /** The threshold in force when it was captured. */
  threshold?: number;
}

export class UtteranceDetector {
  private readonly speechRms: number;
  private readonly noiseMultiplier: number;
  private readonly startFrames: number;
  private readonly bargeInFrames: number;
  private readonly bargeInMultiplier: number;
  private readonly silenceHangMs: number;
  private readonly minUtteranceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly prerollFrames: number;
  private readonly calibrationFrames: number;

  private noiseFloor: number;
  private calibrated = 0;
  private agentSpeaking = false;

  private inUtterance = false;
  private frames: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  private speechRun = 0;
  private bargeRun = 0;
  private silenceMs = 0;
  private utteranceMs = 0;

  constructor(options: UtteranceDetectorOptions = {}) {
    this.speechRms = options.speechRms ?? 500;
    this.noiseMultiplier = options.noiseMultiplier ?? 3;
    this.startFrames = options.startFrames ?? 4;
    this.bargeInFrames = options.bargeInFrames ?? 5;
    this.bargeInMultiplier = options.bargeInMultiplier ?? 1.5;
    this.silenceHangMs = options.silenceHangMs ?? 700;
    this.minUtteranceMs = options.minUtteranceMs ?? 400;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 15000;
    this.prerollFrames = options.prerollFrames ?? 10;
    this.calibrationFrames = options.calibrationFrames ?? 25;
    this.noiseFloor = this.speechRms / this.noiseMultiplier;
  }

  /** Raises the bar for opening an utterance while the agent is talking. */
  setAgentSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
  }

  /** Current energy a frame must beat to count as speech. */
  get threshold(): number {
    return Math.max(this.speechRms, this.noiseFloor * this.noiseMultiplier);
  }

  reset(): void {
    this.inUtterance = false;
    this.frames = [];
    this.preroll = [];
    this.speechRun = 0;
    this.bargeRun = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
  }

  /**
   * Minimum-statistics noise tracking, updated on every frame including loud
   * ones. Falling quickly and rising slowly means the floor settles onto the
   * quiet background rather than onto speech, while still climbing to meet a
   * genuinely noisy room. Updating only on "quiet" frames would deadlock: in a
   * room noisier than `speechRms` nothing is ever quiet, the floor never moves,
   * and the detector latches permanently open on the noise.
   */
  private trackNoiseFloor(level: number): void {
    const rate = level < this.noiseFloor ? 0.1 : 0.002;
    this.noiseFloor = this.noiseFloor * (1 - rate) + level * rate;
  }

  /** Feed one 20 ms frame of PCM16 samples. */
  push(frame: Int16Array): DetectorResult {
    const level = rms(frame);

    // Measure the room before trusting any threshold. On an outbound call the
    // other end is usually silent here anyway, still saying hello.
    if (this.calibrated < this.calibrationFrames) {
      this.calibrated += 1;
      this.noiseFloor =
        this.calibrated === 1
          ? level
          : this.noiseFloor + (level - this.noiseFloor) / this.calibrated;
      this.preroll.push(frame);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      return {};
    }

    const energetic = level >= this.threshold;

    // Never learn the room while the agent is talking. Its own voice leaks
    // back through the caller's speakers, and letting that raise the floor
    // raises the threshold, which makes interrupting progressively harder the
    // longer the agent speaks. The floor describes a quiet room, nothing else.
    if (!this.agentSpeaking) this.trackNoiseFloor(level);

    this.preroll.push(frame);
    if (this.preroll.length > this.prerollFrames) this.preroll.shift();

    // Interrupting is judged on its own, not as "an utterance began", because
    // an utterance is very often already open by the time the agent starts
    // talking (noise, or the tail of the caller's own last sentence). Keying
    // off the opening transition means that once anything opens an utterance
    // the caller can never interrupt again. The bar is deliberately higher
    // than normal speech detection so leaked agent audio cannot trip it.
    if (this.agentSpeaking) {
      const loud = level >= this.threshold * this.bargeInMultiplier;
      this.bargeRun = loud ? this.bargeRun + 1 : 0;
      if (this.bargeRun === this.bargeInFrames) {
        // Restart capture: whatever was buffered overlapped the agent's own
        // speech, so keep only the preroll, which holds the interruption.
        this.inUtterance = true;
        this.frames = [...this.preroll];
        this.utteranceMs = this.frames.length * FRAME_MS;
        this.silenceMs = 0;
        this.speechRun = 0;
        return { bargeIn: true };
      }
    } else {
      this.bargeRun = 0;
    }

    if (!this.inUtterance) {
      this.speechRun = energetic ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.startFrames) {
        this.inUtterance = true;
        this.frames = [...this.preroll];
        this.utteranceMs = this.frames.length * FRAME_MS;
        this.silenceMs = 0;
        return { speechStarted: true };
      }
      return {};
    }

    this.frames.push(frame);
    this.utteranceMs += FRAME_MS;
    this.silenceMs = energetic ? 0 : this.silenceMs + FRAME_MS;

    const closed =
      this.silenceMs >= this.silenceHangMs || this.utteranceMs >= this.maxUtteranceMs;
    if (!closed) return {};

    const utterance = concatInt16(this.frames);
    const speechMs = this.utteranceMs - this.silenceMs;
    const threshold = this.threshold;
    this.reset();
    if (speechMs < this.minUtteranceMs) return { speechEnded: true };
    return { utterance, level: rms(utterance), threshold, speechEnded: true };
  }
}
