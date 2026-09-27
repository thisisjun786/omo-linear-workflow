import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeSnapshotSchema } from "../src/core/schema";
import { ensureMirror } from "../src/repo/mirror";
import { type PrepareRunner, prepareUpdate } from "../src/update/prepare";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function updateFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olw-git-boundary-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "omo-ai": "5.0.0", "@code-yeongyu/senpi": "2026.9.26" } }),
  );
  await writeFile(
    join(root, ".omo/state/update-check.json"),
    JSON.stringify({
      packages: {
        "omo-ai": { state: "update_available", pinned: "5.0.0", available: "5.0.1" },
        "@code-yeongyu/senpi": {
          state: "current",
          pinned: "2026.9.26",
          available: "2026.9.26",
        },
      },
    }),
  );
  return root;
}

test("mirror clone places -- before the remote and destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-mirror-argv-"));
  roots.push(root);
  const bin = join(root, "bin");
  const argv = join(root, "git-argv");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nexit 17\n`, {
    mode: 0o700,
  });
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  try {
    await expect(ensureMirror(root, "https://example.test/repo.git")).rejects.toMatchObject({
      code: "mirror_clone_failed",
    });
  } finally {
    process.env["PATH"] = previous;
  }
  expect((await readFile(argv, "utf8")).trim().split("\n").slice(4, 9)).toEqual([
    "clone",
    "--mirror",
    "--",
    "https://example.test/repo.git",
    expect.stringContaining("/.omo/repos/.tmp/"),
  ]);
});

test("option-like remotes are rejected at scope and mirror runtime boundaries", async () => {
  const scope = scopeSnapshotSchema.safeParse({
    version: 1,
    source: "fixture",
    initiative: null,
    projects: [
      {
        project: { id: "project", url: "linear://project", revision: "r1" },
        issues: [],
        repository: { remote: "--upload-pack=evil", defaultBranch: "main" },
      },
    ],
    decisionRefs: [],
  });
  expect(scope.success).toBe(false);
  if (!scope.success)
    expect(scope.error.issues[0]?.message).toBe("Repository remote must not start with '-'");

  const root = await mkdtemp(join(tmpdir(), "olw-mirror-option-"));
  roots.push(root);
  await expect(ensureMirror(root, "--upload-pack=evil")).rejects.toMatchObject({
    code: "invalid_remote",
    message: "Remote must not start with '-'",
  });
});

test("update prepare rejects option-like remotes before lock or command side effects", async () => {
  const root = await updateFixture();
  const calls: string[][] = [];
  const run: PrepareRunner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await prepareUpdate(root, { run, remote: "--upload-pack=evil" })).toEqual({
    ok: false,
    error: { code: "invalid_input", message: "Git remote must not start with '-'" },
  });
  expect(calls).toEqual([]);
  expect(await Bun.file(join(root, ".omo/state/update.lock")).exists()).toBe(false);
});
