import type { FillerBank, FillerClip } from "../../src/fillers.js";

/** A filler bank with pre-rendered clips, so nothing is synthesised. */
export class FakeFillerBank implements FillerBank {
  readonly picked: string[] = [];
  private index = 0;

  constructor(private readonly phrases: string[] = ["let me have a look"]) {}

  get size(): number {
    return this.phrases.length;
  }

  pick(): FillerClip | null {
    if (!this.phrases.length) return null;
    const phrase = this.phrases[this.index % this.phrases.length];
    this.index += 1;
    this.picked.push(phrase);
    return { phrase, samples: new Int16Array(160).fill(800) };
  }
}
