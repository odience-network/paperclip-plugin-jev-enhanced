import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_JEV_MODEL } from "./jev/models.js";

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
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "http.outbound",
    "secrets.read-ref",
    "api.routes.register",
    "agent.tools.register",
    "jobs.schedule",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "metrics.write",
    "telemetry.track",
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
          },
        },
        description: "Per-policy enablement, mode, and thresholds. New policies default to shadow mode.",
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
      routeKey: "policy-aggregate",
      method: "GET",
      path: "/policies/:policy/aggregate",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
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
    ],
  },
};

export default manifest;
