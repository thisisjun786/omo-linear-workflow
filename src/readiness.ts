import { watch } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Binding } from "./core/contracts";
import { TuiAttachmentUnverifiedError } from "./transport/client";

const readinessSchema = z.strictObject({
  bindingId: z.string().min(1),
  durableSessionId: z.string().min(1),
  sessionPath: z.string().min(1),
  cwd: z.string().min(1),
  paneId: z.string().min(1),
  launch: z
    .object({
      nonce: z.string().min(1),
      pid: z.number().int().positive(),
      starttime: z.string().regex(/^\d+$/),
    })
    .optional(),
});
export type Readiness = z.infer<typeof readinessSchema>;

export async function processStarttime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return z
    .string()
    .regex(/^\d+$/)
    .parse(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]);
}

export async function proveTuiConnection(
  root: string,
  binding: Binding,
  nonce: string,
  containsPid: (pid: number) => Promise<boolean>,
  sockets: () => Promise<string> = async () => {
    const child = Bun.spawn(["ss", "-xHnp", "state", "connected"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const [text, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`Unix socket observation failed: ${stderr}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  },
): Promise<boolean> {
  try {
    const receipt = await readReadiness(root, binding);
    if (receipt?.launch?.nonce !== nonce) throw new TuiAttachmentUnverifiedError();
    if (receipt.sessionPath !== binding.sessionPath) throw new TuiAttachmentUnverifiedError();
    const launch = receipt.launch;
    if (
      (await processStarttime(launch.pid)) !== launch.starttime ||
      !(await containsPid(launch.pid))
    )
      throw new TuiAttachmentUnverifiedError();
    const rows = (await sockets())
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^u_str\s+ESTAB\s+\d+\s+\d+\s+(.+?)\s+(\d+)\s+(.+?)\s+(\d+)\s*(.*)$/.exec(
          line,
        );
        if (match === null) {
          if (line.startsWith("u_str")) throw new TuiAttachmentUnverifiedError();
          return undefined;
        }
        return { path: match[1], inode: match[2], peer: match[4], owners: match[5] ?? "" };
      })
      .filter((row) => row !== undefined);
    const hostPeers = new Set(
      rows.filter((row) => row.path === binding.omoSocket).map((row) => row.inode),
    );
    if (rows.some((row) => hostPeers.has(row.peer) && !row.owners.includes("pid=")))
      throw new TuiAttachmentUnverifiedError();
    if ((await processStarttime(launch.pid)) !== launch.starttime)
      throw new TuiAttachmentUnverifiedError();
    return rows.some((row) => hostPeers.has(row.peer) && row.owners.includes(`pid=${launch.pid},`));
  } catch {
    throw new TuiAttachmentUnverifiedError();
  }
}

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
