import type { z } from "zod";
import { classifyError } from "../jev/errors.js";
import { runPolicy, type RunPolicyDeps, type RunPolicyResult } from "../policies/run.js";
import type { Policy } from "../policies/types.js";
import type { JevConfig } from "../config.js";

export type ToolOutcome =
  | { ok: true; result: RunPolicyResult }
  | { ok: false; error: string };

export interface RunDecisionToolInput<TParams, TState> {
  rawParams: unknown;
  paramsSchema: z.ZodType<TParams>;
  toState: (params: TParams) => TState;
  policy: Policy<TState>;
  config: JevConfig;
  companyId: string;
  issueId?: (params: TParams) => string | null | undefined;
  runId?: string | null;
  agentId?: string | null;
}

/**
 * Shared entry point for every `jev:*` tool and API route handler: validates
 * `rawParams` against the caller's own zod schema, then runs the policy
 * through the standard ledger/budget pipeline. Maps *any* failure — a
 * validation error or whatever `runPolicy` throws (budget exhaustion,
 * missing key, provider/validation errors) — to a short machine code via
 * `classifyError`, so a tool call or API response body never carries a raw
 * exception, stack trace, or free text. Never throws.
 */
export async function runDecisionTool<TParams, TState>(
  input: RunDecisionToolInput<TParams, TState>,
  deps: RunPolicyDeps,
): Promise<ToolOutcome> {
  const parsed = input.paramsSchema.safeParse(input.rawParams);
  if (!parsed.success) {
    return { ok: false, error: "invalid-params" };
  }

  const state = input.toState(parsed.data);
  try {
    const result = await runPolicy(
      {
        policy: input.policy,
        state,
        config: input.config,
        companyId: input.companyId,
        issueId: input.issueId?.(parsed.data) ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
      },
      deps,
    );
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: classifyError(error) };
  }
}

/** Maps a `classifyError`/`"invalid-params"` code to the HTTP status an API
 * route handler returns for it. Centralized here so every `tool-*` route in
 * `worker.ts` reports the same status for the same failure. */
export function statusForToolError(code: string): number {
  switch (code) {
    case "invalid-params":
      return 400;
    case "missing-api-key":
      return 412;
    case "auth-failed":
      return 401;
    case "permission-denied":
      return 403;
    case "budget-exceeded":
    case "rate-limited":
      return 429;
    case "timeout":
    case "aborted":
      return 504;
    case "validation-failed":
    case "connection-error":
      return 502;
    default:
      return code.startsWith("provider-error-") ? 502 : 500;
  }
}
