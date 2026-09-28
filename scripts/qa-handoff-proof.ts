import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@code-yeongyu/senpi";
import { processStarttime, proveTuiConnection, publishReadiness } from "../src/readiness";

const root = await mkdtemp(join(tmpdir(), "olw-handoff-proof-"));
const sock = join(root, "omo.sock");
const senpi = join(process.cwd(), "node_modules/.bin/omo");
const env = { ...process.env, SENPI_AGENT_DIR: join(root, "agent"), OMO_NATIVE: "1" };
const run = async (args: string[]) => {
  const p = Bun.spawn([senpi, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [o, e, c] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (c !== 0) throw new Error(`${args.join(" ")} -> ${c}: ${e.slice(-400)}`);
  return o;
};
const result: Record<string, unknown> = { root };
let client: RpcClient | undefined;
try {
  await run(["host", "ensure", "--socket", sock, "--json"]);
  const handed = JSON.parse(
    await run(["host", "handoff", "--socket", sock, "--json"]).catch(async () =>
      run(["host", "handoff", "--socket", sock]),
    ),
  );
  result.generation = handed.generation;
  const ss = Bun.spawn(["ss", "-xHlnp"], { stdout: "pipe" });
  const listeners = (await new Response(ss.stdout).text())
    .split("\n")
    .filter((l) => l.includes(root));
  result.kernelListenerNames = listeners.map((l) => l.trim().split(/\s+/)[4]);
  client = new RpcClient({ socketPath: sock });
  await client.start();
  const opened = await client.openSession({ sessionPath: join(root, "s.jsonl"), cwd: root });
  const binding = {
    id: "qa",
    designationId: "d",
    assignment: { role: "supervisor", initiativeId: "i" },
    durableSessionId: "x",
    cwd: root,
    checkout: null,
    herdrSocket: "/h",
    omoSocket: sock,
    workspaceId: "w",
    paneId: "w:p",
    sessionPath: join(root, "s.jsonl"),
    launchState: "provisioning",
    initialization: { state: "pending", text: null },
    contactState: "active",
  } as const;
  await publishReadiness(root, {
    bindingId: "qa",
    durableSessionId: "x",
    sessionPath: join(root, "s.jsonl"),
    cwd: root,
    paneId: "w:p",
    launch: { nonce: "n", pid: process.pid, starttime: await processStarttime(process.pid) },
  });
  result.proofWithRealClient = await proveTuiConnection(
    root,
    binding as never,
    "n",
    async () => true,
  );
  await client.closeSession(opened.sessionId);
  await client.stop();
  client = undefined;
  result.proofAfterDisconnect = await proveTuiConnection(
    root,
    binding as never,
    "n",
    async () => true,
  );
} finally {
  await client?.stop().catch(() => {});
  await run(["host", "stop", "--socket", sock]).catch((e) => {
    result.stopError = String(e).slice(0, 200);
  });
  await rm(root, { recursive: true, force: true });
  result.rootRemoved = !(await Bun.file(root).exists());
}
console.log(JSON.stringify(result));
