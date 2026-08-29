/**
 * Pre-synthesised filler speech ("umm", "let me have a look") to cover the
 * silence while a turn is being generated.
 *
 * The whole point is that a filler must start instantly. Synthesising one on
 * demand would add another round trip, which is the very thing it exists to
 * hide, so every phrase is rendered once at startup and kept as ready samples.
 *
 * These also become the natural cover for slow work behind the call: if the
 * agent has to ask another service something, the caller hears "let me check
 * that" rather than silence.
 */

import { StreamingDownsampler } from "./audio.js";
import type { TextToSpeech } from "./providers/types.js";

const TRANSPORT_RATE = 8000;

export const DEFAULT_FILLERS = [
  "Umm...",
  "Let me think.",
  "Let me have a look.",
  "One moment.",
  "Hmm, let me see.",
  "Right, give me a second.",
];

export interface FillerClip {
  phrase: string;
  /** PCM16 at 8 kHz, ready to hand to a transport. */
  samples: Int16Array;
}

export interface FillerBank {
  readonly size: number;
  /** A clip, never the same one twice in a row. */
  pick(): FillerClip | null;
}

/**
 * Renders each phrase once. Failures are skipped rather than fatal: a call
 * with no fillers is worse, not broken.
 */
export async function createFillerBank(
  tts: TextToSpeech,
  phrases: string[] = DEFAULT_FILLERS
): Promise<FillerBank | null> {
  const wanted = phrases.filter(Boolean);
  if (!wanted.length) return null;

  const rendered = await Promise.all(
    wanted.map(async (phrase): Promise<FillerClip | null> => {
      try {
        const down = new StreamingDownsampler(tts.sampleRate, TRANSPORT_RATE);
        const parts: Int16Array[] = [];
        await tts.speak({ text: phrase, onAudio: (chunk) => parts.push(down.push(chunk)) });
        parts.push(down.flush());

        let total = 0;
        for (const part of parts) total += part.length;
        const samples = new Int16Array(total);
        let offset = 0;
        for (const part of parts) {
          samples.set(part, offset);
          offset += part.length;
        }
        return samples.length ? { phrase, samples } : null;
      } catch {
        return null;
      }
    })
  );

  const clips = rendered.filter((clip): clip is FillerClip => clip !== null);
  if (!clips.length) return null;

  let lastIndex = -1;
  return {
    size: clips.length,
    pick() {
      if (clips.length === 1) return clips[0]!;
      let index = lastIndex;
      while (index === lastIndex) index = Math.floor(Math.random() * clips.length);
      lastIndex = index;
      return clips[index]!;
    },
  };
}
