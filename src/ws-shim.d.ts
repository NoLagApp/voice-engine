/**
 * Minimal ambient types for the parts of `ws` the simulator uses.
 *
 * This exists only because installing @types/ws currently fails: the repo's
 * workspace install is blocked on @nolag/js-sdk@^1.12.0, which is referenced by
 * the blueprint SDKs but not yet published. Once that resolves, add
 * @types/ws as a devDependency and delete this file.
 *
 * Nothing here leaks to consumers: TypeScript emits no declarations for .d.ts
 * inputs, and the package's public types describe sockets structurally through
 * SocketLike rather than through `ws`.
 */
declare module "ws" {
  import type { Server as HttpServer } from "node:http";

  export interface WebSocket {
    readonly readyState: number;
    readonly OPEN: number;
    send(data: string): void;
    close(): void;
    on(event: "message", handler: (data: unknown) => void): void;
    on(event: "close", handler: () => void): void;
  }

  export class WebSocketServer {
    constructor(options: { server?: HttpServer; port?: number; path?: string });
    on(event: "connection", handler: (socket: WebSocket) => void): void;
    close(callback?: () => void): void;
  }
}
