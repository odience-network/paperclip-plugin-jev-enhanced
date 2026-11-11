import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the mock server received, as the contract suite asserts on it. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** What the server replies with. `delayMs` holds the response back, for
 * timeout tests. */
export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
}

export type MockHandler = (request: RecordedRequest) => MockReply;

export interface MockSystemOneServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Replaces the handler for subsequent requests. */
  respondWith(handler: MockHandler): void;
  close(): Promise<void>;
}

/** Answers a SystemOne body with a valid, synthetic answer per question:
 * `noul` 0.8, the first choice label at 0.9, the lowest score at 0.9. Echoes
 * the requested model, as a real SystemOne server does. */
export function syntheticSystemOneReply(request: RecordedRequest): MockReply {
  if (request.method === "GET") {
    return { body: { models: [{ name: "mock-model", description: "synthetic", release_date: "2026-01-01" }] } };
  }
  const body = request.body as { model: string; questions: Record<string, { type: string; criteria?: unknown }> };
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(body.questions)) {
    if (question.type === "noul") {
      answers[name] = { type: "noul", noul: 0.8 };
    } else if (question.type === "choice") {
      const labels = Object.keys(question.criteria as Record<string, unknown>);
      const rest = labels.length > 1 ? 0.1 / (labels.length - 1) : 0;
      const probabilities = Object.fromEntries(labels.map((label, index) => [label, index === 0 ? (labels.length > 1 ? 0.9 : 1) : rest]));
      answers[name] = { type: "choice", choice: labels[0], probabilities, confidence: 0.9 };
    } else {
      const levels = (question.criteria as unknown[]).length;
      const rest = 0.1 / (levels - 1);
      const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === 0 ? 0.9 : rest]));
      const legend = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `level ${i}`]));
      answers[name] = { type: "score", score: 0.2, legend, probabilities, confidence: 0.9 };
    }
  }
  return { body: { model: body.model, answers, usage: { input_tokens: 1_000, output_tokens: 10 } } };
}

/** In-process SystemOne-shaped HTTP server on an ephemeral loopback port.
 * Records every request and replays whatever the current handler returns. */
export async function startMockSystemOneServer(handler: MockHandler = syntheticSystemOneReply): Promise<MockSystemOneServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      const reply = current(recorded);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    respondWith(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
