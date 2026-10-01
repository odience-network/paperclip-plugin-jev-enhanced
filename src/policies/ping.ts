import { noul } from "@typesafe-ai/sdk";
import type { JevAnswer } from "../jev/types.js";
import type { Policy, PolicyContext, PolicyVerdict } from "./types.js";

/**
 * Trivial reference policy: asks Jev whether a short message is a "ping",
 * and decides "pong" or "no-pong" from the yes/no probability. Exists to
 * exercise the full pipeline (client, ledger, config) end to end, not to
 * encode any real product behavior.
 */
export interface PingState {
  message: string;
}

export const pingPolicy: Policy<PingState> = {
  name: "ping",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  preFilter(state): boolean {
    return typeof state.message === "string" && state.message.trim().length > 0;
  },

  questions(state) {
    return {
      pong: noul(`Is this message a ping? Message: ${state.message}`),
    };
  },

  decide(answers: Record<string, JevAnswer>, ctx: PolicyContext): PolicyVerdict {
    const pong = answers.pong;
    if (!pong || pong.type !== "noul") {
      return { verdict: "no-pong", confidence: null, margin: null, reason: "missing-or-invalid-answer" };
    }
    const threshold = ctx.config.thresholds.pong ?? 0.5;
    const isPong = pong.noul >= threshold;
    return {
      verdict: isPong ? "pong" : "no-pong",
      confidence: pong.noul,
      margin: Math.abs(pong.noul - threshold),
      reason: isPong ? "noul-above-threshold" : "noul-below-threshold",
    };
  },
};
