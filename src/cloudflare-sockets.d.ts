// Minimal types for the Workers TCP socket API (used by the mail providers).
declare module "cloudflare:sockets" {
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<unknown>;
    close(): Promise<void>;
  }
  export function connect(address: { hostname: string; port: number }, options?: { secureTransport?: "on" | "off" | "starttls" }): Socket;
}
