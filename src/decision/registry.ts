import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";
import type { VerdictConfig, ProviderBinding, ProviderConfig } from "../config.js";
import { MissingApiKeyError } from "./errors.js";
import { DecisionPipeline, type DecisionPipelineOptions } from "./pipeline.js";
import { providerModelKey, type DecisionProvider } from "./provider.js";
import { CoreProvider, detectHostDecisions } from "./providers/core.js";
import { SYSTEMONE_PRESETS } from "./providers/presets.js";
import { SystemOneProvider } from "./providers/systemone.js";

/** Alias the legacy top-level `apiKeyRef`/`model`/`baseUrl` are read as. */
export const LEGACY_PROVIDER_ID = "typesafe";

export interface ProviderRuntime {
  /** Wraps `ctx.secrets.resolve`. Never a `process.env` lookup. */
  resolveSecret: (ref: NonNullable<VerdictConfig["apiKeyRef"]>) => Promise<string>;
  /** Whatever the host handed the worker (`ctx`); `core` feature-detects on it. */
  host?: unknown;
  timeoutMs?: number;
  fetchImpl?: Fetch;
  retry?: Partial<RetryPolicy>;
}

/** The provider map after the legacy shim: an empty `providers` map plus the
 * deprecated top-level fields becomes a single implicit `typesafe` entry. */
export function effectiveProviders(config: VerdictConfig): { providers: Record<string, ProviderConfig>; legacy: boolean } {
  if (Object.keys(config.providers).length > 0) return { providers: config.providers, legacy: false };
  return {
    providers: {
      [LEGACY_PROVIDER_ID]: {
        kind: "systemone",
        preset: "typesafe",
        apiKeyRef: config.apiKeyRef,
        model: config.model,
        baseUrl: config.baseUrl,
      },
    },
    legacy: true,
  };
}

export function defaultProviderId(config: VerdictConfig): string {
  const { providers } = effectiveProviders(config);
  if (config.defaultProvider) return config.defaultProvider;
  if (LEGACY_PROVIDER_ID in providers) return LEGACY_PROVIDER_ID;
  return Object.keys(providers)[0];
}

export interface PolicyProviderIds {
  primary: string;
  fallbacks: string[];
  shadows: string[];
}

export function resolvePolicyProviderIds(config: VerdictConfig, policyName: string): PolicyProviderIds {
  const policy = config.policies[policyName];
  const primary = policy?.provider ?? defaultProviderId(config);
  const fallbacks = (policy?.fallbackProviders ?? []).filter((id) => id !== primary);
  const shadows = config.shadowProviders.filter((id) => id !== primary);
  return { primary, fallbacks: [...new Set(fallbacks)], shadows: [...new Set(shadows)] };
}

export function buildProvider(id: string, providerConfig: ProviderConfig, runtime: ProviderRuntime): DecisionProvider {
  switch (providerConfig.kind) {
    case "systemone": {
      const preset = SYSTEMONE_PRESETS[providerConfig.preset];
      if (!preset) throw new Error(`Unknown SystemOne preset "${providerConfig.preset}" for provider "${id}"`);
      const apiKeyRef = providerConfig.apiKeyRef;
      return new SystemOneProvider({
        id,
        preset,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        path: providerConfig.path,
        authStyle: providerConfig.authStyle,
        resolveApiKey: async () => {
          if (!apiKeyRef) {
            throw new MissingApiKeyError(`No API key bound for provider "${id}". Bind a vault secret to its apiKeyRef.`);
          }
          return runtime.resolveSecret(apiKeyRef);
        },
        timeoutMs: runtime.timeoutMs,
        fetchImpl: runtime.fetchImpl,
        retry: runtime.retry,
      });
    }
    case "core":
      return new CoreProvider(id, runtime.host, providerConfig.model);
  }
}

/** Builds the `[primary, ...fallbacks]` chain for one policy. `core` is
 * dropped from the chain on a host without the capability, unless it is the
 * only entry (then its calls fail as `provider-unavailable`). */
