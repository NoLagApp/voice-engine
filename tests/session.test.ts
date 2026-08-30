import { describe, it, expect } from "vitest";
import { harness, LOUD } from "./support/harness.js";
import { FakeFillerBank } from "./support/fake-fillers.js";
import { flush } from "./support/async.js";

/**
 * Turn taking, end to end, against fake providers and a fake phone line.
 *
 * These are integration tests of `VoiceSession` on purpose. Every interesting
 * behaviour here is an interaction between the detector, the work queue, the
 * mark accounting and the policy layer, and none of it is visible from a unit
 * test of any one of those.
 */

describe("VoiceSession", () => {
  describe("opening a call", () => {
    it("greets an inbound call without being spoken to", async () => {
      const h = harness({ lines: { greeting: "Hello, how can I help?" } });

      h.transport.start({ outbound: false });
      await h.settle();

      expect(h.observed.started).toBe(1);
      expect(h.observed.agentSpeech).toEqual([
        { text: "Hello, how can I help?", kind: "greeting" },
      ]);
      expect(h.providers.tts.spoken).toEqual(["Hello, how can I help?"]);
    });

    it("holds an outbound introduction until the other end speaks", async () => {
      const h = harness({ lines: { outboundGreeting: "Hi, it's the clinic calling." } });
      h.providers.stt.script = ["Hello?"];

      h.transport.start({ outbound: true });
      await h.settle();
      expect(h.providers.tts.spoken).toEqual([]);

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.providers.tts.spoken).toEqual(["Hi, it's the clinic calling."]);
      // The introduction is scripted, so the model is never consulted for it.
      expect(h.providers.llm.requests).toHaveLength(0);
    });

    it("greets immediately on an outbound call when told not to wait", async () => {
      const h = harness({
        lines: { outboundGreeting: "Hi, it's the clinic calling." },
        waitForHello: false,
      });

      h.transport.start({ outbound: true });
      await h.settle();

      expect(h.providers.tts.spoken).toEqual(["Hi, it's the clinic calling."]);
    });
  });

  describe("an ordinary turn", () => {
    it("transcribes, asks the model, and speaks the answer", async () => {
      const h = harness();
      h.providers.stt.script = ["What time do you open?"];
      h.providers.llm.script = ["We open at eight. See you then."];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.observed.callerSpeech).toEqual(["What time do you open?"]);
      expect(h.observed.agentSpeech).toEqual([
        { text: "We open at eight. See you then.", kind: "reply" },
      ]);
      // First sentence goes out while the model is still writing, and the rest
      // follows as one clip rather than one per sentence.
      expect(h.providers.tts.spoken).toEqual(["We open at eight.", "See you then."]);
    });

    it("reports per-turn latency once playback has finished", async () => {
      const h = harness();
      h.providers.stt.script = ["Are you open?"];
      h.providers.llm.script = ["Yes we are."];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.observed.turns).toHaveLength(1);
      const [turn] = h.observed.turns;
      expect(turn.clips).toBe(1);
      expect(turn.firstAudioMs).not.toBeNull();
      expect(turn.totalMs).toBeGreaterThanOrEqual(0);
    });

    it("carries the conversation into the next model call", async () => {
      const h = harness();
      h.providers.stt.script = ["Hi there.", "And on Sunday?"];
      h.providers.llm.script = ["We open at eight.", "Closed Sundays."];

      h.calibrate();
      h.utterance();
      await h.settle();
      h.utterance();
      await h.settle();

      const messages = h.providers.llm.lastMessages;
      expect(messages[0]).toEqual({ role: "system", content: "You are a test agent." });
      expect(messages.map((m) => m.content)).toEqual([
        "You are a test agent.",
        "Hi there.",
        "We open at eight.",
        "And on Sunday?",
      ]);
    });

    it("says nothing when transcription comes back empty", async () => {
      const h = harness();
      h.providers.stt.script = [""];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.observed.callerSpeech).toEqual([]);
      expect(h.providers.llm.requests).toHaveLength(0);
    });

    it("discards a transcript that is only room noise", async () => {
      const h = harness();
      // A known noise transcript, captured at a level that does not stand out.
      h.providers.stt.script = ["you"];

      h.calibrate();
      h.utterance(800); // audible, but not loud enough to be a confident turn
      await h.settle();

      expect(h.observed.callerSpeech).toEqual([]);
      expect(h.providers.llm.requests).toHaveLength(0);
    });
  });

  describe("steering from outside", () => {
    it("speaks an injected line and remembers saying it", async () => {
      const h = harness();
      h.providers.stt.script = ["What about parking?"];
      h.providers.llm.script = ["There is parking out front."];

      h.session.say("We can hold the car until two.");
      await h.settle();

      expect(h.observed.agentSpeech).toEqual([
        { text: "We can hold the car until two.", kind: "injected" },
      ]);

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.providers.llm.lastMessages.map((m) => m.content)).toContain(
        "We can hold the car until two."
      );
    });

    it("never speaks an instruction, but the model sees it next turn", async () => {
      const h = harness();
      h.providers.stt.script = ["Can I get a refund?"];
      h.providers.llm.script = ["Let me check that."];

      h.session.instruct("Do not offer refunds.");
      await h.settle();
      expect(h.providers.tts.spoken).toEqual([]);

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.providers.llm.lastMessages).toContainEqual({
        role: "system",
        content: "Do not offer refunds.",
      });
    });
  });

  describe("screeners and voicemail", () => {
    it("identifies itself to a screener without involving the model", async () => {
      const h = harness({ lines: { identify: "It's the clinic, about an appointment." } });
      h.providers.stt.script = ["Who's calling please?"];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.observed.screenings).toEqual([{ kind: "identify", turn: 1 }]);
      expect(h.providers.tts.spoken).toEqual(["It's the clinic, about an appointment."]);
      expect(h.providers.llm.requests).toHaveLength(0);
    });

    it("says nothing to hold music", async () => {
      const h = harness({ lines: { identify: "It's the clinic." } });
      h.providers.stt.script = ["Please hold while I transfer you."];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.observed.screenings).toEqual([{ kind: "hold", turn: 1 }]);
      expect(h.providers.tts.spoken).toEqual([]);
    });

    it("leaves a voicemail message and hangs up once it has played out", async () => {
      const h = harness({ lines: { voicemail: "Please call the clinic back." } });
      h.providers.stt.script = ["Please leave a message after the tone."];

      h.calibrate();
      h.utterance();

      // Before playback reports back, the call is still up. This is the part a
      // synchronously-echoed mark would hide: the hang-up latch is set after
      // speak() resolves, so an early echo makes the call never end.
      await flush();
      expect(h.transport.closed).toBe(false);

      await h.settle();

      expect(h.providers.tts.spoken).toEqual(["Please call the clinic back."]);
      expect(h.transport.closed).toBe(true);
      expect(h.observed.ended).toEqual(["message left"]);
    });

    it("gives up on a screener that will not stop talking", async () => {
      const h = harness({
        lines: { identify: "It's the clinic.", voicemail: "Please call us back." },
      });
      h.providers.stt.script = Array(5).fill("Who's calling please?");

      h.calibrate();
      for (let i = 0; i < 5; i++) {
        h.utterance();
        await h.settle();
      }

      expect(h.observed.screenings.map((s) => s.turn)).toEqual([1, 2, 3, 4, 5]);
      expect(h.providers.tts.spoken).toEqual([
        "It's the clinic.",
        "It's the clinic.",
        "It's the clinic.",
        "It's the clinic.",
        "Please call us back.",
      ]);
      expect(h.transport.closed).toBe(true);
    });
  });

  describe("ending the call", () => {
    it("says goodbye and hangs up when the caller winds up", async () => {
      const h = harness({ lines: { farewell: "Thanks for calling, goodbye." } });
      h.providers.stt.script = ["That's everything, thank you. Goodbye."];

      h.calibrate();
      h.utterance();
      await h.settle();

      expect(h.providers.tts.spoken).toEqual(["Thanks for calling, goodbye."]);
      // Scripted, so the model never gets a chance to keep the call going.
      expect(h.providers.llm.requests).toHaveLength(0);
      expect(h.transport.closed).toBe(true);
    });

    it("reports the far end hanging up", async () => {
      const h = harness();

      h.transport.start();
      h.transport.hangUp();
      await h.settle();

      expect(h.observed.ended).toEqual(["the other end hung up"]);
    });

    it("only ends once", async () => {
      const h = harness();

      h.session.close("first");
      h.session.close("second");

      expect(h.observed.ended).toEqual(["first"]);
    });
  });

  describe("interruption", () => {
    it("stops playback and reports the interruption", async () => {
      const h = harness({ lines: { greeting: "Hello, this is a fairly long greeting." } });
      h.providers.tts.manual = true;

      h.transport.start();
      await flush();
      h.calibrate();

      // One chunk out, so the agent is audibly speaking and can be talked over.
      await h.providers.tts.step();
      expect(h.transport.sent).toHaveLength(1);

      h.feed(8, LOUD);

      expect(h.observed.bargeIns).toBe(1);
      expect(h.transport.clears).toBe(1);
    });

    it("ignores marks from audio that was discarded", async () => {
      const h = harness({
        lines: { greeting: "Hello there, this is the clinic.", farewell: "Goodbye then." },
      });
      h.providers.stt.script = ["Goodbye."];

      // The greeting finishes synthesis and emits its mark, but the far end has
      // not reported it yet, so the agent is still holding the channel.
      h.transport.start();
      await flush();
      const staleMark = h.transport.marks[0];
      expect(staleMark).toBeDefined();

      // Interrupt, then let the interrupting turn run to a scripted goodbye.
      // That arms the hang-up, so anything that wrongly settles the mark count
      // now ends the call before the goodbye has actually played.
      h.calibrate();
      h.utterance();
      await flush();
      expect(h.observed.bargeIns).toBe(1);
      expect(h.providers.tts.spoken).toContain("Goodbye then.");

      h.transport.echo(staleMark);
      expect(h.transport.closed).toBe(false);
      expect(h.observed.ended).toEqual([]);

      // The goodbye's own mark is the one that may end the call.
      await h.settle();
      expect(h.transport.closed).toBe(true);
    });

    it("stops an interrupted greeting from streaming any more audio", async () => {
      const h = harness({ lines: { greeting: "Hello there, this is the clinic calling." } });
      h.providers.tts.manual = true;

      h.transport.start();
      await flush();
      h.calibrate();
      await h.providers.tts.step();
      expect(h.transport.sent).toHaveLength(1);

      h.feed(8, LOUD);
      expect(h.transport.clears).toBe(1);

      // Synthesis is still running and will keep producing. Cleared audio is
      // gone from the far end's buffer, so anything sent now is heard on top of
      // the caller: the agent talks over the person who just interrupted it.
      const sentWhenInterrupted = h.transport.sent.length;
      await h.providers.tts.drain();

      expect(h.transport.sent).toHaveLength(sentWhenInterrupted);
      expect(h.providers.tts.aborted).toEqual(["Hello there, this is the clinic calling."]);
      expect(h.observed.errors).toEqual([]);
    });

    it("stops an interrupted injected line from streaming any more audio", async () => {
      const h = harness();
      h.providers.tts.manual = true;

      h.calibrate();
      h.session.say("We can hold the car until two o'clock.");
      await flush();
      await h.providers.tts.step();

      h.feed(8, LOUD);
      expect(h.transport.clears).toBe(1);

      const sentWhenInterrupted = h.transport.sent.length;
      await h.providers.tts.drain();

      expect(h.transport.sent).toHaveLength(sentWhenInterrupted);
      expect(h.observed.errors).toEqual([]);
    });

    it("does not let the agent's own voice interrupt it", async () => {
      const h = harness({ lines: { greeting: "Hello there." } });
      h.providers.tts.manual = true;

      h.transport.start();
      await flush();
      h.calibrate();
      await h.providers.tts.step();

      // Leaked agent audio: above the speech threshold, below the higher bar
      // that interruption requires.
      h.feed(20, 600);

      expect(h.observed.bargeIns).toBe(0);
      expect(h.transport.clears).toBe(0);

      await h.providers.tts.drain();
      await h.settle();
    });
  });

  describe("filler speech", () => {
    it("covers the gap when an answer is slow to arrive", async () => {
      const fillers = new FakeFillerBank();
      const h = harness({ fillers, fillerDelayMs: 5 });
      h.providers.stt.script = ["Can you look that up?"];
      h.providers.llm.script = ["It is on its way."];
      h.providers.llm.manual = true;

      h.calibrate();
      h.utterance();
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(fillers.picked).toEqual(["let me have a look"]);
      expect(h.observed.agentSpeech[0]).toEqual({
        text: "let me have a look",
        kind: "filler",
      });

      await h.providers.llm.drain();
      await h.settle();
      expect(h.providers.tts.spoken).toEqual(["It is on its way."]);
    });

    it("does not fill when the answer is already being spoken", async () => {
      const fillers = new FakeFillerBank();
      const h = harness({ fillers, fillerDelayMs: 40 });
      h.providers.stt.script = ["Are you open?"];
      h.providers.llm.script = ["Yes, until six."];

      h.calibrate();
      h.utterance();
      await h.settle();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(fillers.picked).toEqual([]);
    });

    it("disarms the filler when the model comes back with nothing", async () => {
      const fillers = new FakeFillerBank();
      const h = harness({ fillers, fillerDelayMs: 40 });
      h.providers.stt.script = ["Hello?"];
      h.providers.llm.script = [""];

      h.calibrate();
      h.utterance();
      await h.settle();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The turn is over and the agent has nothing to say. A filler left armed
      // fires into the silence, so the caller hears "let me have a look"
      // seconds after the exchange it belonged to has finished.
      expect(fillers.picked).toEqual([]);
      expect(h.observed.agentSpeech).toEqual([]);
    });

    it("never fills for noise, because it only arms after a real transcript", async () => {
      const fillers = new FakeFillerBank();
      const h = harness({ fillers, fillerDelayMs: 5 });
      h.providers.stt.script = [""];

      h.calibrate();
      h.utterance();
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(fillers.picked).toEqual([]);
    });
  });
});
