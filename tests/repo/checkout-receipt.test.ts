import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout } from "../../src/core/contracts";
import { initializeCheckout } from "../../src/repo/checkout";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("checkout receipts use a non-reversible source label", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-checkout-receipt-"));
  roots.push(root);
  const checkoutPath = join(root, "checkout");
  const receiptPath = join(root, "receipt.json");
  const source = join(root, "private", "project.env");
  const remote = "file:///fixture";
  await mkdir(join(root, ".omo/repos"), { recursive: true });
  await mkdir(join(source, ".."), { recursive: true });
  await mkdir(checkoutPath);
  await writeFile(source, "PRIVATE_FIXTURE_BYTES");
  await writeFile(
    join(root, ".omo/repos/config.json"),
    JSON.stringify({ [remote]: { localFiles: [{ source, target: ".env" }] } }),
  );
  const checkout: Checkout = {
    kind: "owned-clone",
    remote,
    receiptPath,
    originalRepoRoot: checkoutPath,
    path: checkoutPath,
    branch: "fixture",
    baseBranch: "main",
    baseCommit: "fixture",
  };
  await initializeCheckout(root, checkout);
  const raw = await readFile(receiptPath, "utf8");
  expect(raw).not.toContain(source);
  expect(JSON.parse(raw).copies).toEqual([
    { sourceLabel: "project.env", target: ".env", mode: "0600" },
  ]);
});
