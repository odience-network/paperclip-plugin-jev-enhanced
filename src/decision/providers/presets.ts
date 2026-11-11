import { DEFAULT_TYPESAFE_MODEL, TYPESAFE_MODEL_ALIASES, TYPESAFE_MODELS } from "../models.js";
import type { ProviderCapabilities } from "../provider.js";

/** How the API key is sent. `"none"` is for self-hosted servers with no auth. */
export type SystemOneAuthStyle = "bearer" | "x-api-key" | "none";

/** A named SystemOne-shaped endpoint. Endpoints that speak the SystemOne body
 * differ only in these fields, so a new one is a data row here, not a new
 * adapter. G4 adds the Tier B presets. */
export interface SystemOnePreset {
  name: string;
  baseUrl: string;
  path: string;
  modelsPath: string;
  authStyle: SystemOneAuthStyle;
  defaultModel: string;
  /** Operator-typed aliases resolved to a pinned version before the call. */
  modelAliases: Readonly<Record<string, string>>;
  /** When set, the only models (after alias resolution) config may name;
   * anything else is a validation error. */
  pinnedModels?: readonly string[];
  capabilities: ProviderCapabilities;
  verification: "live" | "fixtures";
  /** Key into `RATE_CARDS`; absent when the preset has no published prices. */
  rateCard?: string;
  /** Which host receives state text, and its published retention. Shown next
   * to the provider in the config UI. */
  disclosure: string;
}

export const SYSTEMONE_PRESETS: Record<string, SystemOnePreset> = {
  typesafe: {
    name: "typesafe",
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    modelsPath: "/v1/models",
    authStyle: "bearer",
    defaultModel: DEFAULT_TYPESAFE_MODEL,
    modelAliases: TYPESAFE_MODEL_ALIASES,
    pinnedModels: TYPESAFE_MODELS,
    capabilities: {
      questionTypes: ["boolean", "choice", "score"],
      maxQuestions: Number.POSITIVE_INFINITY,
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      // Not a published limit: a ceiling well above anything the pipeline can
      // send (state is truncated to `maxStateChars` first), so no request that
      // works today is skipped.
      maxRequestBytes: 1_048_576,
      images: false,
      confidence: "native",
      probabilities: true,
      billing: "plugin",
    },
    verification: "live",
    rateCard: "typesafe",
    disclosure: "Sends redacted state text to TypeSafe (api.typesafe.ai). Zero data retention on enterprise plans.",
  },
};
