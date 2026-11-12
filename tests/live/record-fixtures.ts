/**
 * L2 fixture recorder (plan 2.3b). Developer machines only, never CI:
 *
 *   pnpm fixtures:record
 *
 * Sends a fixed, synthetic request (no company data) through each Tier A
 * adapter with the tokens from the gitignored `.env`, captures the exact
 * request the adapter sent and the provider's reply, scrubs both, and writes
 * one JSON file per case under `tests/fixtures/<provider>/`. The replay suite
 * (`tests/provider-fixtures.spec.ts`) then runs in CI without any token.
 *
 * Scrub rules (reviewed in the PR; `scrub()` below is the implementation):
 * 1. Response headers are never stored (they carry request ids, rate-limit
 *    state and cf-ray ids). Only status and body are kept.
 * 2. The Cloudflare account id is replaced with `<account-id>` everywhere,
 *    including the request path.
 * 3. Every UUID (Cloudflare error request ids, catalog ids) becomes `<uuid>`;
 *    OpenAI-style `req_...` ids become `<request-id>`.
 * 4. The request state is synthetic, but any echo of it (or of a 24+
 *    character slice of it) in a response becomes `<state>`.
 * 5. The `authorization` header is never stored. After scrubbing, the file is
 *    checked for every token and the account id; a hit aborts the run
 *    without writing anything.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetch } from "@typesafe-ai/sdk";
import { parseVerdictConfig } from "../../src/config.js";
import { buildProvider } from "../../src/decision/registry.js";
import type { DecisionProvider } from "../../src/decision/provider.js";
import { canonicalize } from "../../src/decision/canonical.js";
import { FIXTURE_CASES, FIXTURE_STATE, type FixtureFile } from "../fixtures/cases.js";

if (process.env.CI) throw new Error("Never record fixtures in CI");
const envFile = join(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
};
const tokens = {
  typesafe: env("VERDICT_LIVE_TYPESAFE_TOKEN"),
  cloudflare: env("VERDICT_LIVE_CLOUDFLARE_TOKEN"),
  openai: env("VERDICT_LIVE_OPENAI_TOKEN"),
};
const accountId = env("VERDICT_LIVE_CLOUDFLARE_ACCOUNT_ID");
const secrets = [...Object.values(tokens), accountId];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REQUEST_ID = /\breq_[A-Za-z0-9]+/g;

function scrub(text: string): string {
  let out = text.split(accountId).join("<account-id>").replace(UUID, "<uuid>").replace(REQUEST_ID, "<request-id>");
  const state = canonicalize(FIXTURE_STATE);
  out = out.split(JSON.stringify(state).slice(1, -1)).join("<state>");
  for (let start = 0; start + 24 <= state.length; start += 12) {
    out = out.split(state.slice(start, start + 24)).join("<state>");
  }
  return out;
}

function providerConfig(kind: FixtureFile["provider"], model: string): Record<string, unknown> {
  switch (kind) {
    case "typesafe":
      return { kind: "systemone", preset: "typesafe", apiKeyRef: "typesafe", model };
    case "cloudflare":
      return { kind: "cloudflare", accountId, apiKeyRef: "cloudflare", model };
    case "openai":
      return { kind: "openai", apiKeyRef: "openai", model };
  }
}

/** Builds the adapter with a fetch that records the last exchange. */
function recordingProvider(kind: FixtureFile["provider"], model: string) {
  const exchanges: Array<{ method: string; url: string; body: unknown; status: number; text: string }> = [];
  const fetchImpl: Fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.clone().text();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    exchanges.push({ method: init?.method ?? "GET", url: String(input), body, status: response.status, text });
    return response;
  };
  const config = parseVerdictConfig({ providers: { subject: providerConfig(kind, model) } });
  const provider: DecisionProvider = buildProvider("subject", config.providers.subject, {
    resolveSecret: async (ref) => tokens[ref as keyof typeof tokens],
    timeoutMs: 30_000,
    fetchImpl,
    retry: { maxRetries: 0 },
  });
  return { provider, exchanges };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const pending: Array<{ path: string; text: string }> = [];

for (const fixtureCase of FIXTURE_CASES) {
  const { provider, exchanges } = recordingProvider(fixtureCase.provider, fixtureCase.model);
  if (fixtureCase.call === "listModels") {
    await provider.listModels?.();
  } else {
    await provider
      .decide({ state: canonicalize(FIXTURE_STATE), questions: fixtureCase.questions ?? {}, model: provider.model }, { signal: AbortSignal.timeout(30_000) })
      .catch(() => undefined);
  }
  const exchange = exchanges.at(-1);
  if (!exchange) throw new Error(`${fixtureCase.name}: no request was made`);
  const url = new URL(exchange.url);
  const fixture: FixtureFile = {
    source: "recorded",
    recordedAt: new Date().toISOString().slice(0, 10),
    provider: fixtureCase.provider,
    model: fixtureCase.model,
    name: fixtureCase.name,
    request: { method: exchange.method, path: `${url.pathname}${url.search}`, body: exchange.body ?? null },
    response: { status: exchange.status, body: JSON.parse(exchange.text) },
  };
  const text = `${scrub(JSON.stringify(fixture, null, 2))}\n`;
  const leaked = secrets.filter((secret) => text.includes(secret));
  if (leaked.length > 0) throw new Error(`${fixtureCase.name}: scrubbed fixture still contains a secret; nothing written`);
  pending.push({ path: join(root, fixtureCase.provider, `${fixtureCase.name}.json`), text });
}

for (const { path, text } of pending) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path.slice(root.length + 1)}`);
}
