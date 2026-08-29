/**
 * A browser page that pretends to be a phone, so a voice agent can be built
 * and tested without a telephony account, a phone number, or a public tunnel.
 *
 * The page speaks the same Media Streams protocol a real carrier does, at the
 * same endpoint, so the agent cannot tell the difference. That matters more
 * than convenience: the things that are hard to get right in voice (barge-in,
 * turn taking, whether the agent notices you talking over it) are exactly the
 * things you cannot test from a unit test, and iterating on them through real
 * phone calls is slow and costs money on every attempt.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { TwilioMediaStreamTransport } from "./transports/twilio.js";
import type { AudioTransport, SocketLike } from "./transport.js";

export interface SimulatorOptions {
  port?: number;
  /** Path the browser connects to for audio. Matches the telephony webhook. */
  mediaPath?: string;
  /**
   * Called for each simulated call. Wire the transport into a VoiceSession
   * exactly as the telephony handler does, so both paths share one code path.
   */
  onCall: (transport: AudioTransport, socket: SocketLike) => void;
}

export interface SimulatorHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function simulatorHtmlPath(): string {
  // Resolved relative to the built file in dist/, so it works from the package
  // whether it was installed or is being run out of the repo.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "public", "simulator.html"),
    path.join(here, "public", "simulator.html"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("simulator.html not found in the package");
}

/**
 * Serves the page and accepts its audio connection. Returns once listening.
 */
export async function startSimulator(options: SimulatorOptions): Promise<SimulatorHandle> {
  const port = options.port ?? 3000;
  const mediaPath = options.mediaPath ?? "/media";
  const htmlPath = simulatorHtmlPath();

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/" || req.url?.startsWith("/simulator")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
    res.writeHead(404).end("not found");
  });

  const wss = new WebSocketServer({ server, path: mediaPath });
  wss.on("connection", (socket) => {
    const transport = new TwilioMediaStreamTransport({
      socket,
      peerParameter: "peer",
      outboundParameter: "outbound",
    });
    options.onCall(transport, socket);
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    url: `http://localhost:${port}/simulator`,
    port,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
