# Draft: session worker isolation has no per-session memory limit

Not filed. Senpi 2026.9.27, Bun 1.4.0, Linux x64.

## Observed behavior

`dist/modes/rpc/session-worker-client.js:11-15` creates `node:worker_threads.Worker`
with only a URL. There are no resourceLimits. The nested JavaScript eval worker
in senpi-codemode `src/kernels/js/worker-host.ts:29-34` likewise passes workerData
only. Ten open worker sessions report the same process PID. The documented
20-worker capacity bounds occupancy, not an individual session's allocation.

This is a containment limitation, not a claim that graceful eval disposal is
broken. In a real extension RPC calling `pi.executeTool("eval", ...)`, ten touched
64 MiB buffers plus Bun.serve listeners were released after close in both runtimes.
The worker run went from 2,761,072 to 389,896 KiB RSS; twenty TCP LISTEN sockets
became zero. Live idle sessions retained both memory and sockets.

## Senpi-only minimal reproduction

Install the pinned package in an empty temporary project. Save this as memory.ts;
load it with `senpi --mode rpc --listen /tmp/memory-repro.sock --session-runtime worker
--no-extensions -e ./memory.ts`. Use a temporary agent directory and no credentials.

```ts
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { Type } from "typebox";

export default function memory(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_fixture",
    label: "Memory fixture",
    description: "Retain a bounded touched allocation and loopback listener",
    parameters: Type.Object({}),
    async execute() {
      const bytes = new Uint8Array(64 * 1024 * 1024);
      bytes.fill(17);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
        fetch: () => new Response(String(bytes.byteLength)) });
      const details = { pid: process.pid, port: server.port, bytes: bytes.byteLength };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.rpc.handle("memory.allocate", () => pi.executeTool("memory_fixture", {}));
}
```

For each session send `open_session`, then `extension_request` named
`memory.allocate` with that routing sessionId. Read `/proc/PID/status` and join
TCP state 0A socket inodes against `/proc/PID/fd`. All allocations belong to one
PID. Close each session with `close_session`. Repeat with `--session-runtime
in-process`: extension-owned listeners without shutdown cleanup survive close;
worker termination removes them. Terminate the disposable process group and remove
its socket/project afterwards. No model inference is needed.

The bounded extension-tool variant was observed separately with ten sessions:
in-process 1,077,588 -> 1,071,456 KiB and ten surviving user listeners; worker
2,695,116 -> 381,592 KiB and zero listeners. These numbers do not establish a
fatal OOM threshold. No unbounded allocation or host OOM was induced.

## Requested upstream clarification / capability

Expose a supported process-backed session runtime or an explicit enforceable
per-session resource boundary. Do not describe worker count or a memory-warning
observer as protection against a live session exhausting the shared process.
If resourceLimits are considered, verify Bun's actual enforcement and account for
ArrayBuffer/external memory; a JavaScript heap cap alone may not bound RSS.
