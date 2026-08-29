/**
 * OpenRouter implementations of the three provider interfaces.
 *
 * One key covers transcription, the language model and speech, which is why it
 * is the default here, but nothing in the engine depends on it: implement the
 * interfaces in `providers/types.ts` and any vendor will do.
 *
 * Model choice matters more than it looks, in two specific ways. Synthesis
 * must return raw PCM, and it must START returning it quickly, because the
 * engine forwards audio as it arrives. Providers that render the whole clip
 * before sending a byte leave the caller in silence for seconds no matter what
 * the code does.
 */

import type {
  ChatRequest,
  LanguageModel,
  SpeakRequest,
  SpeechToText,
  TextToSpeech,
  TranscribeRequest,
} from "./types.js";
import { toBase64 } from "../bytes.js";

const BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** Sent so usage shows up meaningfully in the OpenRouter dashboard. */
  appUrl?: string;
  appName?: string;
}

function headers(options: OpenRouterOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": options.appUrl ?? "https://nolag.app",
    "X-Title": options.appName ?? "NoLag Voice Engine",
  };
}

async function fail(response: Response, label: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throw new Error(`${label} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
}

export class OpenRouterSpeechToText implements SpeechToText {
  constructor(private readonly options: OpenRouterOptions) {}

  async transcribe({ audio, language, signal }: TranscribeRequest): Promise<string> {
    const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: headers(this.options),
      signal,
      body: JSON.stringify({
        model: this.options.model,
        ...(language ? { language } : {}),
        input_audio: { data: toBase64(audio), format: "wav" },
      }),
    });
    if (!response.ok) await fail(response, "transcription");
    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
}

// Abbreviations whose full stop does not end a sentence.
const ABBREVIATION = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|e\.g|i\.e)\.$/i;
const MAX_SENTENCE_CHARS = 240;

/**
 * Index just past the end of the first complete sentence, or -1.
 *
 * A terminator at the very end of the buffer is not accepted, because more
 * tokens may still be arriving and we cannot yet tell "3." from "3.5".
 */
export function findSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== "." && char !== "!" && char !== "?") continue;
    const next = text[i + 1];
    if (next === undefined || !/\s/.test(next)) continue;
    if (char === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(next)) continue;
    if (ABBREVIATION.test(text.slice(0, i + 1))) continue;
    return i + 1;
  }
  return -1;
}

export class OpenRouterLanguageModel implements LanguageModel {
  constructor(private readonly options: OpenRouterOptions) {}

  async chat({ messages, signal, onSentence }: ChatRequest): Promise<string> {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: headers(this.options),
      signal,
      body: JSON.stringify({ model: this.options.model, messages, stream: true }),
    });
    if (!response.ok) await fail(response, "chat completion");
    if (!response.body) throw new Error("chat completion returned no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pending = ""; // text not yet emitted as a sentence
    let full = "";

    const emit = (text: string) => {
      const trimmed = text.trim();
      if (trimmed) onSentence?.(trimmed);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // Blank lines separate events; ":" lines are keep-alive comments.
        if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let json: { choices?: Array<{ delta?: { content?: string } }> };
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (!delta) continue;

        full += delta;
        pending += delta;

        let cut: number;
        while ((cut = findSentenceEnd(pending)) !== -1) {
          emit(pending.slice(0, cut));
          pending = pending.slice(cut);
        }
        // A model that never punctuates should not stall playback forever.
        if (pending.length > MAX_SENTENCE_CHARS) {
          const space = pending.lastIndexOf(" ");
          const cutAt = space > 0 ? space : pending.length;
          emit(pending.slice(0, cutAt));
          pending = pending.slice(cutAt);
        }
      }
    }

    emit(pending);
    return full.trim();
  }
}

export interface OpenRouterTtsOptions extends OpenRouterOptions {
  voice: string;
  /** Sample rate of the PCM this model returns. Most use 24000. */
  sampleRate?: number;
}

export class OpenRouterTextToSpeech implements TextToSpeech {
  readonly sampleRate: number;

  constructor(private readonly options: OpenRouterTtsOptions) {
    this.sampleRate = options.sampleRate ?? 24000;
  }

  async speak({ text, signal, onAudio }: SpeakRequest): Promise<void> {
    const response = await fetch(`${BASE_URL}/audio/speech`, {
      method: "POST",
      headers: headers(this.options),
      signal,
      body: JSON.stringify({
        model: this.options.model,
        input: text,
        voice: this.options.voice,
        response_format: "pcm",
      }),
    });
    if (!response.ok) await fail(response, "speech synthesis");
    if (!response.body) throw new Error("speech synthesis returned no body");

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) onAudio(value);
    }
  }
}
