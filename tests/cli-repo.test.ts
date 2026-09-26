import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function invoke(root: string, args: string[]): Promise<{ code: number; output: unknown }> {
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    return { code: await runCli(["--root", root, ...args, "--json"]), output: JSON.parse(output) };
  } finally {
    stdout.mockRestore();
  }
}

test("repo list is read-only and help describes repository commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-repo-"));
  roots.push(root);
  expect(await invoke(root, ["repo", "list"])).toEqual({
    code: 0,
    output: { ok: true, value: [] },
  });
  expect(await Bun.file(join(root, ".omo/repos")).exists()).toBe(false);
  expect((await invoke(root, ["help"])).output).toMatchObject({
    ok: true,
    value: {
      commands: expect.arrayContaining(["repo list", "repo fetch"]),
      options: { "repo list": "[--json]", "repo fetch": "--remote URL [--json]" },
    },
  });
});

test("repo fetch rejects a credential URL through a typed CLI error", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-repo-"));
  roots.push(root);
  const result = await invoke(root, [
    "repo",
    "fetch",
    "--remote",
    "https://user:password@example.test/repo.git",
  ]);
  expect(result).toMatchObject({
    code: 2,
    output: { ok: false, error: { code: "invalid_remote" } },
  });
  expect(JSON.stringify(result)).not.toContain("password");
});
