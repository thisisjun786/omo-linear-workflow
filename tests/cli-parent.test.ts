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
async function invoke(args: string[]) {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-parent-"));
  roots.push(root);
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      join(import.meta.dir, "../src/cli.ts"),
      "--root",
      root,
      ...args,
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  return { code, output: JSON.parse(stdout) as unknown, root };
}

test.each(
  [
    ["parent", "create", "--project", "p", "--repo", "/fixture", "--base", "main"],
    [
      "parent",
      "create",
      "--project",
      "p",
      "--repo",
      "/fixture",
      "--base",
      "main",
      "--supervisor",
      "s",
      "--scope-digest",
      "digest",
      "--designation",
      "d",
      "--execute",
    ],
    [
      "parent",
      "create",
      "--project",
      "p",
      "--repo",
      "/fixture",
      "--base",
      "main",
      "--supervisor",
      "s",
      "--fixture",
    ],
    ["parent", "link", "--parent", "p"],
    ["status", "--project", "p", "--initiative", "i"],
    ["reports", "--project", "p", "--initiative", "i"],
    ["notices", "--project", "p", "--initiative", "i"],
    ["reconcile"],
  ].map((args) => ({ args })),
)("rejects incomplete or ambiguous arguments: %j", async ({ args }) => {
  const result = await invoke(args);
  expect(result).toMatchObject({
    code: 2,
    output: { ok: false, error: { code: "invalid_arguments" } },
  });
  expect(await Bun.file(join(result.root, ".omo/state/registry.sqlite")).exists()).toBe(false);
});

test("standalone CLI refuses missing execution approval before opening state", async () => {
  const result = await invoke([
    "parent",
    "create",
    "--project",
    "p",
    "--repo",
    "/fixture",
    "--base",
    "main",
    "--scope-digest",
    "digest",
    "--designation",
    "d",
  ]);
  expect(result).toMatchObject({
    code: 2,
    output: { ok: false, error: { code: "execute_denied" } },
  });
  expect(await Bun.file(join(result.root, ".omo/state/registry.sqlite")).exists()).toBe(false);
});

test.each(["reports", "notices"] as const)(
  "%s is read-only even when no registry exists",
  async (command) => {
    const result = await invoke([command, "--project", "p"]);
    expect(result).toMatchObject({ code: 0, output: { ok: true, value: [] } });
    expect(await Bun.file(join(result.root, ".omo/state/registry.sqlite")).exists()).toBe(false);
  },
);

test("standalone CLI forwards explicit approval without adding a supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-parent-"));
  roots.push(root);
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const create = spyOn(Orchestrator.prototype, "createParent").mockResolvedValue({
    ok: false,
    error: { code: "fixture_stop", message: "No real roles" },
  });
  try {
    expect(
      await runCli([
        "--root",
        root,
        "parent",
        "create",
        "--project",
        "p",
        "--repo",
        "/fixture",
        "--base",
        "main",
        "--scope-digest",
        "digest",
        "--designation",
        "d",
        "--execute",
        "--fixture",
        "--json",
      ]),
    ).toBe(2);
    expect(create).toHaveBeenCalledWith({
      projectId: "p",
      repo: "/fixture",
      base: "main",
      scopeDigest: "digest",
      designationId: "d",
      execute: true,
      fixture: true,
    });
    expect(await Bun.file(join(root, ".omo/state/registry.sqlite")).exists()).toBe(false);
  } finally {
    create.mockRestore();
    stdout.mockRestore();
  }
});
