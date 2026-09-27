import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout } from "../../src/core/contracts";
import { initializeCheckout } from "../../src/repo/checkout";
import { copyIntoCheckout } from "../../src/repo/checkout-fd";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(source: string, target: string) {
  const root = await mkdtemp(join(tmpdir(), "olw-checkout-boundary-"));
  roots.push(root);
  const checkoutPath = join(root, "checkout");
  const receiptPath = join(root, "receipt.json");
  const remote = "file:///fixture";
  await mkdir(checkoutPath);
  await mkdir(join(root, "outside"));
  await mkdir(join(root, ".omo/repos"), { recursive: true });
  await writeFile(
    join(root, ".omo/repos/config.json"),
    JSON.stringify({ [remote]: { localFiles: [{ source, target }] } }),
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
  return { root, checkoutPath, receiptPath, checkout };
}

test.each([
  ["target NUL", "source", `..\0/outside/secret`],
  ["target control", "source", "nested/secret\u001f"],
  ["source NUL", `source\0suffix`, "secret"],
  ["source control", "source\u001f", "secret"],
])("rejects %s in local-file configuration", async (_label, sourceName, target) => {
  const root = await mkdtemp(join(tmpdir(), "olw-checkout-config-"));
  roots.push(root);
  const source = join(root, sourceName);
  if (!source.includes("\0")) await writeFile(source.replace("\u001f", ""), "fixture");
  const w = await fixture(source, target.replace("\\u001f", "\u001f"));
  await expect(initializeCheckout(w.root, w.checkout)).rejects.toBeDefined();
  expect(await Bun.file(join(w.root, "outside", "secret")).exists()).toBe(false);
  if (await Bun.file(w.receiptPath).exists())
    expect(JSON.parse(await readFile(w.receiptPath, "utf8"))).toMatchObject({ copies: [] });
});

test("the FFI boundary rejects embedded NUL before encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-checkout-ffi-nul-"));
  roots.push(root);
  await mkdir(join(root, "checkout"));
  await expect(
    copyIntoCheckout(join(root, "checkout"), `..\0/secret`, new Uint8Array([1])),
  ).rejects.toMatchObject({
    code: "local_file_target_unsafe",
  });
});

test("a directory close failure is typed and each descriptor is closed once", async () => {
  const calls: number[] = [];
  const operations = {
    open: (_path: Uint8Array, _flags: number, _mode: number) => 10,
    openat: () => 11,
    mkdirat: () => 0,
    renameat: () => 0,
    unlinkat: () => 0,
    close: (fd: number) => {
      calls.push(fd);
      return fd === 10 ? -1 : 0;
    },
    errno: () => 5,
  };
  await expect(
    copyIntoCheckout("/fixture", "secret", new Uint8Array([1]), {
      operations,
      write: async () => 1,
    }),
  ).rejects.toMatchObject({
    code: "local_file_target_unsafe",
    details: { cleanup: [{ operation: "directory close", errno: 5 }] },
  });
  expect(calls).toEqual([11, 10]);
});

test("cleanup closes each descriptor once and surfaces close and unlink failures", async () => {
  const calls: number[] = [];
  let closeFailure = true;
  let unlinkCalls = 0;
  const operations = {
    open: (_path: Uint8Array, _flags: number, _mode: number) => 10,
    openat: (_fd: number, path: Uint8Array) =>
      new TextDecoder().decode(path).startsWith(".secret.olw-") ? 11 : 12,
    mkdirat: () => 0,
    renameat: () => -1,
    unlinkat: () => {
      unlinkCalls += 1;
      return -1;
    },
    close: (fd: number) => {
      calls.push(fd);
      if (fd === 11 && closeFailure) {
        closeFailure = false;
        return -1;
      }
      return 0;
    },
    errno: () => 5,
  };
  await expect(
    copyIntoCheckout("/fixture", "secret", new Uint8Array([1]), {
      operations,
      write: async () => 1,
    }),
  ).rejects.toMatchObject({
    code: "local_file_target_unsafe",
    details: expect.objectContaining({ cleanup: expect.any(Array) }),
  });
  expect(calls.filter((fd) => fd === 11)).toHaveLength(1);
  expect(calls.filter((fd) => fd === 10)).toHaveLength(1);
  expect(unlinkCalls).toBe(1);
});
