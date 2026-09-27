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

test("update prepare CLI forwards the remote and documents the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-update-cli-"));
  roots.push(root);
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const prepare = spyOn(Orchestrator.prototype, "updatePrepare").mockResolvedValue({
    ok: true,
    value: { action: "exists", branch: "olw/update-omo-1-senpi-2", pr: null },
  });
  try {
    expect(
      await runCli(["--root", root, "update", "prepare", "--remote", "/tmp/bare.git", "--json"]),
    ).toBe(0);
    expect(prepare).toHaveBeenCalledWith({ remote: "/tmp/bare.git" });
    expect(await runCli(["--help", "--json"])).toBe(0);
    const help = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(help.value.commands).toContain("update prepare");
    expect(help.value.options["update prepare"]).toContain("--remote");
  } finally {
    prepare.mockRestore();
    stdout.mockRestore();
  }
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
