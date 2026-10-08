export type { Policy, PolicyContext, PolicyVerdict, FieldDecision } from "./types.js";
export { pingPolicy, type PingState } from "./ping.js";
export {
  issueTriagePolicy,
  ISSUE_TYPE_CATALOG,
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
export { runPolicy, type RunPolicyInput, type RunPolicyDeps, type RunPolicyResult } from "./run.js";

import { pingPolicy } from "./ping.js";
import { issueTriagePolicy } from "./issue-triage.js";
import { askPolicy } from "./ask.js";
import { classifyTaskPolicy } from "./classify-task.js";
import { verifyPolicy } from "./verify.js";
import { rerankPolicy } from "./rerank.js";
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
};
