import { reserveInputSchema } from "../../src/core/schema";
import { openRegistry } from "../../src/core/store";

const { TEST_DB_PATH: dbPath, TEST_RESERVE_INPUT: encoded } = process.env;
if (dbPath === undefined || encoded === undefined) throw new Error("missing process fixture input");
const input = reserveInputSchema.parse(JSON.parse(encoded));
process.stdout.write("READY\n");
await Bun.stdin.text();
const registry = openRegistry(dbPath);
const result = registry.reserve(input);
registry.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