export function buildPolicyProviders(config: VerdictConfig, policyName: string, runtime: ProviderRuntime): DecisionProvider[] {
  const { providers } = effectiveProviders(config);
  const { primary, fallbacks } = resolvePolicyProviderIds(config, policyName);
  const chain = [primary, ...fallbacks].flatMap((id) => {
    const providerConfig = providers[id];
    return providerConfig ? [buildProvider(id, providerConfig, runtime)] : [];
  });
  if (chain.length === 0) throw new Error(`Policy "${policyName}" resolves to unknown provider "${primary}"`);
  const usable = chain.filter((provider) => !(provider instanceof CoreProvider) || provider.detected);
  return usable.length > 0 ? usable : chain;
}

export function buildPolicyPipeline(
  config: VerdictConfig,
  policyName: string,
  runtime: ProviderRuntime,
  options: Omit<DecisionPipelineOptions, "providers">,
): DecisionPipeline {
  return new DecisionPipeline({ ...options, providers: buildPolicyProviders(config, policyName, runtime) });
}

/** What `policyConfigFor` needs to resolve thresholds and mode for `provider`. */
export function providerBinding(provider: DecisionProvider): ProviderBinding {
  return {
    key: providerModelKey(provider),
    confidence: provider.capabilities.confidence,
    baseline: provider.kind === "systemone" && provider.preset === "typesafe",
  };
}

/** Legacy convenience: a pipeline over one `typesafe` SystemOne provider,
 * from the flat options `VerdictClient` used to take. Used by tests and the
 * offline eval/bench scripts. */
export function createTypesafePipeline(
  options: Omit<DecisionPipelineOptions, "providers"> & {
    resolveApiKey: () => Promise<string>;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: Fetch;
    retry?: Partial<RetryPolicy>;
  },
): DecisionPipeline {
  const { resolveApiKey, model, baseUrl, timeoutMs, fetchImpl, retry, ...pipelineOptions } = options;
  const provider = new SystemOneProvider({
    id: LEGACY_PROVIDER_ID,
    preset: SYSTEMONE_PRESETS.typesafe,
    model,
    baseUrl,
    resolveApiKey,
    timeoutMs,
    fetchImpl,
    retry,
  });
  return new DecisionPipeline({ ...pipelineOptions, providers: [provider] });
}

export interface ProviderConfigReport {
  errors: string[];
  warnings: string[];
}

/** Static checks for `onValidateConfig`: references resolve, presets exist,
 * `core` is only the default where the host exposes it, legacy fields warn. */
export function validateProviderConfig(config: VerdictConfig, host: unknown): ProviderConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { providers, legacy } = effectiveProviders(config);
  const coreDetected = detectHostDecisions(host) !== null;

  if (legacy && (config.apiKeyRef || config.baseUrl || config.model)) {
    warnings.push(
      "Top-level apiKeyRef/model/baseUrl are deprecated and read as an implicit \"typesafe\" provider. " +
        "Move them under providers.typesafe ({ kind: \"systemone\", preset: \"typesafe\", ... }).",
    );
  }
  if (!legacy && (config.apiKeyRef || config.baseUrl || config.model)) {
    warnings.push("Top-level apiKeyRef/model/baseUrl are ignored because a providers map is configured.");
  }

  for (const [id, providerConfig] of Object.entries(providers)) {
    if (providerConfig.kind === "systemone") {
      if (!SYSTEMONE_PRESETS[providerConfig.preset]) errors.push(`providers.${id}: unknown preset "${providerConfig.preset}".`);
    } else if (providerConfig.kind === "core" && !coreDetected) {
      warnings.push(`providers.${id}: core: unavailable on this host; it is skipped until the host exposes decisions.`);
    }
  }

  const checkRef = (where: string, id: string) => {
    if (!(id in providers)) errors.push(`${where} references unknown provider "${id}".`);
  };
  if (config.defaultProvider) checkRef("defaultProvider", config.defaultProvider);
  for (const id of config.shadowProviders) checkRef("shadowProviders", id);
  for (const [name, policy] of Object.entries(config.policies)) {
    if (policy.provider) checkRef(`policies.${name}.provider`, policy.provider);
    for (const id of policy.fallbackProviders ?? []) checkRef(`policies.${name}.fallbackProviders`, id);
  }

  const defaultId = defaultProviderId(config);
  if (providers[defaultId]?.kind === "core" && !coreDetected) {
    errors.push(`defaultProvider "${defaultId}" is core, which is unavailable on this host.`);
  }
  return { errors, warnings };
}
