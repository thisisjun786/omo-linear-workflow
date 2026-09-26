import { describe, expect, test } from "bun:test";
import { interactiveLaunch, type LaunchDependencies } from "../../src/proxy/interactive-launch";

function deps(overrides: Partial<LaunchDependencies> = {}) {
  const warnings: string[] = [];
  const calls: string[] = [];
  const value: LaunchDependencies = {
    upstream: () => "/bin/omo",
    ensureRouting: async () => {
      calls.push("routing");
    },
    scopeArguments: async () => ["--models", "a"],
    routingAdopted: async () => true,
    warn: (line) => warnings.push(line),
    ...overrides,
  };
  return { value, warnings, calls };
}

describe("interactive OMO launch", () => {
  test("a healthy preflight launches with the catalog extension and scope", async () => {
    const d = deps();
    expect(await interactiveLaunch("/olw", "/home", ["chat"], d.value)).toEqual([
      "/bin/omo",
      "-e",
      "/olw/dist/extension/model-catalog.js",
      "--models",
      "a",
      "chat",
    ]);
    expect(d.calls).toEqual(["routing"]);
    expect(d.warnings).toEqual([]);
  });

  test("a failed routing preflight still starts OMO and says why", async () => {
    const d = deps({
      ensureRouting: async () => {
        throw new Error("Upstream routing check failed (1); previous settings were retained");
      },
    });
    const command = await interactiveLaunch("/olw", "/home", [], d.value);
    expect(command[0]).toBe("/bin/omo");
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain("starting OMO with the previous routing");
  });

  test("without adopted routing a failed preflight stops the launch", async () => {
    const d = deps({
      ensureRouting: async () => {
        throw new Error("Routing tracking is not initialized");
      },
      routingAdopted: async () => false,
    });
    await expect(interactiveLaunch("/olw", "/home", [], d.value)).rejects.toThrow(
      /not initialized/,
    );
    expect(d.warnings).toEqual([]);
  });

  test("an unreadable model scope keeps the restriction by stopping the launch", async () => {
    const d = deps({
      scopeArguments: async () => {
        throw new SyntaxError("bad json");
      },
    });
    await expect(interactiveLaunch("/olw", "/home", [], d.value)).rejects.toThrow(/bad json/);
  });

  test("inspection and maintenance commands skip preflight entirely", async () => {
    const d = deps();
    expect(await interactiveLaunch("/olw", "/home", ["--version"], d.value)).toEqual([
      "/bin/omo",
      "--version",
    ]);
    expect(await interactiveLaunch("/olw", "/home", ["update"], d.value)).toEqual([
      "/bin/omo",
      "update",
    ]);
    expect(d.calls).toEqual([]);
  });

  test("a missing upstream executable stops the launch", async () => {
    const d = deps({
      upstream: () => {
        throw new Error("Global OMO executable is unavailable outside the managed wrapper");
      },
    });
    await expect(interactiveLaunch("/olw", "/home", [], d.value)).rejects.toThrow(/unavailable/);
  });
});
