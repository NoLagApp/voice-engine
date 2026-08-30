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

## Quick start

Everything below is one complete program. Run it, open the page, and talk to
the agent. No telephony account, no phone number, no public tunnel.

```ts
import {
  VoiceSession,
  OpenRouterSpeechToText,
  OpenRouterLanguageModel,
  OpenRouterTextToSpeech,
} from "@nolag/voice-engine";
import { startSimulator } from "@nolag/voice-engine/simulator";

const apiKey = process.env.OPENROUTER_API_KEY!;

// One key covers all three legs here, but each is an interface: swap in any
// vendor you like. See "Bringing your own vendors".
const providers = {
  stt: new OpenRouterSpeechToText({ apiKey, model: "openai/gpt-4o-mini-transcribe" }),
  llm: new OpenRouterLanguageModel({ apiKey, model: "mistralai/ministral-8b-2512" }),
  tts: new OpenRouterTextToSpeech({
    apiKey,
    model: "deepgram/aura-2",
    voice: "aura-2-thalia-en",
    sampleRate: 24000, // the rate this model emits, not the phone line
  }),
};

await startSimulator({
  port: 3000,
  onCall: (transport) => {
    new VoiceSession({
      transport,
      providers,
      systemPrompt:
        "You are a friendly phone assistant. Keep replies to one or two short " +
        "spoken sentences. Never use markdown or lists.",
      lines: { greeting: "Hi, how can I help?" },
    });
  },
});

console.log("open http://localhost:3000/simulator");
```

The simulator page speaks the same Media Streams protocol a carrier does, at
the same endpoint, so the session cannot tell it apart from a real call. That
matters more than convenience: barge-in and turn taking cannot be checked from
a unit test, and iterating on them through real phone calls is slow and costs
money every attempt.

## Taking real calls

Twilio Media Streams is included as a transport. The webhook answers with TwiML
pointing at your WebSocket, and each socket becomes one session.

```ts
import { WebSocketServer } from "ws";
import { TwilioMediaStreamTransport, VoiceSession } from "@nolag/voice-engine";

// Answer the voice webhook with this, where PUBLIC_HOST is reachable from the
// internet. The <Parameter> tags become CallInfo on the session.
//   <Response><Connect>
//     <Stream url="wss://PUBLIC_HOST/media">
//       <Parameter name="peer" value="+61400000000" />
//       <Parameter name="outbound" value="0" />
//     </Stream>
//   </Connect></Response>

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (socket) => {
  const transport = new TwilioMediaStreamTransport({ socket });
  const session = new VoiceSession({ transport, providers, systemPrompt, lines });
  socket.on("close", () => session.close("socket closed"));
});
```

One thing to know: the session registers the transport's handlers in its own
constructor, and a transport holds one handler per event. Calling
`transport.onStart()` yourself replaces the session's and the call is never
greeted. Use the `observer` instead, which is what it is for.

## Configuration

### VoiceSession

| Option | Type | Notes |
|---|---|---|
| `transport` | `AudioTransport` | Required. Where audio comes from and goes. |
| `providers` | `{ stt, llm, tts }` | Required. The three AI legs. |
| `systemPrompt` | `string` | Required. Ask for one or two short spoken sentences. |
| `lines` | `ScriptedLines` | Fixed things it says. See below. |
| `detector` | `UtteranceDetectorOptions` | Listening behaviour. See below. |
| `fillers` | `FillerBank \| null` | Stalling phrases. See below. |
| `fillerDelayMs` | `number` (500) | Wait this long for a real answer before filling. |
| `language` | `string` | Transcription hint. Worth setting; see below. |
| `waitForHello` | `boolean` (true) | Outbound: hold the intro until they speak. |
| `observer` | `SessionObserver` | Everything that happens, for logging and coordination. |

Methods: `say(text)` speaks something now and remembers it,
`instruct(text)` adds silent guidance the model sees from its next turn,
`close(reason)` ends the session.

### Scripted lines

These are said verbatim, with no model call, because the moments they cover
cannot afford a surprise or a delay.

```ts
lines: {
  greeting: "Thanks for calling, this is Robin. How can I help?",
  outboundGreeting: "Hi, it's Robin, an AI assistant calling about your booking.",
  identify: "This is Robin, an AI assistant calling about a booking change.",
  voicemail: "Sorry to miss you. Your pickup may need to move; please call back.",
  farewell: "Thanks for your time. Goodbye.",
}
```

`identify` answers a screener that asks who is calling, and deliberately says
nothing about the customer's business. `voicemail` is left on an answering
machine, after which the call ends by itself. `farewell` is said when the
caller signals the conversation is over, and then it hangs up.

