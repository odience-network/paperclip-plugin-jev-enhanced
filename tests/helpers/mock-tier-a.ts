import { syntheticSystemOneReply, type MockReply, type RecordedRequest } from "./mock-systemone-server.js";

/** Mock Workers AI: `POST .../ai/run/@cf/cloudflare/<model>` answers the
 * SystemOne body inside Cloudflare's envelope; `GET .../ai/models/search`
 * lists Clef and Clef Flash. Reuses the SystemOne synthetic answers. */
export function syntheticWorkersAiReply(request: RecordedRequest): MockReply {
  if (request.method === "GET") {
    return {
      body: {
        success: true,
        result: [
          { name: "@cf/cloudflare/clef", description: "27B", created_at: "2026-09-29 14:05:24.552" },
          { name: "@cf/cloudflare/clef-flash", description: "9B", created_at: "2026-09-29 09:25:44.258" },
          { name: "@cf/meta/not-a-decision-model", description: "other" },
        ],
        errors: [],
        messages: [],
      },
    };
  }
  const inner = syntheticSystemOneReply(request);
  return { ...inner, body: { result: inner.body, success: true, errors: [], messages: [] } };
}

interface OpenAiWireQuestion {
  name: string;
  type: "predicate" | "choice" | "score";
  choices?: Array<{ value: string }>;
  levels?: Array<{ label: string }>;
}

/** Mock OpenAI Decisions: answers each question in the request's own array
 * shape (predicate 0.8, first choice 0.9, lowest level 0.9) with the
 * two-decimal rounding the real API applies. `GET /models/<id>` returns a
 * model card. */
export function syntheticOpenAiReply(request: RecordedRequest): MockReply {
  if (request.method === "GET") {
    const id = request.path.split("/").pop();
    return { body: { id, object: "model", created: 1_789_406_102, owned_by: "system" } };
  }
  const body = request.body as { model: string; questions: OpenAiWireQuestion[] };
  const answers = body.questions.map((question) => {
    if (question.type === "predicate") return { type: "predicate", name: question.name, probability: 0.8 };
    if (question.type === "choice") {
      const values = (question.choices ?? []).map((choice) => choice.value);
      const rest = values.length > 1 ? Math.round((0.1 / (values.length - 1)) * 100) / 100 : 0;
      return {
        type: "choice",
        name: question.name,
        choice: values[0],
        probabilities: values.map((value, i) => ({ value, probability: i === 0 ? 0.9 : rest })),
        confidence: 0.9,
      };
    }
    const levels = question.levels ?? [];
    const rest = Math.round((0.1 / (levels.length - 1)) * 100) / 100;
    return {
      type: "score",
      name: question.name,
      score: 0.2,
      probabilities: levels.map((level, i) => ({ value: i, label: level.label, probability: i === 0 ? 0.9 : rest })),
      confidence: 0.9,
    };
  });
  return {
    body: {
      model: body.model,
      answers,
      usage: {
        input_tokens: 1_000,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1_000,
      },
    },
  };
}
