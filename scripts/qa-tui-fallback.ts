import assert from "node:assert/strict";
import { createInteractiveHostRuntime } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-host-runtime.js";
import { processStarttime, publishReadiness } from "../src/readiness";

const [root, bindingId, sessionId, path, pane, nonce] = process.argv.slice(2);
if (!root || !bindingId || !sessionId || !path || !pane || !nonce)
  throw new Error("QA TUI arguments missing");
const local = { session: { sessionFile: path }, cwd: root };
const warnings: unknown[] = [];
const runtime = await Reflect.apply(createInteractiveHostRuntime, undefined, [
  local,
  {
    socket: `${root}/missing-tui.sock`,
    ensureHost: async () => undefined,
    onWarning: (warning: unknown) => warnings.push(warning),
  },
]);
assert.equal(runtime, local);
assert.equal(warnings.length, 1);
await publishReadiness(root, {
  bindingId,
  durableSessionId: sessionId,
  sessionPath: path,
  cwd: root,
  paneId: pane,
  launch: { nonce, pid: process.pid, starttime: await processStarttime(process.pid) },
});
console.log(JSON.stringify({ type: "tui-local-proof", pid: process.pid, warnings }));
process.stdin.resume();
