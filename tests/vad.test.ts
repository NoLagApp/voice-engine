import { describe, it, expect } from "vitest";
import { UtteranceDetector } from "../src/vad.js";

const FRAME = 160; // 20 ms at 8 kHz

function frame(amplitude: number): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    out[i] = Math.round(Math.sin(i / 4) * amplitude + (Math.random() - 0.5) * amplitude * 0.3);
  }
  return out;
}

interface Feed {
  frames: number;
  amplitude: number;
  agentSpeaking?: boolean;
}

function run(steps: Feed[]) {
  const detector = new UtteranceDetector();
  let bargeIns = 0;
  let opened = 0;
  let utterances = 0;
  for (const step of steps) {
    detector.setAgentSpeaking(step.agentSpeaking ?? false);
    for (let i = 0; i < step.frames; i++) {
      const result = detector.push(frame(step.amplitude));
      if (result.bargeIn) bargeIns++;
      if (result.speechStarted) opened++;
      if (result.utterance) utterances++;
    }
  }
  return { bargeIns, opened, utterances, threshold: detector.threshold };
}

const QUIET_ROOM: Feed = { frames: 150, amplitude: 30 };

describe("adapting to the room", () => {
  it("hears speech in a quiet room", () => {
    const result = run([QUIET_ROOM, { frames: 60, amplitude: 4000 }, { frames: 60, amplitude: 30 }]);
    expect(result.opened).toBe(1);
    expect(result.utterances).toBe(1);
  });

  it("raises its threshold in a noisy room instead of latching open", () => {
    // A fixed threshold below the room noise means every frame counts as
    // speech, the floor never updates, and the detector never closes an
    // utterance again. This is the regression that made the agent reply to
    // nothing, repeatedly, in a language nobody spoke.
    const noisy = run([
      { frames: 150, amplitude: 900 },
      { frames: 60, amplitude: 900 },
      { frames: 60, amplitude: 900 },
    ]);
    expect(noisy.threshold).toBeGreaterThan(500);
    expect(noisy.utterances).toBe(0);
  });

  it("still hears real speech over that raised threshold", () => {
    const result = run([
      { frames: 150, amplitude: 900 },
      { frames: 60, amplitude: 6000 },
      { frames: 60, amplitude: 900 },
    ]);
    expect(result.opened).toBe(1);
    expect(result.utterances).toBe(1);
  });

  it("ignores blips too short to be a turn", () => {
    const result = run([QUIET_ROOM, { frames: 3, amplitude: 4000 }, { frames: 60, amplitude: 30 }]);
    expect(result.utterances).toBe(0);
  });
});

describe("interrupting the agent", () => {
  it("stops the agent when the caller talks over it", () => {
    const result = run([
      QUIET_ROOM,
      { frames: 100, amplitude: 30, agentSpeaking: true },
      { frames: 40, amplitude: 9000, agentSpeaking: true },
    ]);
    expect(result.bargeIns).toBe(1);
  });

  it("is not fooled by the agent's own voice leaking back", () => {
    const result = run([QUIET_ROOM, { frames: 250, amplitude: 700, agentSpeaking: true }]);
    expect(result.bargeIns).toBe(0);
  });

  it("can still be interrupted after noise opened an utterance", () => {
    // Barge-in used to key off "an utterance just started", which only fires on
    // the opening transition. Anything that opened an utterance first, noise or
    // the tail of the caller's own sentence, made interruption impossible for
    // the rest of the call.
    const result = run([
      QUIET_ROOM,
      { frames: 30, amplitude: 900 },
      { frames: 150, amplitude: 700, agentSpeaking: true },
      { frames: 40, amplitude: 9000, agentSpeaking: true },
    ]);
    expect(result.bargeIns).toBe(1);
  });
});
