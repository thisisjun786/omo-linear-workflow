import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result, ScopeSnapshot } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import initiativeExtension from "../src/extension";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const scope: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: null,
  projects: [{ project: { id: "p", url: "linear://p", revision: "1" }, issues: [] }],
  decisionRefs: [],
};

test("session start never auto-aborts a bound role when host state is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-fallback-abort-"));
  try {
    await mkdir(join(root, ".omo/state"), { recursive: true });
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    let sessionId: string;
    try {
      const digest = value(registry.importScope(scope)).digest;
      sessionId = value(
        registry.reserve({
          bindingId: "parent",
          durableSessionId: "session-parent",
          designation: {
            id: "designation",
            snapshotDigest: digest,
            designatedBy: "test",
            designatedAt: "now",
            create: true,
            execute: true,
            contact: true,
          },
          snapshot: scope,
          assignment: { role: "parent", initiativeId: null, projectId: "p", ownerBindingId: null },
          cwd: root,
          checkout: null,
          herdrSocket: "/herdr",
          omoSocket: "/missing-host",
        }),
      ).durableSessionId;
    } finally {
      registry.close();
    }
    const handlers: Array<(event: { reason: "reload" }, ctx: unknown) => unknown> = [];
    const aborts: string[] = [];
    const pi = {
      cwd: root,
      on(event: string, handler: (event: { reason: "reload" }, ctx: unknown) => unknown) {
        if (event === "session_start") handlers.push(handler);
      },
      events: { on() {}, emit() {} },
      rpc: { handle() {} },
      registerTool() {},
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      getActiveTools: () => [],
      setActiveTools() {},
      executeTool: async () => ({ details: {} }),
      appendEntry() {},
    };
    initiativeExtension(pi as never);
    const ctx = {
      mode: "tui",
      cwd: root,
      abort: (source?: "user" | "system") => aborts.push(source ?? "user"),
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => [],
      },
      sessionSettings: { setModelFallbackForSession() {} },
      isIdle: () => false,
    };
    for (const handler of handlers) await handler({ reason: "reload" }, ctx);
    expect(aborts).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
