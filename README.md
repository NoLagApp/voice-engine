# @nolag/voice-engine

The real-time half of a voice agent: turn taking, interruption, voice activity
detection, filler speech, call-screener handling and recording.

It has no opinion about which telephony provider carries the call, which models
do the thinking, or whether anything is coordinating from outside. Those are
interfaces. What it owns is the part that is genuinely hard, and that no prompt
can fix: deciding when someone has stopped talking, who holds the channel, and
what the caller actually hears.

It is one half of a voice agent. This half has to answer in about a second, so
it stays fast and knows nothing. Add
[`@nolag/voice`](https://www.npmjs.com/package/@nolag/voice) and the call gains
the other half: a room through which it reaches a larger orchestrator for
knowledge and tool calls, and a human who can watch or approve. See
[Reflexes, not knowledge](#reflexes-not-knowledge) for why that split is the
whole point rather than an inconvenience.

```bash
npm install @nolag/voice-engine
```

## Try it without a phone

The package ships a browser page that pretends to be a phone, speaking the same
Media Streams protocol a carrier does. No telephony account, no phone number, no
public tunnel:

```ts
import { VoiceSession } from "@nolag/voice-engine";
import { startSimulator } from "@nolag/voice-engine/simulator";

await startSimulator({
  port: 3000,
  onCall: (transport) => {
    new VoiceSession({ transport, providers, systemPrompt: "You are a helpful assistant." });
  },
});
// open http://localhost:3000/simulator and talk
```

This matters more than convenience. Barge-in, turn taking and whether the agent
notices you talking over it cannot be checked from a unit test, and iterating on
them through real phone calls is slow and costs money every attempt.

## What it does that is not obvious

**Voice detection adapts to the room.** A fixed energy threshold cannot serve
both a quiet phone line and a noisy room: set it low and every noise becomes a
turn, set it high and quiet speakers are never heard. The detector measures the
background continuously and requires speech to exceed it by a multiple. In a
room noisier than the fixed floor, a static threshold does not merely misfire,
it latches open permanently and streams noise to your transcription bill.

**Interruption is judged independently of utterance state.** The obvious
implementation triggers barge-in when an utterance begins, which fails silently:
if noise or the tail of the caller's own sentence already opened one, the
opening transition never comes again and the caller can never interrupt for the
rest of the call. The bar for interrupting is also higher than for ordinary
speech, so the agent's own voice leaking back through a speaker cannot stop it
mid-sentence.

**Playback is tracked by mark, not by clock.** Audio goes out far faster than it
is heard, so only the far end knows when the agent has finished speaking. A turn
can contain several clips, so marks are counted rather than treated as a flag,
and an interruption starts a new epoch so discarded audio that never reports
back is not waited on forever.

**The model is the last resort, not the first.** Noise, screeners and goodbyes
are recognised and answered from a script before the model is consulted.
Instructing a model not to do something works most of the time, which is another
way of saying it fails in front of customers. Constraining it at the boundary
works every time. Concretely, that is why a call screener is never told the
things you would only tell a customer.

**Speaking starts on the first sentence.** The reply is streamed and synthesis
of the first finished sentence begins while the model is still writing. Worth
knowing before optimising further: synthesis latency is dominated by fixed
per-request overhead rather than text length, so splitting a reply into many
small clips makes it slower, not faster. Choose a provider by time to first
byte.

## Running it somewhere small

The main entry point touches no filesystem, no HTTP server and no socket
library, so a call fits in a function without carrying a dev tool along. The
two parts that do need those are separate imports:

```ts
import { VoiceSession } from "@nolag/voice-engine";            // ~48 KB, no node built-ins
import { createRecorder } from "@nolag/voice-engine/recorder"; // adds node:fs
import { startSimulator } from "@nolag/voice-engine/simulator";// adds node:http and ws
```

`ws` is an optional peer dependency, needed only by the simulator.

The core uses no Node `Buffer` either: audio framing, WAV and base64 are all
`Uint8Array` and `DataView`, so it runs unchanged on Node, Deno, Bun, Workers
and in a browser. That is enforced by a test which deletes the `Buffer` global
and then runs the codec and a full transport exchange, because a stray
`Buffer.from` would pass every other test and only fail once deployed.

One caveat worth more than bundle size: a phone call is a long-lived WebSocket,
which request-oriented platforms cannot hold. AWS Lambda and Cloud Functions
will not work directly, so the natural targets are Cloud Run, Fargate, or Lambda
behind API Gateway WebSockets. Match the platform to the socket first, then
enjoy the small bundle for cold starts.

## Pieces

| Export | What it is |
|---|---|
| `VoiceSession` | Turn taking, interruption, policy, and the conversation |
| `UtteranceDetector` | Adaptive voice activity detection over 20 ms frames |
| `TwilioMediaStreamTransport` | Twilio Media Streams as an `AudioTransport` |
| `OpenRouter*` | Transcription, model and speech through one API key |
| `createFillerBank` | Pre-renders stalling phrases so they start instantly |
| `createRecorder` | Time-aligned WAV tracks and a transcript (`@nolag/voice-engine/recorder`) |
| `startSimulator` | The browser phone (`@nolag/voice-engine/simulator`) |
| `classifyScreening`, `isFarewell`, `stripMarkdown` | The policy layer, usable alone |

## Bringing your own vendors

Implement three interfaces and the engine neither knows nor cares who is behind
them:

```ts
interface SpeechToText { transcribe(req): Promise<string> }
interface LanguageModel { chat(req): Promise<string> }   // streams sentences
interface TextToSpeech  { readonly sampleRate: number; speak(req): Promise<void> }
```

`speak` streams deliberately: the caller hears the first byte, so time to first
byte is what governs how responsive the agent feels, and the gap between
providers is measured in seconds rather than milliseconds.

## Reflexes, not knowledge

This engine gives a call reflexes. It knows when you stopped speaking, who holds
the channel, when to interrupt itself and when to stay quiet. It knows nothing
about your business, and it cannot do anything.

That is a design decision rather than a missing feature, and it follows from the
clock. The model inside the conversation loop has to answer in about a second,
which means it has to be small, which makes it exactly the wrong thing to decide
whether a booking can be moved or what a customer is owed. It also has no tools,
so left alone it will cheerfully say "I have updated that for you" while nothing
anywhere has changed.

Real work runs on a different clock. Looking something up, changing a record,
waiting for a human to approve it: five to thirty seconds, sometimes longer. You
cannot nest that inside a one second budget, so it belongs to a separate
participant the call talks to, not to the model answering the phone.

Notice that the filler speech here is already the mechanism for covering that
wait. It exists because synthesis was slow, and it is exactly what lets an agent
say "let me check that for you" while something more capable does the work.

## Coordination

Pair it with [`@nolag/voice`](https://www.npmjs.com/package/@nolag/voice) and
each call becomes a NoLag room. That room is how the call reaches the rest of
your system: a larger orchestrator with the knowledge and the tools, a human
supervisor who can steer or approve, and any dashboard that wants to watch.
`VoiceSession` takes an `observer`, and that package's publisher is shaped to be
one, so the two clip together without either knowing much about the other.

Together they are a complete voice agent: fast reflexes on the phone, real
capability behind it.

## Recording and consent

Recording writes call audio and transcripts to disk in the clear. That is
personal data, and in many places it needs the consent of everyone on the call.
It is off unless you pass a recorder, and it should stay off until you have
dealt with that.

## Licence

MIT
