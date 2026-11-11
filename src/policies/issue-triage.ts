import { noul, choice, score, type Questions } from "@typesafe-ai/sdk";
import type { FieldDecision, Policy, PolicyContext, PolicyVerdict } from "./types.js";
import { confidenceMarginFor } from "./util.js";

export { confidenceMarginFor };

/** No native `Issue` field carries an issue type — this is the only catalog
 * `decide()` can ever apply, and only when `options.issueTypeLabelIds` maps a
 * value here to a real label id (see `IssueTriageOptions`). Otherwise the
 * `issueType` answer is recorded in the ledger but never patches the issue. */
export const ISSUE_TYPE_CATALOG = ["bug", "feature", "chore", "docs", "question"] as const;

export interface IssueTriageCandidateAgent {
  id: string;
  name: string;
  role: string;
}

export interface IssueTriageCandidateProject {
  id: string;
  name: string;
}

export interface IssueTriageCandidateIssue {
  id: string;
  identifier: string | null;
  title: string;
}

export interface IssueTriageState {
  issueId: string;
  title: string;
  description: string | null;
  priority: string;
  /** A human or an agent is already assigned — `decide()` must never propose
   * reassigning owner while this is `true`, unless `alwaysAuto`. */
  hasOwner: boolean;
  /** A *human user* holds `assigneeUserId` specifically. `decide()` must
   * never set `assigneeAgentId` while this is `true`, in any mode, even
   * `alwaysAuto` — doing so would indirectly override `assigneeUserId`,
   * which has no override. */
  hasUserAssignee: boolean;
  /** A project is already set — `fits_project` is only meaningful, and only
   * ever asked, when this is `false` (there's nothing left to decide). */
  hasProject: boolean;
  existingLabelNames: string[];
  existingLabelIds: string[];
  /** `true` when the ledger has no prior decision at all for this issue —
   * lets `decide()` set an initial `priority` even under
   * `respectExistingFields`, since every issue is created with some default
   * priority that no human has actually reviewed yet. Every re-triage after
   * that treats `priority` as human-owned unless `alwaysAuto`. */
  isFirstTriage: boolean;
  /** `true` when this issue's `originKind` belongs to this plugin itself —
   * `preFilter` skips these unconditionally so Jev never triages its own
   * side-effect issues. */
  isPluginOrigin: boolean;
  eligibleAgents: IssueTriageCandidateAgent[];
  candidateProjects: IssueTriageCandidateProject[];
  recentOpenIssues: IssueTriageCandidateIssue[];
  issueTypes: readonly string[];
}

/** `PolicyConfig.options` shape for this policy, read as a loosely-typed bag
 * by `decide()` since the shared schema keeps `options` as `Record<string, unknown>`. */
export interface IssueTriageOptions {
  /** Maps a decided `issueType` value to a real label id this company has
   * configured — the only way `issueType` can ever become `action: "apply"`. */
  issueTypeLabelIds?: Record<string, string>;
}

