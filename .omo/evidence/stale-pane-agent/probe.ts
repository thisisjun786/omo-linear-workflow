
import { createHerdrClient } from "../src/herdr/client";
const c = createHerdrClient(process.env.HERDR_SOCKET_PATH ?? "");
try {
  const out: Record<string, readonly string[]> = {};
  for (const p of process.argv.slice(2)) out[p] = await c.paneForegroundProcessNames(p);
  console.log(JSON.stringify(out));
} finally { c.close(); }