### Listening behaviour

The detector adapts to the room, so most calls need none of this. Reach for it
when the agent replies to nothing (raise `noiseMultiplier`), never hears a
quiet speaker (lower it), or cuts people off mid-thought (raise
`silenceHangMs`, at the cost of adding that delay to every reply).

| Option | Default | Notes |
|---|---|---|
| `speechRms` | 500 | Absolute floor. The real threshold adapts above it. |
| `noiseMultiplier` | 3 | Speech must beat the measured noise floor by this. |
| `silenceHangMs` | 700 | Silence that ends a turn. Added to every reply's delay. |
| `bargeInFrames` | 5 | 20 ms frames of speech needed to interrupt the agent. |
| `bargeInMultiplier` | 1.5 | How much louder than the threshold an interruption must be. |
| `minUtteranceMs` | 400 | Shorter than this is a blip, not a turn. |
| `maxUtteranceMs` | 15000 | Force-closes a runaway utterance. |
| `startFrames` | 4 | Frames that open an utterance normally. |
| `prerollFrames` | 10 | Kept from before onset so the first word is not clipped. |
| `calibrationFrames` | 25 | Frames spent measuring the room before listening. |

### Filler speech

Phrases are synthesised once at startup and cached, because rendering one on
demand would add the very delay it exists to hide.

```ts
import { createFillerBank } from "@nolag/voice-engine";

const fillers = await createFillerBank(providers.tts, [
  "Let me have a look.",
  "One moment.",
]);
new VoiceSession({ ...options, fillers, fillerDelayMs: 500 });
```

Omit the phrase list for the built-in set. A filler only plays once the
caller's words have been transcribed and judged real, so background noise never
triggers one.

## Recording

Separate import, because it needs the filesystem, and opt-in, because nothing
is captured unless you pass one.

```ts
import { createRecorder } from "@nolag/voice-engine/recorder";

const recorder = createRecorder({ dir: "./recordings", callId: "CA123" });
new VoiceSession({ ...options, observer: recorder });
```

Per call it writes `<callId>-caller.wav`, `<callId>-agent.wav`, a `.jsonl`
event log with per-turn latency, and a readable `.txt` transcript. The two
tracks are time-aligned, so they play side by side, and audio is streamed to
disk rather than buffered, so a long call costs no more memory than a short
one.

Those files are call audio and transcripts of identifiable people, written in
the clear with no retention policy. In many places recording needs the consent
of everyone on the call, which is separate from disclosing that they are
talking to an AI. It is off by default deliberately.

## Watching a call

`observer` receives everything, and several can be fanned out to at once.

```ts
const observer = {
  onCallStarted: (info) => console.log(info.callId, info.peer, info.outbound),
  onCallerSpeech: (text, { sttMs }) => console.log("caller:", text, sttMs),
  onAgentSpeech: (text, { kind }) => console.log(kind, text), // greeting, reply, filler, scripted
  onScreening: (kind) => console.log("screener:", kind),      // identify, hold, voicemail
  onBargeIn: () => console.log("interrupted"),
  onTurnComplete: (m) => console.log(m.totalMs, m.firstAudioMs),
  onCallEnded: (reason) => console.log("ended:", reason),
  onError: (error) => console.error(error),
};
```

`onCallerAudio` and `onAgentAudio` also deliver raw PCM if you want the audio.

## What it does that is not obvious

**Voice detection adapts to the room.** A fixed energy threshold cannot serve
both a quiet phone line and a noisy room: set it low and every noise becomes a
turn, set it high and quiet speakers are never heard. In a room noisier than the
fixed floor, a static threshold does not merely misfire, it latches open
permanently and streams noise to your transcription bill.

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
things you would only tell a customer, and why `language` is worth setting:
handed a buffer of room noise, an unconstrained model returns confident text in
an unrelated language and the agent then answers in that language.

**Speaking starts on the first sentence.** The reply is streamed and synthesis
of the first finished sentence begins while the model is still writing. Worth
knowing before optimising further: synthesis latency is dominated by fixed
per-request overhead rather than text length, so splitting a reply into many
small clips makes it slower, not faster. Choose a provider by time to first
byte.

## Running it somewhere small

The main entry point touches no filesystem, no HTTP server and no socket
library, so a call fits in a function without carrying a dev tool along:

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

`AudioTransport` is the same idea for telephony. Implement it and any carrier,
or a browser, or a test double, can drive a session.

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

## Licence

MIT
