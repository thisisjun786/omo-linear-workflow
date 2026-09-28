import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding } from "../src/core/contracts";
import { processStarttime, proveTuiConnection, publishReadiness } from "../src/readiness";

const root = await mkdtemp(join(tmpdir(), "olw-handoff-proof-"));
const socket = join(root, "omo.sock");
const sessionPath = join(root, "s.jsonl");
const omo = join(process.cwd(), "node_modules/.bin/omo");
const env = { ...process.env, SENPI_AGENT_DIR: join(root, "agent"), OMO_NATIVE: "1" };

async function run(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([omo, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`omo ${args.join(" ")} exited ${code}: ${stderr.slice(-400)}`);
  return stdout;
}

const binding: Binding = {
  id: "qa",
  designationId: "qa-designation",
  assignment: { role: "supervisor", initiativeId: "qa-initiative" },
  durableSessionId: "qa-session",
  cwd: root,
  checkout: null,
  herdrSocket: "/qa-herdr.sock",
  omoSocket: socket,
  workspaceId: "w",
  paneId: "w:p",
  sessionPath,
  launchState: "provisioning",
  initialization: { state: "pending", text: null },
  contactState: "active",
};

let generation: number | undefined;
let kernelListenerNames: string[] = [];
let proofWithRealClient: boolean | undefined;
let proofAfterDisconnect: boolean | undefined;
let stopError: string | undefined;
let client: RpcClient | undefined;
try {
  await run(["host", "ensure", "--socket", socket, "--json"]);
  generation = z
    .object({ generation: z.number() })
    .parse(JSON.parse(await run(["host", "handoff", "--socket", socket, "--json"]))).generation;
  const listing = Bun.spawn(["ss", "-xHlnp"], { stdout: "pipe" });
  kernelListenerNames = (await new Response(listing.stdout).text())
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => line.trim().split(/\s+/)[4] ?? "");
  client = new RpcClient({ socketPath: socket });
  await client.start();
  const opened = await client.openSession({ sessionPath, cwd: root });
  await publishReadiness(root, {
    bindingId: binding.id,
    durableSessionId: binding.durableSessionId,
    sessionPath,
    cwd: root,
    paneId: "w:p",
    launch: { nonce: "qa", pid: process.pid, starttime: await processStarttime(process.pid) },
  });
  proofWithRealClient = await proveTuiConnection(root, binding, "qa", async () => true);
  await client.closeSession(opened.sessionId);
  await client.stop();
  client = undefined;
  proofAfterDisconnect = await proveTuiConnection(root, binding, "qa", async () => true);
} finally {
  await client?.stop();
  await run(["host", "stop", "--socket", socket]).catch((cause: unknown) => {
    stopError = String(cause).slice(0, 200);
  });
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    root,
    generation,
    kernelListenerNames,
    proofWithRealClient,
    proofAfterDisconnect,
    stopError,
    rootRemoved: !(await Bun.file(root).exists()),
  }),
);
const passed =
  proofWithRealClient === true &&
  proofAfterDisconnect === false &&
  stopError === undefined &&
  !(await Bun.file(root).exists());
console.log(passed ? "QA_PASS" : "QA_FAIL");
process.exit(passed ? 0 : 1);
