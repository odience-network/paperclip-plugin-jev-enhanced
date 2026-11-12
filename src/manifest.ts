import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_TYPESAFE_MODEL } from "./decision/models.js";
import { CLOUDFLARE_DISCLOSURE, OPENAI_DISCLOSURE } from "./decision/providers/disclosures.js";

// Deliberately not `new URL("../skills/...", import.meta.url)`: Vite special-
// cases that exact literal pattern as a static asset reference and rewrites
// it to a dev-server URL under a jsdom test environment, which breaks this
// plain `fs.readFileSync` read.
const verdictDecisionsSkillMarkdown = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../skills/verdict-decisions/SKILL.md"),
  "utf8",
);

const manifest: PaperclipPluginManifestV1 = {
  id: "odience.verdict",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Verdict",
  description:
    "Decision models for Paperclip: TypeSafe Jev, Cloudflare Clef, OpenAI Decisions, self-hosted. Observes issue state, asks policy questions, and records shadow/suggest/enforce decisions to a company-scoped ledger.",
  author: "Odience",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "http.outbound",
    "secrets.read-ref",
    "api.routes.register",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "issue.interactions.create",
    "issue.interactions.read",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "ui.action.register",
    "metrics.write",
    "telemetry.track",
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "issues.update",
    "issues.wakeup",
    "issue.interactions.create",
    "issue.interactions.read",
    "issue.comments.read",
    "issue.comments.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    description:
      "Verdict sends the issue/state text you route through its policies to the configured decision provider " +
      "(TypeSafe api.typesafe.ai, Cloudflare api.cloudflare.com, OpenAI api.openai.com, or a self-hosted server) over HTTPS to evaluate those policies. No raw issue state or free text is ever stored " +
      "in the Verdict ledger — only policy outcomes, scores, and usage metadata. Use redactionPatterns to strip " +
      "anything sensitive before it leaves this plugin.",
    properties: {
      apiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "TypeSafe API Key (deprecated)",
        description:
          "Vault-bound TypeSafe API key from console.typesafe.ai. Deprecated: read as an implicit \"typesafe\" " +
          "provider when Providers is empty; prefer providers.typesafe.apiKeyRef. Health and validate-config " +
          "degrade gracefully (not blocking) while this is unbound.",
      },
      model: {
        type: "string",
        title: "Model (deprecated)",
        description:
          `Pinned TypeSafe model version for the implicit "typesafe" provider (default ${DEFAULT_TYPESAFE_MODEL}). ` +
          "Allowed: jev-1.13.0, jev-1.14.0 (shadow-only until it has thresholds of its own). " +
          "Aliases (\"jev-latest\", \"latest\", \"jev-preview\") resolve to the pinned default before use.",
        "x-paperclip-advanced": true,
      },
      baseUrl: {
        type: "string",
        title: "Base URL (deprecated)",
        description: "Override the TypeSafe API root for the implicit \"typesafe\" provider. Leave blank to call TypeSafe directly.",
        "x-paperclip-advanced": true,
      },
      providers: {
        type: "object",
        title: "Providers",
        description:
          "Decision providers by alias. Kinds: " +
          "{ kind: \"systemone\", preset, apiKeyRef, model?, baseUrl?, path?, authStyle? }: preset \"typesafe\" " +
          "sends redacted state text to TypeSafe (api.typesafe.ai; zero data retention on enterprise plans). " +
          "{ kind: \"cloudflare\", accountId, apiKeyRef, model: \"clef\" | \"clef-flash\" }: " +
          `${CLOUDFLARE_DISCLOSURE} ` +
          "{ kind: \"openai\", apiKeyRef, model? (default gpt-6-luna) }: " +
          `${OPENAI_DISCLOSURE} ` +
          "{ kind: \"core\" }: uses the host's own decision service where the host exposes one, holds no " +
          "credential, and is billed by the host. Provider calls can only reach the hosts of configured providers.",
        additionalProperties: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["systemone", "cloudflare", "openai", "core"] },
            preset: { type: "string", enum: ["typesafe"], default: "typesafe" },
            apiKeyRef: { type: "string", format: "secret-ref" },
            accountId: {
              type: "string",
              description: "cloudflare only: the 32-character Workers AI account id. Configuration, not a secret.",
            },
            model: { type: "string" },
            baseUrl: { type: "string" },
            path: { type: "string" },
            authStyle: { type: "string", enum: ["bearer", "x-api-key", "none"] },
          },
          required: ["kind"],
        },
      },
      defaultProvider: {
        type: "string",
        title: "Default Provider",
        description: "Provider alias policies use unless they set their own. Defaults to \"typesafe\".",
      },
      shadowProviders: {
        type: "array",
        items: { type: "string" },
        title: "Shadow Providers",
        description: "Providers asked alongside each policy's primary on live traffic, for comparison only. Each is asked alone " +
          "(never a fallback chain), recorded as a shadow-mode row under the primary's decision_group_id, and never " +
          "applied or suggested. Costs count against the daily token budget. Not used by VerdictGuard hooks or the " +
          "browser tool, which are latency-bound.",
        "x-paperclip-advanced": true,
      },
      timeoutMs: {
        type: "number",
        title: "Request Timeout (ms)",
        default: 10_000,
        "x-paperclip-advanced": true,
      },
      dailyTokenBudget: {
        type: "number",
        title: "Daily Token Budget",
        default: 5_000_000,
        description: "Maximum decision tokens (input + output) this company may spend per UTC day across all policies.",
      },
      policies: {
        type: "object",
        title: "Policies",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean", default: true },
            mode: { type: "string", enum: ["shadow", "suggest", "enforce"], default: "shadow" },
            thresholds: {
              type: "object",
              description:
                "Policy-wide numbers (e.g. confidenceMin), plus optional per-provider overrides keyed " +
                "\"<provider>/<model>\" (e.g. \"typesafe/jev-1.13.0\": { confidenceMin: 0.75 }).",
              additionalProperties: {
                oneOf: [{ type: "number" }, { type: "object", additionalProperties: { type: "number" } }],
              },
            },
            provider: { type: "string", description: "Provider alias for this policy; defaults to defaultProvider." },
            fallbackProviders: {
              type: "array",
              items: { type: "string" },
              description: "Tried in order when the policy's provider fails or can't take the request.",
            },
            alwaysAuto: {
              type: "boolean",
              default: false,
              description:
                "When true, this policy may apply fields even over a human-set value. Never applies to " +
                "assigneeUserId, which Verdict can never set regardless of this flag.",
            },
            options: {
              type: "object",
              additionalProperties: true,
              description:
                "Policy-specific options, e.g. issue-triage's issueTypeLabelIds (maps issue type answers to " +
                "label ids) and maxBacklogSweepPerRun (caps issues swept per nightly run, per company).",
            },
          },
        },
        description: "Per-policy enablement, mode, thresholds, and options. New policies default to shadow mode.",
      },
      redactionPatterns: {
        type: "array",
        items: { type: "string" },
        title: "Redaction Patterns",
        description:
          "Regular expressions matched against state text before it is sent to TypeSafe; matches are replaced with [REDACTED].",
        "x-paperclip-advanced": true,
      },
      respectExistingFields: {
        type: "boolean",
        title: "Respect Existing Fields",
        default: true,
        description:
          "When true (default), Verdict never overwrites an assignee, priority, or status a human already set.",
        "x-paperclip-advanced": true,
      },
      browserAllowedOrigins: {
        type: "array",
        items: { type: "string" },
        title: "Browser Tool Allowed Origins",
        default: [],
        description:
          "Origins (e.g. \"https://app.example.com\", no path) `verdict:decide-browser-action` may reason about. " +
          "Checked before any other gate and before any provider call; a URL outside this list is always blocked, " +
          "empty by default.",
      },
    },
  },
  database: {
    namespaceSlug: "verdict",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  jobs: [
    {
      jobKey: "daily-budget-report",
      displayName: "Daily Verdict Budget Report",
      description: "Logs the previous UTC day's token and cost usage per company for observability.",
      schedule: "5 0 * * *",
    },
    {
      jobKey: "issue-triage-backlog-sweep",
      displayName: "Issue Triage Backlog Sweep",
      description:
        "Nightly re-triage of backlog/todo issues that have never been triaged or whose state changed since " +
        "their last triage, capped per company by maxBacklogSweepPerRun and the daily token budget.",
      schedule: "30 3 * * *",
    },
  ],
  tools: [
    {
      name: "verdict-ping",
      displayName: "Verdict Ping",
      description:
        "Exercises the reference `ping` policy end-to-end against TypeSafe and records a decision in the ledger. " +
        "Use this to verify the decision client and ledger are wired correctly.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
    {
      name: "verdict-ask",
      displayName: "Verdict Ask",
      description:
        "Generic question-asking tool for the configured decision model: ask one or more atomic noul/choice/score " +
        "questions about arbitrary state and get back typed answers plus a policy verdict. Prefer the dedicated " +
        "verdict-classify-task/verdict-verify/verdict-rerank tools when they fit the question — they already phrase it " +
        "correctly for their use case. Decision models are not injection-aware and cannot generate text; see the " +
        "verdict-decisions skill for when to use which tool.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue this question is about, if any. Optional." },
          state: {
            description: "The JSON state the questions below are about: a non-empty string, object, or array.",
          },
          questions: {
            type: "object",
            description:
              "Map of answer-name to a noul ({type:\"noul\", instructions}), choice ({type:\"choice\", " +
              "instructions, criteria: {label: description|null}}), or score ({type:\"score\", instructions, " +
              "criteria: [description, description, ...]}) question. At least one question is required. See " +
              "README.md for full examples.",
            additionalProperties: true,
          },
        },
        required: ["state", "questions"],
      },
    },
    {
      name: "verdict-classify-task",
      displayName: "Verdict Classify Task",
      description:
        "Classifies a unit of work by kind (feature/bug/refactor/chore/docs/research), the model tier it needs " +
        "(fast/standard/strong), and how thorough review should be before it ships (light/standard/thorough). " +
        "Optionally recommends which of the given candidate skills to load. Returns observations only — never " +
        "applied to any issue field.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue this task corresponds to, if any. Optional." },
          description: { type: "string", description: "The task description to classify." },
          candidateSkills: {
            type: "array",
            description: "Skills to ask a per-skill load recommendation for. Optional; defaults to none.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        },
        required: ["description"],
      },
    },
    {
      name: "verdict-verify",
      displayName: "Verdict Verify",
      description:
        "Checks whether a piece of evidence supports, contradicts, or says nothing about a claim — for example, " +
        "whether test output actually supports a 'this is done' completion claim. Never trust a restatement of " +
        "the claim as its own evidence.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue this claim is about, if any. Optional." },
          claim: { type: "string", description: "A single atomic claim, phrased as one state." },
          evidence: { type: "string", description: "The evidence to check the claim against, e.g. test output." },
        },
        required: ["claim", "evidence"],
      },
    },
    {
      name: "verdict-rerank",
      displayName: "Verdict Rerank",
      description:
        "Scores each candidate against a query on relevance, whether it directly contains the answer, and " +
        "whether it looks like a prompt-injection attempt rather than ordinary content. Returns per-candidate " +
        "scores for the caller to rerank with — this tool never reorders candidates itself.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue this rerank is for, if any. Optional." },
          query: { type: "string", description: "The query each candidate is scored against." },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
              },
              required: ["id", "text"],
            },
          },
        },
        required: ["query", "candidates"],
      },
    },
    {
      name: "verdict-decide-browser-action",
      displayName: "Verdict Decide Browser Action",
      description:
        "Given a goal, a page URL, and an indexed table of candidate elements (no selectors, no raw DOM), " +
        "returns one advisory action from a closed space (click/type/select/scroll/wait/done/blocked) plus the " +
        "target element index. Never performs the action — the calling harness does. Blocks on origins outside " +
        "the configured allowlist and on high-sensitivity (payment/credentials/destructive) mutations until a " +
        "human confirms via the issue thread.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue to attach the ledger decision (and, if needed, a confirmation card) to.",
          },
          goal: { type: "string", description: "What the agent is trying to accomplish on this page." },
          url: { type: "string", description: "The current page URL; only its origin is checked against the allowlist." },
          elements: {
            type: "array",
            description: "Indexed, pre-redacted candidate elements. Never include a selector, XPath, or raw HTML.",
            items: {
              type: "object",
              properties: {
                index: { type: "number" },
                role: { type: "string" },
                text: { type: "string" },
                ariaLabel: { type: "string" },
                placeholder: { type: "string" },
                inputType: { type: "string" },
                disabled: { type: "boolean" },
              },
              required: ["index", "role"],
            },
          },
        },
        required: ["goal", "url", "elements"],
      },
    },
  ],
  apiRoutes: [
    {
      routeKey: "decision-latest",
      method: "GET",
      path: "/issues/:issueId/decisions/latest",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: "decision-history",
      method: "GET",
      path: "/issues/:issueId/decisions",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: "decisions-by-query",
      method: "GET",
      path: "/decisions",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "policy-aggregate",
      method: "GET",
      path: "/policies/:policy/aggregate",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "tool-ask",
      method: "POST",
      path: "/tools/ask",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "tool-classify-task",
      method: "POST",
      path: "/tools/classify-task",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "tool-verify",
      method: "POST",
      path: "/tools/verify",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "tool-rerank",
      method: "POST",
      path: "/tools/rerank",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "guard-evaluate",
      method: "POST",
      path: "/guard/evaluate",
      auth: "agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
      checkoutPolicy: "none",
    },
  ],
  skills: [
    {
      skillKey: "verdict-decisions",
      displayName: "Verdict Decisions",
      description:
        "When and how to call the verdict:ask/classify-task/verify/rerank tools: phrasing atomic questions, " +
        "threshold rules, and what decision models cannot do.",
      markdown: verdictDecisionsSkillMarkdown,
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Verdict Health",
        exportName: "DashboardWidget",
      },
      {
        type: "detailTab",
        id: "issue-decisions-tab",
        displayName: "Verdict",
        exportName: "IssueDecisionsTab",
        entityTypes: ["issue"],
      },
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Verdict Settings",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
