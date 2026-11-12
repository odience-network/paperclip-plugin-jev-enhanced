import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseVerdictConfig } from "../src/config.js";
import { canonicalize } from "../src/decision/canonical.js";
import { classifyError } from "../src/decision/errors.js";
import { buildProvider } from "../src/decision/registry.js";
import type { DecisionProvider } from "../src/decision/provider.js";
import { FIXTURE_CASES, FIXTURE_STATE, type FixtureCase, type FixtureFile } from "./fixtures/cases.js";
import { plainHttpFetch, startMockSystemOneServer, type MockSystemOneServer } from "./helpers/mock-systemone-server.js";

/**
 * L2 replay (plan 2.3b): every scrubbed recording under `tests/fixtures/`
 * is served back by a mock server. The adapter must send the same request it
 * sent when the fixture was recorded (so translation drift fails here, not
 * in production) and must parse the real provider's reply. Runs in CI with
 * no tokens. Re-record with `pnpm fixtures:record` (see that script for the
 * scrub rules).
 */

/** Stand-in for the scrubbed `<account-id>`; any 32-hex value validates. */
const ACCOUNT_ID = "00000000000000000000000000000000";
const STATE = canonicalize(FIXTURE_STATE);

function loadFixture(fixtureCase: FixtureCase): FixtureFile {
  const path = join(import.meta.dirname, "fixtures", fixtureCase.provider, `${fixtureCase.name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
}

/** Undoes the scrub placeholders that sit in the request we compare against. */
function unscrub<T>(value: T): T {
  const escapedState = JSON.stringify(STATE).slice(1, -1);
  return JSON.parse(JSON.stringify(value).split("<state>").join(escapedState).split("<account-id>").join(ACCOUNT_ID)) as T;
}

function providerConfig(fixture: FixtureFile, baseUrl: string): Record<string, unknown> {
  switch (fixture.provider) {
    case "typesafe":
      return { kind: "systemone", preset: "typesafe", apiKeyRef: "ref", model: fixture.model, baseUrl };
    case "cloudflare":
      return { kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", model: fixture.model, baseUrl: `${baseUrl}/client/v4` };
    case "openai":
      return { kind: "openai", apiKeyRef: "ref", model: fixture.model, baseUrl: `${baseUrl}/v1` };
  }
}

describe.each(FIXTURE_CASES)("recorded fixture: $provider/$name", (fixtureCase) => {
  const fixture = loadFixture(fixtureCase);
  let server: MockSystemOneServer;
  let provider: DecisionProvider;

  beforeAll(async () => {
    server = await startMockSystemOneServer(() => ({ status: fixture.response.status, body: fixture.response.body }));
    const config = parseVerdictConfig({ providers: { subject: providerConfig(fixture, server.secureBaseUrl) } });
    provider = buildProvider("subject", config.providers.subject, {
      resolveSecret: async () => "sk-replay",
      retry: { maxRetries: 0 },
      fetchImpl: plainHttpFetch,
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it("is a scrubbed Tier A recording", () => {
    expect(fixture).toMatchObject({ source: "recorded", provider: fixtureCase.provider, model: fixtureCase.model });
    const text = JSON.stringify(fixture);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/\/accounts\/[0-9a-f]{32}\//i);
    expect(text).not.toContain(FIXTURE_STATE.ticket.slice(0, 24));
  });

  it("sends the recorded request and parses the recorded reply", async () => {
    server.requests.length = 0;
    if (fixtureCase.call === "listModels") {
      const models = (await provider.listModels?.()) ?? [];
      expect(models.length).toBeGreaterThan(0);
    } else {
      const decided = provider
        .decide({ state: STATE, questions: fixtureCase.questions ?? {}, model: provider.model }, { signal: AbortSignal.timeout(5_000) })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      const outcome = await decided;
      if (fixtureCase.expect === "answers") {
        expect("result" in outcome && outcome.result.model).toBe(fixture.model);
        expect(Object.keys("result" in outcome ? outcome.result.answers : {}).sort()).toEqual(Object.keys(fixtureCase.questions ?? {}).sort());
      } else {
        expect("error" in outcome && classifyError(outcome.error)).toBe(fixtureCase.expect.error);
      }
    }

    const sent = server.requests.at(-1);
    expect(sent?.method).toBe(fixture.request.method);
    expect(sent?.path).toBe(unscrub(fixture.request.path));
    expect(sent?.body ?? null).toEqual(unscrub(fixture.request.body));
  });
});
