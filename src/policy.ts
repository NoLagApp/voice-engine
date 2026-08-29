/**
 * What the agent is allowed to treat as a real turn.
 *
 * Everything here runs before the language model sees anything, and that
 * ordering is the point. Instructing a model not to do something works most of
 * the time, which is another way of saying it fails in front of customers.
 * Constraining it at the boundary works every time.
 *
 * Three jobs:
 *   - drop transcription artefacts invented from background noise
 *   - recognise call screeners and voicemail, so a machine is never told the
 *     things you would only tell the customer
 *   - recognise the caller winding the conversation up
 */

/**
 * Speech-to-text models invent text when handed a buffer of room noise, and
 * the inventions are recognisable: a single stray letter, or one of a small
 * set of stock phrases overlearned from training captions.
 */
const NOISE_TRANSCRIPTS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you.",
  "thanks for watching",
  "thanks for watching!",
  "bye",
  "bye.",
  "okay",
  "so",
  "um",
  "uh",
  "hmm",
  "mm",
  "yeah",
]);

/**
 * Stock phrases only count as noise when the audio behind them was weak. A
 * caller who actually says "yeah" says it well above the threshold; the
 * hallucinated version rides in on something barely louder than the room.
 */
export function isLikelyNoise(text: string, level = 0, threshold = 0): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .trim();
  if (cleaned.length <= 1) return true; // a lone character is never a real turn
  return NOISE_TRANSCRIPTS.has(cleaned) && level < threshold * 2;
}

/**
 * Strips markdown before anything is spoken.
 *
 * Models emit emphasis even when the prompt forbids it ("**1:15 PM**"), and a
 * speech model reads the asterisks out loud.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links, keep the label
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[\s(])[*_](?=\S)([^*_]+?)[*_](?=[\s.,!?)]|$)/g, "$1$2") // italics
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/\s+/g, " ")
    .trim();
}

export type ScreeningKind = "identify" | "hold" | "voicemail";

const IDENTIFY = [
  /state (?:your )?name/i,
  /reason for (?:the )?call/i,
  /who(?:'s| is)? calling/i,
  /may i ask who/i,
  /see if (?:this|that) person is available/i,
  /what(?:'s| is) this (?:call )?regarding/i,
  /screening (?:this|your) call/i,
];

const HOLD = [
  /(?:please )?(?:stay|hold) on the line/i,
  /please hold/i,
  /one moment please/i,
  /connecting you/i,
  /transferring/i,
];

const VOICEMAIL = [
  /after the (?:tone|beep)/i,
  /leave (?:a|your|an additional) message/i,
  /record your message/i,
  /unable to take your call/i,
  /has a voicemail/i,
  /voicemail (?:box|service)/i,
  // Screeners announce the outcome in the third person, and the announcement
  // often arrives as its own utterance, before any mention of a message. Until
  // this was matched, the pause between the two halves was long enough for the
  // agent to treat the machine as the client and start reading out the booking.
  // Third person only: a human saying "I'm not available" is a live objection,
  // not a request to leave a message.
  /(?:this|that) person is (?:currently )?(?:not |un)available/i,
  /(?:he|she|they)(?:'s| is| are) (?:currently )?(?:not |un)available/i,
  /(?:can(?:'|no)?t|unable to) (?:take|come to) (?:your|the) call/i,
];

/**
 * Classifies a screener or answering machine, or null for ordinary speech.
 *
 * Pattern matching rather than another model call: it costs nothing, cannot
 * hallucinate, and these systems are highly formulaic. Voicemail wins over the
 * others, since "not available, leave a message" is an invitation to record
 * rather than an invitation to introduce ourselves again.
 */
export function classifyScreening(text: string): ScreeningKind | null {
  if (!text) return null;
  if (VOICEMAIL.some((re) => re.test(text))) return "voicemail";
  if (IDENTIFY.some((re) => re.test(text))) return "identify";
  if (HOLD.some((re) => re.test(text))) return "hold";
  return null;
}

/**
 * Ways a caller signals the conversation is over. Without this the agent keeps
 * answering after "thanks, bye" and the caller has to hang up on it, which
 * reads as the agent not listening.
 */
const FAREWELL = [
  /\bgood\s?bye\b/i,
  /^\s*(?:ok(?:ay)?[,.\s]*)?(?:thanks?(?:\s*you)?[,.\s]*)?bye(?:\s*bye)?\s*[.!]?\s*$/i,
  /\b(?:thanks?|thank you|cheers)[,.\s]+bye\b/i,
  /\bi(?:'ve| have| )?(?:got to|gotta|have to|need to) (?:go|run)\b/i,
  // The gap allows punctuation, because transcription writes this as two
  // sentences as often as one ("that's enough. Thank you"). It stays short so
  // "that's all I know about the flight, thanks" is not read as a goodbye.
  /\bthat(?:'s| is) (?:all|everything|it|enough)\b[\s,.!-]{0,4}\b(?:thanks?|thank you|cheers)\b/i,
  // ...and the same phrase alone, because the detector splits a turn at every
  // pause, so "no, that's enough" and "thank you" often arrive as two separate
  // utterances and neither half contains both parts. Anchored to the whole
  // utterance so "that's all I know about the flight" still is not a goodbye.
  /^\s*(?:no[,.\s]*)?that(?:'s| is) (?:all|everything|it|enough)\s*[.!]?\s*$/i,
  /\bnothing else\b/i,
  /\bi(?:'m| am) all set\b/i,
  /\bhave a (?:good|great|nice) (?:day|one|flight|evening)\b/i,
];

/** True when the caller is closing the conversation, not just being polite. */
export function isFarewell(text: string): boolean {
  if (!text) return false;
  return FAREWELL.some((re) => re.test(text));
}
