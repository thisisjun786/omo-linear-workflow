import { watch } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Binding } from "./core/contracts";

const readinessSchema = z.strictObject({
  bindingId: z.string().min(1),
  durableSessionId: z.string().min(1),
  sessionPath: z.string().min(1),
  cwd: z.string().min(1),
  paneId: z.string().min(1),
});
export type Readiness = z.infer<typeof readinessSchema>;

function receiptPath(root: string, bindingId: string): string {
  return join(root, ".omo/state/ready", `${encodeURIComponent(bindingId)}.json`);
}

export async function publishReadiness(root: string, receipt: Readiness): Promise<void> {
  const valid = readinessSchema.parse(receipt);
  const path = receiptPath(root, valid.bindingId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(valid)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeReadiness(root: string, bindingId: string): Promise<void> {
  await rm(receiptPath(root, bindingId), { force: true });
}

export async function readReadiness(root: string, binding: Binding): Promise<Readiness | null> {
  let text: string;
  try {
    text = await readFile(receiptPath(root, binding.id), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
  const receipt = readinessSchema.parse(JSON.parse(text));
  if (
    receipt.bindingId !== binding.id ||
    receipt.durableSessionId !== binding.durableSessionId ||
    receipt.cwd !== binding.cwd ||
    receipt.paneId !== binding.paneId
  ) {
    throw new Error("TUI readiness identity does not match the reserved binding");
  }
  return receipt;
}

export async function subscribeReadiness(
  root: string,
  binding: Binding,
): Promise<{ readonly promise: Promise<Readiness>; close(): void }> {
  const path = receiptPath(root, binding.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const ready = Promise.withResolvers<Readiness>();
  let settled = false;
  const watcher = watch(dirname(path), (_event, name) => {
    if (name === null || name.toString() === basename(path)) void inspect();
  });
  const fail = (cause: unknown) => {
    if (settled) return;
    settled = true;
    watcher.close();
    ready.reject(cause);
  };
  async function inspect(): Promise<void> {
    if (settled) return;
    try {
      const receipt = await readReadiness(root, binding);
      if (receipt === null || settled) return;
      settled = true;
      watcher.close();
      ready.resolve(receipt);
    } catch (cause) {
      fail(cause);
    }
  }
  watcher.on("error", fail);
  await inspect();
  return {
    promise: ready.promise,
    close() {
      settled = true;
      watcher.close();
    },
  };
}
