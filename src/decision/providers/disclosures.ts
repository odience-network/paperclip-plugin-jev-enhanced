/** Which host receives state text, and its published retention, per adapter.
 * Its own module so `manifest.ts` can show them without importing adapters. */
export const CLOUDFLARE_DISCLOSURE =
  "Sends redacted state text to Cloudflare Workers AI (api.cloudflare.com). Cloudflare does not store or train on requests.";
export const OPENAI_DISCLOSURE =
  "Sends redacted state text to OpenAI (api.openai.com). Retained up to 30 days for abuse monitoring unless the organization " +
  "has approved zero data retention; EU residency available.";
