import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_JEV_MODEL } from "./jev/models.js";

// Deliberately not `new URL("../skills/...", import.meta.url)`: Vite special-
// cases that exact literal pattern as a static asset reference and rewrites
// it to a dev-server URL under a jsdom test environment, which breaks this
// plain `fs.readFileSync` read.
const jevDecisionsSkillMarkdown = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../skills/jev-decisions/SKILL.md"),
  "utf8",
);

const manifest: PaperclipPluginManifestV1 = {
  id: "odience.jev",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Odience Jev",
  description:
    "Integrates TypeSafe's Jev decision model into agentic workflows: observes issue state, asks policy questions, and records shadow/suggest/enforce decisions to a company-scoped ledger.",
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
      "Odience Jev sends the issue/state text you route through its policies to TypeSafe's hosted Jev model " +
      "(api.typesafe.ai) over HTTPS to evaluate those policies. No raw issue state or free text is ever stored " +
      "in the Jev ledger — only policy outcomes, scores, and usage metadata. Use redactionPatterns to strip " +
      "anything sensitive before it leaves this plugin.",
    properties: {
      apiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "TypeSafe API Key",
        description:
          "Vault-bound TypeSafe API key from console.typesafe.ai. Required for every live call; health and " +
          "validate-config degrade gracefully (not blocking) while this is unbound.",
      },
      model: {
        type: "string",
        title: "Model",
        default: DEFAULT_JEV_MODEL,
        description: "Pinned Jev model version. Aliases such as \"jev-latest\" resolve to a pinned version before use.",
      },
      baseUrl: {
        type: "string",
        title: "Base URL",
        description:
          "Override the TypeSafe API root, for example to route through OpenRouter or the Vercel AI Gateway. " +
          "Leave blank to call TypeSafe directly.",
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
        description: "Maximum Jev tokens (input + output) this company may spend per UTC day across all policies.",
      },
      policies: {
        type: "object",
        title: "Policies",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean", default: true },
            mode: { type: "string", enum: ["shadow", "suggest", "enforce"], default: "shadow" },
            thresholds: { type: "object", additionalProperties: { type: "number" } },
            alwaysAuto: {
              type: "boolean",
              default: false,
              description:
                "When true, this policy may apply fields even over a human-set value. Never applies to " +
                "assigneeUserId, which Jev can never set regardless of this flag.",
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
          "When true (default), Jev never overwrites an assignee, priority, or status a human already set.",
        "x-paperclip-advanced": true,
      },
      browserAllowedOrigins: {
        type: "array",
        items: { type: "string" },
        title: "Browser Tool Allowed Origins",
        default: [],
        description:
          "Origins (e.g. \"https://app.example.com\", no path) `jev:decide-browser-action` may reason about. " +
          "Checked before any other gate and before any provider call; a URL outside this list is always blocked, " +
          "empty by default.",
      },
    },
  },
  database: {
    namespaceSlug: "jev",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  jobs: [
    {
      jobKey: "daily-budget-report",
      displayName: "Daily Jev Budget Report",
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
      name: "jev-ping",
      displayName: "Jev Ping",
      description:
        "Exercises the reference `ping` policy end-to-end against TypeSafe and records a decision in the ledger. " +
        "Use this to verify the Jev client and ledger are wired correctly.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
    {
      name: "jev-ask",
      displayName: "Jev Ask",
      description:
        "Generic question-asking tool for TypeSafe's Jev decision model: ask one or more atomic noul/choice/score " +
        "questions about arbitrary state and get back typed answers plus a policy verdict. Prefer the dedicated " +
        "jev-classify-task/jev-verify/jev-rerank tools when they fit the question — they already phrase it " +
        "correctly for their use case. Jev is not injection-aware and cannot generate text; see the " +
        "jev-decisions skill for when to use which tool.",
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
      name: "jev-classify-task",
      displayName: "Jev Classify Task",
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
      name: "jev-verify",
      displayName: "Jev Verify",
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
      name: "jev-rerank",
      displayName: "Jev Rerank",
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
      name: "jev-decide-browser-action",
      displayName: "Jev Decide Browser Action",
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
      skillKey: "jev-decisions",
      displayName: "Jev Decisions",
      description:
        "When and how to call the jev:ask/classify-task/verify/rerank tools: phrasing atomic questions, " +
        "threshold rules, and what Jev cannot do.",
      markdown: jevDecisionsSkillMarkdown,
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Odience Jev Health",
        exportName: "DashboardWidget",
      },
      {
        type: "detailTab",
        id: "issue-decisions-tab",
        displayName: "Jev Decisions",
        exportName: "IssueDecisionsTab",
        entityTypes: ["issue"],
      },
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Odience Jev Settings",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
