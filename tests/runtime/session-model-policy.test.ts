import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { SettingsManager } from "@code-yeongyu/senpi";
import { z } from "zod";

const settingsActions = z.object({
  getRetryFallbackSettings: z.custom<() => { modelFallback: boolean }>(
    (value) => typeof value === "function",
  ),
  setModelFallbackForSession: z.custom<(enabled: boolean) => void>(
    (value) => typeof value === "function",
  ),
});

function installedActions(source: string, settingsManager: SettingsManager) {
  const marker = "            sessionSettings: ";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  expect(source.indexOf(marker, start + marker.length)).toBe(-1);
  const end = source.indexOf("            },\n            compact:", start);
  expect(end).toBeGreaterThan(start);
  const object = source.slice(start + marker.length, end + "            }".length);
  const result: unknown = runInNewContext(`(function () { return (${object}); }).call(owner)`, {
    owner: { settingsManager, _retryFallback: { activeState: undefined } },
  });
  return settingsActions.parse(result);
}

test("native session model fallback override survives reload without changing another session or settings file", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-session-policy-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agentDir);
    await mkdir(cwd);
    const path = join(agentDir, "settings.json");
    await writeFile(path, JSON.stringify({ retry: { modelFallback: true } }));
    const before = await readFile(path, "utf8");
    const first = SettingsManager.create(cwd, agentDir);
    const second = SettingsManager.create(cwd, agentDir);
    const source = await readFile(
      join(
        dirname(fileURLToPath(import.meta.resolve("@code-yeongyu/senpi"))),
        "core/agent-session.js",
      ),
      "utf8",
    );
    const actions = installedActions(source, first);
    expect(actions.getRetryFallbackSettings().modelFallback).toBe(true);
    actions.setModelFallbackForSession(false);
    expect(actions.getRetryFallbackSettings().modelFallback).toBe(false);
    await first.reload();
    expect(actions.getRetryFallbackSettings().modelFallback).toBe(false);
    expect(second.getRetryFallbackSettings().modelFallback).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
