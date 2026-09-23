import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicText } from "../src/proxy/routing-config";

const [modelId, thinking] = z
  .tuple([z.string().min(1), z.enum(["off", "low", "medium", "high", "xhigh", "max"])])
  .parse(process.argv.slice(2));
const root = resolve(import.meta.dir, "..");
const cwd = await mkdtemp(join(tmpdir(), "olw-model-probe-"));
const expected = crypto.randomUUID();
const input = join(cwd, "probe.txt");
const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  message: z
    .object({
      role: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
      content: z.unknown().optional(),
      errorMessage: z.string().optional(),
    })
    .optional(),
});

try {
  await writeFile(input, expected, { mode: 0o600 });
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "dist/omo.js"),
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-model-fallback",
      "--no-extensions",
      "-e",
      join(root, "dist/proxy/index.js"),
      "--no-skills",
      "--no-context-files",
      "--tools",
      "read",
      "--model",
      `cliproxyapi/${modelId}`,
      "--thinking",
      thinking,
      `Read ${input} with the read tool and reply with exactly its content.`,
    ],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const deadline = AbortSignal.timeout(180000);
  const abort = () => child.kill("SIGTERM");
  deadline.addEventListener("abort", abort, { once: true });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, stderr);
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => eventSchema.parse(JSON.parse(line)));
    const messages = events
      .filter((event) => event.type === "message_end")
      .flatMap((event) => (event.message?.role === "assistant" ? [event.message] : []));
    const reads = events.filter(
      (event) => event.type === "tool_execution_end" && event.toolName === "read" && !event.isError,
    );
    assert.ok(reads.length > 0, JSON.stringify(messages));
    assert.ok(
      messages.every((message) => message.provider === "cliproxyapi" && message.model === modelId),
      "Every turn must use the requested model, not fallback",
    );
    const final = z
      .array(blockSchema)
      .parse(messages.at(-1)?.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    assert.equal(final, expected, "The model must retrieve the hidden random value");
    const thinkingBlocks = messages
      .flatMap((message) => z.array(blockSchema).parse(message.content))
      .filter((block) => block.type === "thinking" && block.thinking).length;
    const evidence = {
      result: "PROXY_MODEL_OK",
      modelId,
      requestedThinking: thinking,
      code,
      toolReads: reads.length,
      thinkingBlocks,
      expected,
      reply: final,
    };
    await atomicText(
      join(root, ".omo/evidence", `model-${modelId.replaceAll("/", "-")}-${thinking}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(JSON.stringify(evidence));
  } finally {
    deadline.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