export const issueTriagePolicy: Policy<IssueTriageState> = {
  name: "issue-triage",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  /** Stable, issue-intrinsic projection of `state` for `ctx.stateHash`'s
   * dedup check — drops ledger-derived (`isFirstTriage`) and full candidate
   * objects (names/titles churn and bloat the hash for no reason), but keeps
   * sorted candidate *id* sets so a membership change (e.g. a new eligible
   * agent) still invalidates it. `recentOpenIssues` is deliberately excluded
   * even as an id set: it's company-wide "other open issues right now", not
   * something intrinsic to *this* issue, so opening or closing any unrelated
   * issue elsewhere changes it for every backlog issue at once — that used
   * to invalidate every issue's hash on every unrelated issue creation,
   * making `issue-triage-backlog-sweep`'s dedup check nearly useless. Losing
   * same-cycle sensitivity to a brand-new possible duplicate is an accepted
   * tradeoff; the next sweep (or any real field edit) still re-triages. */
  identityState(state) {
    return {
      title: state.title,
      description: state.description,
      priority: state.priority,
      hasOwner: state.hasOwner,
      hasUserAssignee: state.hasUserAssignee,
      hasProject: state.hasProject,
      eligibleAgentIds: [...state.eligibleAgents.map((agent) => agent.id)].sort(),
      candidateProjectIds: [...state.candidateProjects.map((project) => project.id)].sort(),
    };
  },

  preFilter(state, ctx): boolean {
    if (state.isPluginOrigin) return false;
    if (ctx.stateHash && ctx.priorStateHash && ctx.stateHash === ctx.priorStateHash) return false;

    const respect = ctx.respectExistingFields ?? true;
    if (respect && !ctx.alwaysAuto && state.hasOwner && state.hasProject && !state.isFirstTriage) {
      // Owner and project are both already set by a human/prior run, and this
      // isn't the issue's first-ever triage — every field this policy could
      // still apply is one `respectExistingFields` already blocks, so there
      // is nothing left to do except re-ask the same questions for no effect.
      return false;
    }
    return true;
  },

  questions(state): Questions {
    // Question text is static and never interpolates issue title/description
    // or another issue's title: that text only reaches the provider through
    // `state`, which goes through the redaction/truncation pipeline before
    // being sent — question strings don't, so putting raw issue text in them
    // would both break the "no secrets in prompts" rule and let injected
    // text sit in instruction position instead of data position.
    const questions: Questions = {
      owner: choice("Who should own this issue? Use the issue's title and description, given above as state, to decide.", {
        ...Object.fromEntries(state.eligibleAgents.map((agent) => [agent.id, `${agent.name} (${agent.role})`])),
        unassigned: "No eligible agent fits yet; leave unassigned",
        needs_triage: "This needs a human to decide, not an agent",
      }),
      priority: choice(
        "What priority fits this issue? critical = urgent/blocking, high = important and should happen soon, " +
          "medium = normal, low = nice to have",
        { critical: null, high: null, medium: null, low: null },
      ),
      issueType: choice(
        "What type of issue is this?",
        Object.fromEntries(state.issueTypes.map((type) => [type, null])),
      ),
      complexity: score("How complex does this issue look to resolve?", [
        "trivial: a one-line or config-only change",
        "small: a single focused change in one area",
        "medium: touches a few files or needs some design",
        "large: a substantial, multi-step effort",
      ]),
      needsMoreContext: noul(
        "Does this issue need more context or clarification from someone before anyone could start on it?",
      ),
      likelyBlocked: noul("Is this issue likely blocked on something outside of this issue right now?"),
      duplicateExists: noul("Does this issue appear to duplicate another currently open issue?"),
    };

    if (state.recentOpenIssues.length > 0) {
      questions.duplicateOf = choice(
        'If this issue duplicates another open issue listed in state\'s "recentOpenIssues", which one (by id)? ' +
          'Pick "none" if it does not.',
        {
          ...Object.fromEntries(state.recentOpenIssues.map((issue) => [issue.id, issue.identifier ?? issue.id])),
          none: "Not a duplicate of any issue listed here",
        },
      );
    }

    if (!state.hasProject) {
      for (const project of state.candidateProjects) {
        questions[`fitsProject:${project.id}`] = noul(`Does this issue belong in the "${project.name}" project?`);
      }
    }

    return questions;
  },

  decide(answers, ctx, state): PolicyVerdict {
    const confidenceMin = ctx.config.thresholds.confidenceMin ?? 0.7;
    const marginMin = ctx.config.thresholds.marginMin ?? 0.15;
    const maxCandidates = ctx.config.thresholds.maxCandidates ?? 20;
    const respect = ctx.respectExistingFields ?? true;
    const alwaysAuto = ctx.alwaysAuto ?? false;
    const options = (ctx.config.options as IssueTriageOptions | undefined) ?? {};

    const candidateCount = state
      ? Math.max(state.eligibleAgents.length, state.candidateProjects.length, state.recentOpenIssues.length)
      : 0;
    const withinStateSizeBudget = candidateCount < maxCandidates;

    const clears = (cm: { confidence: number; margin: number } | null): boolean =>
      cm !== null && cm.confidence >= confidenceMin && cm.margin >= marginMin && withinStateSizeBudget;

    const fields: FieldDecision[] = [];

    const ownerAnswer = answers.owner;
    const ownerCm = confidenceMarginFor(ownerAnswer);
    if (ownerAnswer?.type === "choice" && ownerCm) {
      const hasAnyOwner = state?.hasOwner ?? true;
      const hasUserAssignee = state?.hasUserAssignee ?? true;
      const isSentinel = ownerAnswer.choice === "unassigned" || ownerAnswer.choice === "needs_triage";
      const value = isSentinel ? null : ownerAnswer.choice;
      // Only a specific new owner, and only when nothing is set yet, can
      // ever auto-apply; `alwaysAuto`/`!respect` only ever lets this touch
      // an *agent*-set owner, never a human one (see below).
      const canTouch = !hasAnyOwner || alwaysAuto || !respect;

      let action: FieldDecision["action"];
      let reason: string | undefined;
      if (!clears(ownerCm)) {
        action = "observe";
        reason = "below-threshold";
      } else if (hasUserAssignee) {
        // A human user already owns this issue — setting `assigneeAgentId`
        // at all would be an indirect override of `assigneeUserId`, which
        // has no override, not even `alwaysAuto`.
        action = "suggest";
        reason = "respects-existing-field";
      } else if (isSentinel && hasAnyOwner) {
        // Clearing an existing (agent) owner is never auto-applied,
        // regardless of mode or `alwaysAuto` — only ever a recommendation.
        action = "suggest";
        reason = "respects-existing-field";
      } else if (!canTouch) {
        action = "suggest";
        reason = "respects-existing-field";
      } else {
        action = "apply";
      }

      fields.push({
        field: "assigneeAgentId",
        value,
        confidence: ownerCm.confidence,
        margin: ownerCm.margin,
        action,
        reason,
      });
    }

    const priorityAnswer = answers.priority;
    const priorityCm = confidenceMarginFor(priorityAnswer);
    if (priorityAnswer?.type === "choice" && priorityCm) {
      const priorityExisting = !(state?.isFirstTriage ?? false);
      const canTouch = !priorityExisting || alwaysAuto || !respect;
      fields.push({
        field: "priority",
        value: priorityAnswer.choice,
        confidence: priorityCm.confidence,
        margin: priorityCm.margin,
        action: !clears(priorityCm) ? "observe" : !canTouch ? "suggest" : "apply",
        reason: !clears(priorityCm) ? "below-threshold" : !canTouch ? "respects-existing-field" : undefined,
      });
    }

    const issueTypeAnswer = answers.issueType;
    const issueTypeCm = confidenceMarginFor(issueTypeAnswer);
    if (issueTypeAnswer?.type === "choice" && issueTypeCm) {
      const labelId = options.issueTypeLabelIds?.[issueTypeAnswer.choice];
      const hasMapping = typeof labelId === "string" && labelId.length > 0;
      fields.push({
        field: "issueType",
        value: issueTypeAnswer.choice,
        confidence: issueTypeCm.confidence,
        margin: issueTypeCm.margin,
        action: !clears(issueTypeCm) ? "observe" : !hasMapping ? "observe" : "apply",
        reason: !clears(issueTypeCm) ? "below-threshold" : !hasMapping ? "no-applicable-field" : undefined,
      });
    }

    const complexityAnswer = answers.complexity;
    const complexityCm = confidenceMarginFor(complexityAnswer);
    if (complexityAnswer?.type === "score" && complexityCm) {
      fields.push({
        field: "complexity",
        value: complexityAnswer.score,
        confidence: complexityCm.confidence,
        margin: complexityCm.margin,
        action: "observe",
        reason: "no-applicable-field",
      });
    }

    for (const key of ["needsMoreContext", "likelyBlocked", "duplicateExists"] as const) {
      const answer = answers[key];
      const cm = confidenceMarginFor(answer);
      if (answer?.type === "noul" && cm) {
        fields.push({
          field: key,
          value: answer.noul >= 0.5,
          confidence: cm.confidence,
          margin: cm.margin,
          action: "observe",
          reason: "no-applicable-field",
        });
      }
    }

    const duplicateOfAnswer = answers.duplicateOf;
    const duplicateOfCm = confidenceMarginFor(duplicateOfAnswer);
    if (duplicateOfAnswer?.type === "choice" && duplicateOfCm) {
      fields.push({
        field: "duplicateOf",
        value: duplicateOfAnswer.choice,
        confidence: duplicateOfCm.confidence,
        margin: duplicateOfCm.margin,
        action: "observe",
        reason: "no-applicable-field",
      });
    }

    for (const [key, answer] of Object.entries(answers)) {
      if (!key.startsWith("fitsProject:")) continue;
      const cm = confidenceMarginFor(answer);
      if (answer.type === "noul" && cm) {
        fields.push({
          field: key,
          value: answer.noul >= 0.5,
          confidence: cm.confidence,
          margin: cm.margin,
          action: "observe",
          reason: "no-applicable-field",
        });
      }
    }

    const ownerField = fields.find((f) => f.field === "assigneeAgentId");
    if (!ownerField || ownerAnswer?.type !== "choice") {
      return { verdict: "no-answer", confidence: null, margin: null, reason: "missing-or-invalid-answer", fields };
    }

    return {
      verdict: ownerField.value === null ? ownerAnswer.choice : `assign:${ownerField.value}`,
      confidence: ownerField.confidence,
      margin: ownerField.margin,
      reason: ownerField.action === "apply" ? "ok" : ownerField.reason ?? "ok",
      fields,
    };
  },
};
