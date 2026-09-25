import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { RoutingError, type RoutingGroups } from "./routing-plan";

export const groupsSchema = z.object({
  categories: z.record(z.string(), z.record(z.string(), z.unknown())),
  agents: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export const receiptSchema = z.object({
  generation: z.string(),
  // A receipt without a provider predates opencodex routing and is re-planned.
  provider: z.string().optional(),
  version: z.string(),
  digest: z.string(),
  upstream: z.string(),
  configDigest: z.string(),
  managed: groupsSchema,
  available: z.array(z.string()),
  overrides: z.array(z.string()),
  skipped: z.array(z.string()),
  // Managed routes with no served candidate; absent in receipts written before this field.
  unroutable: z.array(z.string()).default([]),
  changes: z.array(z.string()),
  backup: z.string().nullable(),
});
export type RoutingReceipt = z.infer<typeof receiptSchema>;
const pendingSchema = z.object({
  configPath: z.string(),
  before: z.string(),
  text: z.string(),
  receipt: receiptSchema,
});

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Replace owned sections only; unrelated JSONC bytes, comments and settings survive. */
export function editRoutingConfig(text: string, groups: RoutingGroups): string {
  let result = text;
  for (const scope of ["categories", "agents"] as const) {
    const source = ts.parseJsonText("omo.jsonc", result);
    const statement = source.statements[0];
    if (
      !statement ||
      !ts.isExpressionStatement(statement) ||
      !ts.isObjectLiteralExpression(statement.expression)
    )
      throw new RoutingError("OMO config must be a JSONC object");
    const object = statement.expression;
    const property = object.properties.find(
      (entry) =>
        ts.isPropertyAssignment(entry) &&
        ts.isStringLiteral(entry.name) &&
        entry.name.text === scope,
    );
    const value = JSON.stringify(groups[scope], null, 2).replaceAll("\n", "\n  ");
    if (property && ts.isPropertyAssignment(property)) {
      result =
        result.slice(0, property.initializer.getStart(source)) +
        value +
        result.slice(property.initializer.end);
    } else {
      const position = object.getStart(source) + 1;
      result = `${result.slice(0, position)}\n  "${scope}": ${value}${object.properties.length ? "," : ""}${result.slice(position)}`;
    }
  }
  return result;
}

/** The caller holds the process-wide file lock. Recover an interrupted two-file publication. */
export async function recoverRouting(stateDir: string): Promise<void> {
  const pendingPath = join(stateDir, "pending.json");
  const text = await optionalText(pendingPath);
  if (text === undefined) return;
  const pending = pendingSchema.parse(JSON.parse(text));
  const receiptText = await optionalText(join(stateDir, "state.json"));
  const published = receiptText ? receiptSchema.parse(JSON.parse(receiptText)) : undefined;
  if (published?.generation !== pending.receipt.generation) {
    const actual = digest(await readFile(pending.configPath, "utf8"));
    if (actual !== pending.before && actual !== pending.receipt.configDigest)
      throw new RoutingError(
        `Concurrent config edit detected; inspect ${pendingPath} before recovery`,
      );
    if (actual === pending.before) await atomicText(pending.configPath, pending.text);
    await atomicText(join(stateDir, "state.json"), `${JSON.stringify(pending.receipt, null, 2)}\n`);
  }
  await rm(pendingPath);
}

export async function publishRouting(
  stateDir: string,
  configPath: string,
  before: string,
  text: string,
  receipt: RoutingReceipt,
): Promise<void> {
  if (digest(await readFile(configPath, "utf8")) !== digest(before))
    throw new RoutingError("OMO config changed during routing discovery; retry the check");
  await atomicText(
    join(stateDir, "pending.json"),
    JSON.stringify({ configPath, before: digest(before), text, receipt }),
  );
  await recoverRouting(stateDir);
}
