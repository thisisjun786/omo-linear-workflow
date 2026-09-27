import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PrepareRunner, prepareUpdate } from "../src/update/prepare";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(input: {
  readonly current: string;
  readonly pinned: string;
  readonly available: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olw-update-stale-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { "omo-ai": input.current, "@code-yeongyu/senpi": "2026.9.26" },
    }),
  );
  await writeFile(
    join(root, ".omo/state/update-check.json"),
    JSON.stringify({
      packages: {
        "omo-ai": {
          state: "update_available",
          pinned: input.pinned,
          available: input.available,
        },
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

const unusedRunner: PrepareRunner = async () => {
  throw new Error("stale or non-upgrade receipts must be rejected before commands run");
};

test("prepare rejects a check receipt whose pin differs from the current manifest", async () => {
  const root = await fixture({
    current: "5.0.0",
    pinned: "5.0.0-0.beta.90",
    available: "5.0.1",
  });
  expect(await prepareUpdate(root, { run: unusedRunner })).toEqual({
    ok: false,
    error: {
      code: "update_check_stale",
      message: "The update check is stale for omo-ai; rerun olw update check",
      details: { package: "omo-ai", checked: "5.0.0-0.beta.90", current: "5.0.0" },
    },
  });
});

test("prepare refuses an available version that is not strictly newer than the current pin", async () => {
  const root = await fixture({ current: "5.0.0", pinned: "5.0.0", available: "4.9.9" });
  expect(await prepareUpdate(root, { run: unusedRunner })).toEqual({
    ok: false,
    error: {
      code: "update_not_newer",
      message: "Refusing to replace omo-ai 5.0.0 with non-newer version 4.9.9",
    },
  });
});
