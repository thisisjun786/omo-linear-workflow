import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getBuiltinProviders } from "../../src/proxy/engine";

test("OLW proxy entry registers callable models without the standalone extension", async () => {
  const home = await mkdtemp(join(tmpdir(), "olw-proxy-entry-"));
  const root = resolve(import.meta.dir, "../..");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "gpt-6-astra" }] });
      if (path === "/v0/management/oauth-model-alias")
        return Response.json({ "oauth-model-alias": {} });
      if (path === "/v0/management/model-definitions/codex")
        return Response.json({
          models: [
            {
              id: "gpt-6-astra",
              context_length: 272000,
              max_completion_tokens: 128000,
              supportedInputModalities: ["text", "image"],
              thinking: { levels: ["low", "high"] },
            },
          ],
        });
      return Response.json({ models: [] });
    },
  });
  const agentDir = join(home, ".omo/agent");
  const accessDir = join(home, ".config/cliproxyapi");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(accessDir, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        disabledProviders: getBuiltinProviders(),
        providers: {
          cliproxyapi: { modelOverrides: { "gpt-6-astra": { contextWindow: 372000 } } },
        },
      }),
    );
    await writeFile(
      join(accessDir, "omo-client.json"),
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "fixture-client",
      }),
    );
    await writeFile(
      join(accessDir, "management-access.json"),
      JSON.stringify({
        managementUrl: `http://127.0.0.1:${server.port}/management.html`,
        managementKey: "fixture-management",
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(root, "node_modules/omo-ai/bin/omo.js"),
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "-e",
        join(root, "src/proxy/index.ts"),
        "--list-models",
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          OMO_CODING_AGENT_DIR: agentDir,
          SENPI_CODING_AGENT_DIR: agentDir,
          OMO_RUNTIME: "bun",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toMatch(/cliproxyapi\s+gpt-6-astra\s+372K\s+128K/);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await child.exited;
    }
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 35_000);
