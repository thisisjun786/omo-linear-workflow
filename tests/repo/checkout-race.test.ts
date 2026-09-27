import { afterEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout } from "../../src/core/contracts";
import { initializeCheckout } from "../../src/repo/checkout";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(target: string) {
  const root = await mkdtemp(join(tmpdir(), "olw-checkout-race-"));
  roots.push(root);
  const checkoutPath = join(root, "checkout");
  const outside = join(root, "outside");
  const source = join(root, "source-fifo");
  const receiptPath = join(root, "receipt.json");
  const remote = "file:///fixture";
  await mkdir(join(checkoutPath, "a", ...(target.includes("/b/") ? ["b"] : [])), {
    recursive: true,
  });
  await mkdir(outside);
  await mkdir(join(root, ".omo/repos"), { recursive: true });
  await writeFile(
    join(root, ".omo/repos/config.json"),
    JSON.stringify({ [remote]: { localFiles: [{ source, target }] } }),
  );
  const fifo = Bun.spawnSync(["mkfifo", source]);
  if (fifo.exitCode !== 0) throw new Error(fifo.stderr.toString());
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
  return { root, checkoutPath, outside, source, receiptPath, checkout };
}

test.each(["a/secret", "a/b/secret"])(
  "directory handles contain a local-file copy while %s is swapped",
  async (target) => {
    const w = await fixture(target);
    const deadline = AbortSignal.timeout(5_000);
    const writerReady = open(w.source, constants.O_WRONLY, 0o600);
    const initialized = initializeCheckout(w.root, w.checkout);
    const writer = await Promise.race([
      writerReady,
      new Promise<never>((_, reject) =>
        deadline.addEventListener("abort", () => reject(new Error("FIFO writer deadline")), {
          once: true,
        }),
      ),
    ]);
    await rename(join(w.checkoutPath, "a"), join(w.checkoutPath, "a-saved"));
    await symlink(w.outside, join(w.checkoutPath, "a"));
    await writer.writeFile("RACE_FIXTURE_PRIVATE_BYTES");
    await writer.close();
    await expect(initialized).rejects.toMatchObject({ code: "local_file_target_unsafe" });
    expect(await Bun.file(join(w.outside, "secret")).exists()).toBe(false);
    expect(await Bun.file(join(w.outside, "b")).exists()).toBe(false);
    expect(JSON.parse(await readFile(w.receiptPath, "utf8"))).toMatchObject({ copies: [] });
  },
);
