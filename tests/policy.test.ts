import { describe, it, expect } from "vitest";
import {
  classifyScreening,
  isFarewell,
  isLikelyNoise,
  stripMarkdown,
} from "../src/policy.js";

/**
 * These cases are not hypothetical. Every "should not match" here is something
 * that actually went wrong on a live call, so they are worth keeping even
 * though they look obvious.
 */

describe("classifyScreening", () => {
  it.each([
    ["Call your name and reason for calling, I'll see if this person is available.", "identify"],
    ["Who's calling please?", "identify"],
    ["Please stay on the line.", "hold"],
    ["Please leave a message after the beep.", "voicemail"],
    // Screeners announce this as its own utterance, before any mention of a
    // message. Until it matched, the agent treated the machine as the customer
    // and began reading out the booking.
    ["I'm sorry, this person is not available.", "voicemail"],
    ["She's not available right now.", "voicemail"],
  ])("classifies %j as %s", (text, expected) => {
    expect(classifyScreening(text)).toBe(expected);
  });

  it.each([
    ["Hello, Sam speaking."],
    ["Hello?"],
    ["Yes please, what time do you recommend?"],
    // First person is a live objection from a human, not an answering machine.
    ["I'm not available right now, can you call back?"],
  ])("leaves ordinary speech alone: %j", (text) => {
    expect(classifyScreening(text)).toBeNull();
  });
});

describe("isFarewell", () => {
  it.each([
    ["Goodbye."],
    ["Okay, thanks, bye."],
    ["No, that's enough, thank you."],
    // Transcription splits a turn at every pause, so the same goodbye arrives
    // as one sentence, two sentences, or two separate utterances.
    ["No, that's enough. Thank you."],
    ["No, that's enough."],
    ["I'm all set, cheers."],
    ["I have to go now."],
  ])("ends the call on %j", (text) => {
    expect(isFarewell(text)).toBe(true);
  });

  it.each([
    // Agreement mid-booking. Treating this as goodbye hangs up on the caller
    // in the middle of the conversation.
    ["Yep, that time is fine."],
    ["Yes, that's fine."],
    ["Yes that works, thanks."],
    ["That's all I know about the flight, thanks."],
    ["That is enough time for check-in I think."],
    ["By the way, which driver is it?"],
    ["Can you go over that again?"],
    ["Thank you."],
  ])("keeps going on %j", (text) => {
    expect(isFarewell(text)).toBe(false);
  });
});

describe("isLikelyNoise", () => {
  it("drops a lone character, which is never a real turn", () => {
    expect(isLikelyNoise("У", 900, 500)).toBe(true);
  });

  it("drops stock filler carried on weak audio", () => {
    expect(isLikelyNoise("Thank you", 400, 500)).toBe(true);
  });

  it("keeps the same words when they were actually said", () => {
    expect(isLikelyNoise("Thank you", 4000, 500)).toBe(false);
    expect(isLikelyNoise("yeah", 4000, 500)).toBe(false);
  });
});

describe("stripMarkdown", () => {
  it("removes emphasis a speech model would read aloud", () => {
    expect(stripMarkdown("Confirmed for **1:15 PM** today.")).toBe("Confirmed for 1:15 PM today.");
    expect(stripMarkdown("a train named *Tiny* ran late")).toBe("a train named Tiny ran late");
  });

  it("leaves arithmetic and identifiers alone", () => {
    expect(stripMarkdown("Costs 2 * 3 dollars and 5_000 units")).toBe(
      "Costs 2 * 3 dollars and 5_000 units"
    );
  });

  it("keeps link text and drops the target", () => {
    expect(stripMarkdown("See [our terms](https://x.com/t) for details")).toBe(
      "See our terms for details"
    );
  });
});
