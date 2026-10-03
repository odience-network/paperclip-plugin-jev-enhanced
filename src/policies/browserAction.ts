import { choice, noul } from "@typesafe-ai/sdk";
import type { JevAnswer } from "../jev/types.js";
import type { Policy, PolicyContext, PolicyVerdict } from "./types.js";

/**
 * Closed action space for `jev:decide-browser-action` (plan feature F6).
 * `"blocked"` is a first-class member, not an error path: it is what the
 * policy returns whenever a deterministic gate (confidence, sensitivity,
 * missing target) says the harness must not act yet.
 */
export const BROWSER_ACTIONS = ["click", "type", "select", "scroll", "wait", "done", "blocked"] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** Actions that change page or account state, and so are gated by the
 * sensitivity noul before they can ever be the final verdict. */
const MUTATING_ACTIONS: ReadonlySet<BrowserAction> = new Set(["click", "type", "select"]);

/** Actions that require a resolved element index; `scroll` targets a
 * container element, `wait` / `done` / `blocked` never need one. */
const TARGETED_ACTIONS: ReadonlySet<BrowserAction> = new Set(["click", "type", "select", "scroll"]);

const ACTION_DESCRIPTIONS: Record<Exclude<BrowserAction, "blocked">, string> = {
  click: "Click the target element (button, link, checkbox, etc.)",
  type: "Type text into the target element (a text input or textarea)",
  select: "Choose an option in the target element (a select/listbox/radio group)",
  scroll: "Scroll the target element (or the page) into or within view",
  wait: "Wait for the page to finish loading or changing before acting again",
  done: "The goal is already satisfied; no further action is needed",
};

/** Indexed, pre-redacted element summary — never a selector, never raw DOM.
 * The harness owns the mapping from `index` back to whatever it used
 * (CSS selector, accessibility node id, etc.) to build this table. */
export interface BrowserElement {
  index: number;
  role: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  inputType?: string;
  disabled?: boolean;
}

export interface BrowserActionState {
  goal: string;
  url: string;
  elements: BrowserElement[];
}

function targetQuestionKey(index: number): string {
  return `target_${index}`;
}

/**
 * Picks the element index with the highest "is this the target" noul, as
 * long as it clears `threshold`. Reads directly off the answers map (not the
 * original element table) so eval fixtures can exercise it with nothing but
 * recorded answers.
 */
export function resolveTargetIndex(answers: Record<string, JevAnswer>, threshold: number): number | null {
  let best: { index: number; noul: number } | null = null;
  for (const [key, answer] of Object.entries(answers)) {
    if (answer.type !== "noul") continue;
    const match = /^target_(\d+)$/.exec(key);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (!best || answer.noul > best.noul) {
      best = { index, noul: answer.noul };
    }
  }
  if (!best || best.noul < threshold) return null;
  return best.index;
}

/** Whether the sensitivity noul (payment, credentials, or destructive)
 * clears `threshold`. Missing or invalid answers fail closed (sensitive). */
export function resolveSensitive(answers: Record<string, JevAnswer>, threshold: number): boolean {
  const answer = answers.sensitivity;
  if (!answer || answer.type !== "noul") return true;
  return answer.noul >= threshold;
}

/**
 * The action Jev's `action` choice answer named, independent of whether
 * `decide()` went on to gate it to `"blocked"`. Callers that need to tell a
 * human what they're being asked to confirm (e.g. the `request_confirmation`
 * prompt) want this, not `PolicyVerdict.verdict`, which collapses every
 * gated case to `"blocked"`.
 */
export function resolveCandidateAction(answers: Record<string, JevAnswer>): BrowserAction | null {
  const answer = answers.action;
  if (!answer || answer.type !== "choice") return null;
  return BROWSER_ACTIONS.includes(answer.choice as BrowserAction) ? (answer.choice as BrowserAction) : null;
}

/**
 * Asks Jev three things in one call: which closed action to take, whether
 * the action is high-sensitivity (payment, credentials, destructive), and —
 * via one speculative noul "head" per candidate element — which indexed
 * element is the target. Never sees a selector: the state is this policy's
 * `goal` plus the caller's already-redacted indexed element table.
 */
export const browserActionPolicy: Policy<BrowserActionState> = {
  name: "browser-action",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  preFilter(state): boolean {
    return typeof state.goal === "string" && state.goal.trim().length > 0;
  },

  questions(state) {
    const criteria = Object.fromEntries(
      BROWSER_ACTIONS.filter((action): action is Exclude<BrowserAction, "blocked"> => action !== "blocked").map(
        (action) => [action, ACTION_DESCRIPTIONS[action]],
      ),
    );

    const targetQuestions = Object.fromEntries(
      state.elements.map((element) => [
        targetQuestionKey(element.index),
        noul(
          `Is element ${element.index} (role "${element.role}"${element.text ? `, text "${element.text}"` : ""}) ` +
            `the correct target to achieve the goal: ${state.goal}?`,
        ),
      ]),
    );

    return {
      action: choice(`Given the goal "${state.goal}", which action should happen next?`, criteria),
      sensitivity: noul(
        `Would carrying out this action on ${state.url} involve payment, credentials, or a destructive/` +
          "irreversible change?",
      ),
      ...targetQuestions,
    };
  },

  decide(answers: Record<string, JevAnswer>, ctx: PolicyContext): PolicyVerdict {
    const actionAnswer = answers.action;
    if (!actionAnswer || actionAnswer.type !== "choice") {
      return { verdict: "blocked", confidence: null, margin: null, reason: "missing-or-invalid-action-answer" };
    }

    const action = actionAnswer.choice as BrowserAction;
    if (!BROWSER_ACTIONS.includes(action)) {
      return { verdict: "blocked", confidence: actionAnswer.confidence, margin: null, reason: "unknown-action" };
    }

    const probabilities = Object.values(actionAnswer.probabilities).sort((a, b) => b - a);
    const margin = probabilities.length > 1 ? probabilities[0] - probabilities[1] : probabilities[0];

    const actionThreshold = ctx.config.thresholds.action ?? 0.5;
    if (actionAnswer.confidence < actionThreshold) {
      return { verdict: "blocked", confidence: actionAnswer.confidence, margin, reason: "low-confidence" };
    }

    const sensitivityThreshold = ctx.config.thresholds.sensitivity ?? 0.5;
    if (MUTATING_ACTIONS.has(action) && resolveSensitive(answers, sensitivityThreshold)) {
      return { verdict: "blocked", confidence: actionAnswer.confidence, margin, reason: "sensitive-awaiting-confirmation" };
    }

    if (TARGETED_ACTIONS.has(action)) {
      const targetThreshold = ctx.config.thresholds.target ?? 0.5;
      if (resolveTargetIndex(answers, targetThreshold) === null) {
        return { verdict: "blocked", confidence: actionAnswer.confidence, margin, reason: "no-target-resolved" };
      }
    }

    return { verdict: action, confidence: actionAnswer.confidence, margin, reason: "action-above-threshold" };
  },
};
