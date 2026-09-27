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
  marker();
  expect(markerApi.handlers.size).toBe(0);

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
});
