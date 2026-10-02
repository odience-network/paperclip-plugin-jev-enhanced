export type { Policy, PolicyContext, PolicyVerdict } from "./types.js";
export { pingPolicy, type PingState } from "./ping.js";
export { runPolicy, type RunPolicyInput, type RunPolicyDeps, type RunPolicyResult } from "./run.js";

import { pingPolicy } from "./ping.js";
import type { Policy } from "./types.js";

/** Every policy this plugin ships, keyed by `policy.name`. Add new policies
 * here — `runPolicy` and the API routes resolve them from this registry. */
export const policies: Record<string, Policy<any>> = {
  [pingPolicy.name]: pingPolicy,
};
