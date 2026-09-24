import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { modelForRole } from "../src/core/policy";

const root = resolve(import.meta.dir, "..");
const evidenceRoot = join(root, ".omo/evidence");
const roleSchema = z.enum(["supervisor", "parent", "child"]);
const roles =
  process.argv.length > 2 ? z.array(roleSchema).parse(process.argv.slice(2)) : roleSchema.options;
const eventSchema = z.object({
  type: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  message: z
    .object({
      role: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
      errorMessage: z.string().optional(),
      stopReason: z.string().optional(),
      content: z.unknown().optional(),
    })
    .optional(),
});
const blocksSchema = z.array(z.object({ type: z.string(), text: z.string().optional() }));

await mkdir(evidenceRoot, { recursive: true });
const results = await Promise.allSettled(
  roles.map(async (role) => {
    const model = modelForRole(role);
    const cwd = await mkdtemp(join(tmpdir(), `olw-proxy-${role}-`));
    const expected = `OLW_PROXY_${randomUUID()}`;
    const inputPath = join(cwd, "probe.txt");
    try {
      await writeFile(inputPath, expected, { mode: 0o600 });
      const child = Bun.spawn(
        [
          process.execPath,
          join(root, "node_modules/omo-ai/bin/omo.js"),
          "--mode",
          "json",
          "--print",
          "--no-session",
          "--no-model-fallback",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--tools",
          "read",
          "--model",
          `${model.provider}/${model.modelId}`,
          "--thinking",
          model.thinking,
          `Read ${inputPath} with the read tool. Reply with exactly its content.`,
        ],
        {
          cwd,
          env: process.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = setTimeout(() => child.kill("SIGTERM"), 180_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(exitCode, 0, `${role}: ${stderr}`);
        const events = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => eventSchema.parse(JSON.parse(line)));
        const reads = events.filter(
          (event) =>
            event.type === "tool_execution_end" && event.toolName === "read" && !event.isError,
        );
        const messages = events
          .filter((event) => event.type === "message_end")
          .flatMap((event) => (event.message?.role === "assistant" ? [event.message] : []));
        assert.ok(
          reads.length > 0,
          JSON.stringify({
            role,
            error: "The file must be read through the tool",
            stderr,
            messages: messages.map((message) => ({
              provider: message.provider,
              model: message.model,
              stopReason: message.stopReason,
              error: message.errorMessage,
              text: blocksSchema
                .parse(message.content)
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join(""),
            })),
          }),
        );
        assert.ok(messages.length > 0, `${role}: no assistant response`);
        assert.ok(
          messages.every(
            (message) => message.provider === model.provider && message.model === model.modelId,
          ),
          `${role}: every turn must use the requested proxy model`,
        );
        const text = blocksSchema
          .parse(messages.at(-1)?.content)
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        assert.equal(text.trim(), expected, `${role}: reply must match the unread random file`);
        const evidence = {
          timestamp: new Date().toISOString(),
          role,
          model,
          exitCode,
          toolReads: reads.length,
          reply: text.trim(),
          result: "PROXY_TOOL_OK",
        };
        const evidencePath = join(evidenceRoot, `proxy-${role}.json`);
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
      } finally {
        clearTimeout(deadline);
        child.kill("SIGTERM");
        await child.exited;
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }),
);
const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
if (failures.length > 0) throw new AggregateError(failures, "Proxy role QA failed");
