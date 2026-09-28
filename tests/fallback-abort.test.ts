import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, Result, ScopeSnapshot } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import { abortOrphanedFallbackTurn } from "../src/extension";

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

test("fallback session rebind aborts a busy bound turn only when the exact host session is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-fallback-abort-"));
  try {
    await mkdir(join(root, ".omo/state"), { recursive: true });
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    let binding: Binding;
    try {
      const digest = value(registry.importScope(scope)).digest;
      binding = value(
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
          omoSocket: "/omo",
        }),
      );
    } finally {
      registry.close();
    }
    const aborts: string[] = [];
    const ctx = {
      abort: (source?: "user" | "system") => aborts.push(source ?? "user"),
      sessionManager: { getSessionId: () => binding.durableSessionId },
    };
    expect(await abortOrphanedFallbackTurn(root, ctx, async () => ({ state: "absent" }))).toBe(
      true,
    );
    expect(aborts).toEqual(["system"]);
    expect(
      await abortOrphanedFallbackTurn(root, ctx, async () => ({ state: "unknown", reason: "x" })),
    ).toBe(false);
    expect(aborts).toEqual(["system"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
