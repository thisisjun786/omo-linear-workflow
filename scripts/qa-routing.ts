import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicText } from "../src/proxy/routing-config";

const root = resolve(import.meta.dir, "..");
const cwd = await mkdtemp(join(tmpdir(), "olw-routing-live-"));
const paths = [join(cwd, "quick.txt"), join(cwd, "explore.txt")];
const tokens = paths.map(() => crypto.randomUUID());
await Promise.all(paths.map((path, index) => writeFile(path, tokens[index] ?? "")));
const launchSchema = z.object({
  details: z.object({
    status: z.literal("running"),
    task_id: z.string(),
    resolved_model: z.object({
      provider: z.literal("opencodex"),
      model_id: z.string(),
      source: z.enum(["category", "agent"]),
      variant: z.string().optional(),
    }),
  }),
});
const eventSchema = z.object({ type: z.string() }).passthrough();
const messageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  provider: z.string().optional(),
});
const configured = z
  .object({
    categories: z.object({
      quick: z.object({ models: z.array(z.object({ model: z.string() })).min(1) }),
    }),
    agents: z.object({
      explore: z.object({ models: z.array(z.object({ model: z.string() })).min(1) }),
    }),
  })
  .parse(
    Bun.JSON5.parse(await readFile(join(process.env["HOME"] ?? "", ".omo/omo.jsonc"), "utf8")),
  );
const expected = new Map([
  ["category", configured.categories.quick.models[0]?.model],
  ["agent", configured.agents.explore.models[0]?.model],
]);
const child = Bun.spawn(
  [
    process.execPath,
    join(root, "dist/omo.js"),
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "task",
    "--model",
    "opencodex/gpt-6-luna",
    "--thinking",
    "low",
    "--no-model-fallback",
  ],
  { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);
const deadline = AbortSignal.timeout(240000);
const abort = () => {
  child.kill();
};
deadline.addEventListener("abort", abort, { once: true });
const stderr = new Response(child.stderr).text();
const launched: z.infer<typeof launchSchema>["details"][] = [];
const completions: string[] = [];
const eventTrace: unknown[] = [];
const providers = new Set<string>();
const reader = child.stdout.getReader();
const decoder = new TextDecoder();
let pending = "";
const collect = async () => {
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    pending += decoder.decode(part.value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (!line.startsWith("{")) continue;
      const event = eventSchema.parse(JSON.parse(line));
      if (["tool_execution_end", "agent_end", "response"].includes(event.type)) {
        eventTrace.push(event);
        if (eventTrace.length > 30) eventTrace.shift();
      }
      if (event.type === "tool_execution_end" && event["toolName"] === "task") {
        if (event["isError"]) throw new Error("Actual task launch returned an error");
        const parsed = launchSchema.safeParse(event["result"]);
        if (parsed.success) launched.push(parsed.data.details);
      }
      if (event.type === "message_end") {
        const message = messageSchema.parse(event["message"]);
        if (message.role === "assistant" && message.provider) providers.add(message.provider);
        if (
          message.role === "custom" &&
          typeof message.content === "string" &&
          message.content.startsWith("task completion ")
        )
          completions.push(message.content);
      }
      if (
        event.type === "agent_end" &&
        launched.length === 2 &&
        launched.every((task) =>
          completions.some(
            (text) => text.includes(`id:${task.task_id} `) && text.includes("status:completed "),
          ),
        )
      ) {
        await child.stdin.end();
      }
    }
  }
};
try {
  // Subscribe to actual runtime events before triggering the parent prompt.
  const reading = collect();
  child.stdin.write(
    `${JSON.stringify({
      type: "prompt",
      id: "routing-qa",
      message: `Make exactly two separate task calls with run_in_background=true. First: category quick, read ${paths[0]} and reply with its exact content. Second: subagent_type explore, read ${paths[1]} and reply with its exact content. Do not set model, do not pass category for explore, do not do other work. Wait for both actual completion notifications and then relay both results.`,
    })}\n`,
  );
  await reading;
  const code = await child.exited;
  if (code !== 0) throw new Error(`OMO exited ${code}: ${await stderr}`);
  if (
    launched.length !== 2 ||
    new Set(launched.map((task) => task.resolved_model.source)).size !== 2
  )
    throw new Error("Both category and named-agent launches must be observed");
  for (const task of launched) {
    const actual = `${task.resolved_model.provider}/${task.resolved_model.model_id}`;
    if (actual !== expected.get(task.resolved_model.source))
      throw new Error(`Actual ${task.resolved_model.source} route differs: ${actual}`);
    const index = task.resolved_model.source === "category" ? 0 : 1;
    const token = tokens[index];
    if (
      !token ||
      !completions.some(
        (text) =>
          text.includes(`id:${task.task_id} `) &&
          text.includes("status:completed ") &&
          text.includes(token),
      )
    )
      throw new Error("Runtime completion did not contain the unread file's value");
  }
  if (providers.size !== 1 || !providers.has("opencodex"))
    throw new Error("Parent escaped opencodex");
  const evidence = { result: "ROUTING_LIVE_OK", launched, completions, providers: [...providers] };
  await atomicText(
    join(root, ".omo/evidence/routing-live.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  await atomicText(
    join(root, ".omo/evidence/routing-live-failure.json"),
    `${JSON.stringify(
      {
        launched,
        completions,
        providers: [...providers],
        eventTrace,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  );
  throw error;
} finally {
  deadline.removeEventListener("abort", abort);
  if (child.exitCode === null) child.kill();
  await child.exited;
  await rm(cwd, { recursive: true, force: true });
}
