import { useEffect, useState, createElement } from "react";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionActorContext } from "@paperclipai/plugin-sdk";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import plugin from "../../src/manifest.js";
import workerPlugin from "../../src/worker.js";
import { createFakeDb } from "./fake-db.js";

/** Installs `globalThis.__paperclipPluginBridge__` so plugin UI components
 * under test call into a real worker (backed by the in-memory fake ledger
 * db) through the same `usePluginData`/`usePluginAction`/`useHostContext`
 * contract the real host bridge uses — see `ui/runtime.ts` in the SDK. */
export async function installUiTestBridge(options: {
  companyId: string;
  entityId?: string;
  actor?: Partial<PluginPerformActionActorContext>;
}): Promise<{ harness: TestHarness; uninstall: () => void }> {
  const harness = createTestHarness({
    manifest: plugin,
    capabilities: [...plugin.capabilities, "events.emit"],
  });
  harness.ctx.db = createFakeDb();
  await workerPlugin.definition.setup(harness.ctx);

  const hostContext: PluginHostContext = {
    companyId: options.companyId,
    companyPrefix: null,
    projectId: null,
    entityId: options.entityId ?? null,
    entityType: options.entityId ? "issue" : null,
    parentEntityId: null,
    userId: options.actor?.userId ?? null,
  };

  function usePluginData<T>(key: string, params?: Record<string, unknown>) {
    const [state, setState] = useState<{ data: T | null; loading: boolean; error: Error | null }>({
      data: null,
      loading: true,
      error: null,
    });
    const [version, setVersion] = useState(0);

    useEffect(() => {
      let cancelled = false;
      setState((prev) => ({ ...prev, loading: true }));
      harness
        .getData<T>(key, params ?? {})
        .then((data) => {
          if (!cancelled) setState({ data, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({ data: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
          }
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, JSON.stringify(params ?? {}), version]);

    return { ...state, refresh: () => setVersion((v) => v + 1) };
  }

  function usePluginAction(key: string) {
    return (params?: Record<string, unknown>) =>
      harness.performAction(key, params ?? {}, {
        companyId: options.companyId,
        actor: { type: "user", userId: null, agentId: null, runId: null, ...options.actor },
      });
  }

  function useHostContext(): PluginHostContext {
    return hostContext;
  }

  (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {
    react: { createElement },
    sdkUi: { usePluginData, usePluginAction, useHostContext },
  };

  return {
    harness,
    uninstall: () => {
      delete (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
    },
  };
}
