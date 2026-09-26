import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { Orchestrator } from "../src/orchestrator";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("update check CLI accepts repeated package tags and documents the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-update-cli-"));
  roots.push(root);
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const updateCheck = spyOn(Orchestrator.prototype, "updateCheck").mockResolvedValue({
    ok: true,
    value: {
      checkedAt: "now",
      state: "current",
      packages: {
        "omo-ai": { state: "current", pinned: "1", available: "1", tag: "next" },
        "@code-yeongyu/senpi": { state: "current", pinned: "1", available: "1", tag: "beta" },
      },
      globalOmo: "1",
    },
  });
  try {
    expect(
      await runCli([
        "--root",
        root,
        "update",
        "check",
        "--tag",
        "omo-ai=next",
        "--tag",
        "@code-yeongyu/senpi=beta",
        "--json",
      ]),
    ).toBe(0);
    expect(updateCheck).toHaveBeenCalledWith({ "omo-ai": "next", "@code-yeongyu/senpi": "beta" });
    expect(await runCli(["--help", "--json"])).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain("update check");
  } finally {
    updateCheck.mockRestore();
    stdout.mockRestore();
  }
});
