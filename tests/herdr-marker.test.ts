import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHerdrExtension } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/herdr/index.js";
import marker from "../src/extension/herdr-olw-owner";

class Api {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly events = { on: () => () => undefined };
  on(name: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(name, handler);
  }
}

test("OLW Herdr marker is inert and makes the installed builtin defer", async () => {
  const markerApi = new Api();
  const inert: (pi: Api) => void = marker;
  inert(markerApi);
  expect(markerApi.handlers.size).toBe(0);

  // The builtin only reaches its deferral check inside Herdr; pin that environment explicitly
  // so the result does not depend on where the test runs.
  const saved = {
    HERDR_ENV: process.env["HERDR_ENV"],
    HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    HERDR_SOCKET_PATH: process.env["HERDR_SOCKET_PATH"],
  };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "marker-test:p1";
  process.env["HERDR_SOCKET_PATH"] = "/nonexistent/herdr.sock";
  try {
    const builtMarker = join(import.meta.dir, "../dist/extension/herdr-olw-owner.js");
    const api = new Api();
    const debug: string[] = [];
    const extension = createHerdrExtension({
      getLoadedExtensionPaths: () => [builtMarker],
      readHeader: (path: string) => readFileSync(path, "utf8").slice(0, 400),
      now: () => 1,
      connect: () => {
        throw new Error("builtin must defer before opening transport");
      },
      debug: (message: string) => debug.push(message),
    });
    extension(api as never);
    const start = api.handlers.get("session_start");
    expect(start).toBeDefined();
    await start?.(
      { reason: "new" },
      {
        mode: "tui",
        loadedExtensionPaths: [builtMarker],
        sessionManager: {},
      },
    );
    expect(debug).toContain("Herdr builtin deferred to a loaded user reporter");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
