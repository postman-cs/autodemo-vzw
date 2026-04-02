// SSE streaming helpers for the provisioning Worker

const HEARTBEAT_INTERVAL_MS = 25_000;

export class SSEWriter {
  private encoder = new TextEncoder();
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventCount = 0;
  public readable: ReadableStream<Uint8Array>;

  constructor() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = readable;
    this.writer = writable.getWriter();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.writer.write(this.encoder.encode(":keepalive\n\n")).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  send(event: SSEEvent): void {
    if (this.closed) return;
    const data = JSON.stringify(event);
    this.writer.write(this.encoder.encode(`data: ${data}\n\n`)).catch((err) => {
      if (this.eventCount > 0) {
        console.warn(`SSE write failed after ${this.eventCount} events (connection dropped): ${err}`);
      }
    });
    this.eventCount++;
  }

  getEventCount(): number {
    return this.eventCount;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.writer.close().catch(() => {});
  }

  toResponse(): Response {
    return new Response(this.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export interface SSEEvent {
  project?: string;
  spec_id?: string;
  phase: string;
  status: "running" | "complete" | "error";
  message: string;
  resumption_token?: string;
  data?: Record<string, unknown>;
}
