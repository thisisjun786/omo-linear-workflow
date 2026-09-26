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

test("malformed update tags are rejected before check or state writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-update-tag-"));
  roots.push(root);
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const check = spyOn(Orchestrator.prototype, "updateCheck").mockResolvedValue({
    ok: true,
    value: {
      checkedAt: "now",
      state: "current",
      packages: {
        "omo-ai": { state: "current", pinned: "1.0.0", available: "1.0.0", tag: "beta" },
        "@code-yeongyu/senpi": {
          state: "current",
          pinned: "1.0.0",
          available: "1.0.0",
          tag: "latest",
        },
      },
      globalOmo: null,
    },
  });
  try {
    for (const value of ["omo-ai==beta", "omo-ai=white space", "unknown=beta", "omo-ai="]) {
      const [name, ...rest] = value.split("=");
      const argv = [
        "--root",
        root,
        "update",
        "check",
        "--tag",
        `${name}=${rest.join("=")}`,
        "--json",
      ];
      expect(await runCli(argv)).toBe(2);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }
    expect(check).not.toHaveBeenCalled();
    expect(Bun.file(join(root, ".omo/state/update-check.json")).size).toBe(0);
  } finally {
    check.mockRestore();
    stdout.mockRestore();
  }
});
