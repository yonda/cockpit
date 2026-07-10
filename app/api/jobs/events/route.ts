import { openRunnerEventStream } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener(
        "abort",
        () => {
          closed = true;
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        { once: true },
      );

      openRunnerEventStream({
        signal: request.signal,
        onEvent: (event) => {
          send(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        },
        onError: (message) => {
          send(`event: upstream-error\ndata: ${JSON.stringify({ message })}\n\n`);
        },
      });

      send(`: connected\n\n`);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
