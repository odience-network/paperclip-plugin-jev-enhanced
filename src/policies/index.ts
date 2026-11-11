export type { Policy, PolicyContext, PolicyVerdict, FieldDecision } from "./types.js";
export { pingPolicy, type PingState } from "./ping.js";
export {
  issueTriagePolicy,
  ISSUE_TYPE_CATALOG,
  confidenceMarginFor,
  type IssueTriageState,
  type IssueTriageOptions,
  type IssueTriageCandidateAgent,
  type IssueTriageCandidateProject,
  type IssueTriageCandidateIssue,
} from "./issue-triage.js";
export { askPolicy, type AskState } from "./ask.js";
export {
  classifyTaskPolicy,
  WORK_KIND_CATALOG,
  MODEL_TIER_CATALOG,
  REVIEW_DEPTH_CATALOG,
  type ClassifyTaskState,
  type ClassifyTaskCandidateSkill,
} from "./classify-task.js";
export { verifyPolicy, VERIFY_RELATION_CATALOG, type VerifyState } from "./verify.js";
export { rerankPolicy, type RerankState, type RerankCandidate } from "./rerank.js";
export {
  commentTriagePolicy,
  type CommentTriageState,
  type CommentTriageAuthorType,
} from "./comment-triage.js";
export {
  runOutcomeQaPolicy,
  type RunOutcomeQaState,
  type RunOutcomeQaRunStatus,
} from "./run-outcome-qa.js";
export { runPolicy, type RunPolicyInput, type RunPolicyDeps, type RunPolicyResult } from "./run.js";
export {
  browserActionPolicy,
  BROWSER_ACTIONS,
  resolveTargetIndex,
  resolveSensitive,
  type BrowserAction,
  type BrowserElement,
  type BrowserActionState,
} from "./browserAction.js";

import { pingPolicy } from "./ping.js";
import { issueTriagePolicy } from "./issue-triage.js";
import { askPolicy } from "./ask.js";
import { classifyTaskPolicy } from "./classify-task.js";
import { verifyPolicy } from "./verify.js";
import { rerankPolicy } from "./rerank.js";
import { guardPrePolicy } from "../guard/pre.js";
import { guardPostPolicy } from "../guard/post.js";
import { guardStopPolicy } from "../guard/stop.js";
import { commentTriagePolicy } from "./comment-triage.js";
import { runOutcomeQaPolicy } from "./run-outcome-qa.js";
import { browserActionPolicy } from "./browserAction.js";
import type { Policy } from "./types.js";

/** Every policy this plugin ships, keyed by `policy.name`. Add new policies
 * here — `runPolicy` and the API routes resolve them from this registry. */
export const policies: Record<string, Policy<any>> = {
  [pingPolicy.name]: pingPolicy,
  [issueTriagePolicy.name]: issueTriagePolicy,
  [askPolicy.name]: askPolicy,
  [classifyTaskPolicy.name]: classifyTaskPolicy,
  [verifyPolicy.name]: verifyPolicy,
  [rerankPolicy.name]: rerankPolicy,
  [guardPrePolicy.name]: guardPrePolicy,
  [guardPostPolicy.name]: guardPostPolicy,
  [guardStopPolicy.name]: guardStopPolicy,
  [commentTriagePolicy.name]: commentTriagePolicy,
  [runOutcomeQaPolicy.name]: runOutcomeQaPolicy,
  [browserActionPolicy.name]: browserActionPolicy,
};
