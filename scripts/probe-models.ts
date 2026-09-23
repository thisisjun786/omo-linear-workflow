import { z } from "zod";

const responseSchema = z.object({
  id: z.literal("model-state"),
  success: z.literal(true),
  data: z.object({
    model: z.object({ provider: z.string(), id: z.string() }),
    thinkingLevel: z.string(),
  }),
});

class ProbeError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ProbeError";
  }
}

const roles = [
  { role: "supervisor", model: "chatgpt-subscription/gpt-6-astra", thinking: "high" },
  { role: "parent", model: "kimi-coding/k3", thinking: "max" },
  { role: "child", model: "anthropic-subscription/claude-opus-5", thinking: "xhigh" },
] as const;

for (const role of roles) {
  const child = Bun.spawn(
    [
      "omo",
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--no-recommended-models",
      "--no-model-fallback",
      "--model",
      role.model,
      "--thinking",
      role.thinking,
    ],
    {
      cwd: "/home/jun",
      env: { ...process.env, HERDR_ENV: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGTERM"), 45000);
  let found = false;
  let pending = "";
  try {
    child.stdin.write(`${JSON.stringify({ id: "model-state", type: "get_state" })}\n`);
    await child.stdin.flush();
    for await (const bytes of child.stdout) {
      pending += new TextDecoder().decode(bytes);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const value: unknown = JSON.parse(line);
        const parsed = responseSchema.safeParse(value);
        if (parsed.success) {
          const state = parsed.data.data;
          const actual = `${state.model.provider}/${state.model.id}`;
          if (actual !== role.model || state.thinkingLevel !== role.thinking) {
            throw new ProbeError(
              `${role.role}: wanted ${role.model}:${role.thinking}, got ${actual}:${state.thinkingLevel}`,
            );
          }
          console.log(
            JSON.stringify({ role: role.role, model: actual, thinking: state.thinkingLevel }),
          );
          found = true;
          break;
        }
        newline = pending.indexOf("\n");
      }
      if (found) break;
    }
    if (!found) throw new ProbeError(`No valid state for ${role.role}`);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGTERM");
    await child.exited;
    const stderr = await errors;
    if (stderr) console.error(stderr);
    console.log(`CLEANUP ${role.role}: RPC process ${child.pid} exited`);
  }
}
console.log("MODELS_PASS");
