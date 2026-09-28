import { createHerdrClient } from "../../../src/herdr/client";

const panes = process.argv.slice(2);
const client = createHerdrClient(process.env["HERDR_SOCKET_PATH"] ?? "");
const out: Record<string, readonly string[]> = {};
try {
  for (const pane of panes) out[pane] = await client.paneForegroundProcessNames(pane);
} finally {
  client.close();
}
console.log(JSON.stringify({ panes, out }));
