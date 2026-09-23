import { afterEach, expect, test } from "bun:test";
import {
  getToolSearchService,
  installScopedToolSearchService,
  resetToolSearchServiceForTests,
  ToolSearchService,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/tool-search/service.js";
import {
  ProviderScope,
  runWithProviderScope,
} from "../../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/node/provider-scope.js";

const scopes: ProviderScope[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.close();
  resetToolSearchServiceForTests();
});

function fixture(name: string) {
  const scope = new ProviderScope();
  scopes.push(scope);
  const active = new Set<string>();
  const runtime = {
    getAllTools: () => [],
    getActiveTools: () => [...active],
    setActiveTools: (names: readonly string[]) => {
      active.clear();
      for (const tool of names) active.add(tool);
    },
  };
  const service = new ToolSearchService(runtime);
  const document = {
    name,
    label: name,
    aliases: [],
    keywords: [],
    source: "mcp" as const,
    group: "fixture",
    ownerLabel: "fixture",
    registrationId: name,
  };
  return { scope, active, runtime, service, document };
}

test("MCP feed reaches search across provider-bound async callbacks", async () => {
  const owner = fixture("mcp_fixture_project");
  await runWithProviderScope(owner.scope, async () => {
    await Promise.resolve().then(() => installScopedToolSearchService(owner.service));
    await Promise.resolve().then(() => {
      getToolSearchService(owner.runtime).feed("mcp", [owner.document], {
        activate: (names) => {
          for (const name of names) owner.active.add(name);
        },
      });
    });
    expect(owner.service.search(owner.document.name).map((match) => match.name)).toEqual([
      owner.document.name,
    ]);
    expect(owner.service.activateTool(owner.document.name)).toBe(true);
    expect(owner.active.has(owner.document.name)).toBe(true);
  });
});

test("concurrent provider scopes keep MCP catalogs and activation separate", async () => {
  const owners = [fixture("mcp_alpha_private"), fixture("mcp_beta_private")];
  await Promise.all(
    owners.map((owner) =>
      runWithProviderScope(owner.scope, async () => {
        await Promise.resolve().then(() => installScopedToolSearchService(owner.service));
        getToolSearchService(owner.runtime).feed("mcp", [owner.document], {
          activate: (names) => {
            for (const name of names) owner.active.add(name);
          },
        });
      }),
    ),
  );
  for (const owner of owners) {
    runWithProviderScope(owner.scope, () => {
      const current = getToolSearchService();
      expect(current.getCatalog().map((document) => document.name)).toEqual([owner.document.name]);
      for (const other of owners.filter((candidate) => candidate !== owner)) {
        expect(current.activateTool(other.document.name)).toBe(false);
        expect(owner.active.has(other.document.name)).toBe(false);
      }
    });
  }
});

test("reload replaces only its provider-owned catalog", async () => {
  const owner = fixture("mcp_old_generation");
  const replacement = new ToolSearchService(owner.runtime);
  await runWithProviderScope(owner.scope, async () => {
    await Promise.resolve().then(() => installScopedToolSearchService(owner.service));
    await Promise.resolve().then(() => installScopedToolSearchService(replacement));
    getToolSearchService(owner.runtime).feed("mcp", [owner.document], { activate: () => {} });
    expect(replacement.getCatalog().map((document) => document.name)).toEqual([
      owner.document.name,
    ]);
    expect(owner.service.getCatalog()).toEqual([]);
  });
});

test("a new provider scope cannot borrow the classic session catalog", () => {
  const classic = fixture("mcp_classic_private");
  getToolSearchService(classic.runtime).feed("mcp", [classic.document], { activate: () => {} });
  const owner = fixture("mcp_scoped_private");
  runWithProviderScope(owner.scope, () => {
    expect(getToolSearchService(owner.runtime).getCatalog()).toEqual([]);
  });
  expect(
    getToolSearchService()
      .getCatalog()
      .map((document) => document.name),
  ).toEqual([classic.document.name]);
});
