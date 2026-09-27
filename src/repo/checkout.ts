import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Checkout } from "../core/contracts";
import { CheckoutPathError, copyIntoCheckout } from "./checkout-fd";
import { mirrorPath } from "./mirror";

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
const localFileSchema = z.strictObject({
  source: z
    .string()
    .refine(isAbsolute, "Source must be absolute")
    .refine((path) => !hasControlCharacter(path), "Source must not contain control characters"),
  target: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !isAbsolute(path) &&
        !hasControlCharacter(path) &&
        path
          .split(/[\\/]/)
          .every((part) => part !== ".." && part !== "." && part !== ".git" && part !== ""),
      "Target must be a checkout-relative file outside .git",
    ),
});
const repositoryConfigSchema = z.record(
  z.string().min(1),
  z.strictObject({
    localFiles: z.array(localFileSchema).default([]),
    setup: z.array(z.string().min(1)).default([]),
    setupTimeoutMs: z.number().int().min(1).max(600_000).default(120_000),
  }),
);

export async function checkoutGit(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Checkout git failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

export function ownedCheckoutPath(
  root: string,
  remote: string,
  projectKey: string,
  bindingId: string,
): string {
  const label = (text: string) =>
    text
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 80) || "repository";
  const repo = basename(new URL(remote).pathname).replace(/\.git$/, "");
  return join(
    root,
    ".omo/checkouts",
    `${label(repo)}-${label(projectKey)}-${bindingId.slice(0, 12)}`,
  );
}

export async function cloneCheckout(root: string, checkout: Checkout): Promise<void> {
  if (checkout.remote === undefined) throw new Error("Owned clone requires a remote");
  await mkdir(dirname(checkout.path), { recursive: true });
  // A local path (not file://), without --shared: hardlinks remain valid when the mirror is pruned.
  await checkoutGit(root, [
    "clone",
    "--no-checkout",
    "--",
    mirrorPath(root, checkout.remote),
    checkout.path,
  ]);
  await checkoutGit(checkout.path, ["remote", "set-url", "origin", checkout.remote]);
  await checkoutGit(checkout.path, ["checkout", "-b", checkout.branch, checkout.baseCommit]);
}

export { CheckoutPathError as CheckoutInitializationError } from "./checkout-fd";

interface CheckoutReceipt {
  readonly checkout: string;
  readonly copies: Array<{ sourceLabel: string; target: string; mode: "0600" }>;
  readonly setup: Array<{ index: number; code: number; timedOut: boolean; log: string }>;
}

/** Only explicit config sources are read. Receipt and setup logs live outside the checkout. */
export async function initializeCheckout(root: string, checkout: Checkout): Promise<void> {
  if (checkout.remote === undefined || checkout.receiptPath === undefined) return;
  const configPath = join(root, ".omo/repos/config.json");
  let config: z.infer<typeof repositoryConfigSchema> = {};
  try {
    config = repositoryConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const entry = config[checkout.remote];
  const receipt: CheckoutReceipt = { checkout: checkout.path, copies: [], setup: [] };
  await mkdir(dirname(checkout.receiptPath), { recursive: true, mode: 0o700 });
  const save = () =>
    writeFile(checkout.receiptPath ?? "", `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await save();
  const secrets: string[] = [];
  await mkdir(checkout.path, { recursive: true });
  for (const file of entry?.localFiles ?? []) {
    const contents = await readFile(file.source);
    const text = contents.toString("utf8");
    secrets.push(text, ...text.split(/\r?\n/).filter(Boolean));
    try {
      await copyIntoCheckout(checkout.path, file.target, contents);
    } catch (cause) {
      throw cause instanceof CheckoutPathError
        ? cause
        : new CheckoutPathError("Secure local-file copy failed", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
    }
    receipt.copies.push({ sourceLabel: basename(file.source), target: file.target, mode: "0600" });
    await save();
  }
  const redact = (text: string) =>
    secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .reduce((out, secret) => out.replaceAll(secret, "[REDACTED]"), text);
  for (const [index, command] of (entry?.setup ?? []).entries()) {
    let timedOut = false;
    // A separate process group lets the deadline terminate the command and its descendants.
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: checkout.path,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    }, entry?.setupTimeoutMs ?? 120_000);
    let code: number;
    let stdout: string;
    let stderr: string;
    try {
      [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const log = `${checkout.receiptPath}.setup-${index}.log`;
    await writeFile(log, redact(`${stdout}\n${stderr}`), { mode: 0o600 });
    receipt.setup.push({ index, code, timedOut, log });
    await save();
    if (code !== 0 || timedOut)
      throw new Error(
        `Checkout setup ${index} failed; inspect private receipt ${checkout.receiptPath}`,
      );
  }
}

export async function unpushedCommits(checkout: Checkout, childOnly = false): Promise<string[]> {
  const output = await checkoutGit(checkout.path, [
    "rev-list",
    childOnly ? `refs/heads/${checkout.branch}` : "--branches",
    "--not",
    "--remotes",
  ]);
  return output === "" ? [] : output.split("\n");
}
